/**
 * Live view for the compaction check phase.
 *
 * The check request used to be awaited as one opaque `complete()` call, so the
 * TUI showed nothing for minutes while the model wrote its supplement. This
 * module renders that response as it arrives: a box shaped like a tool-call row
 * (bold `[label]` + dim detail) but painted with the *compaction* palette
 * (`customMessageBg` / `customMessageLabel` / `customMessageText` — the same
 * three colors the native `[compaction]` summary box uses), so the check reads
 * as part of the compaction flow rather than as an unrelated tool.
 *
 * Surface: `ctx.ui.setWidget` above the editor. The widget is transient by
 * construction — it is removed when the phase ends, and pi then renders the
 * real `[compaction]` summary box into the transcript, so nothing is left
 * behind and no session entry is written.
 *
 * Modes:
 *   tui         — a real pi-tui component, click to expand/collapse.
 *   rpc / print — the same content as plain text lines (RPC's setWidget only
 *                 accepts string arrays).
 *   no setWidget — inert; the notify lines and the log carry the progress.
 */
import { Box, Container, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Tracer } from "./log";

/** Widget key, also the cleanup key — must stay stable. */
const VIEW_KEY = "vcc-plus-check";

/**
 * Total body lines the expanded view may occupy. A widget renders above the
 * editor, so an unbounded draft would push the editor off screen; this is a
 * progress display, not a transcript.
 */
const MAX_BODY_LINES = 24;
/** The draft never gets fewer than this many lines when additions want space. */
const MIN_DRAFT_LINES = 6;
/** Rebuild cadence. Faster than this and a 15K-char response redraws for nothing. */
const FRAME_MS = 80;
/** Longest raw (unparsed) tool-argument tail shown while the JSON streams in. */
const RAW_ARGS_PREVIEW = 140;

/** Hard ceiling for the debug (verbose) body, to protect the terminal. */
const MAX_DEBUG_LINES = 3000;

const LABEL = "vcc_check";

export interface CheckViewInit {
  /** The mechanical draft exactly as the model receives it (unnumbered). */
  draft: string;
  /** Token size of the finalized summary the cap is measured against. */
  draftTokens: number;
  capTokens: number;
  tokensBefore: number;
  /** Initial expand state (mirrors the session's tool-expansion setting). */
  expanded: boolean;
  /**
   * Full-fidelity sink for the phase (see `createTracer`). Present only when
   * `debugTrace` is on. The view forwards every thinking delta here because it
   * is the one place that sees them: they are counted for the status line and
   * otherwise dropped, since the widget cannot hold them.
   */
  trace?: Tracer;
  /**
   * debugTrace: render tool-call arguments in full instead of the
   * `RAW_ARGS_PREVIEW` tail, and show a live tail of the thinking text. The
   * widget is still line-bounded, so this widens what is visible rather than
   * making it unbounded.
   */
  verbose?: boolean;
}

/** The subset of pi-ai's AssistantMessageEvent this view consumes. */
export interface CheckViewEvent {
  type: string;
  delta?: string;
  contentIndex?: number;
  /** Tool name, on toolcall_start / toolcall_end. */
  name?: string;
  /** Authoritative tool call, on toolcall_end. */
  toolCall?: { name?: string; arguments?: unknown };
}

export interface LiveCheckView {
  /**
   * Feed one stream event. Cheap: only marks the view dirty. Completion is
   * derived from the stream's own `done` / `error` events, so the last frame
   * painted before teardown already shows the final counters.
   */
  push(event: CheckViewEvent): void;
  /** Remove the widget. Safe to call twice. */
  dispose(): void;
  /**
   * Drop everything streamed so far, for a request that is about to be resent.
   * The buffers are append-only per contentIndex, so a retry would otherwise
   * splice its content onto whatever the failed attempt had already written.
   * The counters and the heading are kept: the phase itself did not restart.
   */
  reset(): void;
}

const INERT: LiveCheckView = {
  push: () => {},
  dispose: () => {},
  reset: () => {},
};

interface Chunk {
  kind: "text" | "toolcall";
  /** Text buffer, or the (possibly half-streamed) tool-call argument JSON. */
  buffer: string;
  name?: string;
}

interface Counters {
  thinkingChars: number;
  outputChars: number;
  startedAt: number;
  /** One `start` event per model request. */
  rounds: number;
  /** Recomputed from the chunks on every frame — never carried across frames. */
  calls: { addCalls: number; deleteCalls: number; addLines: number; deleteLines: number };
}

