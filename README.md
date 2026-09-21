# Project-pi-vcc-plus

把 pi 的上下文压缩从"另起一次摘要请求"改成 **VCC 机械草稿 + 模型就地打补丁**。

核心目标：压缩时**不改动前文一个字节**（system + tools + messages 原样复用），只在会话尾部追加一条指令，
于是"把 20 万–96 万 token 重新 prefill 一遍才写出摘要"的开销不再发生；压缩后重建上下文那一次 prefill 仍不可避免。

## 目录结构

```
index.ts                 pi 扩展入口（系统提示词块 + 三个工具 + 快照 + 压缩接管）
src/
  config.ts              配置与系统提示词块（英文常量）
  prompt.ts              尾部指令 / diff 回执 / P1–P4 错误文案（英文）
  patch.ts               补丁应用与校验（纯逻辑，有单测）
  engine.ts              快照 / 草稿 / 校验循环 / fail-closed
  vcc.ts                 加载上游 pi-vcc（不复制、不改写）
  log.ts                 ~/.pi/agent/vcc-plus/log/<sessionId>.jsonl
test/
  patch.test.ts          P1–P4 单测（10 例）
  draft-smoke.ts         真实会话离线生成草稿（不调模型）
third_party/pi-vcc/      上游 VCC（submodule；当前为未修改的 0.8.0 本地副本占位）
docs/                    设计说明与对比记录
scripts/                 维护脚本
```

## 安装

```powershell
# 0) 安装依赖（submodule 里的 recall 工具会 import typebox，从仓库根解析）
npm install        # lockfile 已提交；bun install 亦可（测试用 bun 跑）

# 1) 安装扩展本身（本地路径不会被复制，改代码后 /reload 即可生效）
pi install "<repo-dir>"

# 2) 让 pi 能加载 VCC：三条路任选其一（见下）
```

> 为什么要 `bun install`：我们直接加载 **上游** `third_party/pi-vcc/src/tools/recall.ts`，
> 它 `import { Type } from "typebox"`，而 submodule 自己没有 node_modules；
> 仓库根装上 `typebox@1.3.7`（与 pi 自带版本一致）后，Node 的解析会从 submodule 向上找到它。

`src/vcc.ts` 按以下顺序解析上游 pi-vcc（都用它**发布出来的源码**，我们不改它一行）：

1. `config.vccPackagePath`（显式指定）
2. 环境变量 `PI_VCC_PLUS_VCC_PATH`
3. **仓库内** `third_party/pi-vcc`（推荐：git submodule）
4. `~/.pi/agent/npm/node_modules/@sting8k/pi-vcc`（`pi install npm:@sting8k/pi-vcc` 装的位置）
5. `<cwd>/.pi/npm/node_modules/@sting8k/pi-vcc`

> 用 npm 路线时，请在 `~/.pi/agent/settings.json` 里把它设为 **安装但不加载**：
> `{ "source": "npm:@sting8k/pi-vcc", "extensions": [] }`
> 否则它自己的 `session_before_compact` 钩子会和本扩展抢同一次压缩。

## 上游 VCC（git submodule）

`third_party/pi-vcc` 是指向 <https://github.com/sting8k/pi-vcc> 的 submodule，当前固定在 `303e89d`
（v0.8.0 之后的一个 docs 提交）。加载器直接读它的源码：**我们不复制、不修改上游代码**。

更新上游：

```powershell
git submodule update --remote --merge third_party/pi-vcc
git add third_party/pi-vcc
git commit -m "bump pi-vcc"
```

`scripts/setup-upstream-vcc.ps1` 只用于"重做这次切换"（把仓库里的本地副本换成 submodule）。

## 工作流程

```
① 触发压缩（复用 pi 现有触发点：工具批次结束 / 回复结束；手动 /compact 沿用 pi 自己的 abort）
② 本地跑 VCC → 草稿（零模型调用）
③ 取上一次请求的快照（system + tools + messages 原文）+ 尾部追加指令 → 一次请求
④ 模型用 vcc_patch 打补丁（可多轮）；vcc_draft 看全文；vcc_done 结束
⑤ 校验 P1–P4（工具内部，纯本地）
⑥ 应用后的草稿 = 定稿摘要 → 写 CompactionEntry
⑦ 重建上下文 = 定稿摘要 + 保留的尾部几轮 → 同一 run 继续（一次不可避免的 prefill）
```

细节见 [docs/design.md](docs/design.md)；VCC 的实测对比见 [docs/vcc-vs-native-notes.md](docs/vcc-vs-native-notes.md)。

## 配置

`~/.pi/agent/vcc-plus/config.json`（首次运行自动生成）：

```json
{
  "enabled": true,
  "vccPackagePath": null,
  "checkModel": null,
  "draftBudget": { "floorTokens": 1100, "ceilingTokens": 2000, "tokensPerBlock": 15 },
  "guards": { "maxRounds": 8, "maxConsecutiveFails": 4, "maxDraftReads": 3, "callTimeoutMs": 0, "requireDone": false },
  "onFailure": "auto",
  "fallbackToNative": false,
  "upstreamRecallTool": true,
  "debugLog": true,
  "systemBlock": "<pi-vcc-plus>…</pi-vcc-plus>"
}
```

