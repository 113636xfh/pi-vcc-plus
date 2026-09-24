/**
 * pi-vcc-plus engine.
 *
 * Flow: VCC produces a mechanical draft -> the draft is appended to an exact
 * copy of the last provider request (snapshot) -> the model corrects it with
 * vcc_patch / vcc_draft / vcc_done -> the corrected draft becomes the
 * compaction summary. No extra summarization request, no prefix change.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { type Config } from "./config";
import { createLogger, type Logger } from "./log";
import { finalizeSummary } from "./finalize";
import { applyChanges, effectiveTokensOf, SECTION_RE, tokensOf, type Change } from "./patch";
import {
  ERR_DRAFT_READ_CAP,
  ERR_RECALL_IN_CHECK,
  ERR_REPEAT_HINT,
  ERR_TOOL_NOT_ALLOWED,
  ERR_TOOL_OUTSIDE_PHASE,
  TOOL_DONE_OK,
  buildTailInstruction,
  draftHeader,
} from "./prompt";
import { isBlockImagesEnabled } from "./pi-settings";
import { loadVcc, type VccModule } from "./vcc";

type Any = any;

interface Snapshot {
  messages: Any[];
  systemPrompt: string;
  tools?: Any[];
  toolsSource: string;
  /** Raw wire tools from the last request's payload (byte-exact, used to
   * replace the check request's tools via the custom fetch). */
  wireTools?: Any[];
  /** Request-level wire parameters from the last request's payload
   * (chat_template_kwargs, max_tokens, ...). FastLLM's prefix-cache key
   * includes these: a check request that differs on them gets zero cache
   * reuse even with a byte-identical message prefix (measured on e5).
   * The custom fetch restores the captured values on the outgoing body. */
  wireParams?: Record<string, unknown>;
  /** "mismatch" = the wire tools contain shapes that cannot be reconstructed
   * byte-exactly (grammar/custom tools, strict: true, deferred loading, or an
   * unrecognized shape) — the check request must fail closed.
   * "unknown" = the snapshot was rebuilt from the session (cold start), so no
   * wire payload was seen: pi-ai re-serializes the tools itself. */
  toolsRoundTrip?: "ok" | "mismatch" | "unknown";
  prefixTokens: number;
  at: number;
}

interface Phase {
  active: boolean;
  draft: string;
  capTokens: number;
  charsPerToken: number;
  maxDraftReads: number;
  guard: { rounds: number; fails: number; draftReads: number; done: boolean };
  failedOldTexts: Map<string, number>;
}

let snapshot: Snapshot | null = null;
let phase: Phase | null = null;

// ────────────────────────────────────────────────────────────────────────────
// Snapshotting the last real request (prefix source of truth)
// ────────────────────────────────────────────────────────────────────────────

export function recordContext(agentMessages: Any[], ctx: Any): void {
  try {
    // Mirror pi's own wire transform: when images.blockImages is enabled, pi
    // replaces image parts with a placeholder text on every request, so the
    // snapshot must apply the same transform or the prefix diverges.
    const converted = convertToLlm((agentMessages ?? []) as Any) as Any[];
    const messages = isBlockImagesEnabled(ctx?.cwd) ? blockImageMessages(converted) : converted;
    // Tools are NOT resolvable from the event ctx (it exposes neither
    // getAllTools nor getSystemPromptOptions), and the registry order is not
    // the wire order — the only byte-exact source is the last provider
    // request's own payload, which recordPayload() fills in.
    const systemPrompt = safeSystemPrompt(ctx);
    snapshot = {
      messages,
      systemPrompt,
      tools: undefined,
      toolsSource: "none",
      prefixTokens: Math.ceil(roughChars(messages) / 4) + Math.ceil((systemPrompt?.length ?? 0) / 4),
      at: Date.now(),
    };
  } catch {
    // A snapshot we cannot build is worse than none: a stale one would
    // silently break the prefix invariant. Nulling makes the next compaction
    // fail closed (see the no-snapshot guard in onBeforeCompact).
    snapshot = null;
  }
}

/**
 * Primary source of the snapshot's tools: the last provider request's own
 * wire tool list (byte-exact, in wire order). The event ctx cannot provide
 * tools (see recordContext), so every snapshot is completed this way.
 * Refreshed on every payload: the payload belongs to the request the current
 * snapshot was made for, so re-adopting it also heals a snapshot left stale
 * by a failed recordContext.
 */
export function recordPayload(payload: Any, ctx: Any): void {
  if (!snapshot) return;
  const wireTools = payload?.tools;
  const tools = toolsFromPayload(payload);
  if (tools?.length) {
    snapshot.tools = tools;
    snapshot.toolsSource = "before_provider_request.payload";
  }
  snapshot.toolsRoundTrip = toolsRoundTripStatus(wireTools);
  if (Array.isArray(wireTools)) snapshot.wireTools = wireTools;
  // Capture the request-level wire parameters that the server includes in
  // its prefix-cache key (see wireParams). Messages/tools are handled
  // separately; these are everything else the server saw on the last real
  // request (chat_template_kwargs, max_tokens, sampling, ...).
  try {
    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload ?? {})) {
      if (key === "model" || key === "messages" || key === "tools") continue;
      if (value !== undefined) params[key] = value;
    }
    snapshot.wireParams = params;
  } catch {
    /* optional */
  }
  // Self wire-baseline for check-request verification (fallback when the
  // prefix-sentinel is not installed). Best-effort; never throws.
  try {
    const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
    const dir = join(cwd, ".pi", "vcc-plus");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "last-wire-request.json"),
      JSON.stringify({ ts: Date.now(), pretty: JSON.stringify(payload, null, 2) }),
      "utf8",
    );
    // Persist the now-complete snapshot so it survives /reload (module state
    // dies with the process). Best-effort; the in-memory copy is authoritative.
    persistSnapshot(cwd, safeSessionId(ctx));
  } catch {
    /* baseline is optional evidence, not part of the request path */
  }
}

