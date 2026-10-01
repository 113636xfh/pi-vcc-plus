# pi-vcc-plus

> Makes pi's context compaction stop being "one more summarization request": a **mechanical draft plus
> one supplement pass**, with the earlier conversation left byte-identical so the server's existing KV
> cache is reused instead of recomputed.
>
> [中文](README.md)

## Why it exists

pi's native compaction sends a **separate summarization request**: it swaps the system prompt,
rearranges the body, and drops the tool definitions. To the server that is a brand new text - token 0
already differs, so every token of KV cache built up by the conversation before it is invalid, and the
compaction itself has to recompute the whole prefix first. The longer the context, the worse it gets:
on a 2xV100 box, compacting an 180K-token session spends 244 seconds on that alone.

pi-vcc-plus produces the summary differently:

1. **The draft comes from an algorithm** — upstream [pi-vcc](https://github.com/sting8k/pi-vcc) does a
   mechanical extraction: deterministic, no model call, milliseconds. It yields a sectioned draft
   (session goal, files changed, commits, key decisions, environment, results, unfinished work, user
   preferences);
2. **The model adds one supplement pass** — one instruction is appended to the end of the current
   session; the model uses `vcc_add` to append to a named section (`"replace": true` rewrites it) and
   adds what the draft is missing. That single response is the whole supplement, and the phase ends
   right after it, closed with `vcc_done`. Sections the model never touches are kept verbatim by
   construction;
3. **Nothing before the tail changes** — the check request is a **strict continuation** of the last
   real request: same system prompt, same tool definitions, same history, with the instruction appended
   at the end. The prefix is byte-identical, so the server reuses its cache and only computes the few
   new tokens.

The only cost is one every compaction method shares: after compaction the new context (summary plus the
recent turns pi keeps) still has to be prefilled once.

## Relationship to upstream pi-vcc

This extension is built on [@sting8k/pi-vcc](https://www.npmjs.com/package/@sting8k/pi-vcc) (MIT, pinned
to v0.8.0 via the `third_party/pi-vcc` git submodule at `303e89d`):

| | pi-vcc (upstream) | pi-vcc-plus (this extension) |
|---|---|---|
| Draft generation | Mechanical extraction (structure, budget anchor, calibration) | Reused as-is; never copied or modified (reads its source directly) |
| Model involvement | None (pure algorithm) | One supplement pass: `vcc_add` (`"replace":true` rewrites a section), `vcc_draft` on demand, `vcc_done` to close |
| Prefix stability | Not handled | Reuses the last request's snapshot + byte-level verification; falls back to native (with a notice) only on failure |
| History recall | `vcc_recall` (reads the raw JSONL) | Registered by default (rejected during the supplement pass) |

The loader only reads upstream's **published source**, never modifies it. Updating it:

```powershell
git submodule update --remote --merge third_party/pi-vcc
git add third_party/pi-vcc
git commit -m "bump pi-vcc"
```

(`scripts/setup-upstream-vcc.ps1` only exists to redo that switch - replacing a local copy in the repo
with the submodule.)

> If you also installed pi-vcc itself (`pi install npm:@sting8k/pi-vcc`), set it to **installed but not
> loaded** in `~/.pi/agent/settings.json`: `{ "source": "npm:@sting8k/pi-vcc", "extensions": [] }`.
> Otherwise its own `session_before_compact` hook competes with this extension for the same compaction.

## How it works

![The compaction takeover flow](docs/images/01-flow.png)

The triggers are pi's own: automatic when the context is about to fill, or a manual `/compact`. The only
difference is where the summary comes from:

1. **Build the draft** (local, no model call): upstream pi-vcc mechanically extracts facts from the
   session into a sectioned draft, and appends the part of the conversation being replaced as plain text
   - the **raw material** the model reads, dropped again when finalizing.
2. **Let the model add one supplement pass**: the last real request verbatim plus one tail instruction
   is sent to the model. The instruction carries the draft with **line numbers** (the sections region is
   numbered; the raw-material region is unnumbered, read-only, and dropped at finalize) and
   says which kinds of information to add. The model sends `vcc_add` edits and closes with `vcc_done`. If that round calls no tool at all, the extension asks
   once more with a nudge instead of finalizing the untouched draft; if the response hits the output
   cap, the edits that parsed are still applied instead of discarding the round.
3. **Finalize**: the raw material and separator markers are dropped, leaving only the section body
   (section names normalized to eight fixed ones in a fixed order), which pi stores as this compaction's
   summary. The recent turns pi keeps follow it verbatim into the next window.

**Why the prefix can be reused**: in step 2, three parts of the outgoing request - system prompt, tool
definitions, history - are byte-identical to the previous request, which is exactly the prefix sitting in
the server's cache. Only the tail instruction is new.

One detail that is easy to miss: the check request also re-attaches "the last reply the previous request
produced". The server generated that reply moments ago, so it is in its KV; without it the token stream
diverges right there and the cache misses anyway.

Because "byte-identical" is the premise of the whole approach, the extension **verifies it itself**:
if the common prefix of this request and the previous one differs, the compaction is treated as failed
(an error, never a silent fallback to native summarization).

The implementation trade-offs (how the tool definitions stay byte-identical, which request-level
parameters are written back, cache block alignment, the full failure matrix) are in
[`docs/design.md`](docs/design.md).

## Compared with native compaction (measured)

Setup: llama.cpp served from **2x Tesla V100-SXM2-16GB** (tensor parallel; model Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp,
`-c 350208 --parallel 2 --kv-unified`, q8_0 KV, MTP draft n=3). The sample is a **real coding session**
(~180K tokens of live context, including 48 messages with tool calls); both implementations run the same
copy of it, serially, with an idle server.

| One compaction (~180K context) | pi native | **pi-vcc-plus** |
|---|---|---|
| compaction time | 508 s | **196 s (2.6x faster)** |
| of which prefill | 112,166 tokens -> 244.0 s | **3,584 tokens -> 15.9 s** (the cache returned 184,940 tokens, 98% of the context) |
| of which generation | 8,836 tokens -> 181.8 s | 6,494 tokens -> 178.9 s |
| summary size | 30,886 chars | 9,774 chars |
| loading the new context after compaction | 44.3 s | 28.4 s |

Native's summarization request has to swap the system prompt, rearrange the body and drop the tools -
token 0 already differs, so the **entire prefix is invalid**: measured, it recomputes **112,166** tokens
every time. The plugin's check request is a strict continuation of the last request, so the prefix is
byte-identical, the server reuses it, and only the draft and the tail instruction are computed.

Generation comes out even: in a real session the mechanical draft is already complete (measured: 7,833
chars, and the model changed 10 of them), so there is no "write the summary from scratch" cost.

How this was measured, per-sample data, the prefill rate distribution, the thinking/summary split and
the prompt-version comparison: [`docs/vcc-vs-native-notes.md`](docs/vcc-vs-native-notes.md).

## Supported backends

Everything here rests on reusing the previous request's prefix **byte for byte**, which is done by
rewriting the request body (raw wire tools written back in, captured request-level parameters
replayed). Rewriting needs an adapter that accepts a custom `fetch` and whose request body is JSON we
can parse.

| pi adapter | Supported |
|---|---|
| `openai-completions` (standard OpenAI `/v1/chat/completions`) | Yes — the primary target. Local servers (llama.cpp server, vLLM, SGLang, FastLLM, TGI, Ollama) all speak it |
| `anthropic-messages` | Yes — its `input_schema` is reconstructed exactly |
| `google-generative-ai` / `google-vertex` / `bedrock-converse-stream` / custom adapters | No |

Unsupported backends do **not** degrade silently. A check request whose prefix quietly diverged costs
a full prefill while looking like nothing but a cache miss, so the extension fails closed and names
the actual cause — Google's `functionDeclarations`, Bedrock's `toolSpec`, a grammar-constrained
tool, an unrecognized shape — instead of saying "unknown shape".

`strict` and `defer_loading` are deliberately *not* refusal reasons. pi-ai puts `strict` on every
OpenAI-style tool unless the model's `compat.supportsStrictMode` is `false`, which is the default,
so treating it as unreconstructable made the extension refuse to compact on essentially every
OpenAI-compatible backend. They are safe because the outgoing `tools` is replaced wholesale with the
captured raw wire tools: the reconstruction only has to hand the adapter a usable definition (name +
JSON schema). The fields that survive *only* through that write-back are logged as
`round.toolsOnlyByWriteback` — and if the write-back ever fails to apply, `checkPrefix` reports
`identical=false` / `fetchCalled=false` rather than the guard guessing in advance.

## Install

```powershell
# 0) Install dependencies (the recall tool in the submodule imports typebox,
#    resolved from the repo root)
npm install        # lockfile is committed; bun install works too (tests run on bun)

# 1) Install the extension itself (local paths are not copied; /reload picks
#    up code changes)
git clone https://github.com/113636xfh/pi-vcc-plus.git
pi install ./pi-vcc-plus

# 2) Let pi load upstream VCC: pick one of the three routes (below)
```

Upstream pi-vcc is resolved in this order (always its **published source**; we never modify it):

1. `config.vccPackagePath` (explicit)
2. the `PI_VCC_PLUS_VCC_PATH` environment variable
3. **in-repo** `third_party/pi-vcc` (recommended: git submodule)
4. `~/.pi/agent/npm/node_modules/@sting8k/pi-vcc` (where `pi install npm:@sting8k/pi-vcc` puts it)
5. `<cwd>/.pi/npm/node_modules/@sting8k/pi-vcc`

## Configuration

`~/.pi/agent/vcc-plus/config.json` (generated on first run):

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

- `enabled`: turn it off to hand compaction fully back to pi.
- `checkModel`: `null` by default, meaning the supplement pass uses the session's current model; you can
  point it at another model with `{ "provider": …, "id": … }`.
- `draftBudget`: knobs for the draft's size (floor, ceiling, tokens per block); rarely needed.
- `guards`: failure protection. All **counts**, never times (a slow model is not cut off by a clock):
  - `maxRounds` (default 1): how many supplement rounds are allowed. The default ends the phase after
    one round; raising it restores "keep editing until the model explicitly finishes".
  - `emptyRetries` (default 1): if a round calls no tool at all, ask once more with a nudge (otherwise
    the untouched draft would be finalized as the summary).
  - `maxConsecutiveFails` (default 4): how many rejected edits in a row abort this compaction.
  - `maxDraftReads` (default 3): how often the model may read the full draft.
  - `maxRequestRetries` (default 3): how many times a check request that failed with a **transient**
    error (dropped connection, timeout, 429, 5xx) is resent, backing off 1s / 2s / 4s with jitter.
    It is not `maxRounds`: a resend is not a round, and `rounds` still counts only the responses the
    model actually produced. Only errors classified transient are resent; 400 / 401 / 413, a context
    overflow, and any unrecognised message still fail closed on the first attempt.
  - `callTimeoutMs` (default 0): per-call time limit; 0 = unlimited.
  - `thinkingCapChars` (default 8000): a hard cap on the characters of thinking the model may stream
    during a supplement round. When it is hit we abort the stream (force-truncate) and fold the
    `[Section]` blocks the model already drafted in its thinking into the draft. 0 = no cap.
    This is a **provider-independent, stream-level abort** — one standard for every model; it does not
    lower the thinking level or configure anything per-model.
    Why: `alignCheckParams` makes the check request inherit the session's thinking setting, and a fast
    reasoning model can spend minutes drafting the whole summary in its thinking (measured: 49,370
    chars / 1,101 s that committed 0.4 k chars). We cannot stop the model mid-thinking and let it
    continue, but we can cut the stream at the cap and keep what it thought — so the under-committed
    sections are recovered instead of lost to an 18-minute wait. Raise it to let heavy over-thinkers
    reach their final draft before the cut; lower it for a tighter time bound.
    The check prompt tells the model about the cap (exceeding it aborts the stream and loses every
    tool call it had not sent yet) and asks it to write each section's final bullet lines under a
    `[Section]` header in its thinking before committing — those lines are still recovered if the
    stream is cut. Harvesting recognizes numbered or annotated section headers
    (`1. [Results]:`, `- [Key Decisions] — …:`) and skips plan entries (`[X] (add specifics)`) and
    self-deliberation; finalization drops the same residue as well as half-lines cut off with
    unbalanced parentheses — the draft chains the previous summary verbatim, so residue that one
    round leaked must not be allowed to persist.
  - `requireDone` (default false): when true, the model must call `vcc_done` explicitly; a plain-text
    finish counts as a failure.
- `onFailure`: what to do on failure - `auto` (default), `cancel`, `throw`, `draft` (finalize with the
  unverified draft). Only reached when `fallbackToNative` is false.
- `fallbackToNative`: `true` (default) = every failure **except a user cancel** returns `undefined` and
  lets pi compact natively, with a warning naming the cause. One flaky gateway should cost that
  compaction its prefix reuse, not the conversation. `false` = fail closed instead (a manual `/compact`
  throws, an automatic one cancels). See the next section.
- `upstreamRecallTool`: register upstream's read-only `vcc_recall` tool (on by default; it is rejected
  during the supplement pass).
