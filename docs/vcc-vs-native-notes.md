# VCC 实测对比（为什么尾部指令要强调那五类信息）

方法：用 pi 自己的 `prepareCompaction` 语义复原"压缩当时被摘要的那段上下文"，
VCC 侧用它的 `compileRanked`（生产预算）本地跑，原生侧直接用 session 里记录的摘要，
再用同一套事实抽取做形状无关的覆盖率比对。**全程零模型调用。**

样本：`~/.pi/agent/sessions/<some-project>/<session-id>.jsonl`

| 压缩点 | tokensBefore | span 消息 | 原生摘要 | VCC 草稿 | 改文件覆盖 | bash 命令覆盖 | 失败命令覆盖 |
|---|---|---|---|---|---|---|---|
| #0 | 234,715 | 176 | 14,176 字符 | 7,113 字符 | 8/8 vs 8/8 | 1/63 vs 42/63 | 0/1 vs 1/1 |
| #15 | 184,934 | 173 | 17,983 | 7,760 | 2/2 vs 2/2 | 2/75 vs 52/75 | 0/4 vs 3/4 |
| #29 | 968,497 | 1,159 | 37,970 | 8,686 | 40/40 vs 33/40 | 48/430 vs 80/430 | 7/41 vs 12/41 |

结论：

1. **可核对的标记类事实，VCC 更好**：体积只有原生的 1/2–1/4.4，文件列表、命令一行、失败命令保留得更多
   （它把 tool_call 逐行抄进 brief）。
2. **合成的约束/理由，VCC 明显更弱**：#0 那次用关键词直查，原生摘要保留了
   `8080`、`GPU 1`、`DO NOT TOUCH`、`NEVER`、`HF_ENDPOINT`、`NCCL_P2P_DISABLE`、`22GB`，VCC 一个都没有。
   机制原因：VCC 的 brief = 5 个提取 section + 被压缩区间**尾部约 120 行**的原文 transcript，
   更早的用户约束与决策理由既不在 section 里、也不在窗口里。

因此尾部指令明确列出五类"重点补什么"：约束与安全红线、决策及理由、精确环境信息、未完成项与下一步、实测结论与失败事实。
（另有更早的一次实验记录了 pi 原生摘要调用 30+ 次 `cacheRead: 0`，以及 Codex / Claude Code 的对照，见会话记录。）

## 前缀缓存的实测（"字节相同"为什么还不够）

2026-09-23/24 在 e5 的生产服务上做的对照实验（`/v1/chat/completions`，同一段 ~2.9K token 的对话，
依次改变一个变量，读响应里的 `usage.prompt_tokens_details.cached_tokens`）：

| 变更 | FastLLM（`--prefix_cache true`） | 说明 |
|---|---|---|
| 只追加一条 user 消息（对照组） | cached=2048（= ⌊种子/2048⌋×2048） | 正常延续 → 命中，且命中按 2048 token 块对齐 |
| `chat_template_kwargs.enable_thinking` true → false | cached=0 | 模板渲染出的 token 序列变了（同一段历史 2912 vs 2876 token） |
| `max_tokens` 100 → 26214 | cached=0 | 该服务端把 `max_tokens` 也算进前缀缓存键 |
| `store` false/不传 | 无差异 | 与缓存键无关 |

生产会话里的同一现象（`scripts/log-rounds.mjs` 输出）：`checkPrefix identical=true` 但
round 1 `cacheRead=0 / prefixSuspect=true`，随后 round 2 命中 219,136 —— 说明"同一轮里的延续"能命中，
"跨到真实请求"不能。

两条修复（`7c78e6a`）：

1. 检查请求拼上上一次请求关尾的那条 assistant 回复（`snapshotContinuationAssistant`）；
2. 自定义 fetch 把上一次请求的请求级参数（除 `model`/`messages`/`tools`）写回出站 body
   （`wireParams`），使渲染与缓存键与上一次请求完全一致。

块粒度是关键：vLLM 默认 16 token、FastLLM 2048 token，命中只会命中完整块，
不足一块的尾部照常 prefill——所以 `cacheRead` 略小于前缀长度是正常状态，不该被误判成 miss。

## 两个后端的命中判据不同（2026-09-24，同端口先后部署）

| 维度 | FastLLM（ftllm，`--prefix_cache true`，GGUF 自带模板 v22.5） | vLLM（+ LMCache `--chunk-size 1568`，AWQ 的 HF 模板） |
|---|---|---|
| 命中粒度 | 2048 token（所有命中 = ⌊种子/2048⌋×2048） | 1568 token（LMCache chunk；命中值精确等于 1568 的整数倍） |
| 缓存键含请求参数 | **含**：token 完全相同、`max_tokens` 100→26214 → `cached=0` | **不含**：`max_tokens`、`store` 变化照样命中 |
| `enable_thinking` 翻转 | prompt 2900→2876（−36）且 `cached=0` → 分叉落在前 2048 token 内 | prompt 2874→2876（+2）且 `cached=1568` → 分叉只在尾部 |
| 对扩展的含义 | 检查请求必须与上一次请求**逐字段**一致 | 只要消息字节一致即可 |

`cached_tokens` 字段两边口径一致（`prompt_tokens_details.cached_tokens`；DeepSeek 为
`prompt_cache_hit_tokens`、Kimi 为顶层 `cached_tokens`），pi-ai 都解析为 `cacheRead`，因此
`round.prefixSuspect` 与哨兵的 `cacheVerdict` 在两端都成立。

代价对照（同一次 E2E，vLLM、26K 上下文）：对齐开启时检查轮继承了 `enable_thinking: true`，
round 1 输出 4441 token / 2m05s；对齐关闭时检查轮不思考（FastLLM 时代实测 25–45s/轮）。
所以 `alignCheckParams` 按后端取舍：模板/缓存键与参数相关的后端留 true，纯 token 键的后端可关。
