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
bun install        # 或 npm install

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
  "guards": { "maxRounds": 8, "maxConsecutiveFails": 4, "maxDraftReads": 3, "callTimeoutMs": 0 },
  "onFailure": "auto",
  "fallbackToNative": false,
  "debugLog": true,
  "systemBlock": "<pi-vcc-plus>…</pi-vcc-plus>"
}
```

- `guards` 全部是**计数**：慢模型不会被时间掐断（`callTimeoutMs` 默认 0 = 不限）。
- `onFailure`：`auto`（手动抛错 / 自动 cancel+通知）、`cancel`、`throw`、`draft`（显式回退未校验草稿）。
- `fallbackToNative: false` = 失败时不静默退回 pi 原生摘要。

## 测试

```powershell
bun test test/patch.test.ts                    # P1–P4 单测（10 例）
bun run test/draft-smoke.ts <session.jsonl> 0  # 用真实会话离线生成草稿（不调模型）
```

## 日志与验收

`~/.pi/agent/vcc-plus/log/<sessionId>.jsonl`：`vcc_loaded`、`draft`、`round`（含 `cacheRead`、
`expectedPrefixTokens`、`prefixSuspect`、`toolsSource`）、`tool`、`summary_final`、`fail_closed`。

**首次实测要看的一条**：`round.prefixSuspect` 必须为 false（即 `cacheRead ≈ 前缀长度`），
否则说明前文被改动了，前缀复用没有成立。

## 待验证清单

1. 快照是否与 pi 上一次请求逐字节等价（`ctx.getSystemPrompt()` + `convertToLlm(event.messages)` + tools 解析链）。
2. `ctx.modelRegistry.complete` 传 `tools` 的行为（官方示例没传）。
3. `toolsSource` 是否稳定命中 `selectedTools`；为 `none` 时前缀可能不一致。
4. 未集成 `vcc_recall`（按设计：补充只看本窗口）。