- `alignCheckParams`: let the check request reuse the previous request's request-level parameters. On by
  default - some servers render the prompt or key their cache on those parameters, and changing them
  makes the prefix miss. The price is that the supplement pass inherits the session's thinking settings
  (slower); if your server's prefix cache depends on prompt tokens only, you can turn it off to save that
  thinking time. How to tell, with measurements, is in
  [`docs/vcc-vs-native-notes.md`](docs/vcc-vs-native-notes.md).
- `onContextOverflow`: what to do when the check request itself exceeds the provider's context window -
  `trim` (default: derive the real chars-per-token from the numbers the provider reports and retry with
  the newest slice that fits), `draft` (no retry, finalize with the draft), `fail` (go through
  `onFailure`). pi's context estimate is conservative for Chinese text, so compaction can trigger a
  little late; this decides what happens when it is just barely too big.
- `debugLog`: write the session log (below).
- `debugTrace`: the debug switch. `false` (default) leaves the box a 24-line preview and counts
  thinking without showing it. `true` makes the expanded box a full transcript — the whole thinking
  stream, untruncated tool arguments, the draft itself — and additionally writes
  `<session ID>.trace.md` (the terminal scrolls; the file does not). Turn it back off when done.
- `systemBlock`: the block injected into the system prompt; changing it changes the prefix, so `/reload`.