const newCalls = (): Counters["calls"] => ({ addCalls: 0, deleteCalls: 0, addLines: 0, deleteLines: 0 });

const newCounters = (): Counters => ({
  thinkingChars: 0,
  outputChars: 0,
  startedAt: Date.now(),
  rounds: 0,
  calls: newCalls(),
});

/**
 * Parse a streaming tool call into preview lines. Best-effort by nature: while
 * the arguments are still streaming the JSON does not parse, so the raw tail is
 * shown instead.
 *
 * `calls` is a fresh accumulator on every frame (see prepare()), so each call is
 * counted exactly once per frame without any "already counted" bookkeeping —
 * and re-parsing after `toolcall_end` swaps in the authoritative arguments
 * cannot double-count or lose the lines.
 */
function toolCallLines(chunk: Chunk, calls: Counters["calls"], verbose = false): string[] {
  let args: any;
  try {
    args = JSON.parse(chunk.buffer);
  } catch {
    const room = verbose ? Number.MAX_SAFE_INTEGER : RAW_ARGS_PREVIEW;
    const tail = chunk.buffer.slice(-room).replace(/\s+/g, " ");
    const ellipsis = chunk.buffer.length > room ? " …" : "";
    return [`  ${chunk.name ?? "vcc_add"}(… ${tail}${ellipsis}`];
  }
  const name = typeof args?.name === "string" ? args.name : chunk.name;
  chunk.name = name ?? "tool";

  if (name === "vcc_add") {
    const lines = Array.isArray(args?.lines) ? args.lines.filter((l: unknown) => typeof l === "string") : [];
    calls.addCalls += 1;
    calls.addLines += lines.length;
    const head = `  + vcc_add [${String(args?.section ?? "?")}] ${lines.length} line${lines.length === 1 ? "" : "s"}${
      args?.replace === true ? " (replace)" : ""
    }`;
    const shown = verbose ? lines : lines.slice(0, 6);
    const out = [head, ...shown.map((line: string) => `      ${line}`)];
    // Without verbose the body is capped: a replace:true on a long section
    // would otherwise print the whole thing and push the draft off the widget.
    if (!verbose && lines.length > shown.length) out.push(`      … ${lines.length - shown.length} more lines`);
    return out;
  }
  if (name === "vcc_delete") {
    const nums = Array.isArray(args?.lines) ? args.lines : [];
    calls.deleteCalls += 1;
    calls.deleteLines += nums.length;
    const list = nums.length > 0 ? ` ${nums.join(", ")}` : "";
    return [`  − vcc_delete ${nums.length} line${nums.length === 1 ? "" : "s"}${list}`];
  }
  if (verbose) {
    // Unknown tool (or vcc_done, which takes no arguments): show the raw
    // argument JSON rather than a bare `name()`, which hides what was sent.
    return [`  ${name}(${chunk.buffer})`];
  }
  return [`  ${name}()`];
}

class CheckView implements LiveCheckView {
  private readonly ui: any;
  private readonly theme: Theme;
  private readonly tui: boolean;
  /** Public: the TUI component reads draft/cap/tokens for its labels. */
  readonly init: CheckViewInit;
  /** Insertion-ordered: content blocks arrive in the order the model wrote them. */
  private readonly chunks = new Map<number, Chunk>();
  private counters = newCounters();
  /** Wall clock of the phase, kept across reset(): a retry is not a new phase. */
  private readonly startedAt = Date.now();
  /** Rolling tail of the thinking stream, shown only under `verbose`. */
  private thinkingText = "";
  /** Public: the TUI component reads it to pick its layout. */
  expanded: boolean;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** Set from the stream's own terminal event, not from the engine. */
  private finished = false;
  private failed = false;
  private tuiHandle: any;
  private component: CheckComponent | undefined;
  /** Additions rendered for the current frame, filled by prepare(). */
  private prepared: string[] = [];