- `guards` 全部是**计数**：慢模型不会被时间掐断（`callTimeoutMs` 默认 0 = 不限）；
  `requireDone: true` 时模型必须显式 `vcc_done`（纯文本收尾升级为失败，默认只警告）。
- `onFailure`：`auto`（手动抛错 / 自动 cancel+通知）、`cancel`、`throw`、`draft`（显式回退未校验草稿）。
- `fallbackToNative: false` = 失败时不静默退回 pi 原生摘要。
- `upstreamRecallTool: true` = 注册上游 pi-vcc 自带的只读 `vcc_recall`（校验阶段内被拒绝）。
- 配置只在扩展加载时读一次；改 `config.json` 需 `/reload`（中途改会改变系统块、破坏前缀不变量）。
- 草稿的 chars/token 校准沿用上游 `before-compact.ts` 的锚（span 字符 + 上次摘要字符 ÷ `tokensBefore`）：
  这是上游算法的行为（对估算偏保守），我们刻意保持一致、不单方分叉；如需精确控制可用 `checkModel` 换模型或向上游提 issue。

## 测试

```powershell
bun run typecheck                            # tsc --noEmit（strict；捕获运行时才会暴露的类型错误）
bun test test/                              # P1–P4 单测 + 校验循环回归 + recall 加载
bun run test/draft-smoke.ts <session.jsonl> 0  # 用真实会话离线生成草稿（不调模型）
```

> `bun run typecheck` 需要 devDependencies（`typescript`、`@earendil-works/pi-coding-agent@0.85.1` 等，
> 与运行中的 pi 同版本）：`bun install` 或 `npm install` 装一次即可。
> 仓库路径含 `&`，Windows 下 `.bin` shim 会解析失败——直接 `node node_modules/typescript/bin/tsc -p tsconfig.json`。

## 日志与验收

`~/.pi/agent/vcc-plus/log/<sessionId>.jsonl`：`vcc_loaded`、`draft`、`round`（含 `cacheRead`、
`expectedPrefixTokens`、`prefixSuspect`、`toolsSource`）、`checkPrefix`（校验请求字节验证结果）、
`tool`、`summary_final`、`fail_closed`。

**首次实测要看的一条**：`round.prefixSuspect` 必须为 false（即 `cacheRead ≈ 前缀长度`），
否则说明前文被改动了，前缀复用没有成立。

## 已对 pi 0.85.1 源码核实的前缀等价性

1. **messages**：`context` 事件在每次 provider 请求前触发，`convertToLlm(event.messages)` 与 pi 自己
   的转换同函数；`images.blockImages` 开启时快照做了与 pi `convertToLlmWithBlockImages` 完全相同的替换。
2. **system prompt**：`before_agent_start` 在首个请求前就把扩展块并入 `agent.state.systemPrompt`，
   快照读到的与请求实际用的同值；块本身是常量，每轮不变。
3. **tools**：事件 ctx 不暴露 `getAllTools` / `getSystemPromptOptions`，所以 tools 只从
   `before_provider_request` 的 payload 取（上一次请求自己的 wire tools，含顺序）。
   校验请求经**自定义 fetch** 发出：出站 body 里的 `tools` 被替换为捕获到的**原始 wire tools**
   （构造性字节一致，pi-ai 自己的重建永远不上 wire；这也顺带消除了 round-trip 隐患）。
   `toolsRoundTripStatus` 保留为三保险：wire tools 含 grammar/custom 形状、`strict: true`
   （来自 wire 不携带的 `constrainedSampling`）或 `defer_loading` 时标记 `mismatch`，检查 fail-closed。
   `toolsSource` 因此恒为 `before_provider_request.payload`；拿不到 tools 时 fail-closed（不再发降级请求）。
4. **单轮失败**：pi-ai 对 API 错误/中止是 resolve 返回 `stopReason: "error" | "aborted"` 的
   AssistantMessage（不 reject）——校验循环现在检查 `stopReason`/`errorMessage`/abort，
   失败即走 fail-closed，绝不把未校验草稿当定稿。
5. **校验请求的字节级复核（B 面）**：校验请求不走 Agent 的 stream 路径
   （`ModelRegistry.complete` → `runtime.complete`，不经过 `onPayload`/`before_provider_request`），
   所以 prefix-sentinel 看不到它——它由 pi-vcc-plus 自己的 fetch 拦截验证：
   第一次出站 body 与上一次真实请求的 wire body 做前缀比较（system / tools / 前 N 条
   messages），结果写 `checkPrefix` 日志（`identical` + `firstDivergence`），完整 body 写到
   `.pi/prefix-sentinel/check-request.json`。基线优先取 prefix-sentinel 的 `last-request.json`
   （独立代码路径捕获），没有哨兵时用自捕获的 `.pi/vcc-plus/last-wire-request.json`。
   双证据：字节层面（本条）+ 框架层面（`round.prefixSuspect` 的 cacheRead 断言）。