function safeSystemPrompt(ctx: Any): string {
  try {
    return ctx?.getSystemPrompt?.() ?? "";
  } catch {
    return "";
  }
}

const SNAPSHOT_FILE = "last-snapshot.json";

/**
 * Persist the complete snapshot (agent-format messages + system prompt +
 * normalized tools + raw wire tools) so it survives /reload — module state
 * dies with the process, but /compact right after a reload must still be
 * able to reuse the last request's prefix. Called from recordPayload, so the
 * file always mirrors the last request the extension observed.
 */
export function persistSnapshot(cwd: string | undefined, sessionId: string | undefined): void {
  const s = snapshot;
  if (!s?.tools?.length) return; // only complete snapshots (tools included)
  if (typeof cwd !== "string" || typeof sessionId !== "string") return;
  try {
    const dir = join(cwd, ".pi", "vcc-plus");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, SNAPSHOT_FILE),
      JSON.stringify({
        ts: s.at,
        sessionId,
        messages: s.messages,
        systemPrompt: s.systemPrompt,
        tools: s.tools,
        toolsSource: s.toolsSource,
        wireTools: s.wireTools,
        wireParams: s.wireParams,
        toolsRoundTrip: s.toolsRoundTrip,
        prefixTokens: s.prefixTokens,
      }),
      "utf8",
    );
  } catch {
    /* best effort — the in-memory snapshot stays authoritative */
  }
}

/**
 * Cold-start recovery. After /reload (or in a fresh process for a resumed
 * session) the in-memory snapshot is gone until the next provider request.
 * If no complete in-memory snapshot exists, restore the last persisted one —
 * only when it belongs to this session and is complete (messages + tools
 * present, round-trip status not "mismatch"). Anything else fails closed.
 */
