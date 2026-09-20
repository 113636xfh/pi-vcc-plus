/**
 * Offline smoke test for the draft path: rebuild the span a pi compaction
 * summarized from the session log, run the vendored VCC compiler with the
 * plugin's production budget, and print the result. No model calls.
 *
 * Usage: bun test/draft-smoke.ts <session.jsonl> [compactionOrdinal] [vccPackageDir]
 */
import { readFileSync } from "node:fs";
import { loadVcc } from "../src/vcc";

const sessionFile = process.argv[2];
const ordinal = Number(process.argv[3] ?? 0);
const vccPackageDir = process.argv[4] ?? null;
const budget = { floorTokens: 1100, ceilingTokens: 2000, tokensPerBlock: 15 };

// Uses pi-vcc's own published source — pi-vcc-plus ships no copy of it.
const vcc = await loadVcc(vccPackageDir);

const entries: any[] = readFileSync(sessionFile, "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const compactionIdxs = entries.map((e, i) => (e.type === "compaction" ? i : -1)).filter((i) => i >= 0);
const idx = compactionIdxs[Math.min(ordinal, compactionIdxs.length - 1)];
const record = entries[idx];
const prev = compactionIdxs.filter((i) => i < idx).pop();
const startId = prev !== undefined ? entries[prev].firstKeptEntryId : undefined;
const startIdx = startId ? entries.findIndex((e) => e.id === startId) : entries.findIndex((e) => e.type === "message");
const endIdx = entries.findIndex((e) => e.id === record.firstKeptEntryId);
const span = entries
  .slice(startIdx >= 0 ? startIdx : 0, endIdx >= 0 ? endIdx : entries.length)
  .filter((e) => e.type === "message" && e.message)
  .map((e) => e.message);

const chars = span.reduce((sum, message) => sum + vcc.estimateMessageContentChars(message?.content), 0);
const calibration = vcc.calibrateCharsPerToken(chars, record.tokensBefore);
const charsPerToken = calibration.charsPerToken || 4;

const draft: string = vcc.compileRanked({
  messages: span as any,
  ranking: {
    maxBriefChars: Math.round(budget.floorTokens * charsPerToken),
    maxBriefCharsCeiling: Math.round(budget.ceilingTokens * charsPerToken),
    briefCharsPerBlock: Math.round(budget.tokensPerBlock * charsPerToken),
  },
});

console.log(`pi-vcc: @${"sting8k"}/pi-vcc@${vcc.version} @ ${vcc.packageDir}`);
console.log(`session: ${sessionFile.split(/[\\/]/).pop()}`);
console.log(`compaction #${ordinal}: tokensBefore=${record.tokensBefore} spanMessages=${span.length}`);
console.log(`chars=${chars} charsPerToken=${charsPerToken} (${calibration.mode})`);
console.log(`draft: ${draft.length} chars (~${Math.ceil(draft.length / charsPerToken)} tokens)`);
console.log(`native summary (recorded): ${(record.summary ?? "").length} chars`);
console.log("--- draft preview (first 1500 chars) ---");
console.log(draft.slice(0, 1500));
