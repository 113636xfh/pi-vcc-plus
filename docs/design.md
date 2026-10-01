# pi-vcc-plus 设计说明

## 三条不变量

1. **前文不改**：检查请求 = 上一次真实请求的快照（system + tools + messages 原文）+ 上一次请求关尾的那条 assistant 回复 + 尾部追加，
   且请求级参数（`chat_template_kwargs`、`max_tokens`、`store`、采样参数……）沿用上一次请求的值；
   合起来才是“与上一次请求严格连续”的请求体，服务端才肯按前缀命中。
   `round.prefixSuspect` 是对这条不变量的运行时断言（前缀逐字节相同但参数/渲染不同 → 仍然 miss）。
2. **草稿由算法产出，模型只做增删改**：结构、文件清单、长度由 VCC 保证；模型按节名 `vcc_add` 修正
   （`"replace":true` 重写该节）。
3. **不新增并发**：不起后台 worker、不发独立摘要请求；所有模型调用都在当前会话内顺序发生。

![检查请求的构成](images/02-request.png)

## 为什么这么切

| 决策 | 原因 |
|---|---|
| 用 `session_before_compact` 接管，而不是新造触发 | pi 的触发点天然位于"工具批次结束 / 下一次 assistant 请求之前"，正是安全截断点；手动 `/compact` 沿用 pi 自己的 abort |
| 指令只加在**尾部**，system/tools 不动 | 原生的摘要请求换 system prompt + 重排正文 + 去掉 tools，token 0 就变了 → 必然 miss |
| tools 只从 `before_provider_request` 的 payload 取 | 事件 ctx 不暴露 `getAllTools` / `getSystemPromptOptions`，registry 顺序 ≠ 线上顺序；payload 是上一次请求自己的 wire tools，唯一逐字节等价来源。校验请求经**自定义 fetch** 发出：出站 body 的 `tools` 被替换为捕获到的**原始 wire tools**（构造性字节一致，pi-ai 的重建永远不上 wire）。`toolsRoundTripStatus` 保留为三保险：wire tools 里**没有任何可还原 JSON schema** 的形状（grammar/custom 工具、Google `functionDeclarations`、Bedrock `toolSpec`、未知形状）时检查 fail-closed。`strict` / `defer_loading` 这类**附加在可读 schema 上的 provider 字段不算失败**——重建只需给出名字 + schema，字节由原始 wire tools 回注保证（pi-ai 默认会给每个工具加 `strict`，若据此 fail-closed 等于在几乎所有 OpenAI 兼容后端上拒绝压缩）；这些字段记在 `round.toolsOnlyByWriteback`，回注真失效时由 `checkPrefix` 的 `identical=false` / `fetchCalled=false` 报出 |
| 拼上“上一次请求关尾的那条 assistant 回复”（`snapshotContinuationAssistant`） | 服务端 slot 里存的是“上一次请求的 prompt + 它生成的回复”。检查请求缺了这条回复，token 流就在快照结尾处与 slot 序列分叉——实测 FastLLM prefix cache 直接给 0 命中、全量重 prefill（~204K token / 10 分钟）。补上它，两者关系与正常轮次之间完全一致（会话里已有该条目，序列化走同一条 pi-ai 通路）；若快照里已有同内容 assistant（生成被中断等），不重复拼 |
| 请求级参数也沿用上一次请求 | `chat_template_kwargs` 参与**服务端 chat 模板渲染**：agent 轮次 `enable_thinking: true`，`complete()` 发出的检查请求默认 `false`，同一段历史渲染出的 token 就不同（实测 2.9K 的 prompt 差 36 token）→ 前缀再逐字节相同也命不中；另外部分服务端（实测 FastLLM）把 `max_tokens` 也算进缓存键。自定义 fetch 在替换 tools 之外，把捕获到的请求级参数（除 `model`/`messages`/`tools`）写回出站 body |
| 检查用"打补丁"而不是"重写摘要" | 模型无法破坏 VCC 的结构；`vcc_add` 只给节名 + 增量行，模型不需要复述大段原文；模型没碰的章节按构造原样保留 |
| 只用 `vcc_add` / `vcc_draft` / `vcc_done` | 校验阶段给模型一个封闭的动作空间；`vcc_draft` 仅在回执不足以判断时使用；一次响应 = 一次补充轮，应用后结束。`vcc_delete` 已移除：71 次压缩实测 46 次调用失败 12 次（模型数不准行号），而它的唯一用途（删掉一条错的机械行）由 `vcc_add replace:true` 覆盖；已注册的 49% 老调用会收到改道提示而不是通用报错 |
| 上限用 `min(0.8 × reserveTokens, model.maxTokens)` | 与 pi 原生摘要完全相同的预算公式；写进提示词，并由 P4 校验（同一个取值来源） |
| 护栏只用计数（轮次/失败次数/draft 读取次数） | 慢模型单次调用几十秒很正常，用时间判断会误杀 |
| 校验请求的字节级复核（B 面，自验证） | 校验请求走 `ModelRegistry.complete` → `runtime.complete`，**不经过** Agent 的 `onPayload`，哨兵看不到它；所以 pi-vcc-plus 自己的 fetch 拦截：tools 原样替换 + 首次出站 body 与上一次真实请求的 wire body 前缀比较（基线要求 `ts ≥ 快照时刻`、取较新者、平手优先哨兵，旧残留不会误报），结果写 `checkPrefix` 日志、完整 body 写 `.pi/prefix-sentinel/check-request.json`；第 1 轮必有一行 `checkPrefix`，验不到也是可见状态（`identical: null` + `reason`） |
| 失败 fail-closed（不静默回退原生） | 静默回退会让“前缀复用”这个核心目标失效，而且用户无法察觉 |
| 提示词全英文 | 与 pi 原生提示词同语言；避免中英混排造成的模板/缓存差异 |

