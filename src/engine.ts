/**
 * pi-vcc-plus engine.
 *
 * Flow: VCC produces a mechanical draft -> the draft is appended to an exact
 * copy of the last provider request (snapshot) -> the model corrects it with
 * vcc_patch / vcc_draft / vcc_done -> the corrected draft becomes the
 * compaction summary. No extra summarization request, no prefix change.
 */
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { loadConfig, type Config } from "./config";
import { createLogger, type Logger } from "./log";
import { applyChanges, tokensOf, type Change } from "./patch";
import {
  ERR_DRAFT_READ_CAP,
  ERR_REPEAT_HINT,
  ERR_TOOL_NOT_ALLOWED,
  ERR_TOOL_OUTSIDE_PHASE,
  TOOL_DONE_OK,
  buildTailInstruction,
  draftHeader,
} from "./prompt";
import { loadVcc, type VccModule } from "./vcc";

type Any = any;

interface Snapshot {
  messages: Any[];
  systemPrompt: string;
  tools?: Any[];
  toolsSource: string;
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
    const messages = convertToLlm((agentMessages ?? []) as Any) as Any[];
    const { tools, source } = resolveTools(ctx);
    snapshot = {
      messages,
      systemPrompt: safeSystemPrompt(ctx),
      tools,
      toolsSource: source,
      prefixTokens:
        Math.ceil(roughChars(messages) / 4) + Math.ceil((safeSystemPrompt(ctx)?.length ?? 0) / 4),
      at: Date.now(),
    };
  } catch {
    // A failed snapshot just means the next compaction fails closed.
  }
}

export function recordPayload(payload: Any, ctx: Any): void {
  if (!snapshot) return;
  if (snapshot.tools?.length) return;
  const tools = toolsFromPayload(payload);
  if (tools?.length) {
    snapshot.tools = tools;
    snapshot.toolsSource = "before_provider_request.payload";
  }
}

function safeSystemPrompt(ctx: Any): string {
  try {
    return ctx?.getSystemPrompt?.() ?? "";
  } catch {
    return "";
  }
}

function resolveTools(ctx: Any): { tools?: Any[]; source: string } {
  try {
    const options = ctx?.getSystemPromptOptions?.();
    const selected = options?.selectedTools;
    if (Array.isArray(selected) && selected.length) {
      const inline = selected.filter((t: Any) => t && typeof t === "object" && t.name && t.parameters);
      if (inline.length === selected.length) return { tools: inline, source: "selectedTools" };
      const names = new Set(selected.filter((t: Any) => typeof t === "string"));
      const all = (ctx?.getAllTools?.() ?? []).filter((t: Any) => t?.name);
      const picked = all.filter((t: Any) => names.has(t.name));
      if (picked.length) return { tools: picked, source: "getAllTools∩selectedTools" };
    }
    const all = (ctx?.getAllTools?.() ?? []).filter((t: Any) => t?.name);
    if (all.length) return { tools: all, source: "getAllTools" };
  } catch {
    // fall through
  }
  return { source: "none" };
}

function toolsFromPayload(payload: Any): Any[] | undefined {
  const tools = payload?.tools;
  if (!Array.isArray(tools)) return undefined;
  const defs = tools
    .map((t: Any) => (t?.function ? { name: t.function.name, description: t.function.description, parameters: t.function.parameters } : t))
    .filter((t: Any) => t?.name);
  return defs.length ? defs : undefined;
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
  const chars = estimateChars(llm, vcc);
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
    spanChars: chars,
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
  isError?: boolean;
}

const text = (value: string, isError = false): ToolOutcome =>
  isError ? { content: [{ type: "text", text: value }], isError: true } : { content: [{ type: "text", text: value }] };

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
  return text(`${draftHeader(tokensOf(phase.draft, phase.charsPerToken), phase.capTokens)}\n\n${body}`);
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

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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
  log: Logger;
}): Promise<{ summary: string; usage: Usage; rounds: number }> {
  const { ctx, model, cfg, signal, capTokens, charsPerToken, reserveTokens, log } = args;
  const usage = emptyUsage();
  const draftTokens = tokensOf(phase!.draft, charsPerToken);
  const instruction = buildTailInstruction({
    draft: phase!.draft,
    capTokens,
    reserveTokens,
    modelMaxTokens: model?.maxTokens ?? 0,
    draftTokens,
  });

  const messages: Any[] = [
    ...(snapshot?.messages ?? []),
    { role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() },
  ];

  const tools = snapshot?.tools;
  let lastResponse: Any = null;

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
        { maxTokens: capTokens, signal: controller.signal },
      );
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }

    phase!.guard.rounds += 1;
    lastResponse = response;
    addUsage(usage, response?.usage);

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
    log("loop_end_without_done", { rounds: phase!.guard.rounds });
  }
  return { summary: phase!.draft, usage, rounds: phase!.guard.rounds };
}

// ────────────────────────────────────────────────────────────────────────────
// session_before_compact
// ────────────────────────────────────────────────────────────────────────────

export async function onBeforeCompact(pi: Any, event: Any, ctx: Any): Promise<Any> {
  const cfg = loadConfig();
  if (!cfg.enabled) return undefined;

  const prep = event?.preparation;
  const log = createLogger(safeSessionId(ctx), cfg.debugLog);
  const reason = String(event?.reason ?? "auto");
  log("compact_start", { reason, tokensBefore: prep?.tokensBefore, firstKeptEntryId: prep?.firstKeptEntryId });

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
    log("warn", { why: "no snapshot; check request would not reuse the prefix" });
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
        `vcc-plus: checking compaction draft (draft ${tokensOf(draft, charsPerToken)} tokens / cap ${capTokens})`,
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
    return {
      compaction: {
        summary: phase.draft,
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
  if (mode === "throw") {
    log("fail_closed", { mode, message });
    throw new Error(`vcc-plus: ${message}`);
  }
  log("fail_closed", { mode: "cancel", message });
  if (ctx?.hasUI) ctx.ui.notify(`vcc-plus: compaction check failed; this compaction was cancelled (${message})`, "warning");
  return { cancel: true };
}

function safeSessionId(ctx: Any): string | undefined {
  try {
    return ctx?.sessionManager?.getSessionId?.() ?? undefined;
  } catch {
    return undefined;
  }
}

export const __internals = { applyChanges, tokensOf, compileDraft, resolveTools, toolsFromPayload };
