import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Guards {
  /**
   * One "round" = one model request inside the check phase.
   * 1 (default) = the designed shape: the model reads the draft and sends every
   * addition in that single response, which is applied and ends the phase.
   * >1 restores the older patch-until-`vcc_done` loop.
   */
  maxRounds: number;
  /**
   * Extra attempts allowed when a round's response carries no edits at all.
   * 1 (default) = the edit-less round is re-asked once, because ending the phase
   * there would finalize the untouched mechanical draft. 0 disables the retry.
   */
  emptyRetries: number;
  /**
   * Retries for a *transport* failure of the check request — dropped connection,
   * timeout, 429, 5xx. 3 (default), matching the Anthropic SDK's `maxRetries: 2`
   * plus the first attempt, with 1s/2s/4s jittered backoff.
   *
   * This is separate from maxRounds on purpose: a resend is not a round. Before
   * this existed a single "Connection error." failed the whole compaction and
   * the session lost its context to a flaky socket (observed on
   * opencode-go, which — unlike the Anthropic path — has no SDK-level retry
   * underneath it).
   *
   * Only errors classified transient are retried. A 400 (MissingSessionID), a
   * 401, a context overflow or any unrecognised message still fails closed on
   * the first attempt: those would be rejected identically.
   */
  maxRequestRetries: number;
  maxConsecutiveFails: number;
  maxDraftReads: number;
  /**
   * Optional safety net only. 0 (default) = no time limit: a slow model is not
   * a failure. The check phase is bounded by maxRounds instead.
   */
  callTimeoutMs: number;
  /**
   * Hard cap on the characters of thinking the check model may stream before we
   * abort the stream and harvest what it has already drafted. 0 (default) =
   * no cap.
   *
   * Why it exists: with alignCheckParams the check inherits the session's
   * thinking setting, and a fast reasoning model can draft the whole summary
   * in its thinking for minutes (measured: 49,370 chars / 1,101 s that
   * committed 0.4 k chars). We cannot stop the model mid-thinking and let it
   * continue, but we CAN cut the stream at a cap and keep what it thought —
   * the drafted sections are then merged into the draft at finalize, so the
   * under-committed summary is recovered instead of lost to an 18-minute wait.
   *
   * The cap is provider-independent (a stream-level abort), so it is the same
   * standard for every model. Raise it to let heavy over-thinkers reach their
   * final draft before we cut them; lower it for a tighter time bound.
   */
  thinkingCapChars: number;
  /**
   * When true, the check loop fails closed unless the model explicitly calls
   * vcc_done (a text-only "stop" response is no longer accepted as done).
   * Default false: a text-only response leaves a cap-validated draft, so it
   * is accepted with a warning.
   */
  requireDone: boolean;
}

export interface DraftBudget {
  floorTokens: number;
  ceilingTokens: number;
  tokensPerBlock: number;
}

export interface Config {
  enabled: boolean;
  /** Optional explicit path to the installed @sting8k/pi-vcc package. */
  vccPackagePath: string | null;
  /** null = use the session's active model for the check request. */
  checkModel: { provider: string; id: string } | null;
  draftBudget: DraftBudget;
  guards: Guards;
  /**
   * auto  = manual /compact throws, auto compaction cancels + notifies (fail closed)
   * cancel = always cancel and let the old context stand
   * throw  = always surface an error
   * draft  = fall back to the un-checked VCC draft (explicit opt-in only)
   */
  onFailure: "auto" | "cancel" | "throw" | "draft";
  /** false = fail closed instead of silently deferring to pi's native summarizer. */
  /**
   * true (default) = when the check phase fails for a reason that is not a user
   * cancel, return `undefined` and let pi compact natively, with a warning
   * notification saying so. A flaky gateway or a provider that rejects the
   * request should cost you the prefix-reuse optimization for one compaction,
   * not the conversation.
   *
   * A user cancel is never treated as a failure and never falls back — the
   * user asked to stop compacting, and running pi's compaction anyway would do
   * exactly what they stopped.
   *
   * false = fail closed instead: a manual `/compact` throws, an automatic one
   * cancels. The extension then never silently produces a summary that skipped
   * its own checks. Costs a failed compaction whenever the provider misbehaves.
   */
  fallbackToNative: boolean;
  /** Register pi-vcc's own vcc_recall tool (read-only history search). */
  upstreamRecallTool: boolean;
  /**
   * What to do when the check request does not fit the provider's context
   * window (measured: pi estimates context tokens as chars/4, so a
   * Chinese-heavy session can be ~1.8x larger than pi thinks and the provider
   * returns a context-overflow 400).
   *
   * trim  (default) = retry once with the newest part of the snapshot that fits
   *   (the earlier part is what the draft already summarizes); if that also
   *   overflows, compact with the mechanical draft instead of failing.
   * draft = skip the retry, compact with the mechanical draft right away
   *   (instant; useful when the provider is slow or down).
   * fail  = no special handling; the failure follows `onFailure` (fail closed).
   *
   * Rationale: when the context itself is over the window, the provider already
   * rejected the previous request, so there is no cached prefix to reuse and
   * the alternative to compacting is a session that can no longer run.
   */
  onContextOverflow: "trim" | "draft" | "fail";
  /**
   * true (default) = the check request re-sends the last real request's
   * request-level parameters (chat_template_kwargs, max_tokens, ...) so the
   * provider sees the same rendering and the same cache key.
   *
   * Required on providers that re-render the prefix when the template
   * parameters change or that key the prefix cache on them (measured: FastLLM
   * returned cached_tokens=0 for a byte-identical prefix under a different
   * max_tokens, and its template re-rendered the conversation when
   * enable_thinking flipped).
   *
   * Cost: the check request inherits the session's thinking setting, so the
   * model thinks during every check round (measured: 4441 output tokens for
   * one round instead of a few hundred).
   *
   * false = keep pi-ai's own parameters (no thinking, output cap = the
   * summary budget). Safe on providers whose prefix cache is keyed on the
   * prompt tokens alone (measured: vLLM + LMCache, where flipping
   * enable_thinking only moves the tail). Verify with
   * `round.prefixSuspect` / `scripts/log-rounds.mjs` after changing it.
   */
  alignCheckParams: boolean;
  debugLog: boolean;
  /**
   * Debug switch. false (default) = the box is a bounded preview: the status
   * line plus, once expanded, the model's additions with a 24-line budget.
   * Thinking is counted and discarded.
   *
   * true = the expanded box becomes a full transcript on screen — the entire
   * thinking stream, every tool call with its untruncated arguments, and the
   * draft it worked from, in that order. A local 27B's reasoning is routinely
   * five figures of characters, which is why this is off by default and not
   * the normal rendering: collapsed, the box is unchanged either way.
   *
   * Also writes `<session>.trace.md` next to the JSONL log with the same
   * content, because the terminal scrolls and the session file does not. Costs
   * one appendFileSync per flush and nothing at request time.
   *
   * Turn it back off when the investigation is done.
   */
  debugTrace: boolean;
  systemBlock: string;
}