## 模型可见文本（三处，互不重复）

| 位置 | 内容 | 代码 |
|---|---|---|
| 系统提示词块（常量，会话开始即固定） | 流程是什么、什么叫"压缩校验阶段"、三个工具的定位 | `src/config.ts` `SYSTEM_BLOCK` |
| 工具 description | 什么时候能用、用法同 edit | `src/prompt.ts` `DESC_*` + `index.ts` |
| 压缩时注入的尾部消息 | 草稿、预算、重点补什么、行为约束 | `src/prompt.ts` `buildTailInstruction()` |
| 工具回执与错误 | 完整 diff 回执、行号/节名校验错误 | `src/prompt.ts` `buildDiffReceipt()` / `ERR_*` |

尾部指令里"重点补什么"那五条不是拍脑袋，来自实测（见 `docs/vcc-vs-native-notes.md`）：
VCC 的 brief 强于文件/命令/最近对话，最容易丢约束、决策理由、环境细节、未完成项与失败事实。

## 编辑规则与护栏

| # | 规则 | 失败处理 |
|---|---|---|
| D1 | `vcc_delete` 已下线 | 收到 `ERR_VCC_DELETE_REDIRECT`：改用 `vcc_add` 的 `"replace": true` 重写该节 |
| A1 | `vcc_add` 的 `lines` 非空；节名按 `finalizeSummary` 的同一套路由解析（别名归一到规范节），缺失的节在章节区末尾新建 | 空行/空节名报错；新建位置固定在转录区**之前** |
| A2 | `replace:true` 先清空该节的 bullet（标题保留），再追加 | 与 A1 同一套原子应用 |
| P4 | 应用后总长 ≤ 上限（按**剥离后**的正文计） | 提示超限并重做 |

护栏：轮次 ≤ 8、连续失败 ≤ 4、`vcc_draft` ≤ 3、同一签名连续失败 2 次给提示；
用户中断立即停止；`callTimeoutMs > 0` 时才启用单轮超时（默认 0）。

fail-closed 的边界（全部在 `src/engine.ts`）：