The config is read once, when the extension loads; run `/reload` after editing `config.json`.

## Does a failure fall back to native compaction?

**Yes — unless you cancelled it yourself.** The decision is made top to bottom; the first match wins:

![On failure](docs/images/03-failclosed-en.png)

| # | Condition | Outcome | Default? |
| --- | --- | --- | --- |
| 0 | **The user cancelled** (Esc) | This compaction is cancelled, context intact. **No retry, no fallback** | — |
| 1 | The error is classified **transient** (dropped connection / timeout / 429 / 5xx) | Resend in place, backing off 1s/2s/4s, up to `maxRequestRetries` | ✅ on |
| 2 | `onFailure: "draft"` | Finalize with the **unverified mechanical draft** | ❌ |
| 3 | `fallbackToNative: true` | Return `undefined` — **pi's own compaction takes over** — plus a warning | ✅ default |
| 4 | `fallbackToNative: false` + `onFailure: "auto"` | manual `/compact` → **throws**; automatic compaction → **cancels** | ❌ |
| 4 | `fallbackToNative: false` + `"cancel"` / `"throw"` | pinned to cancel / throw respectively | ❌ |

Three things worth being precise about:

- **A user cancel is checked first, ahead of every degradation.** You pressed Esc, so the extension stops:
  no retry, and no running pi's compaction either — that would compress the very conversation you just
  stopped, without your ever knowing it happened.
