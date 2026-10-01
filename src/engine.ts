/**
 * pi-vcc-plus engine.
 *
 * Flow: VCC produces a mechanical draft -> the draft is appended to an exact
 * copy of the last provider request (snapshot) -> the model corrects it with
 * vcc_delete / vcc_add / vcc_draft / vcc_done -> the corrected draft becomes the
 * compaction summary. No extra summarization request, no prefix change.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { configPath, type Config } from "./config";
import { createLogger, createTracer, type Logger } from "./log";
import { CANONICAL_SECTIONS, finalizeSummary, isSectionHeaderName, routeHeader } from "./finalize";
import { applyAdd, applyDeletes, effectiveTokensOf, SECTION_RE, tokensOf, type Applied, type Rejected } from "./patch";
import {
  ERR_DRAFT_READ_CAP,
  ERR_RECALL_IN_CHECK,
  ERR_REPEAT_HINT,
  ERR_TOOL_NOT_ALLOWED,
  ERR_TOOL_OUTSIDE_PHASE,
  ERR_VCC_DELETE_REDIRECT,
  EMPTY_ROUND_NUDGE,
  TOOL_DONE_OK,
  buildTailInstruction,
  draftHeader,
  numberLines,
  renderForModel,
} from "./prompt";
import { isBlockImagesEnabled } from "./pi-settings";
import { loadVcc, type VccModule } from "./vcc";
import { mountCheckView, type LiveCheckView } from "./check-ui";
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
  /** "mismatch" = the wire tools contain a shape we cannot hand the adapter as
   * a tool parameter at all (a grammar/custom tool, or an entry with no
   * recoverable JSON schema) — the check request must fail closed.
   * Provider flags on a schema we *can* read (`strict`, `defer_loading`) are
   * deliberately not a mismatch: the raw write-back restores them verbatim.
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
  guard: {
    rounds: number;
    fails: number;
    draftReads: number;
    done: boolean;
    /** Successful vcc_add / vcc_delete calls applied so far. */
    edits: number;
    /** Times an edit-less round was re-asked (guards.emptyRetries caps this). */
    emptyRetries: number;
  };
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
  return restoreSnapshotWhy(ctx).ok;
}

/**
 * Restore, and say why not.
 *
 * A silent false here is the worst kind of failure: the request still works
 * (rebuildSnapshotFromSession takes over), but it pays a full prefill instead
 * of reusing the prefix, and the log only shows "no wire snapshot available" —
 * which does not distinguish "no file yet" from "another session's file" from
 * "the file is incomplete". Those have different fixes, so the reason is part
 * of the return value.
 */
export function restoreSnapshotWhy(ctx: Any): { ok: boolean; reason: string } {
  if (snapshot?.tools?.length) return { ok: true, reason: "already in memory" };
  const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : undefined;
  const sessionId = safeSessionId(ctx);
  if (!cwd) return { ok: false, reason: "no ctx.cwd" };
  if (!sessionId) return { ok: false, reason: "no ctx.sessionId" };
  const path = join(cwd, ".pi", "vcc-plus", SNAPSHOT_FILE);
  try {
    if (!existsSync(path)) return { ok: false, reason: `no snapshot file at ${path}` };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Any;
    if (parsed?.sessionId !== sessionId) {
      return {
        ok: false,
        reason: `snapshot file belongs to another session (${String(parsed?.sessionId).slice(0, 8)}…, this one is ${sessionId.slice(0, 8)}…)`,
      };
    }
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      return { ok: false, reason: "snapshot file has no messages" };
    }
    if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) {
      return { ok: false, reason: "snapshot file has no tools" };
    }
    if (parsed.toolsRoundTrip === "mismatch") {
      return { ok: false, reason: "snapshot file is a fail-closed tools mismatch" };
    }
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
    return { ok: true, reason: "restored" };
  } catch (err) {
    return { ok: false, reason: `snapshot file unreadable: ${(err as Error)?.message ?? err}` };
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
 * strict) are not re-derived here — and do not need to be: buildCheckFetch
 * writes the captured RAW wire tools back into the body verbatim, so they reach
 * the wire byte-exact. All this function has to guarantee is that the adapter
 * receives a usable tool definition (name + JSON schema), which is exactly what
 * toolsRoundTripStatus checks.
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
 * The wire contract this extension is built on.
 *
 * The check request reuses the previous request's prefix by rewriting its body
 * (raw wire tools in, captured request-level parameters back), which needs an
 * adapter that (a) takes a custom `fetch` and (b) speaks a JSON request body we
 * can parse. That is the OpenAI-compatible `/v1/chat/completions` interface —
 * what OpenAI itself, and the common local servers, expose — plus Anthropic's
 * messages API, whose tool shape (`input_schema`) is reconstructed exactly.
 *
 * Anything else (Google Generative AI / Vertex, Bedrock Converse) does not take
 * a custom fetch, and its tool encoding cannot be rebuilt from the wire. We do
 * not degrade silently there: a check request whose prefix quietly diverged
 * would cost a full prefill and hide the reason. We fail closed, with a message
 * that names the contract.
 */
const SUPPORTED_APIS = new Set(["openai-completions", "anthropic-messages"]);

const CONTRACT =
  "supported wire: OpenAI-compatible /v1/chat/completions (api \"openai-completions\") " +
  'or Anthropic messages (api "anthropic-messages")';

/** Adapters that cannot carry the byte-exact prefix rewrite. */
function unsupportedApiReason(api: unknown): string | null {
  const id = typeof api === "string" ? api : "";
  if (!id) return null; // unknown/custom api: let the request decide
  return SUPPORTED_APIS.has(id)
    ? null
    : `this model runs on pi's "${id}" adapter, which is not ${CONTRACT}`;
}