| 触发 | 行为 |
|---|---|
| 单轮响应 `stopReason` 为 `error` / `aborted` / `length` / `deferred`，或带 `errorMessage` | 抛错走失败策略——pi-ai 对 API 错误/中止是 **resolve** 返回该 AssistantMessage（不 reject），不检查就会把未校验草稿当定稿 |
| 快照里没有 tools（payload 拿不到） | 抛错——没有 tools 的检查请求既无法复用前缀，模型也看不到 `vcc_*` |
| 快照 `toolsRoundTrip` 为 `mismatch`（wire tools 含 grammar/custom 形状、Google `functionDeclarations`、Bedrock `toolSpec` 或未知形状） | 抛错——这些形状**没有任何可交给适配器的 JSON schema**，降级 tools 必然破坏前缀 |
| `recordContext` 构建快照失败 | 快照置 null，下个 compaction 走失败策略——旧快照会静默破坏前缀不变量 |
| 没有内存快照（`/reload` / 新进程 / 新项目） | 先读同会话的持久化快照（`restoreSnapshot`，同会话+完整+非 mismatch）；没读到则 `rebuildSnapshotFromSession` 从会话自身重建（messages 取 `buildSessionProjection()` → `convertToLlm` → blockImages，system 取 `ctx.getSystemPrompt()`，tools 取 `pi.getAllTools()` 的活跃项），记 `snapshot_rebuilt`（带 `restoreMiss` 说明**为什么**没恢复到——无文件 / 属于别的会话 / 文件不完整 / 文件损坏 / 拿不到 sessionId，各有不同的修法）；tools 拿不到或会话为空才抛错（没有 tools 模型无法调 `vcc_add` / `vcc_done`） |
| 还没有任何快照且会话也重建不出（空会话 / ctx 未暴露 projection / 无 tools） | 走失败策略——单条消息请求没有 system/tools，前缀复用直接作废 |
| 这一轮完全没有编辑（只有文本/思考） | `guards.emptyRetries: 1` 时追加一句纠偏再问一次；预算用尽则接受未改动的草稿（状态安全，但摘要等于机械草稿） |
| 响应撞上 completion 上限（`stopReason=length`） | 已解析出的工具调用照常应用并结束这一轮（`round_truncated`）；一个可用调用都没有才算失败 |
| 模型全程没调 `vcc_done` | 单轮形态下这是预期的结束状态（不警告）；`guards.maxRounds > 1` 的多轮形态下警告 + 接受当前草稿；`guards.requireDone: true` 时升级为失败 |
| 空补丁列表 | 同样过预算检查（不放过已超限的草稿） |
| 检查请求超出 provider 上下文窗口（`onContextOverflow: "trim"`） | 用 provider 的真实数字反推 chars/token（pi 的 `chars/4` 估算在中文内容上偏乐观 ~1.8×，实测 178,397 vs 322,385），丢掉最旧的快照消息使请求装得下，记 `check_trimmed`，重试一次；重试仍超窗 → `draftFallback`（记 `overflow_fallback`，UI 警告）；`"draft"` 直接走草稿，`"fail"` 不做特殊处置 |
| 模型删到章节标题 / 转录区行号 | 拒绝并给原因（标题是结构；转录区只读、只当原料） |

手动 `/compact <instructions>` 的 `customInstructions` 会拼进尾部指令（只影响前缀之后的内容，不影响缓存）。

## 定稿：机械剥离（`src/finalize.ts`）

上游 VCC 的草稿为“人读”而建：`[章节]` 块 + `---` + **逐轮转录** + `---` + `RECALL_NOTE`，
且 `mergePrevious({preserveFreshBriefOnMerge:true})` 会把上一份草稿的转录合并进新草稿（跨压缩累积）。
这段转录如果原样进下一次窗口，就会与 pi 保留的尾部叠在一起，看起来像“后几轮消息被追加到摘要后面”，
并带着 `[user]`/`[assistant]` 与 `(#123)` 噪声。

所以定稿前做一次**确定性**剥离（不靠模型配合，模型只负责把转录里的内容折进章节）：