export const SYSTEM_BLOCK = `<pi-vcc-plus>
This extension takes over context compaction. The flow is:
1. When compaction is needed, a script first extracts this conversation into a mechanical
   "compaction draft" and appends it to the end of the conversation. The draft is not a user
   message: do not comment on it, restate it, or reply to it.
2. The "check phase" that follows is a single supplement pass: read the draft, then send
   everything it is missing with vcc_add (append lines to a named section; "replace":true
   rewrites it). Use vcc_draft only when the receipts are not enough to judge the draft,
   and end the pass with vcc_done.
3. What you send in that one response is applied as-is and ends the phase, so send everything
   in one batch. Those three tools are only usable during the check phase; calling them at
   any other time is rejected.
   Separately, vcc_recall (shipped with pi-vcc) stays available in normal turns whenever you
   need to look up earlier parts of this session; it is rejected during the check phase.
4. The finalized summary plus the last few turns kept verbatim become the new context, and the
   current task continues.
5. During the check phase, output tool calls only: do not continue the conversation and do not
   write user-facing text.
</pi-vcc-plus>`;

export const DEFAULTS: Config = {
  enabled: true,
  vccPackagePath: null,
  checkModel: null,
  draftBudget: { floorTokens: 1100, ceilingTokens: 2000, tokensPerBlock: 15 },
  guards: {
    maxRounds: 1,
    emptyRetries: 1,
    maxConsecutiveFails: 4,
    maxRequestRetries: 3,
    maxDraftReads: 3,
    callTimeoutMs: 0,
    thinkingCapChars: 8000,
    requireDone: false,
  },
  onFailure: "auto",
  fallbackToNative: true,
  upstreamRecallTool: true,
  alignCheckParams: true,
  onContextOverflow: "trim",
  debugLog: true,
  debugTrace: false,
  systemBlock: SYSTEM_BLOCK,
};

export const agentDir = (): string => join(homedir(), ".pi", "agent");
export const pluginDir = (): string => join(agentDir(), "vcc-plus");
export const configPath = (): string => join(pluginDir(), "config.json");
export const logDir = (): string => {
  // Env override so tests (and a second pi profile) can keep their traces out
  // of the real log directory. Unset in normal use.
  const v = process.env.VCC_PLUS_LOG_DIR;
  // `process.env.X = undefined` stores the literal string "undefined" — treat
  // it as unset instead of a (relative) directory name.
  return v && v !== "undefined" ? v : join(pluginDir(), "log");
}

export function ensureConfigFile(): void {
  try {
    const path = configPath();
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
  } catch {
    // Best effort: a read-only environment just keeps defaults in memory.
  }
}

export function loadConfig(): Config {
  const base = { ...DEFAULTS, draftBudget: { ...DEFAULTS.draftBudget }, guards: { ...DEFAULTS.guards } };
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    // A hand-edited file may be valid JSON that is not an object (null, a
    // bare string, an array): spreading it would corrupt the defaults.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return base;
    const partial = parsed as Partial<Config>;
    return {
      ...base,
      ...partial,
      draftBudget: { ...base.draftBudget, ...(partial.draftBudget ?? {}) },
      guards: { ...base.guards, ...(partial.guards ?? {}) },
    };
  } catch {
    return base;
  }
}
