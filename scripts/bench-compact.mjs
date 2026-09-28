#!/usr/bin/env node
/**
 * A/B compaction benchmark: native pi vs pi-vcc-plus on an identical seeded session.
 *
 * Same as e2e-rpc-compact-test.mjs, plus:
 *  - parameterized target chars + extra pi CLI args (for --no-extensions / -e)
 *  - wall-clock timing around the compact RPC and around each prompt
 *
 * Usage: node scripts/bench-compact.mjs <modelRef> <benchCwd> <seedSession> <targetChars> [--extra pi args...]
 * Output: console lines + <benchCwd>/bench-timing.json
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

const [MODEL, CWD, MAIN_SESSION, TARGET_CHARS_STR, ...EXTRA_ARGS] = process.argv.slice(2);
if (!MODEL || !CWD || !MAIN_SESSION || !TARGET_CHARS_STR) {
  console.error("usage: bench-compact.mjs <modelRef> <benchCwd> <seedSession> <targetChars> [extra pi args]");
  process.exit(2);
}
const TARGET_CHARS = Number(TARGET_CHARS_STR);
if (!existsSync(MAIN_SESSION)) { console.error("no seed session at", MAIN_SESSION); process.exit(2); }

// ── 1. Collect real content from the seed session (identical for A and B)
const blocks = [];
for (const line of readFileSync(MAIN_SESSION, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  const m = e?.message;
  if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
  const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: typeof m.content === "string" ? m.content : "" }];
  const text = parts.filter((p) => p?.type === "text" && p.text).map((p) => p.text).join("\n").trim();
  if (text.length >= 200) blocks.push({ role: m.role, text });
}
let collected = 0;
const chosen = [];
for (const b of blocks) {
  if (collected >= TARGET_CHARS) break;
  chosen.push(b);
  collected += b.text.length;
}
const N = 3;
const per = Math.ceil(chosen.length / N);
const prompts = [];
let off = 0;
for (let i = 0; i < N; i++) {
  const ch = chosen.slice(off, off + per);
  off += per;
  prompts.push(`这是工作会话的内容摘录（第 ${i + 1}/${N} 段）：\n\n${ch.map((b) => b.text).join("\n\n---\n\n")}\n\n请只回复：收到第${i + 1}段。`);
}
console.log(`[seed] ${chosen.length} messages, ${collected} chars, model=${MODEL}, extra=[${EXTRA_ARGS.join(" ")}]`);

// ── 2. Bench dir setup
mkdirSync(CWD, { recursive: true });
if (!existsSync(`${CWD}/.pi`)) mkdirSync(`${CWD}/.pi`, { recursive: true });
writeFileSync(`${CWD}/.pi/settings.json`, JSON.stringify({ compaction: { keepRecentTokens: 2000 } }, null, 2));
const EVENTS_LOG = `${CWD}/rpc-events.log`;
if (existsSync(EVENTS_LOG)) writeFileSync(EVENTS_LOG, "");

const child = spawn(
  "pi",
  ["--mode", "rpc", "--model", MODEL, "--name", "vcc-bench", "--approve", ...EXTRA_ARGS],
  { cwd: CWD, shell: true, stdio: ["pipe", "pipe", "pipe"] },
);
let buf = "";
const pending = new Map();

child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).replace(/\r$/, "");
    buf = buf.slice(idx + "\n".length);
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    appendFileSync(EVENTS_LOG, line + "\n");
    if (rec.type === "turn_end" && rec.message?.usage) {
      const u = rec.message.usage;
      turnUsages.push({
        ts: new Date().toISOString(),
        input: u.input, cacheRead: u.cacheRead, output: u.output,
        totalTokens: u.totalTokens,
        text: (rec.message.content ?? []).filter((p) => p?.type === "text").map((p) => p.text).join(" ").slice(0, 60),
      });
    }
    if (rec.type === "response" && rec.id && pending.has(rec.id)) {
      pending.get(rec.id)(rec);
      pending.delete(rec.id);
    }
  }
});
child.stderr.on("data", (d) => appendFileSync(`${CWD}/rpc-stderr.log`, d.toString()));

let seq = 0;
const send = (obj, timeoutMs = 600_000) => new Promise((resolve, reject) => {
  const id = `req-${++seq}`;
  const timer = setTimeout(() => {
    if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout waiting for ${obj.type} response`)); }
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
    await sleep(1500);
  }
}

const turnUsages = [];
const timing = { model: MODEL, targetChars: TARGET_CHARS, extraArgs: EXTRA_ARGS, seed: MAIN_SESSION, prompts: [], compact: null, postCompact: null, turnUsages, sessionFile: null, error: null };
let sessionId = null;
try {
  const st0 = await send({ type: "get_state" });
  sessionId = st0?.data?.sessionId;
  timing.sessionFile = st0?.data?.sessionFile;
  console.log(`[rpc] session ${sessionId} at ${timing.sessionFile}`);

  for (let i = 0; i < prompts.length; i++) {
    const t0 = Date.now();
    const r = await send({ type: "prompt", message: prompts[i] });
    if (!r.success) throw new Error(`prompt ${i + 1} rejected: ${JSON.stringify(r)}`);
    await waitIdle();
    const dt = Date.now() - t0;
    timing.prompts.push(dt);
    console.log(`[rpc] prompt ${i + 1}/${N} done in ${(dt / 1000).toFixed(1)}s`);
  }

  const c0 = Date.now();
  const c = await send({ type: "compact" }, 3_600_000);
  const compactMs = Date.now() - c0;
  timing.compact = { ms: compactMs, response: c };
  console.log(`[compact] done in ${(compactMs / 1000).toFixed(1)}s`);
  console.log("[compact-response] " + JSON.stringify(c).slice(0, 500));

  // Post-compaction turn: the first turn in the NEW context. This is where
  // the two designs differ: native's fresh summary text is a new prefix (cold
  // prefill), vcc's check request already computed the KV for the draft that
  // becomes the summary (prefix hit).
  const p0 = Date.now();
  const pr = await send({ type: "prompt", message: "ok" });
  if (!pr.success) throw new Error(`post-compact prompt rejected: ${JSON.stringify(pr)}`);
  await waitIdle();
  const postMs = Date.now() - p0;
  timing.postCompact = { ms: postMs, turnsRecorded: turnUsages.length };
  console.log(`[post-compact] done in ${(postMs / 1000).toFixed(1)}s, turn usages so far: ${turnUsages.length}`);
} catch (err) {
  timing.error = String(err);
  console.log(`[error] ${String(err)}`);
} finally {
  writeFileSync(`${CWD}/bench-timing.json`, JSON.stringify(timing, null, 2));
  try { child.stdin.end(); } catch { /* ignore */ }
  setTimeout(() => child.kill(), 2000).unref();
  process.exit(0);
}
