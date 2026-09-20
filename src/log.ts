import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logDir } from "./config";

export interface Logger {
  (event: string, data?: Record<string, unknown>): void;
  path: string;
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
