**⚠️ 这是一个实验性项目，目前工作尚不稳定。**

# pi-vcc-plus

> 把 pi 的上下文压缩从"另起一次摘要请求"改成 **机械草稿 + 模型补一轮**：
> 压缩时前文一个字节都不改，不新增独立摘要请求，服务端已有的 KV 缓存直接复用。
>
> [English](README.en.md)

## 它解决什么问题

pi 原生压缩会**另发一次摘要请求**：换掉 system prompt、重排正文、去掉工具定义。对服务端来说这是一段
全新的文本——第一个 token 就已经不同，此前整段对话累积的 KV 缓存全部作废，压缩本身要先花时间把整个
前缀重新算一遍。上下文越长这笔越贵：在一台 2×V100 的机器上，一次 18 万 token 会话的压缩，仅这一项
就要 244 秒。

pi-vcc-plus 换成"草稿 + 补一轮"：

1. **草稿由算法生成**——用上游 [pi-vcc](https://github.com/sting8k/pi-vcc) 做机械抽取：确定性、
   零模型调用、毫秒级。产出分节的结构化草稿（会话目标、改过的文件、提交、关键决策、环境、
   结果、未完成项、用户偏好）；
2. **模型只补一轮**——在当前会话尾部追加一条指令，模型用 `vcc_add`（往某一节追加，
   `"replace": true` 则重写该节）把草稿缺的事实补上。这一次响应就是全部补充内容，应用后阶段立即结束；
   动过手的章节由 `vcc_done` 收尾。模型没碰的章节按构造原样保留。
3. **前文一个字节不动**——这条检查请求是"上一次真实请求"的**严格延续**：同一个 system prompt、
   同一份工具定义、同一段历史消息，只在尾部多了一段指令。前缀逐字节相同，服务端直接复用缓存，
   只需计算尾部新增的那几个 token。

代价只有一项，而且是所有压缩方式共同承担的：压缩完成后，新的上下文（摘要 + pi 保留的最近若干轮）
首次使用仍要 prefill 一次。

## 与上游 pi-vcc 的关系

本扩展基于 [@sting8k/pi-vcc](https://www.npmjs.com/package/@sting8k/pi-vcc)（MIT，锁定 v0.8.0，
git submodule `third_party/pi-vcc` @ `303e89d`）：

| | pi-vcc（上游） | pi-vcc-plus（本扩展） |
|---|---|---|
| 草稿生成 | 机械抽取算法（结构、预算锚、校准） | 复用上游，不复制不改写（直接读它的源码） |
| 模型参与 | 无（纯算法） | 一次补充轮：`vcc_add`（`"replace":true` 重写某节）、`vcc_draft` 按需、`vcc_done` 收尾 |
| 前缀稳定性 | 不处理 | 复用上一次请求的快照 + 逐字节校验；失败时退回原生（有提示），用户取消除外 |
| 历史检索 | `vcc_recall`（读原始 JSONL） | 默认注册（补充轮内被拒绝） |

加载器只读上游**发布出来的源码**，一行不改。更新上游：

```powershell
git submodule update --remote --merge third_party/pi-vcc
git add third_party/pi-vcc
git commit -m "bump pi-vcc"
```

（`scripts/setup-upstream-vcc.ps1` 只用于"重做这次切换"——把仓库里的本地副本换成 submodule。）

> 如果你另外装了 pi-vcc 本体（`pi install npm:@sting8k/pi-vcc`），请在 `~/.pi/agent/settings.json`
> 里把它设为**安装但不加载**：`{ "source": "npm:@sting8k/pi-vcc", "extensions": [] }`。
> 否则它自己的 `session_before_compact` 钩子会和本扩展抢同一次压缩。

## 工作原理

![压缩接管全流程](docs/images/01-flow.png)

触发点完全沿用 pi：上下文将满时自动触发，或手动 `/compact`。区别只在"摘要怎么来"：

1. **生成草稿**（本地、无模型调用）：上游 pi-vcc 从会话里机械抽取事实，写成分节草稿；同时把这次要
   替换掉的那段对话以纯文本形式附在草稿尾部，作为给模型看的**原料**，并在定稿时丢弃。
2. **让模型补一轮**：把"上一次真实请求"的原文 + 一条尾部指令发给模型。指令给的是**带行号的草稿**
   （章节区标了行号；原料区不编号、只读，定稿时丢弃）以及这次该补哪几类信息。模型用
   `vcc_add` 往指定章节追加（`"replace": true` 重写该节），用 `vcc_done` 收尾。
   若这一轮模型一个工具都没调用，扩展会追加一句提醒再问一次，而不是直接拿未修改的草稿当摘要；
   若响应撞上输出上限，已经解析出来的编辑照常应用（不会整轮作废）。
   这一轮是**流式**的：编辑器上方有一个用压缩摘要那套颜色的框（不是工具框的颜色），边写边显示
   轮次、`vcc_add` 实际追加了什么。点开可以同时看到机械草稿与模型的补充；
   默认只计数不显示模型的思考内容（本地模型的思考量太大，会把补充内容埋掉）；
   打开 `debugTrace` 后展开即为全量——完整思维链、不截断的工具参数，外加一份 `<会话 ID>.trace.md`。
3. **定稿**：丢弃草稿尾部的原料与分隔标记，只保留分节正文（章节名归一到固定的八个、按固定顺序），
   交给 pi 写成这次压缩的摘要。会话最近若干轮由 pi 原样保留，紧跟摘要进入下一个窗口。

**为什么前缀能复用**：第 2 步发出的请求里，system prompt、工具定义、历史消息这三段与上一次请求
逐字节相同——正是服务端缓存里的前缀；只有尾部那段指令是新的。

这里有个容易忽略的细节：检查请求的尾部还会先接上"上一次请求最后生成的那条回复"。服务端刚刚生成过它，
KV 里就有；不接上，token 序列会在那里岔开，缓存同样命中不了。

因为"逐字节相同"是这套做法的前提，扩展会**自己校验**这次请求与上一次请求的公共前缀是否一致，
不一致就按失败处理（宁可报错，也不静默退回原生摘要）。

实现层面的取舍（工具定义如何做到逐字节一致、哪些请求级参数会写回、缓存命中的块对齐、
完整失败矩阵）见 [`docs/design.md`](docs/design.md)。

## 与原生压缩的对比（实测）

设备与口径：**2× Tesla V100-SXM2-16GB**（张量并行）上的 llama.cpp 服务端（Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp，
`-c 350208 --parallel 2 --kv-unified`，q8_0 KV，MTP draft n=3）。样本是一段**真实的编码会话**
（有效上下文 ~180K token，内含 48 条带工具调用的消息），两种实现跑**同一份会话副本**，串行、服务端空闲。

| 压缩一次（~180K 上下文） | pi 原生 | **pi-vcc-plus** |
|---|---|---|
| 压缩耗时 | 508 s | **196 s（快 2.6 倍）** |
| 其中 prefill | 112,166 token → 244.0 s | **3,584 token → 15.9 s**（缓存命中 184,940 token，占上下文的 98%） |
| 其中生成 | 8,836 token → 181.8 s | 6,494 token → 178.9 s |
| 摘要规模 | 30,886 字符 | 9,774 字符 |
| 压缩后加载新上下文 | 44.3 s | 28.4 s |

原生的摘要请求必须换 system prompt、重排正文、去掉工具定义——第一个 token 就不同，于是**整个前缀作废**：
实测它每次都要重新计算 **112,166** 个 token。pi-vcc-plus 的检查请求是上一次请求的严格延续，
前缀逐字节相同，服务端直接复用，只需计算草稿与尾部指令那几个 token。

生成侧两者相当：真实会话里机械草稿已经足够完整（实测草稿 7,833 字符，模型最终只改了 10 个字符），
模型不需要"从头写摘要"。

怎么测的、逐样本数据、prefill 速率的分布、思考量与摘要的拆分、提示词版本的对比：
[`docs/vcc-vs-native-notes.md`](docs/vcc-vs-native-notes.md)。

## 支的后端接口

整套做法的地基是**逐字节复用上一次请求的前缀**，而这靠的是改写请求体（原始 wire tools 写回去、
捕获的请求级参数回放）。改写需要一个能接受自定义 `fetch`、且请求体是可解析 JSON 的适配器。

| pi adapter | 支持 |
|---|---|
| `openai-completions`（标准 OpenAI `/v1/chat/completions`） | ✅ 主要目标。本地服务（llama.cpp server / vLLM / SGLang / FastLLM / TGI / Ollama）都走这个接口 |
| `anthropic-messages` | ✅ 其 `input_schema` 能逐字节重建 |
| `google-generative-ai` / `google-vertex` / `bedrock-converse-stream` / 自定义 adapter | ❌ |

不支持的**不静默降级**：检查请求一旦前缀悄悄分叉，就会白付一次全量 prefill，而表象只是"缓存没命中"。
所以一律 fail closed，并把真正的原因写进报错——比如 Google 的 `functionDeclarations`、Bedrock 的
`toolSpec`、grammar 工具（没有任何 JSON schema 可传）、无法识别的形状，都会指名道姓地说出来。

注意 `strict` / `defer_loading` **不在此列**：pi-ai 只要 `compat.supportsStrictMode !== false`
（默认值）就会给每个工具带上 `strict`，若把它当成"无法重建"，等于在几乎所有 OpenAI 兼容后端上都拒绝压缩。
它们之所以安全，是因为出站 body 的 `tools` 被**原始 wire tools 整体替换**——重建只需要给适配器一份
可用的工具定义（名字 + JSON schema）。这些仅靠回注才保住的字段会记在 `round.toolsOnlyByWriteback`，
一旦回注真没生效，`checkPrefix` 的 `identical=false` / `fetchCalled=false` 会如实报出来。

## 安装

```powershell
# 0) 安装依赖（submodule 里的 recall 工具 import typebox，从仓库根解析）
npm install        # lockfile 已提交；bun install 亦可（测试用 bun 跑）

# 1) 安装扩展本身（本地路径不会被复制，改代码后 /reload 即可生效）
git clone https://github.com/113636xfh/pi-vcc-plus.git
pi install ./pi-vcc-plus

# 2) 让 pi 能加载上游 VCC：三条路任选其一（见下）
```

扩展按以下顺序解析上游 pi-vcc（都用它**发布出来的源码**，我们不改它一行）：

1. `config.vccPackagePath`（显式指定）
2. 环境变量 `PI_VCC_PLUS_VCC_PATH`
3. **仓库内** `third_party/pi-vcc`（推荐：git submodule）
4. `~/.pi/agent/npm/node_modules/@sting8k/pi-vcc`（`pi install npm:@sting8k/pi-vcc` 装的位置）
5. `<cwd>/.pi/npm/node_modules/@sting8k/pi-vcc`

## 配置

`~/.pi/agent/vcc-plus/config.json`（首次运行自动生成）：

```json
{
  "enabled": true,
  "vccPackagePath": null,
  "checkModel": null,
  "draftBudget": { "floorTokens": 1100, "ceilingTokens": 2000, "tokensPerBlock": 15 },
  "guards": {
    "maxRounds": 1,
    "emptyRetries": 1,
    "maxConsecutiveFails": 4,
    "maxDraftReads": 3,
    "maxRequestRetries": 3,
    "callTimeoutMs": 0,
    "thinkingCapChars": 8000,
    "requireDone": false
  },
  "onFailure": "auto",
  "fallbackToNative": true,
  "upstreamRecallTool": true,
  "alignCheckParams": true,
  "onContextOverflow": "trim",
  "debugLog": true,
  "debugTrace": false,
  "systemBlock": "<pi-vcc-plus>…</pi-vcc-plus>"
}
```

- `enabled`：关掉即完全交回 pi 原生压缩。
- `checkModel`：默认 `null`，即补充轮用会话当前模型；也可指定另一个模型（`{ "provider": …, "id": … }`）。
- `draftBudget`：草稿规模的调节参数（下限、上限、每块 token），一般不用改。
- `guards`：失败保护，全是**计数**而不是时间（慢模型不会被时间掐断）：
  - `maxRounds`（默认 1）：补充轮上限。默认"补一次就结束"；设成更大的数就是"多轮编辑直到模型显式完成"。
  - `emptyRetries`（默认 1）：某一轮模型完全没有调用工具时，追加一句提醒再问一次（否则会拿未修改的草稿当摘要）。
  - `maxConsecutiveFails`（默认 4）：连续多少次编辑被拒就放弃本次压缩。
  - `maxDraftReads`（默认 3）：模型查看草稿全文的次数上限。
  - `maxRequestRetries`（默认 3）：检查请求遇到**瞬时**故障（断连、超时、429、5xx）时重发几次，
    退避 1s / 2s / 4s（带抖动）。它和 `maxRounds` 是两回事：重发不算一轮，`rounds` 仍只数模型
    真正产出的响应。只有被判定为瞬时的错误才重发；400 / 401 / 413、上下文超限，以及任何
    认不出来的报错仍然第一次就 fail-closed。
  - `callTimeoutMs`（默认 0）：单次模型调用的时间上限，0 = 不限。
  - `thinkingCapChars`（默认 8000）：补充轮里模型**思维链**字符数的硬上限。达到即中止流（强制截断），
    并把模型在思维里已经写好的 `[Section]` 块抽出来、并入草稿作补充。0 = 不限。
    这是 **provider 无关的流级 abort**，对所有模型是同一套标准——不是调低思考级别，也不是逐模型配置。
    背景：`alignCheckParams` 让检查请求继承会话的思考设置，快推理模型可能花数分钟在思维里把整份摘要
    打好草稿（实测 49,370 字 / 1101s，实际只提交 0.4k 字）。我们无法让模型思考到一半停下再继续写，
    但可以在到达上限时切断流、保留它已想的——欠提交的各节因此被找回，而不是丢在 18 分钟的等待里。
    调大可让重度超想模型在被切断前走到它的最终草稿；调小则时间上界更紧。
    提示词会把这个上限明确告知模型（超限即中止流，其后的工具调用全部作废），并要求它把各节的
    最终条目先在思维里按 `[Section]` 写好再提交——被切断时这些行仍会被收割。收割认得带编号或
    带尾注的节头（`1. [Results]:`、`- [Key Decisions] — …:`），跳过计划条目（`[X] (add specifics)`）
    与自言自语；定稿时同样剔除这类残留行与括号未闭合的半句——草稿会原样带上一次压缩的摘要，
    残留不能只靠本轮模型清理，否则上一轮漏进摘要的行会永久流传。
  - `requireDone`（默认 false）：true 时要求模型显式调用 `vcc_done` 才算完成，纯文本收尾视为失败。
- `onFailure`：失败时怎么办——`auto`（默认）、`cancel`、`throw`、`draft`（直接用未经校验的草稿定稿）。
  仅在 `fallbackToNative: false` 时才会走到这一步。
- `fallbackToNative`：`true`（默认）= 除**用户主动取消**以外的任何失败，都返回 `undefined` 交回 pi 走它
  自己的压缩，并弹一条 warning 说明原因。一次网关抖动只该让这次压缩丢掉前缀复用，不该赔上整段会话。
  `false` = 改回 fail-closed（手动 `/compact` 报错、自动压缩取消）。详见下一节。
- `upstreamRecallTool`：是否注册上游自带的只读检索工具 `vcc_recall`（默认开；补充轮内它会被拒绝）。
- `alignCheckParams`：是否让检查请求沿用上一次请求的请求级参数。默认开——有些服务端的模板渲染或缓存键
  与这些参数相关，改动它们会让前缀命中不了。代价是补充轮会继承会话的思考设置（更慢）；
  如果你的服务端前缀缓存只看 prompt token，可以关掉以省掉这部分思考时间。
  判断方法与实测对照见 [`docs/vcc-vs-native-notes.md`](docs/vcc-vs-native-notes.md)。
- `onContextOverflow`：检查请求本身超出服务端上下文窗口时怎么办——`trim`（默认，用服务端报出的真实数字
  反推字符/token 比，保留能装下的最新一段重试一次）、`draft`（不重试，直接用草稿定稿）、
  `fail`（按 `onFailure` 处理）。pi 的上下文估算对中文偏保守，压缩有时会触发得偏晚，这一项决定"差一点装不下"时的处置。
- `debugLog`：写会话日志（见下）。
- `debugTrace`：调试开关。`false`（默认）时压缩框展开后是 24 行以内的预览，思维链只计数不显示。
  `true` 时展开即为全量——完整思维链、不截断的工具参数、连草稿原文都在，并额外写一份
  `<会话 ID>.trace.md`（终端会滚屏，文件不会）。查完记得改回 `false`。
- `systemBlock`：注入系统提示词的那段说明；改它等于改变前缀，需要 `/reload`。

配置只在扩展加载时读一次，改完 `config.json` 请 `/reload`。

## 失败了会退回原生压缩吗

**会，除非是你自己取消的。** 判断按优先级从上往下走，第一个命中的生效：

![失败处理](docs/images/03-failclosed.png)

| 顺序 | 条件 | 结果 | 默认？ |
| --- | --- | --- | --- |
| 0 | **用户主动取消**（Esc） | 本次压缩取消，上下文原样保留。**不重试、不降级** | — |
| 1 | 错误被判定为**瞬时**（断连 / 超时 / 429 / 5xx） | 原地重发，退避 1s/2s/4s，最多 `maxRequestRetries` 次 | ✅ 默认开 |
| 2 | `onFailure: "draft"` | 用**未校验的机械草稿**定稿 | ❌ |
| 3 | `fallbackToNative: true` | 返回 `undefined`，**交回 pi 走它自己的压缩**，并弹 warning | ✅ 默认 |
| 4 | `fallbackToNative: false` + `onFailure: "auto"` | 手动 `/compact` → **报错**；自动压缩（上下文将满）→ **取消** | ❌ |
| 4 | `fallbackToNative: false` + `"cancel"` / `"throw"` | 分别固定为取消 / 报错 | ❌ |

三个要点：

- **用户取消是最高优先级，且在所有降级之前。** 用户按了 Esc，扩展就停下：既不重试，也不去跑 pi 的
  压缩——那等于把用户刚叫停的压缩又执行了一遍，而他不会知道发生过。
- **第 3 档会弹一条 warning**，内容包含失败原因（`vcc-plus: … — falling back to pi's native compaction`）。
  这不是静默降级：这次摘要确实没走检查流程，前缀复用也没生效，日志里另有 `fallback_native` 事件。
- **想要 fail-closed**，把 `fallbackToNative` 设成 `false`。那时手动 `/compact` 依旧会抛错——
  扩展宁可让这次压缩失败，也不让一份没校验的摘要在无声无息中成为定稿。

## 日志与自查

开启 `debugLog` 后，每次压缩都会往 `~/.pi/agent/vcc-plus/log/<会话 ID>.jsonl` 追加记录。想确认
"前缀复用是否真的成立"，看两行就够：

- `checkPrefix`：`identical` 应为 true——检查请求与上一次真实请求的公共前缀逐字节一致；
- `round`：`cacheRead` 应接近上下文长度（同一行的 `prefixSuspect`（前缀可疑标记）为 false）——这表示服务端确实命中了缓存，
  只计算了新增的那几个 token。命中按**块**对齐（vLLM 16 token 一块、FastLLM 2048 token 一块），
  与上下文长度差一块以内属于正常。

其余字段（`draft`、`tool`、`summary_final`、`finalize`、`snapshot_restored` / `snapshot_rebuilt`、
`fail_closed`）的含义，以及每种失败情形下的具体行为，见 [`docs/design.md`](docs/design.md)。

## 测试

```powershell
bun run typecheck                            # tsc --noEmit（strict）
bun test test/                              # 编辑规则单测 + 校验循环回归 + recall 加载
bun run test/draft-smoke.ts <session.jsonl>  # 用真实会话离线生成草稿（不调模型）
node scripts/e2e-rpc-compact-test.mjs        # RPC E2E：种子短会话 → 三轮 → /compact
node scripts/e2e-rpc-compact-resume.mjs      # 恢复压缩后的会话 → 提问 → 第二次 /compact
node scripts/log-rounds.mjs [sessionId]      # 读会话日志，打出每轮缓存命中/前缀校验表
```

> 这些命令需要 devDependencies（`typescript`、`@earendil-works/pi-coding-agent@0.87.0` 等）：
> `npm install` 或 `bun install` 装一次即可。
> 仓库路径含 `&` 时 Windows 的 `.bin` shim 会解析失败，改用
> `node node_modules/typescript/lib/tsc.js -p tsconfig.json`。

## 目录结构

```
index.ts                 pi 扩展入口（系统提示词块 + 四个工具 + 快照 + 压缩接管）
src/
  config.ts              配置与系统提示词块（英文常量）
  prompt.ts              尾部指令 / 编辑回执 / 错误文案（英文）
  patch.ts               编辑应用与校验（纯逻辑，有单测）
  engine.ts              快照 / 草稿 / 补充轮 / 失败处理
  check-ui.ts            检查阶段的实时视图（流式渲染，用压缩摘要那套颜色）
  vcc.ts                 加载上游 pi-vcc（不复制、不改写）
  log.ts                 ~/.pi/agent/vcc-plus/log/<会话 ID>.jsonl
test/                    单测、回归与 recall 加载
docs/
  design.md              详细设计（不变量、决策表、模型可见文本、日志字段）
  vcc-vs-native-notes.md 实测对比与原始数据
  src/*.svg              插图源码（手工布局，可编辑）
  images/*.png           渲染产物（已提交，GitHub 可直接引用）
  render.mjs / verify.mjs / probe-pixels.mjs   渲染与验证脚本
scripts/                 E2E 与维护脚本
third_party/pi-vcc/      上游 pi-vcc（git submodule，锁定版本）
```

## License

MIT — 见 [LICENSE](LICENSE)
