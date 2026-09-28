#!/usr/bin/env node
/**
 * E2E test for pi-vcc-plus compaction in a controlled short session.
 *
 * 1. Seeds a fresh RPC session (in an isolated cwd) with ~75K chars of real
 *    content copied from the main session file.
 * 2. Sends it as 3 user prompts (short model acks keep the transcript realistic).
 * 3. Fires {"type":"compact"} and waits for the full vcc-plus flow
 *    (draft -> one supplement pass -> vcc_delete / vcc_add -> finalized summary).
 *
 * For a timing/usage comparison against native compaction (3+ samples per side, since
 * one prompt's output varies by ~2.4x run to run) use scripts/bench-compact.mjs
 * plus scripts/bench-analyze.mjs instead.
 *
 * Usage: node scripts/e2e-rpc-compact-test.mjs [modelRef]
 * Output: JSON lines for every RPC record + a final result line.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

// usage: node scripts/e2e-rpc-compact-test.mjs [modelRef] [cwd] [mainSession]
//   cwd         : isolated project directory (default ./tmp-vcc-e2e)
//   mainSession : a real session JSONL to seed 75 KB of content from
//                 (or set $VCC_E2E_SEED_SESSION; required)
const CWD = process.argv[3] ?? "./tmp-vcc-e2e";
const MAIN_SESSION = process.argv[4] ?? process.env.VCC_E2E_SEED_SESSION;
if (!MAIN_SESSION || !existsSync(MAIN_SESSION)) {
  console.error("no seed session — pass it as argv[4] or set VCC_E2E_SEED_SESSION to a JSONL path.");
  process.exit(2);
}
const TARGET_CHARS = 75_000;
const MODEL = process.argv[2] ?? "fastllm/Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp";
const EVENTS_LOG = `${CWD}/rpc-events.log`;

// ── 1. Collect real content from the main session (user + assistant text, in order)
const blocks = [];
for (const line of readFileSync(MAIN_SESSION, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let e;
  try { e = JSON.parse(line); } catch { continue; }
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
console.log(`[seed] ${chosen.length} messages, ${collected} chars`);

// Cut into 3 chunks (role order doesn't matter; presented as user excerpts)
const N = 3;
const per = Math.ceil(collected / N);
const chunks = [];
let off = 0;
for (let i = 0; i < N; i++) {
  chunks.push(chosen.slice(off, off + Math.ceil(chosen.length / N)));
  off += Math.ceil(chosen.length / N);
}
const prompts = chunks.map((ch, i) =>
  `这是工作会话的内容摘录（第 ${i + 1}/${N} 段）：\n\n${ch.map((b) => b.text).join("\n\n---\n\n")}\n\n请只回复：收到第${i + 1}段。`,
);

// ── 2. RPC driver
mkdirSync(CWD, { recursive: true });
// Test-only: lower the keep-recent budget so compaction is possible in a
// short session (isolated cwd, does not affect the main session).
if (!existsSync(`${CWD}/.pi`)) mkdirSync(`${CWD}/.pi`, { recursive: true });
// keepRecentTokens must be below the tail-message accumulation so the cut
// point lands before the last turn; the system prompt (~12K tokens) alone
// can never be summarized, so the cut must be at a real user message.
writeFileSync(`${CWD}/.pi/settings.json`, JSON.stringify({ compaction: { keepRecentTokens: 2000 } }, null, 2));
if (existsSync(EVENTS_LOG)) writeFileSync(EVENTS_LOG, "");

const child = spawn(
  "pi",
  ["--mode", "rpc", "--model", MODEL, "--name", "vcc-e2e", "--approve"],
  { cwd: CWD, shell: true, stdio: ["pipe", "pipe", "pipe"] },
);
let buf = "";
const pending = new Map(); // id -> { resolve }
const events = [];

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
    events.push(rec);
    if (rec.type === "response" && rec.id && pending.has(rec.id)) {
      pending.get(rec.id)(rec);
      pending.delete(rec.id);
    }
  }
});
child.stderr.on("data", (d) => appendFileSync(`${CWD}/rpc-stderr.log`, d.toString()));

let seq = 0;
const send = (obj, timeoutMs = 60_000) => new Promise((resolve, reject) => {
  const id = `req-${++seq}`;
  const timer = setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${obj.type} response`));
    }
  }, timeoutMs);
  pending.set(id, (rec) => { clearTimeout(timer); resolve(rec); });
  child.stdin.write(`${JSON.stringify({ ...obj, id })}\n`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitIdle(timeoutMs = 300_000) {
  const start = Date.now();
  for (;;) {
    const st = await send({ type: "get_state" });
    const d = st?.data;
    if (d && !d.isStreaming && !d.isCompacting) return d;
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for idle");
    await sleep(1500);
  }
}

let sessionId = null;
let sessionFile = null;
try {
  const st0 = await send({ type: "get_state" });
  sessionId = st0?.data?.sessionId;
  sessionFile = st0?.data?.sessionFile;
  console.log(`[rpc] session ${sessionId} at ${sessionFile}`);

  for (let i = 0; i < prompts.length; i++) {
    const r = await send({ type: "prompt", message: prompts[i] });
    if (!r.success) throw new Error(`prompt ${i + 1} rejected: ${JSON.stringify(r)}`);
    await waitIdle();
    console.log(`[rpc] prompt ${i + 1}/${prompts.length} done`);
  }

  const c = await send({ type: "compact" }, 900_000);
  console.log("[compact-response] " + JSON.stringify(c));
} catch (err) {
  console.log(`[error] ${String(err)}`);
} finally {
  try { child.stdin.end(); } catch { /* ignore */ }
  setTimeout(() => child.kill(), 2000).unref();
  process.exit(0);
}