| 步骤 | 规则 |
|---|---|
| 去噪 | 丢转录块（首行 `[user]`/`[assistant]`/`[tool]`，或过半行带 `(#N)`）、`---` 块、`RECALL_NOTE`（含被 wrap 后的多行形式）、`...(N earlier lines omitted)` |
| 转录模式 | 一旦进入转录区，后续无标题块也归转录（转录取自 assistant 消息，里面会带 `## 标题` 与正文），直到再出现 `[章节]` 为止 |
| 归一 | 固定 8 节与固定顺序：`[Session Goal]`/`[Files And Changes]`/`[Commits]`/`[Key Decisions]`/`[Environment]`/`[Results]`/`[Outstanding Context]`/`[User Preferences]`；别名改名，自造标题按关键词并入（内容不丢） |
| 保底 | 只删转录/分隔/提示行；章节 bullet 永不删；同节完全重复行去重；无章节形状时原文返回（绝不返回空摘要） |

`## 标题` 只在名字命中已知章节名（`Goal`、`Key Decisions`…）时算章节边界——否则它就是转录引用的
assistant 正文。每次剥离写一行 `finalize` 日志（`stripped*` / `renamed` / `folded` / `charsBefore→charsAfter`）。

## 目录与职责

- `index.ts`：注册系统块、三个工具、`context` / `before_provider_request` 快照钩子、压缩接管，
  并向引擎注入 `setToolProvider`（冷启动重建快照时用 `pi.getActiveTools()` ∩ `pi.getAllTools()`）。
  配置只在加载时读一次（改 `config.json` 需 `/reload`）——中途变更会改变系统块、破坏前缀不变量。
- `src/vcc.ts`：解析并加载**上游** pi-vcc（仓库内 submodule → 显式路径 → 环境变量 → npm 安装位置），
  并记录加载到的版本与路径到日志（`vcc_loaded`）。我们从不修改它。
- `src/engine.ts`：快照、草稿、校验循环、失败策略。
- `src/patch.ts`：`vcc_add`（节名）与 diff 回执渲染（无 pi 依赖，可单测）。
- `src/pi-settings.ts`：读 pi 自己的设置（`images.blockImages`，项目 `.pi/settings.json` 覆盖全局），
  让快照与 pi 的 `convertToLlmWithBlockImages` 逐字节一致。
- `src/check-ui.ts`：检查阶段的**实时视图**。检查请求走 `modelRegistry.stream()` 而不是
  `complete()`（pi-ai 的 `complete` 就是 `stream().result()`，所以拿到的消息完全一样），
  增量边到边渲染。

## 检查阶段的实时视图

以前检查请求是一次不透明的 `complete()`：本地模型跑几分钟，屏幕上什么都不出，用户只能等。
现在这一轮是流式的，界面上有一个框跟着输出走。

- **形态**：工具调用框的样子（粗体 `[vcc_check]` + 一行灰色状态），但用**压缩摘要那套颜色**
  （`customMessageBg` / `customMessageLabel` / `customMessageText`，即原生 `[compaction]` 框用的三个），
  所以它读起来属于压缩流程，而不是一个不相干的工具。
- **位置**：`ctx.ui.setWidget` 挂在编辑上方，阶段结束即卸载。压缩完成后由 pi 自己把
  `[compaction]` 摘要框渲染进对话区——所以既不留残留，也不往 session 里写条目。
- **展开**：点一下（或以会话当前的工具展开状态为准）。展开后上半是机械草稿（模型看到的那份，
  静态参考），下半是模型正在追加的内容：`vcc_add` 的参数边流边解析，
  JSON 还没成形时显示原始尾巴。**thinking 只计数、不显示**——本地模型的思考量能到五位数字符，
  全量刷屏会把真正重要的补充内容埋掉。
- **有界**：展开区最多 24 行正文。草稿超长会显式标注省略了多少行，不会静默截断；
  正在增长的新增内容优先占空间。
- **降级**：TUI 走组件；RPC 只接受字符串数组，于是同样内容以纯文本行渲染；没有 `setWidget`
  的模式（print）直接不显示，交给 `notify` 与日志。
- **不动前缀**：流式只影响"什么时候把增量交给视图"，出站 body 与之前逐字节一致。


## 支持的后端接口（硬约束）