  constructor(ui: any, init: CheckViewInit) {
    this.ui = ui;
    this.theme = ui.theme as Theme;
    this.tui = String(ui.mode ?? "") === "tui";
    this.init = init;
    this.expanded = init.expanded;
    this.mount();
    this.render();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  private mount(): void {
    if (this.tui) {
      // The factory runs synchronously inside setWidget, so both handles exist
      // as soon as this returns.
      this.ui.setWidget(
        VIEW_KEY,
        (tui: any, theme: Theme) => {
          this.tuiHandle = tui;
          this.component = new CheckComponent(this, theme);
          this.component.updateDisplay();
          return this.component;
        },
        { placement: "aboveEditor" },
      );
    } else {
      // RPC's setWidget ignores component factories and only renders lines.
      this.ui.setWidget(VIEW_KEY, this.plainBody(), { placement: "aboveEditor" });
    }
  }

  push(event: CheckViewEvent): void {
    if (this.disposed) return;
    const index = typeof event.contentIndex === "number" ? event.contentIndex : this.chunks.size;
    switch (event.type) {
      case "done":
        this.finished = true;
        this.dirty = true;
        this.render(); // terminal event: flush now, the phase is about to tear the view down
        return;
      case "error":
        this.finished = true;
        this.failed = true;
        this.dirty = true;
        this.render();
        return;
      case "start": {
        this.counters.rounds += 1;
        break;
      }
      case "text_start":
      case "toolcall_start": {
        const chunk = this.chunk(index, event.type === "toolcall_start" ? "toolcall" : "text");
        if (typeof event.name === "string") chunk.name = event.name;
        break;
      }
      case "text_delta":
        this.counters.outputChars += event.delta?.length ?? 0;
        this.chunk(index, "text").buffer += event.delta ?? "";
        this.init.trace?.text(event.delta ?? "");
        break;
      case "thinking_delta": {
        // Counted for the status line, never rendered inline: local-model
        // reasoning runs to five figures of characters and would bury the
        // additions that matter. debugTrace is the escape hatch — it goes to
        // the trace file in full, and `verbose` puts a live tail on screen.
        this.counters.thinkingChars += event.delta?.length ?? 0;
        this.thinkingText += event.delta ?? "";
        this.init.trace?.thinking(event.delta ?? "");
        break;
      }
      case "toolcall_delta":
        this.counters.outputChars += event.delta?.length ?? 0;
        this.chunk(index, "toolcall").buffer += event.delta ?? "";
        break;
      case "toolcall_end": {
        const chunk = this.chunk(index, "toolcall");
        const call = event.toolCall;
        if (call) {
          // The authoritative arguments replace the accumulated guess.
          if (typeof call.name === "string") chunk.name = call.name;
          if (call.arguments !== undefined) chunk.buffer = safeStringify(call.arguments);
        }
        this.init.trace?.toolCall(chunk.name ?? "(unnamed)", chunk.buffer);
        break;
      }
      default:
        return;
    }
    this.dirty = true;
    this.schedule();
  }

  private chunk(index: number, kind: Chunk["kind"]): Chunk {
    let chunk = this.chunks.get(index);
    if (!chunk) {
      chunk = { kind, buffer: "" };
      this.chunks.set(index, chunk);
    }
    if (kind === "toolcall") chunk.kind = "toolcall";
    return chunk;
  }

  reset(): void {
    if (this.disposed) return;
    this.chunks.clear();
    this.thinkingText = "";
    this.counters = newCounters();
    this.counters.startedAt = this.startedAt;
    this.finished = false;
    this.failed = false;
    this.dirty = true;
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.component?.dispose();
    this.component = undefined;
    try {
      this.ui?.setWidget?.(VIEW_KEY, undefined);
    } catch {
      /* already gone */
    }
  }

  // ── frame scheduling ───────────────────────────────────────────────────────

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.render();
    }, FRAME_MS);
    // A progress frame must never hold the process open.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private render(): void {
    if (this.disposed) return;
    if (this.tui) {
      if (this.component && this.dirty) {
        this.component.updateDisplay();
        this.tuiHandle?.requestRender?.();
      }
    } else {
      this.ui.setWidget(VIEW_KEY, this.plainBody(), { placement: "aboveEditor" });
    }
    this.dirty = false;
  }

  // ── content ────────────────────────────────────────────────────────────────

  /** One line: what the check is doing, and how far along it is. */
  status(): string {
    const c = this.counters;
    const parts: string[] = [];
    if (this.finished) {
      parts.push(this.failed ? "check failed" : `checked in ${c.rounds} round${c.rounds === 1 ? "" : "s"}`);
    } else {
      parts.push("checking draft");
    }
    const calls = c.calls.addCalls + c.calls.deleteCalls;
    if (calls > 0) {
      parts.push(
        `+${c.calls.addLines}/-${c.calls.deleteLines} lines in ${calls} call${calls === 1 ? "" : "s"}`,
      );
      const net = c.calls.addLines - c.calls.deleteLines;
      if (net !== 0) parts.push(`net ${net > 0 ? "+" : ""}${net}`);
    }
    if (c.outputChars > 0) parts.push(`${(c.outputChars / 1000).toFixed(1)}k chars out`);
    if (c.thinkingChars > 0) parts.push(`${(c.thinkingChars / 1000).toFixed(1)}k thinking`);
    if (this.init.trace?.path) parts.push("trace on");
    const elapsed = Math.max(0, Math.round((Date.now() - c.startedAt) / 1000));
    parts.push(`${elapsed}s`);
    return parts.join(" · ");
  }

  heading(): string {
    const tokens = this.init.tokensBefore.toLocaleString();
    return this.finished ? `Compacted from ${tokens} tokens` : `Compacting ${tokens} tokens`;
  }

  /**
   * Recompute the per-frame call counts from the chunks, and cache the rendered
   * additions. Must run before `status()`/`bodyLines()` — both read it, and the
   * counts it produces are what the status line reports.
   */
  prepare(): void {
    const calls = newCalls();
    this.counters.calls = calls;
    const lines: string[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.kind === "text") {
        const text = chunk.buffer.trimEnd();
        if (text) lines.push(...text.split("\n").map((l) => `  ${l}`));
        continue;
      }
      lines.push(...toolCallLines(chunk, calls, this.init.verbose === true));
    }
    this.prepared = lines;
  }

  /**
   * Expanded body: mechanical draft above, the model's live additions below.
   *
   * Additions get first claim on the space — they are the part still arriving —
   * and the draft takes what is left, always with an explicit elision note
   * rather than a silent truncation.
   *
   * Under `verbose` (debugTrace) this stops being a preview: the view is
   * already collapsed-or-expanded, and CTRL+O has said "show me", so the whole
   * thinking stream and every tool argument are rendered uncut. The 24-line
   * budget exists to keep the default box readable; applying it to a box the
   * user explicitly expanded would hide exactly the thing they expanded to see.
   */
  bodyLines(): string[] {
    return this.init.verbose === true ? this.fullBodyLines() : this.previewBodyLines();
  }

  /** Default: bounded preview, additions first, draft takes the remainder. */
  private previewBodyLines(): string[] {
    const t = this.theme;
    const additions = this.prepared;
    const addRoom = Math.max(0, MAX_BODY_LINES - MIN_DRAFT_LINES - 2);
    const keptAdditions =
      additions.length > addRoom ? additions.slice(additions.length - addRoom) : additions;
    const keptDraft = this.draftLines(Math.max(MIN_DRAFT_LINES, MAX_BODY_LINES - keptAdditions.length - 2));
    const lines = [
      t.fg("customMessageText", `draft ${this.init.draftTokens} tokens / cap ${this.init.capTokens} tokens`),
      ...keptDraft,
    ];
    if (additions.length === 0) {
      lines.push(t.fg("dim", this.finished ? "  (no additions)" : "  … waiting for the model's additions"));
    } else {
      lines.push(t.fg("customMessageLabel", "model additions"));
      if (keptAdditions.length < additions.length) {
        lines.push(t.fg("dim", `  … ${additions.length - keptAdditions.length} earlier additions`));
      }
      for (const line of keptAdditions) lines.push(t.fg("customMessageText", line));
    }
    return lines;
  }

  /**
   * debugTrace: everything, in the order it answers "what did the model do" —
   * what it thought, what it called, and the draft it was working from.
   *
   * Still line-capped, but at a ceiling that exists to protect the terminal
   * rather than to be readable; a local 27B's reasoning is routinely five
   * figures of characters and the whole point of the switch is to see it.
   */
  private fullBodyLines(): string[] {
    const t = this.theme;
    const out: string[] = [];
    out.push(...this.thinkingLines());
    if (this.prepared.length === 0) {
      out.push(t.fg("dim", this.finished ? "  (no additions)" : "  … waiting for the model's additions"));
    } else {
      out.push(t.fg("customMessageLabel", "model additions"));
      for (const line of this.overflow(this.prepared)) out.push(t.fg("customMessageText", line));
    }
    out.push(t.fg("customMessageText", `draft ${this.init.draftTokens} tokens / cap ${this.init.capTokens} tokens`));
    for (const line of this.overflow(this.init.draft.split("\n"))) out.push(t.fg("dim", line));
    if (this.init.trace?.path) out.push(t.fg("dim", `full trace: ${this.init.trace.path}`));
    return out;
  }

  /** Cap with an explicit elision note, so nothing is ever silently dropped. */
  private overflow(lines: string[]): string[] {
    if (lines.length <= MAX_DEBUG_LINES) return lines;
    const kept = lines.slice(lines.length - MAX_DEBUG_LINES);
    return [`  … ${lines.length - MAX_DEBUG_LINES} earlier lines elided`, ...kept];
  }

  /**
   * The thinking stream in full. The view keeps every delta in `thinkingText`
   * precisely so this can be rendered: counted-only was the old behavior and it
   * left no way to see what the model was reasoning about at all.
   */
  private thinkingLines(): string[] {
    const t = this.theme;
    if (this.counters.thinkingChars === 0) return [];
    const lines = this.thinkingText
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    const out = [
      t.fg("customMessageLabel", `thinking (${this.counters.thinkingChars.toLocaleString()} chars)`),
    ];
    if (lines.length === 0) return [...out, t.fg("dim", "  (no line breaks in the stream)")];
    for (const line of this.overflow(lines)) out.push(t.fg("dim", `  ${line}`));
    return out;
  }

  /** The draft as a bounded static reference (head kept, tail elided). */
  private draftLines(room: number): string[] {
    const all = this.init.draft.split("\n");
    if (all.length <= room) return all;
    return [...all.slice(0, room), `  … ${all.length - room} more draft lines (the model sees them all)`];
  }

  /** Plain-text rendering, used by the RPC/print fallback. */
  private plainBody(): string[] {
    const t = this.theme;
    this.prepare();
    const head = `${t.fg("customMessageLabel", `[${LABEL}]`)} ${this.heading()} — ${this.status()}`;
    if (!this.expanded) {
      return [
        head,
        `${t.fg("customMessageText", `draft ${this.init.draftTokens} tokens / cap ${this.init.capTokens} tokens (`)}${t.fg("dim", "expand")}${t.fg("customMessageText", ")")}`,
      ];
    }
    return [head, ...this.bodyLines()];
  }

  toggle(): void {
    this.expanded = !this.expanded;
    this.dirty = true;
    this.render();
  }
}

