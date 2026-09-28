#!/usr/bin/env node
/**
 * bench-analyze.mjs — extract per-LLM-call usage around a compact RPC.
 *
 * Source of truth:
 *   - For VCC: ~/.pi/agent/vcc-plus/log/<sessionId>.jsonl (per-round events).
 *   - For native: <sessionFile>'s compaction.usage (single summarization call)
 *     plus any assistant messages in the session file produced while the
 *     compact RPC was open.
 *
 * Output: per-call rows + one-line summary with llmCalls, fullPrefills,
 * coldPrefills, and wall-clock compactMs.
 *
 * Usage: node scripts/bench-analyze.mjs <benchDir>
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const benchDir = process.argv[2];
if (!benchDir || !existsSync(`${benchDir}/bench-timing.json`)) {
  console.error("usage: bench-analyze.mjs <benchDir with bench-timing.json>");
  process.exit(2);
}

const timing = JSON.parse(readFileSync(`${benchDir}/bench-timing.json`, "utf8"));
const sessionFile = timing.sessionFile?.replace(/\\/g, "/");

// extract sessionId from the filename: any UUID-shaped substring after the last path separator
let sessionId;
if (sessionFile) {
  const m = sessionFile.match(/([0-9a-f]{8}-[0-9a-f-]{20,})/i);
  if (m) sessionId = m[1];
}

const sessionEntries = existsSync(sessionFile)
  ? readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

const compactEntry = sessionEntries.find((e) => e?.type === "compaction");

// ── 1. Read vcc log per-round events
const vccLogPath = sessionId ? join(homedir(), ".pi/agent/vcc-plus/log", `${sessionId}.jsonl`) : null;
const vccRounds = [];
let vccSummaryFinal = null;
if (vccLogPath && existsSync(vccLogPath)) {
  for (const line of readFileSync(vccLogPath, "utf8").split("\n").filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e?.event === "round") vccRounds.push(e);
    else if (e?.event === "summary_final") vccSummaryFinal = e;
  }
}

// ── 2. Compose rows: prefer vcc-round rows; if absent (native), use compaction.usage
const FULL_PREFILL_TOKENS = 30_000;
const rows = [];

if (vccRounds.length > 0) {
  for (const r of vccRounds) {
    const inTok = r.input ?? 0;
    const crTok = r.cacheRead ?? 0;
    const outTok = r.output ?? 0;
    const total = inTok + crTok;
    rows.push({
      source: "vcc-round",
      round: r.round,
      ts: r.ts,
      input: inTok,
      cacheRead: crTok,
      output: outTok,
      total,
      fullPrefill: total >= FULL_PREFILL_TOKENS,
      coldPrefill: crTok < 1000,
      notes: `expected=${r.expectedPrefixTokens ?? "?"}`,
    });
  }
} else if (compactEntry?.usage) {
  const u = compactEntry.usage;
  rows.push({
    source: "native-compact",
    ts: compactEntry.timestamp,
    input: u.input ?? 0,
    cacheRead: u.cacheRead ?? 0,
    output: u.output ?? 0,
    total: (u.input ?? 0) + (u.cacheRead ?? 0),
    fullPrefill: ((u.input ?? 0) + (u.cacheRead ?? 0)) >= FULL_PREFILL_TOKENS,
    coldPrefill: (u.cacheRead ?? 0) < 1000,
    notes: `native summarization`,
  });
}

console.log(`# bench-analyze: ${benchDir}`);
console.log(`model=${timing.model}  tokensBefore=${compactEntry?.tokensBefore ?? "?"}  compactMs=${timing.compact?.ms}`);
console.log(`sessionId=${sessionId}`);
console.log(`# full-prefill threshold: input+cacheRead >= ${FULL_PREFILL_TOKENS} tokens`);
console.log();
console.log("| # | source | round | ts | in | cacheR | out | total | full? | cold? | notes");
console.log("|---|--------|-------|----|----|--------|-----|-------|-------|-------|------");
rows.forEach((r, i) => {
  const round = r.round ?? "-";
  console.log(`| ${i} | ${r.source} | ${round} | ${r.ts?.slice(11, 19) ?? "-"} | ${r.input} | ${r.cacheRead} | ${r.output} | ${r.total} | ${r.fullPrefill ? "**Y**" : "n"} | ${r.coldPrefill ? "**Y**" : "n"} | ${r.notes}`);
});

const fullPrefills = rows.filter((r) => r.fullPrefill).length;
const coldPrefills = rows.filter((r) => r.coldPrefill).length;
const totalIn = rows.reduce((a, r) => a + (r.input ?? 0), 0);
const totalCr = rows.reduce((a, r) => a + (r.cacheRead ?? 0), 0);
const totalOut = rows.reduce((a, r) => a + (r.output ?? 0), 0);

console.log();
console.log(`SUMMARY:  llmCalls=${rows.length}  fullPrefills=${fullPrefills}  coldPrefills=${coldPrefills}  compactMs=${timing.compact?.ms}`);
console.log(`          totalIn=${totalIn}  totalCacheRead=${totalCr}  totalOut=${totalOut}  grandTotal=${totalIn + totalCr + totalOut}`);
if (vccSummaryFinal) {
  console.log(`          vcc-finalized: rounds=${vccSummaryFinal.rounds} chars=${vccSummaryFinal.chars} tokens=${vccSummaryFinal.tokens}`);
}