export function restoreSnapshot(ctx: Any): boolean {
  if (snapshot?.tools?.length) return true; // already complete
  const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : undefined;
  const sessionId = safeSessionId(ctx);
  if (!cwd || !sessionId) return false;
  const path = join(cwd, ".pi", "vcc-plus", SNAPSHOT_FILE);
  try {
    if (!existsSync(path)) return false;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Any;
    if (parsed?.sessionId !== sessionId) return false; // other session in this cwd
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return false;
    if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) return false;
    if (parsed.toolsRoundTrip === "mismatch") return false;
    snapshot = {
      messages: parsed.messages,
      systemPrompt: typeof parsed.systemPrompt === "string" ? parsed.systemPrompt : "",
      tools: parsed.tools,
      toolsSource: "persisted (restored after reload)",
      wireTools: Array.isArray(parsed.wireTools) ? parsed.wireTools : undefined,
      wireParams:
        parsed.wireParams && typeof parsed.wireParams === "object" ? parsed.wireParams : undefined,
      toolsRoundTrip: parsed.toolsRoundTrip,
      prefixTokens: typeof parsed.prefixTokens === "number" ? parsed.prefixTokens : 0,
      at: typeof parsed.ts === "number" ? parsed.ts : 0,
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * Tools for a rebuilt snapshot. `toolsFromPayload` needs a wire payload, which
 * a cold start does not have; the extension entry point injects pi's own tool
 * registry here instead (getActiveTools + getAllTools).
 */
type ToolProvider = () => Any[];
let toolProvider: ToolProvider | null = null;

export function setToolProvider(provider: ToolProvider): void {
  toolProvider = provider;
}

/**
 * Cold start without any snapshot: the extension was just loaded (/reload, new
 * process, or a project where it never saw a request) and the last provider
 * request is unknown. Refusing to compact is the wrong answer for a session
 * that already has plenty of context, so rebuild what a snapshot needs from the
 * session itself:
 *
 *  - messages: the session's own projection (exactly what the next request
 *    would send), passed through the same convertToLlm + blockImages transform
 *    as recordContext;
 *  - system prompt: ctx.getSystemPrompt();
 *  - tools: pi's active tool registry, in pi-ai's Tool shape.
 *
 * What is missing is what only the wire payload knows: the exact wire tool
 * order/shape (pi-ai re-serializes the same way for a request it builds) and
 * the request-level parameters (chat_template_kwargs, max_tokens, ...). Logged
 * as a rebuilt snapshot so the check request's prefix status stays visible: the
 * round-1 `prefixSuspect` flag and the prefix-sentinel both report a miss if
 * re-serialization diverged.
 */
export function rebuildSnapshotFromSession(ctx: Any): boolean {
  if (snapshot?.tools?.length) return false; // a real one exists
  const manager = ctx?.sessionManager;
  if (typeof manager?.buildSessionProjection !== "function") return false;
  try {
    const projected: Any[] = manager.buildSessionProjection()?.messages ?? [];
    if (!projected.length) return false;
    const converted = convertToLlm(projected as Any) as Any[];
    const messages = isBlockImagesEnabled(ctx?.cwd) ? blockImageMessages(converted) : converted;
    const tools = toolProvider?.() ?? [];
    if (!tools.length) return false; // without tools the model cannot patch at all
    const systemPrompt = safeSystemPrompt(ctx);
    snapshot = {
      messages,
      systemPrompt,
      tools,
      toolsSource: "rebuilt from the session (cold start)",
      toolsRoundTrip: "unknown",
      prefixTokens:
        Math.ceil(roughChars(messages) / 4) + Math.ceil((systemPrompt?.length ?? 0) / 4),
      at: Date.now(),
    };
    // Best effort: a later /reload can restore this one instead of rebuilding.
    persistSnapshot(typeof ctx?.cwd === "string" ? ctx.cwd : undefined, safeSessionId(ctx));
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize the provider-specific wire tools back to pi-ai's Tool shape
 * ({name, description, parameters}) so re-serialization through pi-ai
 * reproduces the original wire bytes:
 *  - OpenAI-style:    { type: "function", function: { name, description, parameters } }
 *  - Anthropic-style: { name, description, input_schema } — the wire
 *    input_schema is exactly what pi-ai regenerates from `parameters`, so
 *    mapping it back round-trips byte-stably.
 * Provider-only fields (cache_control, defer_loading, eager_input_streaming,
 * strict) are dropped: pi-ai re-derives them from the same settings.
 */
function toolsFromPayload(payload: Any): Any[] | undefined {
  const tools = payload?.tools;
  if (!Array.isArray(tools)) return undefined;
  const defs = tools
    .map((t: Any) => {
      if (!t || typeof t !== "object") return undefined;
      if (t.function && typeof t.function === "object" && typeof t.function.name === "string") {
        const f = t.function;
        return { name: f.name, description: f.description, parameters: f.parameters };
      }
      if (typeof t.name === "string" && t.input_schema) {
        return { name: t.name, description: t.description, parameters: t.input_schema };
      }
      if (typeof t.name === "string" && t.parameters) {
        return { name: t.name, description: t.description, parameters: t.parameters };
      }
      return undefined;
    })
    .filter((t: Any): t is { name: string; description?: string; parameters?: unknown } => !!t?.name);
  return defs.length ? defs : undefined;
}

/**
 * The {name, description, parameters} reconstruction is byte-stable only for
 * plain JSON-schema tools. These wire shapes carry information the wire does
 * not return (constrainedSampling / deferred tool loading), so any of them
 * means the check request's tools would silently differ from the original:
 *  - type: "custom" (grammar tools) — not reconstructable at all
 *  - strict: true — came from constrainedSampling, lost in the wire
 *  - defer_loading — provider-managed deferred tool loading
 *  - unrecognized shape — no function.parameters / input_schema / parameters
 */
export function toolsRoundTripStatus(wireTools: Any): "ok" | "mismatch" | undefined {
  if (!Array.isArray(wireTools)) return undefined;
  for (const t of wireTools) {
    if (!t || typeof t !== "object") return "mismatch";
    if (t.type === "custom" || t.custom) return "mismatch";
    if (t.strict === true || t.function?.strict === true) return "mismatch";
    if (t.defer_loading === true || t.function?.defer_loading === true) return "mismatch";
    const hasOpenAiFunction = !!t.function && typeof t.function.name === "string";
    const hasAnthropicSchema = typeof t.name === "string" && !!t.input_schema;
    const hasPlainSchema = typeof t.name === "string" && !!t.parameters;
    if (!hasOpenAiFunction && !hasAnthropicSchema && !hasPlainSchema) return "mismatch";
  }
  return "ok";
}

/**
 * Byte-exact verification of the outgoing check request against the previous
 * real request's wire body. The check request's body may legitimately be
 * LONGER (the tail instruction is appended after the snapshot's messages),
 * so this is a prefix comparison: system, tools and the first
 * `baseline.messages.length` messages must match exactly.
 */
export function verifyCheckPrefix(
  baseline: Any,
  check: Any,
  source: "sentinel" | "self",
): {
  identical: boolean;
  baselineSource: "sentinel" | "self";
  checks: { system: boolean; tools: boolean; messages: boolean };
  firstDivergence: { field: "system" | "tools" | "messages"; index?: number } | null;
  messages: { baseline: number; check: number };
} {
  const systemEq = JSON.stringify(baseline?.system ?? null) === JSON.stringify(check?.system ?? null);
  const toolsEq = JSON.stringify(baseline?.tools ?? null) === JSON.stringify(check?.tools ?? null);
  const bm = Array.isArray(baseline?.messages) ? baseline.messages : [];
  const cm = Array.isArray(check?.messages) ? check.messages : [];
  let messagesEq = cm.length >= bm.length;
  let firstIndex = -1;
  const n = Math.min(bm.length, cm.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(bm[i]) !== JSON.stringify(cm[i])) {
      firstIndex = i;
      messagesEq = false;
      break;
    }
  }
  if (!messagesEq && firstIndex === -1) firstIndex = cm.length; // baseline longer: dropped tail
  const identical = systemEq && toolsEq && messagesEq;
  return {
    identical,
    baselineSource: source,
    checks: { system: systemEq, tools: toolsEq, messages: messagesEq },
    firstDivergence: !systemEq
      ? { field: "system" }
      : !toolsEq
        ? { field: "tools" }
        : !messagesEq
          ? { field: "messages", index: firstIndex }
          : null,
    messages: { baseline: bm.length, check: cm.length },
  };
}

/**
 * Wire baseline for the check-request verification. Candidates are
 * freshness-gated (ts >= sinceTs, i.e. this request or later — anything older
 * is a stale leftover, possibly from another session in the cwd) and the
 * NEWEST wins; ties go to the sentinel (independent capture).
 */
export function readWireBaseline(
  cwd: string | undefined,
  sinceTs?: number,
): { pretty: string; source: "sentinel" | "self"; ts: number } | null {
  if (typeof cwd !== "string") return null;
  const candidates: Array<["sentinel" | "self", string]> = [
    ["sentinel", join(cwd, ".pi", "prefix-sentinel", "last-request.json")],
    ["self", join(cwd, ".pi", "vcc-plus", "last-wire-request.json")],
  ];
  let best: { pretty: string; source: "sentinel" | "self"; ts: number } | null = null;
  for (const [source, path] of candidates) {
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Any;
      if (typeof parsed?.pretty !== "string") continue;
      const ts = typeof parsed.ts === "number" ? parsed.ts : 0; // missing ts = treat as stale
      if (typeof sinceTs === "number" && ts < sinceTs) continue; // stale leftover
      if (!best || ts > best.ts) best = { pretty: parsed.pretty, source, ts }; // ties keep the earlier candidate (sentinel)
    } catch {
      /* try the next candidate */
    }
  }
  return best;
}

/**
 * Custom fetch for the check request. Does two things, both by construction:
 *  1. Replaces the outgoing body's `tools` with the captured RAW wire tools
 *     (byte-exact — pi-ai's own reconstruction of tools never reaches the
 *     wire, which also removes the round-trip concern entirely).
 *  2. Captures the first outgoing body for byte-level verification against
 *     the previous real request (see verifyCheckPrefix).
 *
 * Re-serialization is byte-stable: JSON.parse preserves key order and the
 * body was itself produced by JSON.stringify, so untouched fields come back
 * identical. Any failure degrades to the original request (never breaks it).
 */
type FetchLike = (input: Any, init?: Any) => Promise<unknown>;

/** Parameters owned by the engine — a captured value never overwrites them. */
const ENGINE_OWNED_PARAMS = new Set(["model", "messages", "tools"]);
/** Transport flags that belong to pi-ai's own response parsing. */
const TRANSPORT_PARAMS = new Set(["stream", "stream_options"]);

export function buildCheckFetch(
  wireTools: Any,
  capture: { url?: string; bodyText?: string },
  wireParams?: Record<string, unknown>,
): FetchLike {
  const realFetch: FetchLike = globalThis.fetch;
  return async (input, init) => {
    let out: Any = init;
    try {
      const bodyText = typeof (init as { body?: unknown })?.body === "string" ? (init as { body: string }).body : "";
      const parsed = bodyText ? (JSON.parse(bodyText) as Any) : null;
      if (parsed && Array.isArray(wireTools)) {
        parsed.tools = wireTools;
      }
      // Restore the request-level parameters of the last real request
      // (chat_template_kwargs, max_tokens, sampling, store, ...). The
      // provider renders the chat template from these values, so a
      // different one changes the token sequence and no prefix cache can
      // match; some providers also key their prefix cache on them
      // (measured: FastLLM returns cached=0 when max_tokens differs even
      // with a byte-identical message prefix). model/messages/tools are
      // owned by the engine, and the transport flags belong to pi-ai's
      // response parsing — neither is overwritten here.
      if (parsed && wireParams && typeof wireParams === "object") {
        for (const [key, value] of Object.entries(wireParams)) {
          if (ENGINE_OWNED_PARAMS.has(key) || TRANSPORT_PARAMS.has(key)) continue;
          parsed[key] = value;
        }
      }
      if (parsed) {
        out = { ...(init as object), body: JSON.stringify(parsed) };
      }
      // no body / unparseable body: keep the original request untouched
    } catch {
      out = init; // never break the request over capture problems
    }
    if (capture.bodyText === undefined) {
      capture.url = typeof input === "string" ? input : (input as Any)?.url ?? "";
      capture.bodyText = typeof (out as { body?: unknown })?.body === "string" ? (out as { body: string }).body : "";
    }
    return realFetch(input, out);
  };
}

const BLOCKED_IMAGE_TEXT = "Image reading is disabled.";

/**
 * pi's own `convertToLlmWithBlockImages` transform (sdk.js): when
 * images.blockImages is enabled, image parts in user/toolResult messages are
 * replaced with a placeholder text (deduplicated) before every request.
 * The snapshot must apply the identical transform to stay byte-identical.
 */
export function blockImageMessages(messages: Any[]): Any[] {
  return messages.map((msg: Any) => {
    if (msg?.role !== "user" && msg?.role !== "toolResult") return msg;
    const content = msg?.content;
    if (!Array.isArray(content) || !content.some((c: Any) => c?.type === "image")) return msg;
    const filtered = content
      .map((c: Any) => (c?.type === "image" ? { type: "text", text: BLOCKED_IMAGE_TEXT } : c))
      .filter(
        (c: Any, i: number, arr: Any[]) =>
          !(
            c?.type === "text" &&
            c.text === BLOCKED_IMAGE_TEXT &&
            i > 0 &&
            arr[i - 1]?.type === "text" &&
            arr[i - 1]?.text === BLOCKED_IMAGE_TEXT
          ),
      );
    return { ...msg, content: filtered };
  });
}

function estimateChars(messages: Any[], vcc: VccModule): number {
  let total = 0;
  for (const message of messages) total += vcc.estimateMessageContentChars(message?.content);
  return total;
}

/** Rough char count for the prefix assertion only (no dependency on pi-vcc). */
function roughChars(messages: Any[]): number {
  try {
    return JSON.stringify(messages).length;
  } catch {
    return 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Draft
// ────────────────────────────────────────────────────────────────────────────

function compileDraft(
  prep: Any,
  cfg: Config,
  log: Logger,
  vcc: VccModule,
): { draft: string; charsPerToken: number; spanMessages: number } {
  const spanMessages = [...(prep?.messagesToSummarize ?? []), ...(prep?.turnPrefixMessages ?? [])];
  const llm = convertToLlm(spanMessages as Any) as Any[];
  // Mirror upstream before-compact.ts: the calibration numerator includes the
  // previous summary's chars (it is part of the context tokens) as well as
  // the span's own chars.
  const chars =
    estimateChars(llm, vcc) + (typeof prep?.previousSummary === "string" ? prep.previousSummary.length : 0);
  const calibration = vcc.calibrateCharsPerToken(chars, prep?.tokensBefore);
  const charsPerToken = calibration.charsPerToken || 4;
  const { floorTokens, ceilingTokens, tokensPerBlock } = cfg.draftBudget;
  const draft: string = vcc.compileRanked({
    messages: llm as Any,
    previousSummary: prep?.previousSummary,
    fileOps: {
      readFiles: [...(prep?.fileOps?.read ?? [])],
      modifiedFiles: [...(prep?.fileOps?.written ?? []), ...(prep?.fileOps?.edited ?? [])],
    } as Any,
    ranking: {
      maxBriefChars: Math.round(floorTokens * charsPerToken),
      maxBriefCharsCeiling: Math.round(ceilingTokens * charsPerToken),
      briefCharsPerBlock: Math.round(tokensPerBlock * charsPerToken),
    },
  });
  log("draft", {
    vccVersion: vcc.version,
    vccPath: vcc.packageDir,
    spanMessages: spanMessages.length,
    calibrationChars: chars,
    charsPerToken,
    calibrated: calibration.mode,
    draftChars: draft.length,
    draftTokens: tokensOf(draft, charsPerToken),
  });
  return { draft, charsPerToken, spanMessages: spanMessages.length };
}

// ────────────────────────────────────────────────────────────────────────────
// Tool execution (called from index.ts)
// ────────────────────────────────────────────────────────────────────────────

export interface ToolOutcome {
  content: Array<{ type: "text"; text: string }>;
  /** AgentToolResult requires `details`; we carry none. */
  details: undefined;
  /** Internal flag used when building the check-loop toolResult messages. */
  isError?: boolean;
}

const text = (value: string, isError = false): ToolOutcome =>
  isError
    ? { content: [{ type: "text", text: value }], details: undefined, isError: true }
    : { content: [{ type: "text", text: value }], details: undefined };

export function toolPatch(params: Any): ToolOutcome {
  if (!phase?.active) return text(ERR_TOOL_OUTSIDE_PHASE, true);
  const changes = params?.changes;
  const result = applyChanges({
    draft: phase.draft,
    changes: changes as Change[],
    capTokens: phase.capTokens,
    charsPerToken: phase.charsPerToken,
  });
  if (!result.ok) {
    phase.guard.fails += 1;
    let message = result.error;
    if (result.repeatOf) {
      const seen = (phase.failedOldTexts.get(result.repeatOf) ?? 0) + 1;
      phase.failedOldTexts.set(result.repeatOf, seen);
      if (seen >= 2) message += `\n${ERR_REPEAT_HINT}`;
    }
    return text(message, true);
  }
  phase.guard.fails = 0;
  phase.draft = result.text;
  return text(result.receipt);
}

export function toolDraft(params: Any): ToolOutcome {
  if (!phase?.active) return text(ERR_TOOL_OUTSIDE_PHASE, true);
  const section = typeof params?.section === "string" ? params.section.trim() : "";
  if (phase.guard.draftReads >= phase.maxDraftReads) {
    return text(ERR_DRAFT_READ_CAP(phase.maxDraftReads), true);
  }
  phase.guard.draftReads += 1;
  const body = section ? extractSection(phase.draft, section) : phase.draft;
  // The budget is about the finalized summary (the transcript is stripped), so
  // report that number rather than the raw draft size.
  const shown = effectiveTokensOf(phase.draft, phase.charsPerToken);
  return text(`${draftHeader(shown, phase.capTokens)}\n\n${body}`);
}

export function toolDone(): ToolOutcome {
  if (!phase?.active) return text(ERR_TOOL_OUTSIDE_PHASE, true);
  phase.guard.done = true;
  return text(TOOL_DONE_OK);
}

function extractSection(draft: string, header: string): string {
  const wanted = header.startsWith("[") ? header : `[${header}]`;
  const lines = draft.split("\n");
  const headers = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((entry) => SECTION_RE.test(entry.line));
  const start = headers.find((entry) => entry.line === wanted);
  if (!start) return `Section ${wanted} not found; full draft:\n\n${draft}`;
  const next = headers.find((entry) => entry.index > start.index);
  return lines.slice(start.index, next ? next.index : lines.length).join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// The check loop
// ────────────────────────────────────────────────────────────────────────────

/**
 * The assistant message that closed the last real request — the reply the
 * server already generated and already holds in its slot KV. The check
 * request appends it between the snapshot and the tail instruction so the
 * wire body is a strict continuation of what the server last processed
 * (the same relationship the server's KV reuse recognizes between normal
 * turns: request N+1 = request N's context + its reply + new user message).
 * Without it, the check prefix diverges from the slot's stored
 * (prompt + reply) sequence and the server prefills the whole prefix even
 * though the leading messages are byte-identical.
 * Returns null when there is nothing to continue: no last assistant in the
 * session, or the last one is already part of the snapshot's context (the
 * turn was aborted before its reply was appended — nothing new to reuse).
 */
export function snapshotContinuationAssistant(ctx: Any): Any | null {
  if (!snapshot?.messages?.length) return null;
  let branch: Any[] = [];
  try {
    branch = ctx?.sessionManager?.getBranch?.() ?? [];
  } catch {
    return null;
  }
  let lastAssistant: Any = null;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      lastAssistant = entry.message;
      break;
    }
  }
  if (!lastAssistant) return null;
  const canon = (m: Any) => JSON.stringify({ role: m?.role, content: m?.content });
  const json = canon(lastAssistant);
  const snapMsgs = snapshot.messages as Any[];
  for (let i = snapMsgs.length - 1; i >= 0; i--) {
    const msg = snapMsgs[i];
    if (msg?.role === "assistant") {
      // Same reply the snapshot already carries — nothing new to continue.
      return canon(msg) === json ? null : lastAssistant;
    }
  }
  return lastAssistant;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** pi-ai 0.87: subset of cacheWrite written with 1h retention (Anthropic only). */
  cacheWrite1h?: number;
  /** pi-ai 0.87: reasoning tokens, a subset of output (provider-dependent). */
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const addUsage = (target: Usage, source: Any): void => {
  if (!source || typeof source !== "object") return;
  target.input += source.input ?? 0;
  target.output += source.output ?? 0;
  target.cacheRead += source.cacheRead ?? 0;
  target.cacheWrite += source.cacheWrite ?? 0;
  // Optional provider-reported breakdowns (pi-ai 0.87 Usage). Mirror pi's
  // combineUsage: stay undefined unless at least one side reports them.
  if (source.cacheWrite1h !== undefined || target.cacheWrite1h !== undefined) {
    target.cacheWrite1h = (target.cacheWrite1h ?? 0) + (source.cacheWrite1h ?? 0);
  }
  if (source.reasoning !== undefined || target.reasoning !== undefined) {
    target.reasoning = (target.reasoning ?? 0) + (source.reasoning ?? 0);
  }
  target.totalTokens += source.totalTokens ?? (source.input ?? 0) + (source.output ?? 0);
};

async function runCheckLoop(args: {
  ctx: Any;
  model: Any;
  cfg: Config;
  signal: AbortSignal | undefined;
  capTokens: number;
  charsPerToken: number;
  reserveTokens: number;
  customInstructions?: string;
  log: Logger;
}): Promise<{ summary: string; usage: Usage; rounds: number }> {
  const { ctx, model, cfg, signal, capTokens, charsPerToken, reserveTokens, customInstructions, log } = args;
  const usage = emptyUsage();
  // Byte-level verification of the check request (round 1 only): the custom
  // fetch below injects the captured wire tools verbatim and captures the
  // outgoing body, which is then compared against the previous real
  // request's wire body (sentinel baseline, else our own capture).
  const checkCapture: { url?: string; bodyText?: string } = {};
  const draftTokens = effectiveTokensOf(phase!.draft, charsPerToken);
  const instruction = buildTailInstruction({
    draft: phase!.draft,
    capTokens,
    reserveTokens,
    modelMaxTokens: model?.maxTokens ?? 0,
    draftTokens,
    customInstructions,
  });

  const continuation = snapshotContinuationAssistant(ctx);
  const messages: Any[] = [
    ...(snapshot?.messages ?? []),
    // The last real request's own reply (if the session has one beyond the
    // snapshot): makes the check body a strict continuation of what the
    // server last processed, so its slot KV is reused instead of prefilled.
    ...(continuation ? [continuation] : []),
    { role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() },
  ];
  if (continuation) log("continuation", { appended: true });

  const tools = snapshot?.tools;
  // Fail closed: without the last request's tools the check request cannot
  // reuse the prefix and the model would not even see the vcc_* tools.
  if (!tools?.length) {
    throw new Error(
      "vcc-plus: no tool definitions in the last-request snapshot; the check request could not reuse the prefix",
    );
  }
  // Fail closed: the wire tools contained a shape that cannot be
  // reconstructed byte-exactly (grammar/custom, strict: true, deferred
  // loading, unknown) — a degraded check request would break the prefix.
  if (snapshot?.toolsRoundTrip === "mismatch") {
    throw new Error(
      "vcc-plus: last request's wire tools are not byte-reconstructable (strict/grammar/deferred or unknown shape); refusing a degraded check request",
    );
  }

  while (phase!.guard.rounds < cfg.guards.maxRounds) {
    if (signal?.aborted) throw new Error("vcc-plus: aborted by the user");

    const controller = new AbortController();
    // No time-based guardrails by default: slow local models are expected.
    const timer = cfg.guards.callTimeoutMs > 0
      ? setTimeout(() => controller.abort(), cfg.guards.callTimeoutMs)
      : undefined;
    const onAbort = () => controller.abort();
    signal?.addEventListener?.("abort", onAbort, { once: true });

    let response: Any;
    try {
      response = await ctx.modelRegistry.complete(
        model,
        { systemPrompt: snapshot?.systemPrompt, messages, tools },
        {
          maxTokens: capTokens,
          signal: controller.signal,
          // Only align the request-level parameters when configured to: they
          // are required where the provider re-renders the prefix or keys its
          // cache on them, and cost thinking time where they are not.
          fetch: buildCheckFetch(
            snapshot?.wireTools,
            checkCapture,
            cfg.alignCheckParams === false ? undefined : snapshot?.wireParams,
          ),
        },
      );
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }

    // Fail closed on non-successful responses. pi-ai RESOLVES (does not
    // reject) with the AssistantMessage itself on API errors and aborts —
    // stopReason "error" | "aborted" plus errorMessage — so these must be
    // checked here; otherwise a failed round would look like "no tool calls"
    // and the uncorrected draft would be finalized silently.
    // "length" = output truncated mid tool-call batch (partial arguments are
    // unsafe to apply); "deferred" = no content available to inspect.
    if (
      signal?.aborted ||
      response?.stopReason === "error" ||
      response?.stopReason === "aborted" ||
      response?.stopReason === "length" ||
      response?.stopReason === "deferred" ||
      response?.errorMessage
    ) {
      const detail = response?.errorMessage ? `: ${String(response.errorMessage).slice(0, 300)}` : "";
      throw new Error(
        `vcc-plus: check request did not succeed (stopReason=${response?.stopReason ?? "unknown"}${detail})`,
      );
    }

    phase!.guard.rounds += 1;
    addUsage(usage, response?.usage);

    // Verify the check request's bytes against the last real request (once,
    // on the first round). The body is written next to the sentinel's files
    // so it can be inspected independently. "Not verified" is a visible state:
    // this branch ALWAYS logs a checkPrefix line on round 1.
    if (phase!.guard.rounds === 1) {
      if (checkCapture.bodyText) {
        const baseline = readWireBaseline(ctx?.cwd, snapshot?.at);
        if (baseline) {
          try {
            const verification = verifyCheckPrefix(
              JSON.parse(baseline.pretty),
              JSON.parse(checkCapture.bodyText),
              baseline.source,
            );
            try {
              const dir = join(ctx?.cwd, ".pi", "prefix-sentinel");
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, "check-request.json"), checkCapture.bodyText, "utf8");
            } catch {
              /* the log line below still records the result */
            }
            log("checkPrefix", { ...verification, baselineTs: baseline.ts });
          } catch (e) {
            log("checkPrefix", { identical: null, error: String(e) });
          }
        } else {
          log("checkPrefix", {
            identical: null,
            baselineSource: null,
            reason: "no fresh wire baseline (missing, or older than the snapshot — stale leftover?)",
          });
        }
      } else {
        log("checkPrefix", {
          identical: null,
          baselineSource: null,
          fetchCalled: checkCapture.bodyText !== undefined,
          reason:
            checkCapture.bodyText === undefined
              ? "custom fetch was never called (provider ignored options.fetch?)"
              : "custom fetch was called but no JSON body string was captured",
        });
      }
    }

    const prefixTokens = snapshot?.prefixTokens ?? 0;
    const cacheRead = response?.usage?.cacheRead ?? 0;
    const cacheSuspect = prefixTokens > 0 && cacheRead < prefixTokens * 0.5;
    log("round", {
      round: phase!.guard.rounds,
      input: response?.usage?.input,
      cacheRead,
      output: response?.usage?.output,
      expectedPrefixTokens: prefixTokens,
      prefixSuspect: cacheSuspect,
      toolsSource: snapshot?.toolsSource,
      toolsRoundTrip: snapshot?.toolsRoundTrip,
      toolsCount: snapshot?.tools?.length ?? 0,
    });

    const calls = (response?.content ?? []).filter((part: Any) => part?.type === "toolCall");
    if (calls.length === 0) break;

    messages.push({ ...response });
    for (const call of calls) {
      const name = String(call?.name ?? "");
      let outcome: ToolOutcome;
      if (name === "vcc_patch") outcome = toolPatch(call?.arguments ?? {});
      else if (name === "vcc_draft") outcome = toolDraft(call?.arguments ?? {});
      else if (name === "vcc_done") outcome = toolDone();
      else if (name === "vcc_recall") outcome = text(ERR_RECALL_IN_CHECK, true);
      else outcome = text(ERR_TOOL_NOT_ALLOWED, true);

      messages.push({
        role: "toolResult",
        toolCallId: call?.id,
        toolName: name,
        content: outcome.content,
        isError: outcome.isError === true,
        timestamp: Date.now(),
      });
      log("tool", { name, ok: outcome.isError !== true });
    }

    if (phase!.guard.done) break;
    if (phase!.guard.fails >= cfg.guards.maxConsecutiveFails) {
      throw new Error(`vcc-plus: ${phase!.guard.fails} consecutive patch failures; giving up on this compaction`);
    }
  }

  if (!phase!.guard.done) {
    log("loop_end_without_done", { rounds: phase!.guard.rounds, requireDone: cfg.guards.requireDone });
    // A text-only "stop" response leaves a cap-validated draft (only
    // successful, P4-checked patches modified it), so the default is to
    // accept it with a warning. requireDone escalates this to a hard failure.
    if (ctx?.hasUI) {
      ctx.ui.notify("vcc-plus: the model stopped without vcc_done; using the current draft", "warning");
    }
    if (cfg.guards.requireDone) {
      throw new Error("vcc-plus: the model never called vcc_done (guards.requireDone)");
    }
  }
  // The draft is a reader's artifact (sections + a mechanical transcript of the
  // replaced turns + upstream's recall note). The summary handed to pi must be
  // the sections only: strip the rest mechanically so the next window does not
  // open with a transcript that reads like the kept turns were duplicated.
  const finalized = finalizeSummary(phase!.draft);
  if (finalized.report.changed || finalized.report.passthrough) {
    log("finalize", { ...finalized.report });
  }
  return { summary: finalized.text, usage, rounds: phase!.guard.rounds };
}

// ────────────────────────────────────────────────────────────────────────────
// session_before_compact
// ────────────────────────────────────────────────────────────────────────────

export async function onBeforeCompact(event: Any, ctx: Any, cfg: Config): Promise<Any> {
  if (!cfg.enabled) return undefined;

  const prep = event?.preparation;
  const log = createLogger(safeSessionId(ctx), cfg.debugLog);
  const reason = String(event?.reason ?? "auto");
  log("compact_start", { reason, willRetry: event?.willRetry ?? false, tokensBefore: prep?.tokensBefore, firstKeptEntryId: prep?.firstKeptEntryId });

  if (!prep) {
    log("abort", { why: "no preparation" });
    return undefined;
  }

  let vcc: VccModule;
  try {
    vcc = await loadVcc(cfg.vccPackagePath);
    log("vcc_loaded", { version: vcc.version, path: vcc.packageDir });
  } catch (error) {
    log("abort", { why: "pi-vcc not available", error: String(error) });
    return fail(cfg, ctx, log, reason, String(error), prep);
  }

  let model: Any;
  try {
    model = cfg.checkModel ? ctx.modelRegistry.find(cfg.checkModel.provider, cfg.checkModel.id) : ctx.model;
  } catch {
    model = undefined;
  }
  if (!model) {
    log("abort", { why: "no model" });
    return fail(cfg, ctx, log, reason, "no usable model", prep);
  }

  const reserveTokens = prep?.settings?.reserveTokens ?? 16384;
  const capTokens = Math.min(Math.floor(0.8 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : 32768);

  let draft: string;
  let charsPerToken = 4;
  try {
    const compiled = compileDraft(prep, cfg, log, vcc);
    draft = compiled.draft;
    charsPerToken = compiled.charsPerToken;
  } catch (error) {
    log("abort", { why: "draft failed", error: String(error) });
    return fail(cfg, ctx, log, reason, `draft generation failed: ${String(error)}`, prep);
  }

  if (!draft.trim()) {
    log("abort", { why: "empty draft" });
    return fail(cfg, ctx, log, reason, "mechanical draft was empty", prep);
  }

  if (!snapshot?.messages?.length) {
    // Cold start: module state died with the previous process (e.g. /reload).
    // Reuse the last complete snapshot persisted for this session, if one
    // exists; otherwise fall through to the cold-start rebuild below.
    if (restoreSnapshot(ctx)) {
      log("snapshot_restored", {
        at: snapshot?.at ?? 0,
        tools: snapshot?.tools?.length ?? 0,
        toolsRoundTrip: snapshot?.toolsRoundTrip,
      });
    } else if (rebuildSnapshotFromSession(ctx)) {
      // Cold start: no request observed yet in this process, none persisted for
      // this session. Rebuilt from the session so /compact works instead of
      // failing closed; the missing wire details are logged and show up as a
      // prefixSuspect round if they actually broke the prefix.
      log("snapshot_rebuilt", {
        messages: snapshot?.messages?.length ?? 0,
        tools: snapshot?.tools?.length ?? 0,
        systemPromptChars: snapshot?.systemPrompt?.length ?? 0,
        prefixTokens: snapshot?.prefixTokens ?? 0,
        note: "no wire snapshot available: wire tool order/shape and request-level parameters are unknown",
      });
    }
  }

  if (!snapshot?.messages?.length) {
    // Without the last-request snapshot the check request cannot reuse the
    // prefix at all (no system prompt, no tools) — fail closed instead of
    // sending a one-message request that silently abandons the design.
    // Reached only when even the session has nothing to rebuild from: an empty
    // session, or pi's ctx not exposing the session projection/tools.
    log("abort", { why: "no snapshot of the last provider request yet" });
    return fail(
      cfg,
      ctx,
      log,
      reason,
      "no snapshot of the last provider request yet, and the session has nothing to rebuild one from (empty session, or pi did not expose the session projection/tools). Send one normal message first, then run /compact again",
      prep,
    );
  }

  phase = {
    active: true,
    draft,
    capTokens,
    charsPerToken,
    maxDraftReads: cfg.guards.maxDraftReads,
    guard: { rounds: 0, fails: 0, draftReads: 0, done: false },
    failedOldTexts: new Map(),
  };

  try {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `vcc-plus: checking compaction draft (draft ${effectiveTokensOf(draft, charsPerToken)} tokens / cap ${capTokens})`,
        "info",
      );
    }
    const result = await runCheckLoop({
      ctx,
      model,
      cfg,
      signal: event?.signal,
      capTokens,
      charsPerToken,
      reserveTokens,
      customInstructions: typeof event?.customInstructions === "string" ? event.customInstructions : undefined,
      log,
    });
    log("summary_final", {
      rounds: result.rounds,
      chars: result.summary.length,
      tokens: tokensOf(result.summary, charsPerToken),
      usage: result.usage,
    });
    if (ctx.hasUI) {
      ctx.ui.notify(
        `vcc-plus: summary finalized (${result.rounds} rounds, ${tokensOf(result.summary, charsPerToken)} tokens)`,
        "info",
      );
    }
    return {
      compaction: {
        summary: result.summary,
        firstKeptEntryId: prep.firstKeptEntryId,
        tokensBefore: prep.tokensBefore,
        usage: result.usage,
      },
    };
  } catch (error) {
    log("abort", { why: "check loop failed", error: String(error) });
    return fail(cfg, ctx, log, reason, String(error), prep);
  } finally {
    phase = null;
  }
}

/**
 * Failure policy. Never silently falls back to pi's native summarizer unless
 * fallbackToNative is explicitly enabled: undefined would let pi run its own
 * (prefix-breaking) summarization instead.
 */
function fail(cfg: Config, ctx: Any, log: Logger, reason: string, message: string, prep?: Any): Any {
  if (cfg.onFailure === "draft" && phase?.draft) {
    log("fallback_draft", { message });
    if (ctx?.hasUI) ctx.ui.notify(`vcc-plus: using the unchecked draft (${message})`, "warning");
    const finalized = finalizeSummary(phase.draft);
    log("finalize", { ...finalized.report, after: "fallback_draft" });
    return {
      compaction: {
        summary: finalized.text,
        firstKeptEntryId: prep?.firstKeptEntryId,
        tokensBefore: prep?.tokensBefore,
      },
    };
  }
  if (cfg.fallbackToNative) {
    log("fallback_native", { message });
    return undefined;
  }
  const manual = reason === "manual";
  const mode = cfg.onFailure === "auto" ? (manual ? "throw" : "cancel") : cfg.onFailure;
  // Inner errors already carry the "vcc-plus:" prefix — don't double it.
  const bare = message.replace(/^vcc-plus:\s*/, "");
  if (mode === "throw") {
    log("fail_closed", { mode, message: bare });
    throw new Error(`vcc-plus: ${bare}`);
  }
  log("fail_closed", { mode: "cancel", message });
  if (ctx?.hasUI) {
    ctx.ui.notify(
      message.includes("no snapshot of the last provider request")
        ? "vcc-plus: no provider-request snapshot yet — send one normal message, then run /compact again"
        : `vcc-plus: compaction check failed; this compaction was cancelled (${message})`,
      "warning",
    );
  }
  return { cancel: true };
}

function safeSessionId(ctx: Any): string | undefined {
  try {
    return ctx?.sessionManager?.getSessionId?.() ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Test-only hooks — never called by pi at runtime (kept for the unit tests
 * that drive runCheckLoop / fail with controlled inputs).
 */
export const __internals = {
  applyChanges,
  tokensOf,
  compileDraft,
  toolsFromPayload,
  toolsRoundTripStatus,
  buildCheckFetch,
  verifyCheckPrefix,
  readWireBaseline,
  blockImageMessages,
  extractSection,
  runCheckLoop,
  fail,
  persistSnapshot,
  restoreSnapshot,
  rebuildSnapshotFromSession,
  setToolProvider,
  snapshotContinuationAssistant,
  _testSetPhase: (p: Phase | null) => {
    phase = p;
  },
  _testSetSnapshot: (s: Snapshot | null) => {
    snapshot = s;
  },
  _getSnapshot: (): Snapshot | null => snapshot,
};
