#!/usr/bin/env node
/**
 * Compaction benchmark on a REAL session (resume a copy, then compact).
 *
 * bench-compact.mjs can only paste text into a fresh session, so the mechanical draft
 * never sees a tool call - the worst case for the extension and not what real use looks
 * like. This driver copies an existing session (tool calls, tool results and all) and
 * resumes it, which is the shape the extension is built for.
 *
 * The source session is never modified: the copy is compacted, the original is only read.
 *
 * 1. resume the copy (a resumed session's server-side KV is empty, so it first sends a
 *    warm-up turn - that prefill belongs to the resume, not to compaction),
 * 2. fire `compact` and time it,
 * 3. send one short post-compaction turn to time loading the new context.
 *
 * Usage:
 *   node scripts/bench-compact-session.mjs <modelRef> <benchCwd> <sourceSession> [extra pi args...]
 * Output: <benchCwd>/bench-timing.json + the [warmup]/[compact]/[post-compact] lines on stdout.
 */
import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const [MODEL, CWD, SOURCE, ...EXTRA_ARGS] = process.argv.slice(2);
if (!MODEL || !CWD || !SOURCE) {
  console.error("usage: bench-compact-session.mjs <modelRef> <benchCwd> <sourceSession> [extra pi args...]");
  process.exit(2);
}
if (!existsSync(SOURCE)) {
  console.error("no source session at", SOURCE);
  process.exit(2);
}

mkdirSync(CWD, { recursive: true });
const sessionCopy = `${CWD}/session.jsonl`;
copyFileSync(SOURCE, sessionCopy); // pristine copy; the source is read-only
const EVENTS_LOG = `${CWD}/rpc-events.log`;
writeFileSync(EVENTS_LOG, "");

const child = spawn(
  "pi",
  ["--mode", "rpc", "--model", MODEL, "--session", sessionCopy, "--approve", ...EXTRA_ARGS],
  { cwd: CWD, shell: true, stdio: ["pipe", "pipe", "pipe"] },
);

let buf = "";
const pending = new Map();
const turnUsages = [];

child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).replace(/\r$/, "");
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    appendFileSync(EVENTS_LOG, line + "\n");
    if (rec.type === "turn_end" && rec.message?.usage) {
      const u = rec.message.usage;
      turnUsages.push({ ts: new Date().toISOString(), input: u.input, cacheRead: u.cacheRead, output: u.output, totalTokens: u.totalTokens });
    }
    if (rec.type === "response" && rec.id && pending.has(rec.id)) {
      pending.get(rec.id)(rec);
      pending.delete(rec.id);
    }
  }
});
child.stderr.on("data", (d) => appendFileSync(`${CWD}/rpc-stderr.log`, d.toString()));

let seq = 0;
const send = (obj, timeoutMs = 3_600_000) => new Promise((resolve, reject) => {
  const id = `req-${++seq}`;
  const timer = setTimeout(() => {
    if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout waiting for ${obj.type}`)); }
  }, timeoutMs);
  pending.set(id, (rec) => { clearTimeout(timer); resolve(rec); });
  child.stdin.write(`${JSON.stringify({ ...obj, id })}\n`);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitIdle(timeoutMs = 1_800_000) {
  const start = Date.now();
  for (;;) {
    const st = await send({ type: "get_state" });
    const d = st?.data;
    if (d && !d.isStreaming && !d.isCompacting) return d;
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for idle");
    await sleep(2000);
  }
}

const timing = { model: MODEL, source: SOURCE, extraArgs: EXTRA_ARGS, sessionFile: sessionCopy, warmup: null, compact: null, preContextTokens: null, postCompact: null, turnUsages, error: null };
try {
  const st0 = await send({ type: "get_state" });
  console.log(`[rpc] resumed ${st0?.data?.sessionId} from ${sessionCopy}`);

  // Warm-up turn. A resumed session's server-side KV is empty, so the FIRST request pays a
  // full prefill of the whole context however it is sent. That cost belongs to the resume,
  // not to compaction, so it is measured separately: it also gives the extension its
  // last-request snapshot, which is what the check request continues (the warm shape that
  // compaction actually runs in during a real session).
  const w0 = Date.now();
  const wr = await send({ type: "prompt", message: "Reply with just: ok" });
  if (!wr.success) throw new Error(`warm-up prompt rejected: ${JSON.stringify(wr)}`);
  await waitIdle();
  timing.warmup = { ms: Date.now() - w0 };
  console.log(`[warmup] done in ${(timing.warmup.ms / 1000).toFixed(1)}s`);
  const before = turnUsages.length;

  const c0 = Date.now();
  const c = await send({ type: "compact" });
  timing.compact = { ms: Date.now() - c0, response: c };
  console.log(`[compact] done in ${(timing.compact.ms / 1000).toFixed(1)}s success=${c?.success}`);
  if (c?.data?.tokensBefore) timing.preContextTokens = c.data.tokensBefore;

  const p0 = Date.now();
  const pr = await send({ type: "prompt", message: "ok" });
  if (!pr.success) throw new Error(`post-compact prompt rejected: ${JSON.stringify(pr)}`);
  await waitIdle();
  timing.postCompact = { ms: Date.now() - p0, turns: turnUsages.length - before };
  console.log(`[post-compact] done in ${(timing.postCompact.ms / 1000).toFixed(1)}s, turns ${timing.postCompact.turns}`);
} catch (err) {
  timing.error = String(err);
  console.log(`[error] ${String(err)}`);
} finally {
  writeFileSync(`${CWD}/bench-timing.json`, JSON.stringify(timing, null, 2));
  try { child.stdin.end(); } catch { /* ignore */ }
  setTimeout(() => child.kill(), 2000).unref();
  process.exit(0);
}