/**
 * The TUI component: a compaction-colored box, click to expand. Mirrors
 * CompactionSummaryMessageComponent's shape (Box + MouseRegion) so it reads as
 * the same family of UI.
 */
class CheckComponent extends Container {
  private view: CheckView;
  private theme: Theme;

  constructor(view: CheckView, theme: Theme) {
    super();
    this.view = view;
    this.theme = theme;
  }

  updateDisplay(): void {
    const t = this.theme;
    this.view.prepare();
    this.clear();
    const content = new Container();
    content.addChild(new Text(t.fg("customMessageLabel", t.bold(`[${LABEL}]`)), 0, 0));
    content.addChild(new Text(t.fg("customMessageText", `${this.view.heading()} — ${this.view.status()}`), 0, 0));
    const cap = `draft ${this.view.init.draftTokens} tokens / cap ${this.view.init.capTokens} tokens`;
    if (!this.view.expanded) {
      content.addChild(
        new Text(
          t.fg("customMessageText", `${cap} (`) + t.fg("dim", "click") + t.fg("customMessageText", " to expand)"),
          0,
          0,
        ),
      );
    } else {
      content.addChild(new Spacer(1));
      for (const line of this.view.bodyLines()) content.addChild(new Text(line, 0, 0));
    }
    const region = new MouseRegion(content, (event) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      this.view.toggle();
      return { handled: true };
    });
    const framed = new Box(1, 1, (text) => t.bg("customMessageBg", text));
    framed.addChild(region);
    this.addChild(framed);
  }

  override invalidate(): void {
    super.invalidate();
    this.updateDisplay();
  }

  dispose(): void {
    this.clear();
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Mount the live view. Returns an inert handle when the surface is
 * unavailable, so callers never branch on it.
 */
export function mountCheckView(ui: any, init: CheckViewInit): LiveCheckView {
  try {
    if (typeof ui?.setWidget !== "function") return INERT;
    if (typeof ui?.theme?.fg !== "function") return INERT;
    return new CheckView(ui, init);
  } catch {
    return INERT;
  }
}
