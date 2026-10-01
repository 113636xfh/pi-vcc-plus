import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logDir } from "./config";

export interface Logger {
  (event: string, data?: Record<string, unknown>): void;
  path: string;
}

/**
 * Full-fidelity record of one check phase: every thinking delta, every tool
 * call with its authoritative arguments, and every receipt.
 *
 * The JSONL log above is for assertions — it keeps counters and status lines so
 * a run can be compared against the next one. It is the wrong shape for the
 * question "what was the model actually thinking", because the text is not in
 * it at all: `thinking_delta` only ever incremented a character count, and tool
 * arguments were summarized as "+N/-M lines". This tracer is that missing
 * record, written as markdown so it can be read directly.
 *
 * Thinking goes to the file and not to the widget on purpose: a local 27B emits
 * five figures of characters per round, which would bury the additions that
 * are the point of the view. Tool calls are short and few, so those go to both.
 */
export interface Tracer {
  /** Model request boundary. */
  round(n: number): void;
  thinking(delta: string): void;
  text(delta: string): void;
  /** A call finished streaming; `argsJson` is the authoritative argument JSON. */
  toolCall(name: string, argsJson: string): void;
  /** The receipt handed back for that call. */
  toolResult(name: string, text: string, isError: boolean): void;
  /** Phase-level marker (model, draft size, final summary size, ...). */
  note(text: string): void;
  close(): void;
  readonly path: string;
}

const INERT_TRACER: Tracer = {
  round: () => {},
  thinking: () => {},
  text: () => {},
  toolCall: () => {},
  toolResult: () => {},
  note: () => {},
  close: () => {},
  path: "",
};

export function createTracer(sessionId: string | undefined, enabled: boolean): Tracer {
  const safe = (sessionId ?? "unknown").replace(/[^\w.-]/g, "_").slice(0, 80);
  // Disabled means *no* path, not a path nothing writes to: engine and the view
  // both gate on `trace.path` being truthy, and a real path here would announce
  // a trace that is never produced.
  if (!enabled) return { ...INERT_TRACER, path: "" };
  const path = join(logDir(), `${safe}.trace.md`);

  // Never let a trace write break a compaction: every sink swallows its own
  // errors, same rule as createLogger above.
  const write = (text: string): void => {
    try {
      mkdirSync(logDir(), { recursive: true });
      appendFileSync(path, text);
    } catch {
      /* ignore */
    }
  };
  write(`# vcc-plus check trace\n\n- session: \`${safe}\`\n- started: ${new Date().toISOString()}\n\n`);

  let thinking = "";
  let text_ = "";
  const fence = (body: string): string => "```\n" + body.replace(/\r/g, "") + "\n```\n\n";
  const flush = (): void => {
    if (thinking) {
      write(`#### thinking (${thinking.length} chars)\n\n${fence(thinking.trim())}`);
      thinking = "";
    }
    if (text_) {
      write(`#### model text (${text_.length} chars)\n\n${fence(text_.trim())}`);
      text_ = "";
    }
  };

  return {
    path,
    round(n) {
      flush();
      write(`\n## round ${n}\n\n`);
    },
    thinking(delta) {
      thinking += delta;
    },
    text(delta) {
      text_ += delta;
    },
    toolCall(name, argsJson) {
      flush();
      write(`#### tool call — \`${name}\`\n\n${fence(argsJson || "(no arguments)")}`);
    },
    toolResult(name, body, isError) {
      write(`→ ${isError ? "**error**" : "ok"}\n\n${fence(body)}`);
      if (!isError) write(`\n`);
      void name;
    },
    note(text) {
      flush();
      write(`> ${text}\n\n`);
    },
    close() {
      flush();
      write(`\n---\n\n- ended: ${new Date().toISOString()}\n`);
    },
  };
}

let counter = 0;

export function createLogger(sessionId: string | undefined, enabled: boolean): Logger {
  const safe = (sessionId ?? "unknown").replace(/[^\w.-]/g, "_").slice(0, 80);
  const path = join(logDir(), `${safe}.jsonl`);
  const log = ((event: string, data: Record<string, unknown> = {}) => {
    if (!enabled) return;
    try {
      mkdirSync(logDir(), { recursive: true });
      appendFileSync(
        path,
        `${JSON.stringify({ ts: new Date().toISOString(), seq: ++counter, event, ...data })}\n`,
      );
    } catch {
      // logging must never break compaction
    }
  }) as Logger;
  log.path = path;
  try {
    mkdirSync(logDir(), { recursive: true });
  } catch {
    /* ignore */
  }
  return log;
}