检查请求靠**改写请求体**（原始 wire tools 写回、捕获的请求级参数回放）来逐字节复用上一次请求的前缀。
改写需要一个能接受自定义 `fetch`、且 body 是可解析 JSON 的适配器，因此契约是：

- `openai-completions`（标准 OpenAI `/v1/chat/completions`）——主要目标；本地服务
  （llama.cpp server / vLLM / SGLang / FastLLM / TGI / Ollama）都走这个接口；
- `anthropic-messages`——其 `input_schema` 能逐字节重建。

其余（Google Generative AI / Vertex、Bedrock Converse、自定义 adapter）一律 **fail closed**。
理由是：前缀悄悄分叉的检查请求会白付一次全量 prefill，而表象只是"缓存没命中"，用户无从判断。
报错会指名真实原因（`functionDeclarations` / `toolSpec` / grammar / 无法识别的形状），
不再只说 "unknown shape"。`toolsRoundTripStatus` 仍是权威判据（基于实际 wire 形状），
`unsupportedApiReason` 只负责把消息说清楚。

## 失败处理

![失败处理](images/03-failclosed.png)

`fail()` 按优先级从上往下走，第一个命中的生效：

| 顺序 | 条件 | 行为 | 默认 |
|---|---|---|---|
| 0 | `userAborted`（`event.signal.aborted`，即用户按 Esc） | 返回 `{ cancel: true }`，**不重试、不降级**；记 `fail_cancelled_by_user` | — |
| 1 | `transientCheckFailure(response)` 命中 | 原地重发，退避 `retryBackoffMs(attempt)`（1s/2s/4s，带抖动，上限 15s），最多 `guards.maxRequestRetries` 次；每次重发前 `view.reset()` + trace note | ✅ 3 次 |
| 2 | `onFailure: "draft"` | `draftFallback()` 用未校验草稿定稿 | ❌ |
| 3 | `fallbackToNative: true` | `notify(..., "warning")` + 返回 `undefined`，交回 pi 原生压缩；记 `fallback_native` | ✅ |
| 4 | `fallbackToNative: false` + `onFailure: "auto"` | 手动 `/compact` → 抛错；自动压缩 → `{ cancel: true }` + 通知 | ❌ |
| 4 | `fallbackToNative: false` + `"cancel"` / `"throw"` | 分别固定为取消 / 抛错 | ❌ |

第 0 档的取消判定读的是 `event.signal`（pi 在用户取消时 abort 它），**不是** `callTimeoutMs`
——后者 abort 的是每次尝试自己的 controller，那是超时，属于真错误，应该走降级。

第 1 档的分类（`transientCheckFailure`）**永久性优先**：400/401/403/404/405/413/414/422、
`MissingSessionID`、上下文超限类一律不重试；再认瞬时错误（断连、`terminated`、`ECONNRESET`、
超时、429、5xx、529、overloaded 等）。**认不出来的不重试**，仍然往下走降级——往重试方向猜错
只多花一次请求，往另一个方向猜错会拿一个坏草稿静默压缩。重发不消耗 `maxRounds`。

| 触发 | 例子 | 行为 |
|---|---|---|
| 快照缺失 | 全新会话还没发生过 provider 请求（`/reload` 后先尝试恢复持久化快照；仅全新会话需先发一条消息） | 先恢复 / 重建（`snapshot_rebuilt` / `snapshot_restored`）；三条都拿不到才失败 |
| tools 不可用/不一致 | 拿不到 wire tools；wire tools 含无可还原 schema 的形状（grammar/custom、Google、Bedrock） | 抛错——没有可交给适配器的 schema，宁可失败也不用降级 tools 破坏前缀 |
| 编辑被拒 | 追加超出预算；连续失败超限 | 回执里带原因，模型可以改；连续失败到 `maxConsecutiveFails` 就放弃本次压缩 |
| 模型异常 | API 错误、中止、纯文本收尾但 `requireDone: true`、轮次或草稿读取超限 | 先过重试与取消判定，再走 `fail()` |
| 响应截断 | 撞上输出上限，但已解析出可用调用 | 应用这些调用并结束这一轮（`round_truncated`）；一个可用调用都没有才算失败 |
| 检查请求超窗 | 会话本身超出 provider 窗口（pi 的估算偏保守，触发偏晚） | 按 `onContextOverflow`：`trim` 裁剪重试 / `draft` 直接用草稿 / `fail` 走失败策略 |