/**
 * Tool flags that the *reconstruction* drops but the raw wire-tools write-back
 * restores, so they must not fail the check request.
 *
 * pi-ai emits `strict` on every OpenAI-style tool whenever the model's
 * `compat.supportsStrictMode !== false` — which is the default — so treating
 * `strict: true` as unreconstructable made the extension refuse to compact on
 * essentially every OpenAI-compatible backend (observed: 400-free but
 * fail-closed on opencode-go). `defer_loading` and `cache_control` are the same
 * kind of case: provider-owned metadata we never re-derive, and never need to.
 *
 * If the raw write-back ever fails to apply, these *are* what pi-ai's own
 * re-serialization would drop — and that shows up where it belongs, in the
 * `checkPrefix` log (identical=false, or fetchCalled=false), not as a guess made
 * before the request.
 */
const RESTORED_BY_RAW_WRITEBACK = new Set(["strict", "defer_loading", "cache_control", "eager_input_streaming"]);

/** Flags present in the captured wire tools that only the write-back preserves. */
export function wireToolCaveats(wireTools: Any): string[] {
  if (!Array.isArray(wireTools)) return [];
  const found = new Set<string>();
  for (const t of wireTools) {
    if (!t || typeof t !== "object") continue;
    for (const holder of [t, t.function]) {
      if (!holder || typeof holder !== "object") continue;
      for (const [key, value] of Object.entries(holder)) {
        if (RESTORED_BY_RAW_WRITEBACK.has(key) && value != null && value !== false) found.add(key);
      }
    }
  }
  return [...found].sort();
}

/**
 * Can we hand the adapter a usable tool definition for every wire tool?
 *
 * That is the only thing this has to answer, because the bytes that reach the
 * wire come from the raw capture (buildCheckFetch writes `wireTools` back
 * verbatim) — not from this reconstruction. So the failure cases are only the
 * shapes with no JSON schema to pass along:
 *  - type: "custom" (grammar tools) — not a JSON-schema tool at all
 *  - unrecognized shape — no function.parameters / input_schema / parameters
 *
 * Provider flags that merely ride along on a readable schema (`strict`,
 * `defer_loading`) are NOT failures: pi-ai's own re-serialization would drop
 * them, but it never gets to run — the write-back replaces the whole array. See
 * wireToolCaveats.
 */
export function toolsRoundTripStatus(wireTools: Any): "ok" | "mismatch" | undefined {
  if (!Array.isArray(wireTools)) return undefined;
  for (const t of wireTools) {
    if (!t || typeof t !== "object") return "mismatch";
    // A grammar tool carries no JSON schema at all, so there is nothing to hand
    // the adapter as a tool parameter — unlike strict/defer_loading, which ride
    // along on a schema we do have and are restored by the raw write-back.
    if (t.type === "custom" || t.custom) return "mismatch";
    const hasOpenAiFunction = !!t.function && typeof t.function.name === "string";
    const hasAnthropicSchema = typeof t.name === "string" && !!t.input_schema;
    const hasPlainSchema = typeof t.name === "string" && !!t.parameters;
    if (!hasOpenAiFunction && !hasAnthropicSchema && !hasPlainSchema) return "mismatch";
  }
  return "ok";
}

/**
 * Why the wire tools cannot be rebuilt byte-exactly, in words. `toolsRoundTrip`
 * answers *whether*; this answers *which shape* — "unknown shape" on its own is
 * unactionable, whereas "Google functionDeclarations" tells the reader their
 * backend is outside the contract.
 */
