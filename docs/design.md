# pi-vcc-plus 设计说明

## 三条不变量

1. **前文不改**：检查请求 = 上一次真实请求的快照（system + tools + messages 原文）+ 尾部追加，
   因此前缀逐字节相同，KV 前缀必然复用；`round.prefixSuspect` 是对这条不变量的运行时断言。
2. **草稿由算法产出，模型只做增删改**：结构、文件清单、长度由 VCC 保证；模型通过 `vcc_patch` 修正。
3. **不新增并发**：不起后台 worker、不发独立摘要请求；所有模型调用都在当前会话内顺序发生。

## 为什么这么切

| 决策 | 原因 |
|---|---|
| 用 `session_before_compact` 接管，而不是新造触发 | pi 的触发点天然位于"工具批次结束 / 下一次 assistant 请求之前"，正是安全截断点；手动 `/compact` 沿用 pi 自己的 abort |
| 指令只加在**尾部**，system/tools 不动 | 原生的摘要请求换 system prompt + 重排正文 + 去掉 tools，token 0 就变了 → 必然 miss |
| tools 只从 `before_provider_request` 的 payload 取 | 事件 ctx 不暴露 `getAllTools` / `getSystemPromptOptions`，registry 顺序 ≠ 线上顺序；payload 是上一次请求自己的 wire tools，唯一逐字节等价来源。校验请求经**自定义 fetch** 发出：出站 body 的 `tools` 被替换为捕获到的**原始 wire tools**（构造性字节一致，pi-ai 的重建永远不上 wire）。`toolsRoundTripStatus` 保留为三保险：wire tools 含 grammar/custom、`strict: true`、`defer_loading` 或未知形状时检查 fail-closed |
| 检查用"打补丁"而不是"重写摘要" | 模型无法破坏 VCC 的结构；失败可定位到行；`oldText` 唯一匹配的语义与原生 edit 一致，模型最熟练 |
| 只用 `vcc_patch` / `vcc_draft` / `vcc_done` | 校验阶段给模型一个封闭的动作空间；`vcc_draft` 仅在 diff 不足以判断时使用 |
| 上限用 `min(0.8 × reserveTokens, model.maxTokens)` | 与 pi 原生摘要完全相同的预算公式；写进提示词，并由 P4 校验（同一个取值来源） |
| 护栏只用计数（轮次/失败次数/draft 读取次数） | 慢模型单次调用几十秒很正常，用时间判断会误杀 |
| 校验请求的字节级复核（B 面，自验证） | 校验请求走 `ModelRegistry.complete` → `runtime.complete`，**不经过** Agent 的 `onPayload`，哨兵看不到它；所以 pi-vcc-plus 自己的 fetch 拦截：tools 原样替换 + 首次出站 body 与上一次真实请求的 wire body 前缀比较（基线优先哨兵 `last-request.json`，否则自捕获 `.pi/vcc-plus/last-wire-request.json`），结果写 `checkPrefix` 日志、完整 body 写 `.pi/prefix-sentinel/check-request.json` |
| 失败 fail-closed（不静默回退原生） | 静默回退会让“前缀复用”这个核心目标失效，而且用户无法察觉 |
| 提示词全英文 | 与 pi 原生提示词同语言；避免中英混排造成的模板/缓存差异 |

## 模型可见文本（三处，互不重复）

| 位置 | 内容 | 代码 |
|---|---|---|
| 系统提示词块（常量，会话开始即固定） | 流程是什么、什么叫"压缩校验阶段"、三个工具的定位 | `src/config.ts` `SYSTEM_BLOCK` |
| 工具 description | 什么时候能用、用法同 edit | `src/prompt.ts` `DESC_*` + `index.ts` |
| 压缩时注入的尾部消息 | 草稿、预算、重点补什么、行为约束 | `src/prompt.ts` `buildTailInstruction()` |
| 工具回执与错误 | 完整 diff 回执、P1–P4 错误 | `src/prompt.ts` `buildDiffReceipt()` / `ERR_*` |

尾部指令里"重点补什么"那五条不是拍脑袋，来自实测（见 `docs/vcc-vs-native-notes.md`）：
VCC 的 brief 强于文件/命令/最近对话，最容易丢约束、决策理由、环境细节、未完成项与失败事实。

## 校验规则（P1–P4）与护栏

| # | 规则 | 失败处理 |
|---|---|---|
| P1 | `oldText` 唯一精确匹配 | 返回 edit 风格错误，模型就地重试 |
| P2 | `oldText` 非空 | 同上 |
| P3 | 覆盖 section 名（`[...]`）时 `newText` 必须保留它 | 同上 |
| P4 | 应用后总长 ≤ 上限 | 提示超限并重做 |

护栏：轮次 ≤ 8、连续失败 ≤ 4、`vcc_draft` ≤ 3、同一 `oldText` 连续失败 2 次给提示；
用户中断立即停止；`callTimeoutMs > 0` 时才启用单轮超时（默认 0）。

fail-closed 的边界（全部在 `src/engine.ts`）：

| 触发 | 行为 |
|---|---|
| 单轮响应 `stopReason` 为 `error` / `aborted` / `length` / `deferred`，或带 `errorMessage` | 抛错走失败策略——pi-ai 对 API 错误/中止是 **resolve** 返回该 AssistantMessage（不 reject），不检查就会把未校验草稿当定稿 |
| 快照里没有 tools（payload 拿不到） | 抛错——没有 tools 的检查请求既无法复用前缀，模型也看不到 `vcc_*` |
| 快照 `toolsRoundTrip` 为 `mismatch`（wire tools 含 grammar/custom 形状、`strict: true`、`defer_loading` 或未知形状） | 抛错——这些形状来自 wire 不携带的 `constrainedSampling`/延迟加载状态，无法逐字节重建，宁可失败也不用降级 tools 破坏前缀 |
| `recordContext` 构建快照失败 | 快照置 null，下个 compaction 走失败策略——旧快照会静默破坏前缀不变量 |
| 还没有任何快照（会话首个请求前就压缩） | 走失败策略——单条消息请求没有 system/tools，前缀复用直接作废 |
| 模型全程没调 `vcc_done` | 默认：警告 + 接受当前草稿（只被 P4 校验过的补丁改过，状态安全）；`guards.requireDone: true` 时升级为失败 |
| 空 `changes` 补丁 | 同样过 P4 上限检查（不放过已超限的草稿） |

手动 `/compact <instructions>` 的 `customInstructions` 会拼进尾部指令（只影响前缀之后的内容，不影响缓存）。

## 目录与职责

- `index.ts`：注册系统块、三个工具、`context` / `before_provider_request` 快照钩子、压缩接管。
  配置只在加载时读一次（改 `config.json` 需 `/reload`）——中途变更会改变系统块、破坏前缀不变量。
- `src/vcc.ts`：解析并加载**上游** pi-vcc（仓库内 submodule → 显式路径 → 环境变量 → npm 安装位置），
  并记录加载到的版本与路径到日志（`vcc_loaded`）。我们从不修改它。
- `src/engine.ts`：快照、草稿、校验循环、失败策略。
- `src/patch.ts`：P1–P4 与 diff 回执渲染（无 pi 依赖，可单测）。
- `src/pi-settings.ts`：读 pi 自己的设置（`images.blockImages`，项目 `.pi/settings.json` 覆盖全局），
  让快照与 pi 的 `convertToLlmWithBlockImages` 逐字节一致。