**默认任何非人为取消的失败都降级到 pi 原生压缩**，并弹一条 warning（日志里另有 `fallback_native`）。
理由：一次网关抖动、一次前缀没保住，代价应该只是这次压缩少了前缀复用，而不是整段会话卡在装不下的
上下文里。降级是**有提示的**，不是静默的——摘要确实没走检查流程，扩展说出来了。

想要 fail-closed（扩展宁可让压缩失败，也不让未校验的摘要无声成为定稿）就把 `fallbackToNative`
设成 `false`；此时 `{ cancel: true }` 同样**不是**退回原生，而是本次压缩不发生、pi 按自己逻辑继续。

## 日志字段（`~/.pi/agent/vcc-plus/log/<sessionId>.jsonl`）

一行一个 JSON 事件，`debugLog: true` 时写入；纯追加，随时可以删掉重开。

| 事件 | 何时写 | 关键字段 |
|---|---|---|
| `vcc_loaded` | 加载扩展、解析到上游 pi-vcc | `version`、`path` |
| `compact_start` | 每次压缩开始 | `reason`（manual / auto）、`tokensBefore`、`firstKeptEntryId`、`guards`（本次生效的护栏值，可直接看出 config 是否被读到）、`configPath` |
| `draft` | 机械草稿生成 | `draftChars` / `draftTokens`、`spanMessages`、`charsPerToken`、`calibrated` |
| `continuation` | 检查请求尾部接上了上一次请求的最后一条回复 | `appended` |
| `checkPrefix` | 第 1 轮的字节级复核（每次压缩必有一行） | `identical`、`firstDivergence`、`baselineSource`、`baselineTs` |
| `round` | 每一轮补充请求返回 | `round`、`input`（本轮新增 prefill）、`cacheRead`（命中）、`output`、`expectedPrefixTokens`、`prefixSuspect`、`toolsSource`、`toolsRoundTrip`、`toolsCount` |
| `tool` | 每次编辑调用 | `name`、`ok` |
| `empty_round_retry` | 某轮完全没有工具调用，追加提醒重问一次 | `round`、`attempt` |
| `round_truncated` | 响应撞上输出上限，但已有可应用的调用 | `round`、`calls` |
| `single_round_end` | 单轮形态正常结束（默认） | `rounds`、`requireDone` |
| `loop_end_without_done` | 多轮形态（`maxRounds > 1`）模型没调 `vcc_done` 就停 | `rounds` |
| `summary_final` | 定稿完成 | `rounds`、`chars`、`tokens`、`usage` |
| `finalize` | 机械剥离 | `strippedTranscriptLines`、`strippedSeparators`、`strippedNotes`、`renamed`、`folded`、`charsBefore` / `charsAfter` |
| `snapshot_restored` / `snapshot_rebuilt` | 内存里没有快照，改从持久化快照 / 会话本身重建 | 看 `restoreMiss` 字段：恢复未命中会退回全量 prefill（`cacheRead` 掉到 0），且各原因修法不同，所以必须报出具体哪一条 |
| `check_trimmed` | 检查请求超窗，按服务端报出的真实数字裁剪后重试 | 裁剪报告 |
| `upstream_recall_registered` / `upstream_recall_failed` | 注册上游只读检索工具的结果 | — |
| `abort` / `fail_closed` / `fallback_native` | 失败路径 | `why`、`mode`、`message`、`error` |

日常只需两条：`checkPrefix.identical == true`，以及 `round.cacheRead ≈ round.expectedPrefixTokens`
（此时 `round.prefixSuspect` 为 false）。命中按**块**对齐（vLLM 16 token 一块、FastLLM 2048 token 一块，
其余后端各有各的块大小），与前缀长度差一块以内属正常，不足一块的尾部本来就要计算。