export function unsupportedToolReason(wireTools: Any): string | null {
  if (!Array.isArray(wireTools)) return null;
  for (const t of wireTools) {
    if (!t || typeof t !== "object") return "a tool entry is not an object";
    if (t.type === "custom" || t.custom) return "grammar-constrained tool (type: custom)";
    if (t.functionDeclarations) return "Google functionDeclarations tool encoding";
    if (t.toolSpec) return "Bedrock toolSpec tool encoding";
    if (!t.function?.name && !t.name) return "an unrecognized tool shape";
  }
  return null;
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

export function toolDelete(params: Any): ToolOutcome {
  if (!phase?.active) return text(ERR_TOOL_OUTSIDE_PHASE, true);
  const result = applyDeletes({
    draft: phase.draft,
    lines: params?.lines as number[],
    capTokens: phase.capTokens,
    charsPerToken: phase.charsPerToken,
  });
  return patchOutcome(result);
}

export function toolAdd(params: Any): ToolOutcome {
  if (!phase?.active) return text(ERR_TOOL_OUTSIDE_PHASE, true);
  const result = applyAdd({
    draft: phase.draft,
    section: params?.section,
    lines: params?.lines,
    replace: params?.replace === true,
    capTokens: phase.capTokens,
    charsPerToken: phase.charsPerToken,
  });
  return patchOutcome(result);
}

/** Shared result handling: failure bookkeeping (repeat hint) and the draft swap. */
function patchOutcome(result: Applied | Rejected): ToolOutcome {
  if (!phase?.active) return text(ERR_TOOL_OUTSIDE_PHASE, true);
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
  const body = section ? extractSection(phase.draft, section) : renderForModel(phase.draft);
  // The budget is about the finalized summary (the transcript is stripped), so
  // report that number next to the raw size of what is actually shown.
  const shown = effectiveTokensOf(phase.draft, phase.charsPerToken);
  const raw = tokensOf(phase.draft, phase.charsPerToken);
  return text(`${draftHeader(shown, phase.capTokens, raw)}\n\n${body}`);
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
  if (!start) return `Section ${wanted} not found; full draft:\n\n${renderForModel(draft)}`;
  const next = headers.find((entry) => entry.index > start.index);
  // numbered like the full view, so the model can delete from this excerpt too
  const slice = lines.slice(start.index, next ? next.index : lines.length);
  return numberLines(slice, start.index).join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// The check loop
// ────────────────────────────────────────────────────────────────────────────

/**
 * What pi keeps verbatim after the cut: the setting it used plus the concrete
 * tail (message count and rough token size). Quoted in the instruction so the
 * model knows how much of the session it neither has to restate nor to
 * re-extract.
 */
export function keptTurnStats(ctx: Any, prep: Any): { keepRecentTokens: number; messages: number; tokens: number } {
  const keepRecentTokens = Number(prep?.settings?.keepRecentTokens) || 0;
  let messages = 0;
  let tokens = 0;
  try {
    const branch: Any[] = ctx?.sessionManager?.getBranch?.() ?? [];
    const at = branch.findIndex((entry) => entry?.id === prep?.firstKeptEntryId);
    const kept = (at >= 0 ? branch.slice(at) : []).filter((entry) => entry?.type === "message");
    messages = kept.length;
    tokens = Math.ceil(roughChars(kept.map((entry) => entry.message)) / 4);
  } catch {
    /* the configured number alone is still worth stating */
  }
  return { keepRecentTokens, messages, tokens };
}

/**
 * Provider context-overflow errors, across backends:
 *   llama.cpp: request (322385 tokens) exceeds the available context size (262144 tokens)
 *   vLLM:      The engine prompt is too long / maximum context length is N tokens
 *   OpenAI:    This model's maximum context length is N tokens
 * Only parsed when the provider rejected the prompt for length; the numbers are
 * what makes the follow-up (trim to fit) possible.
 */
export function parseOverflowError(message: string): { tokens: number | null; limit: number | null } | null {
  const text = String(message ?? "");
  if (!/context|too long|too many tokens|n_prompt_tokens/i.test(text)) return null;
  const tokens = Number(
    /(?:request \(|n_prompt_tokens"?\s*[:=]\s*|\(\s*)(\d{3,})\s*tokens?/.exec(text)?.[1] ?? NaN,
  );
  const limit = Number(
    /(?:available context size|maximum context length|context (?:size|window)|max_model_len)\(?\s*(\d{3,})/.exec(text)?.[1] ??
      /(?:available context size|maximum context length|context (?:size|window)|max_model_len)[^\d]{0,20}(\d{3,})/i.exec(
        text,
      )?.[1] ??
      NaN,
  );
  if (!Number.isFinite(tokens) && !Number.isFinite(limit)) return null;
  return {
    tokens: Number.isFinite(tokens) ? tokens : null,
    limit: Number.isFinite(limit) ? limit : null,
  };
}

/**
 * Cut the check request down to the newest part that fits the provider's window.
 *
 * The provider's own counts give the true chars-per-token ratio for this content
 * (pi's own estimate is chars/4, which a Chinese-heavy session beats by ~1.8x),
 * so the budget is converted back into the measure we can slice by. Always keeps
 * the newest messages, and at least two of them: the point is to still have the
 * model write the summary of a session whose context no longer fits anywhere.
 */
export function trimCheckMessages(args: {
  messages: Any[];
  sentChars: number;
  reportedTokens: number;
  limitTokens: number;
  reserveTokens: number;
  draftTokens: number;
}): { messages: Any[]; report: Record<string, unknown> } {
  const { messages, sentChars, reportedTokens, limitTokens, reserveTokens, draftTokens } = args;
  const ratio = reportedTokens > 0 ? sentChars / reportedTokens : 4;
  const budget = Math.max(1, limitTokens - reserveTokens - draftTokens);
  const keepChars = Math.floor(budget * ratio * 0.9); // 10% safety margin
  const sizes = messages.map((m) => roughChars([m]) + 1);
  const kept: Any[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (kept.length >= 2 && chars + sizes[i] > keepChars) break;
    kept.unshift(messages[i]);
    chars += sizes[i];
  }
  return {
    messages: kept,
    report: {
      dropped: messages.length - kept.length,
      kept: kept.length,
      charsPerToken: Number(ratio.toFixed(3)),
      keepChars,
      sentChars,
      reportedTokens,
      limitTokens,
      budget,
    },
  };
}

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

/**
 * One check round's model request, streamed into the live view.
 *
 * pi-ai's `complete` is literally `stream(...).result()`, so the message this
 * returns is the one `complete` would have returned and every check below it is
 * unchanged — the only difference is that the deltas pass through on the way.
 *
 * `stream` is optional on the registry (pi's peer range is `*`), so a registry
 * without it falls back to `complete`: the check still runs, it just is not
 * rendered live.
 */
/**
 * One check request's outcome: the final AssistantMessage plus the thinking
 * stream it produced. `truncated` is true when we aborted the stream ourselves
 * because the thinking hit `thinkingCapChars`; the response then carries
 * stopReason "aborted" by design and its tool calls (if any) are not applied —
 * the harvested thinking is the supplement instead.
 */
interface CheckRoundResult {
  response: Any;
  thinking: string;
  thinkingChars: number;
  truncated: boolean;
}

async function requestCheckRound(args: {
  ctx: Any;
  model: Any;
  messages: Any[];
  tools: Any[];
  systemPrompt: string | undefined;
  options: Any;
  view: LiveCheckView;
  /** Hard cap on thinking characters. 0 / undefined = no cap. */
  thinkingCapChars?: number;
  /** Aborted when the cap is hit (the same controller the timeout/user use). */
  controller?: AbortController;
}): Promise<CheckRoundResult> {
  const { ctx, model, messages, tools, systemPrompt, options, view } = args;
  const cap = args.thinkingCapChars ?? 0;
  if (typeof ctx?.modelRegistry?.stream !== "function") {
    const response = await ctx.modelRegistry.complete(model, { systemPrompt, messages, tools }, options);
    const thinking = (response?.content ?? [])
      .filter((part: Any) => part?.type === "thinking")
      .map((part: Any) => String(part?.thinking ?? ""))
      .join("\n");
    return { response, thinking, thinkingChars: thinking.length, truncated: false };
  }
  const stream = ctx.modelRegistry.stream(model, { systemPrompt, messages, tools }, options);
  let thinking = "";
  let truncated = false;
  for await (const event of stream as AsyncIterable<Any>) {
    view.push(event);
    if (event?.type === "thinking_delta") {
      thinking += String(event.delta ?? "");
      // The universal force-truncate: provider-independent. We cannot stop the
      // model mid-thinking and let it continue, but we can cut the stream at a
      // cap and keep what it thought — that is the supplement source.
      if (cap > 0 && thinking.length > cap && !truncated) {
        truncated = true;
        args.controller?.abort();
      }
    }
  }
  const response = await stream.result();
  return { response, thinking, thinkingChars: thinking.length, truncated };
}

/**
 * Extract the summary sections a model drafted inside its thinking stream.
 *
 * Fast reasoning models frequently write the whole supplement as `[Section]`
 * blocks in their thinking and then under-commit it (or never commit it, when we
 * cut the stream at the thinking cap). This recovers those drafted sections:
 * a bracket / markdown header that names a real section opens a block, and the
 * bullet lines under it are its content. Meta-reasoning prose (no bullets) and
 * arbitrary `[foo]` headers (not a known section) are ignored, so harvesting a
 * model that never drafted sections returns null and changes nothing.
 */
function detectSectionHeader(line: string): string | null {
  let t = line.trim();
  // Models often number the sections they plan ("1. [Results]:") — strip a
  // leading list marker so those still read as headers.
  t = t.replace(/^(?:\d{1,3}[.)]|[-*•])\s+/, "");
  let m: RegExpExecArray | null;
  // Trailing text is allowed ("[Key Decisions] — missing entirely. …:") — a
  // model analyzing the draft annotates the header line it plans to fill.
  // Only names that routeHeader accepts open a section, so this cannot be
  // hijacked by arbitrary bracketed prose.
  if ((m = /^\[([^\]\n]{1,80})\]/.exec(t))) return m[1]; // [Name] / [Name]: / [Name] — …
  if ((m = /^#{1,6}\s+([^\n#]{1,80}?)\s*:?$/.exec(t))) return m[1]; // ## Name / ## Name:
  if ((m = /^([A-Za-z][A-Za-z &/-]{1,79})\s*:$/.exec(t))) return m[1]; // Name:
  return null;
}

function harvestThinking(thinking: string): string | null {
  const lines = String(thinking ?? "").split("\n").map((l) => l.trim());
  const sections = new Map<string, string[]>();
  const bulletRe = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;
  let open: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const name = detectSectionHeader(line);
    if (name !== null) {
      const afterBracket = line.includes("]") ? line.slice(line.indexOf("]") + 1).trimStart() : "";
      // "[Name] (add specifics)" / "[Name] (new section)" is a plan annotation
      // about an edit, not a section header: keep whatever was open.
      if (afterBracket.startsWith("(")) continue;
      // A header line must actually introduce bullets: a model's plan list
      // ("3. [Key Decisions] — add (new section).") is followed by the next
      // entry, so it closes the section instead.
      let j = i + 1;
      while (j < Math.min(i + 3, lines.length) && !lines[j]) j++;
      const followedByBullet = j < lines.length && bulletRe.test(lines[j]);
      open = isSectionHeaderName(name) && followedByBullet ? routeHeader(name).to : null;
      continue;
    }
    const bullet = bulletRe.exec(line);
    if (open && bullet) {
      const text = line.replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/, "").trim();
      if (!text) continue;
      // Planning residue, not summary content: a bare section reference
      // ("[Files And Changes] (add specifics)") or self-deliberation
      // ("bun version? Not verified. Don't invent.") stays out of the draft.
      if (/^\[[^\]\n]{1,80}\]/.test(text)) continue;
      if (/\b(don'?t (?:invent|say|add)|not verified|could say|let me (?:write|add|say|do))\b/i.test(text)) continue;
      const list = sections.get(open) ?? [];
      if (!list.includes(text)) list.push(text);
      sections.set(open, list);
    }
  }
  const parts: string[] = [];
  for (const name of CANONICAL_SECTIONS) {
    const bullets = sections.get(name);
    if (bullets?.length) parts.push(`[${name}]\n${bullets.map((b) => `- ${b}`).join("\n")}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Transient check-request failures: worth sending again.
 *
 * A dropped connection says nothing about the draft, and failing the whole
 * compaction on one throws away the session's context over a flaky socket
 * (observed: opencode-go returning a bare "Connection error." mid-check).
 * pi-ai resolves rather than rejects on API errors, so this reads
 * `stopReason` + `errorMessage` off the response.
 *
 * Conservative by design: an unrecognised message is NOT transient and fails
 * closed as before. Guessing wrong in that direction costs a retry; guessing
 * wrong in the other direction silently compacts with a broken draft.
 */
const TRANSIENT_FAILURE = [
  /\b(408|425|429|500|502|503|504|529)\b/,
  /connection error/i,
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_[A-Z_]+/,
  /socket hang up/i,
  /fetch failed/i,
  // undici's wording when the peer drops a stream mid-response. It arrives with
  // no status code at all, so it is easy to miss and was: one "terminated"
  // failed a whole compaction before this list existed.
  /terminated/i,
  /premature close/i,
  /(connection|stream) (closed|reset)/i,
  /other side closed/i,
  /network (error|failure)/i,
  /timed?\s?out|timeout/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /rate limit|too many requests/i,
  /overloaded/i,
  /internal server error/i,
];

/** Permanent failures: retrying sends the identical request and fails again. */
const PERMANENT_FAILURE = [
  /\b(400|401|403|404|405|413|414|422)\b/,
  /MissingSessionID/i,
  /context (length|window|limit)/i,
  /context[_ ]?overflow/i,
  /prompt is too long/i,
  /maximum context length/i,
  /too many tokens/i,
  /invalid[_ ]?(api[_ ]?key|request|argument)/i,
];

/** The reason to retry, or null when this failure must not be retried. */
export function transientCheckFailure(response: Any): string | null {
  const stop = String(response?.stopReason ?? "");
  if (stop === "aborted") return null;
  const message = String(response?.errorMessage ?? "").slice(0, 400);
  if (!message && stop !== "error") return null;
  // Permanent first: a 400 can also mention a timeout, and retrying a request
  // the provider already rejected on its merits only delays the real error.
  if (PERMANENT_FAILURE.some((re) => re.test(message))) return null;
  if (!TRANSIENT_FAILURE.some((re) => re.test(message))) return null;
  return message || `stopReason=${stop}`;
}

/** 1s, 2s, 4s … capped, with jitter so parallel sessions do not sync up. */
export function retryBackoffMs(attempt: number, base = 1000, cap = 15000): number {
  const raw = Math.min(cap, base * 2 ** attempt);
  return Math.round(raw * (0.7 + Math.random() * 0.6));
}

/** Sleep that resolves false when the phase was aborted while waiting. */
async function sleepAbortable(ms: number, signal: Any): Promise<boolean> {
  if (ms <= 0) return !signal?.aborted;
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(ok);
    };
    const timer = setTimeout(() => done(true), ms);
    const onAbort = () => done(false);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) done(false);
  });
}

async function runCheckLoop(args: {
  ctx: Any;
  model: Any;
  cfg: Config;
  signal: AbortSignal | undefined;
  capTokens: number;
  charsPerToken: number;
  reserveTokens: number;
  /** prep.tokensBefore, for the live view's heading. */
  tokensBefore?: number;
  /** What pi keeps verbatim after the cut (settings value + the concrete tail). */
  keptTurns?: { keepRecentTokens: number; messages: number; tokens: number };
  customInstructions?: string;
  /** Live view override (tests). Production mounts its own from ctx.ui. */
  view?: LiveCheckView;
  log: Logger;
}): Promise<{ summary: string; usage: Usage; rounds: number }> {
  const { ctx, model, cfg, signal, capTokens, charsPerToken, reserveTokens, customInstructions, log } = args;
  const keptTurns = args.keptTurns ?? { keepRecentTokens: 0, messages: 0, tokens: 0 };
  const usage = emptyUsage();
  // Thinking streamed across the rounds, harvested at finalize into the draft.
  let allThinking = "";
  // Byte-level verification of the check request (round 1 only): the custom
  // fetch below injects the captured wire tools verbatim and captures the
  // outgoing body, which is then compared against the previous real
  // request's wire body (sentinel baseline, else our own capture).
  const checkCapture: { url?: string; bodyText?: string } = {};
  // Read the wire baseline BEFORE the first check request goes out: the
  // prefix-sentinel captures every provider request at the fetch level —
  // including this check request — and overwrites last-request.json mid-loop.
  // A baseline read after round 1 would compare the check body to itself
  // (a vacuous "identical: true").
  const wireBaseline = readWireBaseline(ctx?.cwd, snapshot?.at);
  const draftTokens = effectiveTokensOf(phase!.draft, charsPerToken);
  const instruction = buildTailInstruction({
    draft: phase!.draft,
    capTokens,
    reserveTokens,
    modelMaxTokens: model?.maxTokens ?? 0,
    draftTokens,
    keptTurns,
    customInstructions,
    thinkingCapChars: cfg.guards.thinkingCapChars,
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
  /** A context-overflow retry may replace `messages` once (see the loop). */
  let trimmed = false;
  if (continuation) log("continuation", { appended: true });

  const tools = snapshot?.tools;
  // Fail closed: the wire tools contained a shape that cannot be reconstructed
  // byte-exactly (grammar/custom, strict: true, deferred loading, or a backend
  // encoding outside the contract) — a degraded check request would break the
  // prefix. Checked before the empty-tools case because it names the cause.
  if (snapshot?.toolsRoundTrip === "mismatch") {
    const shape = unsupportedToolReason(snapshot?.wireTools);
    throw new Error(
      `vcc-plus: the last request's wire tools are not byte-reconstructable` +
        (shape ? ` (${shape})` : "") +
        `; refusing a degraded check request — ${CONTRACT}`,
    );
  }
  // Fail closed: without the last request's tools the check request cannot
  // reuse the prefix and the model would not even see the vcc_* tools.
  if (!tools?.length) {
    const api = unsupportedApiReason(model?.api);
    throw new Error(
      `vcc-plus: no tool definitions in the last-request snapshot; the check request could not reuse the prefix` +
        (api ? ` — ${api}` : ` (${CONTRACT})`),
    );
  }

  // rounds counts model requests; the extra emptyRetries attempts are only for
  // responses that carried no edits at all (see the empty-round branch below).
  const attemptBudget = cfg.guards.maxRounds + cfg.guards.emptyRetries;
  // Live view for the whole phase: a compaction-colored box above the editor
  // that streams the model's supplement as it arrives. Removed in `finally`,
  // so nothing survives the phase (pi then renders its own [compaction] box).
  //
  // debugTrace: the tracer is created here rather than per-round so it also
  // receives the tool results, which the engine produces in the dispatch loop
  // and never sends through the stream.
  const trace = createTracer(safeSessionId(ctx), cfg.debugTrace);
  if (trace.path) trace.note(`model: ${model?.id ?? "?"} · draft ${draftTokens} tokens / cap ${capTokens} tokens`);
  const view: LiveCheckView =
    args.view ??
    mountCheckView(ctx?.ui, {
      draft: phase!.draft,
      draftTokens,
      capTokens,
      tokensBefore: Number(args.tokensBefore) || 0,
      expanded: ctx?.ui?.getToolsExpanded?.() === true,
      trace,
      verbose: cfg.debugTrace,
    });
  try {
  while (phase!.guard.rounds < attemptBudget) {
    if (signal?.aborted) throw new Error("vcc-plus: aborted by the user");

    // Coerced rather than trusted: a hand-edited config with a string, null or
    // NaN here would make Math.max return NaN, and `attempt >= NaN` is false
    // forever — silently disabling the very retry this exists for.
    const retrySetting = Number(cfg.guards?.maxRequestRetries);
    const maxRetries = Number.isFinite(retrySetting) ? Math.max(0, Math.trunc(retrySetting)) : 0;
    let response: Any;
    // The thinking this round produced (harvested at finalize), and whether we
    // cut the stream at the thinking cap — a planned "aborted", not a failure.
    let roundThinking = "";
    let thinkingTruncated = false;
    // Transient transport failures are retried rather than failing the phase:
    // see transientCheckFailure(). The retry lives INSIDE the round loop, so a
    // resend does not consume one of maxRounds — rounds still counts only the
    // responses the model actually produced.
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      // No time-based guardrails by default: slow local models are expected.
      const timer = cfg.guards.callTimeoutMs > 0
        ? setTimeout(() => controller.abort(), cfg.guards.callTimeoutMs)
        : undefined;
      const onAbort = () => controller.abort();
      signal?.addEventListener?.("abort", onAbort, { once: true });
      try {
        const roundResult = await requestCheckRound({
        ctx,
        model,
        messages,
        tools,
        systemPrompt: snapshot?.systemPrompt,
        view,
        thinkingCapChars: cfg.guards.thinkingCapChars,
        controller,
        options: {
          maxTokens: capTokens,
          signal: controller.signal,
          // pi's own turns pass sessionId, and pi-ai only adds the
          // session-affinity headers when it is set (x-session-affinity /
          // x-client-request-id / session_id). Gateways route on it and reject
          // the request outright without it (observed: opencode.ai returns
          // 400 MissingSessionID), so dropping it here made the check request
          // unroutable while every normal turn worked.
          sessionId: safeSessionId(ctx),
          // Only align the request-level parameters when configured to: they
          // are required where the provider re-renders the prefix or keys its
          // cache on them, and cost thinking time where they are not.
          fetch: buildCheckFetch(
            snapshot?.wireTools,
            checkCapture,
            cfg.alignCheckParams === false ? undefined : snapshot?.wireParams,
          ),
        },
      });
        response = roundResult.response;
        roundThinking = roundResult.thinking;
        thinkingTruncated = roundResult.truncated;
    } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
      }

      const reason = attempt >= maxRetries || signal?.aborted ? null : transientCheckFailure(response);
      if (!reason) break;
      const delayMs = retryBackoffMs(attempt);
      log("check_retry", { attempt: attempt + 1, of: maxRetries, reason: reason.slice(0, 200), delayMs });
      // The failed attempt may already have streamed a partial buffer into the
      // view and the trace, both append-only per contentIndex — without a reset
      // the retry's content would splice itself onto the wreckage.
      view.reset();
      trace.note(`retry ${attempt + 1}/${maxRetries} after: ${reason.slice(0, 200)} — waiting ${delayMs}ms`);
      if (!(await sleepAbortable(delayMs, signal))) break;
    }

    // A planned thinking-cap truncation: we aborted the stream ourselves at the
    // cap, so the response is "aborted" by design and its (absent) tool calls
    // are not applied. The model's thinking is harvested at finalize. End the
    // phase — the mechanical draft plus the harvested thinking is the summary.
    if (thinkingTruncated) {
      phase!.guard.rounds += 1;
      addUsage(usage, response?.usage);
      trace.round(phase!.guard.rounds);
      if (roundThinking) allThinking += (allThinking ? "\n" : "") + roundThinking;
      log("thinking_capped", {
        chars: roundThinking.length,
        cap: cfg.guards.thinkingCapChars,
        rounds: phase!.guard.rounds,
      });
      if (ctx?.hasUI) {
        ctx.ui.notify(
          `vcc-plus: the model's thinking hit the ${cfg.guards.thinkingCapChars}-char cap; stopping it and harvesting what it drafted`,
          "info",
        );
      }
      break;
    }

    // Not truncated: this round's thinking still feeds the harvest at finalize
    // (the model may have drafted sections it did not fully commit).
    if (roundThinking) allThinking += (allThinking ? "\n" : "") + roundThinking;

    // Fail closed on non-successful responses. pi-ai RESOLVES (does not
    // reject) with the AssistantMessage itself on API errors and aborts —
    // stopReason "error" | "aborted" plus errorMessage — so these must be
    // checked here; otherwise a failed round would look like "no tool calls"
    // and the uncorrected draft would be finalized silently.
    // "length" = the output hit the completion cap. A batch that was cut off
    // mid-argument is unsafe, so a truncated response with no parsed tool calls
    // is still a failure; a truncated response that *did* parse tool calls is
    // applied and ends the pass instead, because the phase is a single
    // supplement pass and refusing it would drop everything the model had
    // already produced (observed: the model writes its additions in one batch
    // and can hit the inherited max_tokens).
    // "deferred" = no content available to inspect.
    const parsedCalls = (response?.content ?? []).filter((part: Any) => part?.type === "toolCall");
    const truncatedButUsable = response?.stopReason === "length" && parsedCalls.length > 0;
    if (
      signal?.aborted ||
      response?.stopReason === "error" ||
      response?.stopReason === "aborted" ||
      (response?.stopReason === "length" && !truncatedButUsable) ||
      response?.stopReason === "deferred" ||
      response?.errorMessage
    ) {
      const detail = response?.errorMessage ? `: ${String(response.errorMessage).slice(0, 300)}` : "";
      const overflow = parseOverflowError(String(response?.errorMessage ?? ""));
      if (overflow && cfg.onContextOverflow !== "fail") {
        // The context itself is over the provider's window (pi estimates chars/4,
        // a Chinese-heavy session is ~1.8x bigger, so pi compacts too late and
        // the provider rejects the request). There is no cached prefix to reuse
        // in that state, and refusing to compact would leave the session unable
        // to run at all: retry once with the newest slice that fits, else fall
        // back to the mechanical draft (in the caller).
        if (cfg.onContextOverflow === "trim" && !trimmed) {
          const sentChars = roughChars(messages);
          const limitTokens = overflow.limit ?? (model?.contextWindow > 0 ? model.contextWindow : 0);
          if (limitTokens > 0) {
            const trimmedRequest = trimCheckMessages({
              messages,
              sentChars,
              reportedTokens: overflow.tokens ?? Math.ceil(sentChars / charsPerToken),
              limitTokens,
              reserveTokens,
              draftTokens,
            });
            log("check_trimmed", trimmedRequest.report);
            if (ctx?.hasUI) {
              ctx.ui.notify(
                `vcc-plus: the check request is over the provider's context (${overflow.tokens ?? "?"} > ${limitTokens} tokens); retrying with the last ${trimmedRequest.messages.length} messages`,
                "warning",
              );
            }
            messages.length = 0;
            messages.push(...trimmedRequest.messages);
            trimmed = true;
            continue;
          }
        }
        const error = new Error(
          `vcc-plus: the check request does not fit the provider's context window (${overflow.tokens ?? "?"} prompt tokens vs a limit of ${overflow.limit ?? "?"}). pi estimated this session at ${tokensOf(phase!.draft, charsPerToken)} draft tokens plus the snapshot and uses chars/4 for context estimates, which under-counts non-Latin text: raise the provider's context size, or set onContextOverflow ("trim" / "draft") to compact with a smaller request or with the mechanical draft`,
        );
        (error as Any).overflow = overflow;
        throw error;
      }
      throw new Error(
        `vcc-plus: check request did not succeed (stopReason=${response?.stopReason ?? "unknown"}${detail})`,
      );
    }

    phase!.guard.rounds += 1;
    addUsage(usage, response?.usage);
    trace.round(phase!.guard.rounds);

    // Verify the check request's bytes against the last real request (once,
    // on the first round). The body is written next to the sentinel's files
    // so it can be inspected independently. "Not verified" is a visible state:
    // this branch ALWAYS logs a checkPrefix line on round 1.
    if (phase!.guard.rounds === 1) {
      if (checkCapture.bodyText) {
        const baseline = wireBaseline;
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
  const caveats = wireToolCaveats(snapshot?.wireTools);
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
      // Flags the reconstruction drops and only the raw write-back restores.
      // If checkPrefix above reports identical=false or fetchCalled=false, this
      // list is exactly what diverged.
      ...(caveats.length > 0 ? { toolsOnlyByWriteback: caveats } : {}),
    });

    const calls = parsedCalls;
    if (truncatedButUsable) {
      log("round_truncated", { round: phase!.guard.rounds, calls: calls.length });
      if (ctx?.hasUI) {
        ctx.ui.notify(
          `vcc-plus: the check response hit the output cap; applying the ${calls.length} edit call(s) that arrived`,
          "warning",
        );
      }
    }
    if (calls.length === 0) {
      // The phase ends after the response that carries the additions. A response
      // with no tool calls at all leaves the mechanical draft untouched, which is
      // strictly worse than one more attempt, so show the model its own reply and
      // ask again - but only while it has not applied anything yet.
      if (phase!.guard.edits === 0 && phase!.guard.emptyRetries < cfg.guards.emptyRetries) {
        phase!.guard.emptyRetries += 1;
        messages.push({ ...response });
        messages.push({
          role: "user",
          content: [{ type: "text", text: EMPTY_ROUND_NUDGE }],
          timestamp: Date.now(),
        });
        log("empty_round_retry", { round: phase!.guard.rounds, attempt: phase!.guard.emptyRetries });
        continue;
      }
      break;
    }

    messages.push({ ...response });
    for (const call of calls) {
      const name = String(call?.name ?? "");
      let outcome: ToolOutcome;
      // vcc_delete is no longer registered, but 49% of compactions used to call
      // it. Answer with the replacement instead of a generic rejection, so the
      // model spends one call on the right tool instead of probing the closed set.
      if (name === "vcc_delete") outcome = text(ERR_VCC_DELETE_REDIRECT, true);
      else if (name === "vcc_add") outcome = toolAdd(call?.arguments ?? {});
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
      if (trace.path) {
        trace.toolResult(
          name,
          Array.isArray(outcome.content)
            ? outcome.content.map((c: Any) => c?.text ?? "").join("\n")
            : String(outcome.content ?? ""),
          outcome.isError === true,
        );
      }
      if (outcome.isError !== true && name === "vcc_add") {
        phase!.guard.edits += 1;
      }
    }

    if (phase!.guard.done) break;
    // The first response that carried edits is the whole supplement pass
    // (maxRounds = 1 by default); the patch loop keeps running while
    // maxRounds > 1 and no vcc_done has arrived.
    if (phase!.guard.rounds >= cfg.guards.maxRounds) break;
    if (phase!.guard.fails >= cfg.guards.maxConsecutiveFails) {
      throw new Error(`vcc-plus: ${phase!.guard.fails} consecutive patch failures; giving up on this compaction`);
    }
  }
  } finally {
    // The live view exists only for the duration of the phase: pi renders the
    // durable `[compaction]` box into the transcript right after.
    view.dispose();
    // The trace outlives the view on purpose: the terminal scrolls, the file
    // does not, and the box is gone by the time anyone wants to read it.
    trace.close();
  }

  if (!phase!.guard.done) {
    // Single-round shape (the default): the phase is designed to end after the
    // model's one supplement response, so a missing vcc_done is the expected
    // end state and not worth a warning. The older patch loop (maxRounds > 1)
    // keeps its warning, because there the model was expected to finish.
    if (cfg.guards.maxRounds <= 1) {
      log("single_round_end", { rounds: phase!.guard.rounds, requireDone: cfg.guards.requireDone });
    } else {
      log("loop_end_without_done", { rounds: phase!.guard.rounds, requireDone: cfg.guards.requireDone });
      if (ctx?.hasUI) {
        ctx.ui.notify("vcc-plus: the model stopped without vcc_done; using the current draft", "warning");
      }
    }
    // A text-only "stop" response leaves a cap-validated draft (only
    // successful, P4-checked patches modified it), so the default is to
    // accept it; requireDone escalates this to a hard failure in either shape.
    if (cfg.guards.requireDone) {
      throw new Error("vcc-plus: the model never called vcc_done (guards.requireDone)");
    }
  }
  // Recover the sections the model drafted in its thinking but did not (fully)
  // commit — either it under-committed, or we cut the stream at the thinking
  // cap. Appending here lets finalizeSummary merge + dedup them against the
  // mechanical draft and any committed edits.
  if (allThinking) {
    const harvested = harvestThinking(allThinking);
    if (harvested) {
      phase!.draft = phase!.draft ? `${phase!.draft}\n\n${harvested}` : harvested;
      log("thinking_harvest", { thinkingChars: allThinking.length, harvestedChars: harvested.length });
      if (ctx?.hasUI) {
        ctx.ui.notify("vcc-plus: folded the model's drafted thinking into the summary", "info");
      }
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
  // pi sets event.signal when the user cancels; callTimeoutMs aborts the
  // per-attempt controller instead, so this is specifically "the user
  // stopped it" and not merely "the call did not finish".
  const userAborted = event?.signal?.aborted === true;
  log("compact_start", {
    reason,
    willRetry: event?.willRetry ?? false,
    tokensBefore: prep?.tokensBefore,
    firstKeptEntryId: prep?.firstKeptEntryId,
    // Effective guards: makes a stale config.json (it is read once, at extension
    // load) visible in the log instead of only in the behaviour.
    guards: { ...cfg.guards },
    configPath: configPath(),
  });

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
    return fail(cfg, ctx, log, reason, String(error), prep, { userAborted });
  }

  let model: Any;
  try {
    model = cfg.checkModel ? ctx.modelRegistry.find(cfg.checkModel.provider, cfg.checkModel.id) : ctx.model;
  } catch {
    model = undefined;
  }
  if (!model) {
    log("abort", { why: "no model" });
    return fail(cfg, ctx, log, reason, "no usable model", prep, { userAborted });
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
    return fail(cfg, ctx, log, reason, `draft generation failed: ${String(error)}`, prep, { userAborted });
  }

  if (!draft.trim()) {
    log("abort", { why: "empty draft" });
    return fail(cfg, ctx, log, reason, "mechanical draft was empty", prep, { userAborted });
  }

  if (!snapshot?.messages?.length) {
    // Cold start: module state died with the previous process (e.g. /reload).
    // Reuse the last complete snapshot persisted for this session, if one
    // exists; otherwise fall through to the cold-start rebuild below.
    // A restore miss costs a full prefill, so it always says which of the
    // several reasons it was — see restoreSnapshotWhy.
    const restored = restoreSnapshotWhy(ctx);
    if (restored.ok) {
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
        restoreMiss: restored.reason,
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
      { userAborted },
    );
  }

  phase = {
    active: true,
    draft,
    capTokens,
    charsPerToken,
    maxDraftReads: cfg.guards.maxDraftReads,
    guard: { rounds: 0, fails: 0, draftReads: 0, done: false, edits: 0, emptyRetries: 0 },
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
      tokensBefore: prep?.tokensBefore,
      keptTurns: keptTurnStats(ctx, prep),
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
    // An overflow that the registry rejects (instead of resolving as a
    // stopReason=error message) reaches here without a marker: parse the
    // message the same way runCheckLoop does, so trim/draft still apply.
    const overflow = ((error as Any)?.overflow ??
      parseOverflowError(String(error))) as { tokens: number | null; limit: number | null } | null;
    log("abort", { why: "check loop failed", error: String(error), overflow: overflow ?? undefined });
    if (overflow && cfg.onContextOverflow !== "fail") {
      // Unblock the session: the context is over the provider's window, so no
      // prefix could be reused anyway and the summary is the only way out.
      const fallback = draftFallback(
        ctx,
        log,
        "overflow_fallback",
        "the check request cannot fit the provider's context window; compacting with the mechanical draft (unchecked)",
        prep,
      );
      if (fallback) return fallback;
    }
    return fail(cfg, ctx, log, reason, String(error), prep, { userAborted });
  } finally {
    phase = null;
  }
}

/**
 * Failure policy. Never silently falls back to pi's native summarizer unless
 * fallbackToNative is explicitly enabled: undefined would let pi run its own
 * (prefix-breaking) summarization instead.
 */
/**
 * Compact with the finalized mechanical draft, without a model check. Visible
 * by construction: a log line plus a warning in the UI. Used by the explicit
 * `onFailure: "draft"` policy and when the check request cannot fit the
 * provider's context window (where refusing to compact would leave a session
 * that can no longer run at all). Returns null when there is no draft yet.
 */
export function draftFallback(ctx: Any, log: Logger, after: string, message: string, prep?: Any): Any | null {
  if (!phase?.draft) return null;
  log(after, { message });
  if (ctx?.hasUI) ctx.ui.notify(`vcc-plus: ${message}`, "warning");
  const finalized = finalizeSummary(phase.draft);
  log("finalize", { ...finalized.report, after });
  return {
    compaction: {
      summary: finalized.text,
      firstKeptEntryId: prep?.firstKeptEntryId,
      tokensBefore: prep?.tokensBefore,
    },
  };
}

function fail(
  cfg: Config,
  ctx: Any,
  log: Logger,
  reason: string,
  message: string,
  prep?: Any,
  opts?: { userAborted?: boolean },
): Any {
  // A user cancel is not a failure and must never be "recovered" from. Running
  // pi's native compaction here would compress the conversation the user just
  // stopped compressing, and they would have no way to tell that happened.
  if (opts?.userAborted) {
    log("fail_cancelled_by_user", { reason, message });
    if (ctx?.hasUI) ctx.ui.notify("vcc-plus: compaction cancelled", "info");
    return { cancel: true };
  }
  if (cfg.onFailure === "draft") {
    const fallback = draftFallback(ctx, log, "fallback_draft", `using the unchecked draft (${message})`, prep);
    if (fallback) return fallback;
  }
  if (cfg.fallbackToNative) {
    log("fallback_native", { message });
    if (ctx?.hasUI) {
      ctx.ui.notify(`vcc-plus: ${message} — falling back to pi's native compaction`, "warning");
    }
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
  applyDeletes,
  applyAdd,
  tokensOf,
  compileDraft,
  toolsFromPayload,
  toolsRoundTripStatus,
  unsupportedToolReason,
  unsupportedApiReason,
  wireToolCaveats,
  buildCheckFetch,
  verifyCheckPrefix,
  readWireBaseline,
  blockImageMessages,
  extractSection,
  harvestThinking,
  detectSectionHeader,
  runCheckLoop,
  transientCheckFailure,
  retryBackoffMs,
  fail,
  persistSnapshot,
  restoreSnapshot,
  restoreSnapshotWhy,
  rebuildSnapshotFromSession,
  setToolProvider,
  keptTurnStats,
  parseOverflowError,
  trimCheckMessages,
  draftFallback,
  snapshotContinuationAssistant,
  _testSetPhase: (p: Phase | null) => {
    phase = p;
  },
  _testSetSnapshot: (s: Snapshot | null) => {
    snapshot = s;
  },
  _getSnapshot: (): Snapshot | null => snapshot,
};
