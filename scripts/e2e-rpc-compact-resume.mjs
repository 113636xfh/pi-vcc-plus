// E2E part 2: resume the compacted session, prompt about summarized content,
// then compact again to prove the post-compaction snapshot is usable.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const CWD = "<e2e-cwd>";
const SESSION =
  process.argv[2] ??
  "<USER>/.pi/agent/sessions/--D--vcc-rpc-test--/<session>.jsonl";
const MODEL = process.env.PI_PROVIDER ? `${process.env.PI_PROVIDER}/${process.env.PI_MODEL}` : null;
if (!MODEL) throw new Error("set PI_PROVIDER/PI_MODEL");

const child = spawn(
  "pi",
  ["--mode", "rpc", "--model", MODEL, "--session", SESSION, "--approve"],
  { cwd: CWD, shell: true, stdio: ["pipe", "pipe", "pipe"] },
);
child.stderr.on("data", (d) => appendFileSync(`${CWD}/rpc-stderr2.log`, d.toString()));

let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      const waiter = rec?.id ? pending.get(rec.id) : undefined;
      if (waiter) {
        pending.delete(rec.id);
        waiter(rec);
      }
    } catch { /* not a JSON line */ }
  }
});

let seq = 0;
const pending = new Map();
const send = (obj, timeoutMs = 300_000) =>
  new Promise((resolve, reject) => {
    const id = `req-${++seq}`;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${obj.type}`));
      }
    }, timeoutMs);
    pending.set(id, (rec) => {
      clearTimeout(timer);
      resolve(rec);
    });
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

let exitCode = 1;
try {
  for (const msg of ["第1段摘录的内容主要讲了什么？一两句话回答。"]) {
    const r = await send({ type: "prompt", message: msg });
    if (!r.success) throw new Error(`prompt rejected: ${JSON.stringify(r)}`);
    await waitIdle();
    const last = await send({ type: "get_last_assistant_text" });
    console.log(`[post-compact answer] ${JSON.stringify(last?.data?.text ?? "").slice(0, 300)}`);
  }
  const c = await send({ type: "compact" }, 900_000);
  console.log("[compact2-response] " + JSON.stringify(c).slice(0, 400));
  exitCode = c.success ? 0 : 1;
} catch (err) {
  console.error("[error]", err.message);
} finally {
  child.stdin.end();
  await sleep(1000);
  child.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 500).unref();
}