- **Step 3 notifies.** The message carries the cause
  (`vcc-plus: … — falling back to pi's native compaction`), and the log gets a `fallback_native` event.
  This is not a silent downgrade: that summary genuinely skipped the check pass and lost prefix reuse.
- **To get fail-closed instead**, set `fallbackToNative: false`. A manual `/compact` will then throw:
  the extension would rather let one compaction fail than let an unverified summary become the record
  without saying so.

## Logs and self-check

With `debugLog` on, every compaction appends records to `~/.pi/agent/vcc-plus/log/<session ID>.jsonl`.
To confirm that prefix reuse actually happened, two lines are enough:

- `checkPrefix`: `identical` should be true - the check request and the previous real request share a
  byte-identical prefix;
- `round`: `cacheRead` should be close to the context length (with the `prefixSuspect` warning flag false) - that means the
  server hit its cache and only computed the new tokens. Hits are **block-aligned** (vLLM 16 tokens per
  block, FastLLM 2048), so being within one block of the context length is normal.

The meaning of the other fields (`draft`, `tool`, `summary_final`, `finalize`, `snapshot_restored` /
`snapshot_rebuilt`, `fail_closed`) and what happens in each failure case: [`docs/design.md`](docs/design.md).

## Tests

```powershell
bun run typecheck                            # tsc --noEmit (strict)
bun test test/                              # edit-rule unit tests + check-loop regressions + recall loading
bun run test/draft-smoke.ts <session.jsonl>  # offline draft from a real session (no model call)
node scripts/e2e-rpc-compact-test.mjs        # RPC E2E: seeded short session -> 3 turns -> /compact
node scripts/e2e-rpc-compact-resume.mjs      # resume the compacted session -> ask -> /compact again
node scripts/log-rounds.mjs [sessionId]      # print the per-round cache/pretext verification table
```

