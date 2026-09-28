#!/usr/bin/env node
/**
 * Read a pi-vcc-plus session log and print the compaction round table.
 *
 * Usage:
 *   node scripts/log-rounds.mjs               # newest session log
 *   node scripts/log-rounds.mjs <sessionId>   # substring match on the file name
 *   node scripts/log-rounds.mjs --all         # every session log, oldest first
 *
 * The check phase is one supplement pass (guards.maxRounds = 1), so a healthy
 * compaction shows exactly one `round` line followed by `single_round_end`.
 * The line that matters: `round.cacheRead` must be close to
 * `expectedPrefixTokens` (a full prefill shows cacheRead 0 / prefixSuspect
 * true). Hits are block-aligned server-side, so a remainder below one block
 * (vLLM 16 tokens, FastLLM 2048 tokens) is normal.
 * `empty_round_retry` means that round carried no edits at all and was re-asked
 * (guards.emptyRetries) instead of finalizing the untouched draft.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".pi", "agent", "vcc-plus", "log");
const args = process.argv.slice(2);

function pickFiles() {
  let names = [];
  try {
    names = readdirSync(LOG_DIR).filter((n) => n.endsWith(".jsonl") && n !== "startup.jsonl");
  } catch {
    console.error(`no log directory at ${LOG_DIR}`);
    process.exit(1);
  }
  if (args.includes("--all")) {
    return names
      .map((n) => join(LOG_DIR, n))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  }
  const needle = args.find((a) => !a.startsWith("--"));
  const matches = needle ? names.filter((n) => n.includes(needle)) : names;
  if (matches.length === 0) {
    console.error(`no session log matches ${needle ?? "(newest)"}`);
    process.exit(1);
  }
  const paths = matches.map((n) => join(LOG_DIR, n));
  paths.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  return [paths[paths.length - 1]];
}

function fmtTime(ts) {
  if (!ts) return "".padEnd(19);
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function verdict(cacheRead, expected) {
  if (typeof expected !== "number" || expected <= 0) return "";
  if (!cacheRead) return "MISS (full prefill)";
  const ratio = cacheRead / expected;
  if (ratio >= 0.9) return "hit";
  return `partial (${(ratio * 100).toFixed(0)}%)`;
}

for (const path of pickFiles()) {
  console.log(`\n=== ${path.split(/[\\/]/).pop()} ===`);
  let inCompaction = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const kind = e.event ?? e.kind;
    switch (kind) {
      case "vcc_loaded":
        inCompaction = false;
        break;
      case "draft":
        inCompaction = true;
        console.log(
          `${fmtTime(e.ts)}  draft            ${e.draftTokens} tokens (${e.calibrated ?? "?"}, ${e.charsPerToken} chars/token, span ${e.spanMessages} msgs)`,
        );
        break;
      case "continuation":
        console.log(`${fmtTime(e.ts)}  continuation     last reply appended: ${e.appended}`);
        break;
      case "checkPrefix":
        console.log(
          `${fmtTime(e.ts)}  checkPrefix      identical=${e.identical} firstDivergence=${e.firstDivergence ? JSON.stringify(e.firstDivergence) : "null"} (${e.baselineSource ?? "?"})`,
        );
        break;
      case "round": {
        const extra = e.prefixSuspect ? "  <-- PREFIX SUSPECT" : "";
        console.log(
          `${fmtTime(e.ts)}  round ${String(e.round).padEnd(10)} in=${e.input} cacheRead=${e.cacheRead} out=${e.output} expectedPrefix=${e.expectedPrefixTokens}  ${verdict(e.cacheRead, e.expectedPrefixTokens)}${extra}`,
        );
        break;
      }
      case "single_round_end":
        console.log(
          `${fmtTime(e.ts)}  single_round_end rounds=${e.rounds}${e.requireDone ? " (requireDone)" : ""}`,
        );
        break;
      case "empty_round_retry":
        console.log(
          `${fmtTime(e.ts)}  empty_round_retry round=${e.round} was empty, re-asked (attempt ${e.attempt})`,
        );
        break;
      case "loop_end_without_done":
        console.log(`${fmtTime(e.ts)}  loop_end_without_done rounds=${e.rounds} (patch loop, no vcc_done)`);
        break;
      case "summary_final":
        console.log(
          `${fmtTime(e.ts)}  summary_final    ${e.rounds} rounds, ${e.tokens} tokens` +
            (e.usage ? `, cacheRead total ${e.usage.cacheRead}` : ""),
        );
        break;
      case "fail_closed":
      case "fallback_native":
      case "fallback_draft":
        console.log(`${fmtTime(e.ts)}  ${String(kind).padEnd(16)} ${e.mode ?? ""} ${e.message ?? ""}`);
        break;
      case "snapshot_restored":
        console.log(`${fmtTime(e.ts)}  snapshot_restored`);
        break;
      default:
        break;
    }
  }
  if (!inCompaction) console.log("(no compaction in this session)");
}
