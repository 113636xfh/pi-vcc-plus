# pi-vcc-plus 设计说明

## 三条不变量

1. **前文不改**：检查请求 = 上一次真实请求的快照（system + tools + messages 原文）+ 上一次请求关尾的那条 assistant 回复 + 尾部追加，
   且请求级参数（`chat_template_kwargs`、`max_tokens`、`store`、采样参数……）沿用上一次请求的值；
   合起来才是“与上一次请求严格连续”的请求体，服务端才肯按前缀命中。
   `round.prefixSuspect` 是对这条不变量的运行时断言（前缀逐字节相同但参数/渲染不同 → 仍然 miss）。
2. **草稿由算法产出，模型只做增删改**：结构、文件清单、长度由 VCC 保证；模型按行号 `vcc_delete`、按节名 `vcc_add` 修正。
3. **不新增并发**：不起后台 worker、不发独立摘要请求；所有模型调用都在当前会话内顺序发生。

## 为什么这么切

| 决策 | 原因 |
|---|---|
| 用 `session_before_compact` 接管，而不是新造触发 | pi 的触发点天然位于"工具批次结束 / 下一次 assistant 请求之前"，正是安全截断点；手动 `/compact` 沿用 pi 自己的 abort |
| 指令只加在**尾部**，system/tools 不动 | 原生的摘要请求换 system prompt + 重排正文 + 去掉 tools，token 0 就变了 → 必然 miss |
| tools 只从 `before_provider_request` 的 payload 取 | 事件 ctx 不暴露 `getAllTools` / `getSystemPromptOptions`，registry 顺序 ≠ 线上顺序；payload 是上一次请求自己的 wire tools，唯一逐字节等价来源。校验请求经**自定义 fetch** 发出：出站 body 的 `tools` 被替换为捕获到的**原始 wire tools**（构造性字节一致，pi-ai 的重建永远不上 wire）。`toolsRoundTripStatus` 保留为三保险：wire tools 含 grammar/custom、`strict: true`、`defer_loading` 或未知形状时检查 fail-closed |
| 拼上“上一次请求关尾的那条 assistant 回复”（`snapshotContinuationAssistant`） | 服务端 slot 里存的是“上一次请求的 prompt + 它生成的回复”。检查请求缺了这条回复，token 流就在快照结尾处与 slot 序列分叉——实测 FastLLM prefix cache 直接给 0 命中、全量重 prefill（~204K token / 10 分钟）。补上它，两者关系与正常轮次之间完全一致（会话里已有该条目，序列化走同一条 pi-ai 通路）；若快照里已有同内容 assistant（生成被中断等），不重复拼 |
| 请求级参数也沿用上一次请求 | `chat_template_kwargs` 参与**服务端 chat 模板渲染**：agent 轮次 `enable_thinking: true`，`complete()` 发出的检查请求默认 `false`，同一段历史渲染出的 token 就不同（实测 2.9K 的 prompt 差 36 token）→ 前缀再逐字节相同也命不中；另外部分服务端（实测 FastLLM）把 `max_tokens` 也算进缓存键。自定义 fetch 在替换 tools 之外，把捕获到的请求级参数（除 `model`/`messages`/`tools`）写回出站 body |
| 检查用"打补丁"而不是"重写摘要" | 模型无法破坏 VCC 的结构；失败可定位到行号；`vcc_delete` 只给行号、`vcc_add` 只给节名，都是廉价操作，模型不需要复述大段原文 |
| 只用 `vcc_delete` / `vcc_add` / `vcc_draft` / `vcc_done` | 校验阶段给模型一个封闭的动作空间；`vcc_draft` 仅在回执不足以判断时使用；一次响应 = 一次补充轮，应用后结束 |
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
| D1 | `vcc_delete` 的行号必须在章节区内（1..N）、不能指向区外（转录区不编号、只读）、不能是章节标题行、不能重复 | 返回带原因的错误（行号范围 / 读转录 / 标题 / 重复），模型就地重试 |
| D2 | 行号是**当次调用前**的编号；删除后后面的行号会前移 | 提示词要求重新用 `vcc_draft` 取号再删 |
| A1 | `vcc_add` 的 `lines` 非空；节名按 `finalizeSummary` 的同一套路由解析（别名归一到规范节），缺失的节在章节区末尾新建 | 空行/空节名报错；新建位置固定在转录区**之前** |
| A2 | `replace:true` 先清空该节的 bullet（标题保留），再追加 | 与 D1/A1 同一套原子应用 |
| P4 | 应用后总长 ≤ 上限（按**剥离后**的正文计） | 提示超限并重做 |

护栏：轮次 ≤ 8、连续失败 ≤ 4、`vcc_draft` ≤ 3、同一签名连续失败 2 次给提示；
用户中断立即停止；`callTimeoutMs > 0` 时才启用单轮超时（默认 0）。

fail-closed 的边界（全部在 `src/engine.ts`）：

| 触发 | 行为 |
|---|---|
| 单轮响应 `stopReason` 为 `error` / `aborted` / `length` / `deferred`，或带 `errorMessage` | 抛错走失败策略——pi-ai 对 API 错误/中止是 **resolve** 返回该 AssistantMessage（不 reject），不检查就会把未校验草稿当定稿 |
| 快照里没有 tools（payload 拿不到） | 抛错——没有 tools 的检查请求既无法复用前缀，模型也看不到 `vcc_*` |
| 快照 `toolsRoundTrip` 为 `mismatch`（wire tools 含 grammar/custom 形状、`strict: true`、`defer_loading` 或未知形状） | 抛错——这些形状来自 wire 不携带的 `constrainedSampling`/延迟加载状态，无法逐字节重建，宁可失败也不用降级 tools 破坏前缀 |
| `recordContext` 构建快照失败 | 快照置 null，下个 compaction 走失败策略——旧快照会静默破坏前缀不变量 |
| 没有内存快照（`/reload` / 新进程 / 新项目） | 先读同会话的持久化快照（`restoreSnapshot`，同会话+完整+非 mismatch）；没读到则 `rebuildSnapshotFromSession` 从会话自身重建（messages 取 `buildSessionProjection()` → `convertToLlm` → blockImages，system 取 `ctx.getSystemPrompt()`，tools 取 `pi.getAllTools()` 的活跃项），记 `snapshot_rebuilt`；tools 拿不到或会话为空才抛错（没有 tools 模型无法调 `vcc_delete` / `vcc_add`） |
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
- `src/patch.ts`：`vcc_delete`（行号）/ `vcc_add`（节名）与 diff 回执渲染（无 pi 依赖，可单测）。
- `src/pi-settings.ts`：读 pi 自己的设置（`images.blockImages`，项目 `.pi/settings.json` 覆盖全局），
  让快照与 pi 的 `convertToLlmWithBlockImages` 逐字节一致。