> These need devDependencies (`typescript`, `@earendil-works/pi-coding-agent@0.87.0`, ...):
> one `npm install` or `bun install` is enough.
> With `&` in the repo path Windows fails to resolve the `.bin` shims; use
> `node node_modules/typescript/lib/tsc.js -p tsconfig.json` instead.

## Layout

```
index.ts                 pi extension entry (system block + four tools + snapshot + compaction takeover)
src/
  config.ts              config and the system-prompt block (English constants)
  prompt.ts              tail instruction / edit receipts / error text (English)
  patch.ts               applying and validating edits (pure logic, unit-tested)
  engine.ts              snapshot / draft / supplement pass / failure handling
  vcc.ts                 loads upstream pi-vcc (never copies, never modifies)
  log.ts                 ~/.pi/agent/vcc-plus/log/<session ID>.jsonl
test/                    unit tests, regressions, recall loading
docs/
  design.md              detailed design (invariants, decision table, model-visible text, log fields)
  vcc-vs-native-notes.md measured comparisons and raw data
  src/*.svg              diagram sources (hand-laid out, editable)
  images/*.png           rendered output (committed, referenced directly by GitHub)
  render.mjs / verify.mjs / probe-pixels.mjs   render and verification scripts
scripts/                 E2E and maintainer scripts
third_party/pi-vcc/      upstream pi-vcc (git submodule, pinned)
```

## License

MIT - see [LICENSE](LICENSE)
