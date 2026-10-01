import { describe, expect, test } from "bun:test";
import { CANONICAL_SECTIONS, finalizeSummary } from "../src/finalize";

/** A draft shaped like upstream VCC's real output: sections, then the brief
 *  transcript (with the previous draft's lines merged in), then the note. */
const DRAFT = `[Session Goal]
- 消除压缩期间的双重 prefill

[Files And Changes]
- src/engine.ts：新增 snapshotContinuationAssistant

[Commits]
- pi-vcc-plus: 7c78e6a

[User Preferences]
- headless pi 子命令绝不写死模型

---

[Outstanding]
- 待决定：alignCheckParams

[Root Cause: 双重 prefill（本次核心）]
- 现象（会话 01a0ca67）：cacheRead=0

---

Use \`vcc_recall\` to search for prior work, decisions, and context from before this summary. Do not redo work already
completed.

[assistant]
* edit "D:/x/src/prompt.ts" (#166)
* edit "D:/x/test/prompt.test.ts" (#168)

[user]
？
go on

[assistant]
* (10 earlier tool-call entries omitted)
* write "D:/x/docs/src/02-request-en.svg" (#249)

## 我在哨兵那边探测到这类情况

- 第一层：出站请求里的参数变化`;

describe("finalizeSummary", () => {
  test("drops the transcript, the separators and the recall note", () => {
    const { text, report } = finalizeSummary(DRAFT);
    expect(text).not.toContain("[assistant]");
    expect(text).not.toContain("[user]");
    expect(text).not.toContain("(#166)");
    expect(text).not.toContain("vcc_recall");
    expect(text).not.toContain("---");
    expect(text).not.toContain("earlier tool-call entries omitted");
    expect(report.strippedNotes).toBe(1);
    expect(report.strippedSeparators).toBe(2);
    expect(report.strippedTranscriptLines).toBeGreaterThanOrEqual(6);
  });

  test("drops prose that belongs to the transcript (assistant messages)", () => {
    const { text } = finalizeSummary(DRAFT);
    // the "## …" block after the transcript is quoted assistant prose
    expect(text).not.toContain("我在哨兵那边探测到这类情况");
    expect(text).not.toContain("第一层：出站请求里的参数变化");
  });

  test("renames alias headers and folds unknown ones into a canonical section", () => {
    const { text, report } = finalizeSummary(DRAFT);
    expect(text).toContain("[Outstanding Context]\n- 待决定：alignCheckParams");
    expect(text).not.toContain("[Outstanding]\n");
    expect(report.renamed).toEqual([{ from: "Outstanding", to: "Outstanding Context" }]);
    expect(report.folded).toEqual([{ from: "Root Cause: 双重 prefill（本次核心）", to: "Results" }]);
    expect(text).toContain("[Results]\n- 现象（会话 01a0ca67）：cacheRead=0");
  });

  test("emits the canonical sections in canonical order, and nothing else", () => {
    const { text, report } = finalizeSummary(DRAFT);
    const headers = text.match(/^\[[^\]]+\]$/gm) ?? [];
    expect(headers).toEqual([
      "[Session Goal]",
      "[Files And Changes]",
      "[Commits]",
      "[Results]",
      "[Outstanding Context]",
      "[User Preferences]",
    ]);
    expect(report.sections).toEqual(headers.map((h) => h.slice(1, -1)));
    // every canonical name is a real section, even when absent from the draft
    expect(CANONICAL_SECTIONS.length).toBe(8);
  });

  test("is idempotent", () => {
    const once = finalizeSummary(DRAFT).text;
    const twice = finalizeSummary(once);
    expect(twice.text).toBe(once);
    expect(twice.report.changed).toBe(false);
    expect(twice.report.strippedTranscriptLines).toBe(0);
    expect(twice.report.strippedNotes).toBe(0);
  });

  test("dedupes bullets repeated inside one section", () => {
    const { text, report } = finalizeSummary(`[Commits]\n- abc123\n- abc123\n- def456`);
    expect(text).toBe("[Commits]\n- abc123\n- def456");
    expect(report.dedupedBullets).toBe(1);
  });

  test("near-duplicate bullets: the richer one subsumes the shorter", () => {
    const { text, report } = finalizeSummary(
      `[Results]\n- bun test: 213 pass\n- bun test: 213 pass, 0 fail, 13 files\n- tsc clean`,
    );
    expect(text).toBe("[Results]\n- bun test: 213 pass, 0 fail, 13 files\n- tsc clean");
    expect(report.dedupedBullets).toBe(1);
  });

  test("drops planning residue inherited from a previous summary", () => {
    const { text, report } = finalizeSummary(
      [
        "[Files And Changes]",
        "- src/engine.ts modified",
        "[Commits] — probably no commits. Let me check — I don't recall any git commits.",
        "- Main line: improve compaction quality (drafts well in thinking",
        "- code bullet kept: grep `/(` for unbalanced",
        "- date kept: [2026-09-30] deploy",
      ].join("\n"),
    );
    expect(text).toBe("[Files And Changes]\n- src/engine.ts modified\n- code bullet kept: grep `/(` for unbalanced\n- date kept: [2026-09-30] deploy");
    expect(report.dedupedBullets).toBe(0);
  });

  test("a later superset bullet replaces the earlier shorter one in place", () => {
    const { text } = finalizeSummary(`[Environment]\n- repo path\n- repo path D:/01-R&D/Project-pi-vcc-plus`);
    expect(text).toBe("[Environment]\n- repo path D:/01-R&D/Project-pi-vcc-plus");
  });

  test("case/punctuation variants of the same bullet dedupe, unrelated ones stay", () => {
    const { text, report } = finalizeSummary(
      `[Key Decisions]\n- VCC_DELETE removed from registry.\n- vcc_delete removed from registry; engine returns ERR_VCC_DELETE_REDIRECT\n- unrelated decision`,
    );
    expect(text).toBe(
      "[Key Decisions]\n- vcc_delete removed from registry; engine returns ERR_VCC_DELETE_REDIRECT\n- unrelated decision",
    );
    expect(report.dedupedBullets).toBe(1);
  });

  test("keeps section bullets even when a later transcript block follows them", () => {
    const { text } = finalizeSummary(
      `[Key Decisions]\n- 对齐参数默认开启\n\n[assistant]\n* bash "git log" (#12)\n\n- 这条是转录里的后续行`,
    );
    expect(text).toBe("[Key Decisions]\n- 对齐参数默认开启");
  });

  test("resumes collecting sections after the transcript", () => {
    const { text } = finalizeSummary(
      `[assistant]\n* bash "npm test" (#7)\n\n[Results]\n- 92/92 通过`,
    );
    expect(text).toBe("[Results]\n- 92/92 通过");
  });

  test("falls back to the non-transcript text when no canonical header exists", () => {
    const { text, report } = finalizeSummary(
      `## 随便写的东西\n- a\n\n## 另一段\n- b\n\n[assistant]\n* bash "ls" (#3)`,
    );
    expect(report.usedFallbackShape).toBe(true);
    expect(text).toContain("## 随便写的东西");
    expect(text).toContain("- b");
    expect(text).not.toContain("[assistant]");
    expect(text).not.toContain("(#3)");
  });

  test("accepts markdown headings that name a known section", () => {
    const { text, report } = finalizeSummary(
      `## Goal\n- 修 prefix\n\n## Key Decisions\n- 对齐参数默认开启\n\n[assistant]\n* bash "ls" (#3)`,
    );
    expect(report.usedFallbackShape).toBe(false);
    expect(text).toBe("[Session Goal]\n- 修 prefix\n\n[Key Decisions]\n- 对齐参数默认开启");
  });

  test("returns the input unchanged when there is nothing but transcript", () => {
    const raw = `[assistant]\n* bash "ls" (#3)\n\n[user]\nhello`;
    const { text, report } = finalizeSummary(raw);
    expect(text).toBe(raw);
    expect(report.passthrough).toBe(true);
  });

  test("tolerates CRLF, a wrapped note and a note glued to a section", () => {
    const { text, report } = finalizeSummary(
      "[Commits]\r\n- 7c78e6a\r\n\r\nUse `vcc_recall` to search for prior work, decisions, and context from before this summary. Do\r\nnot redo work already completed.\r\n\r\n---\r\n",
    );
    expect(text).toBe("[Commits]\n- 7c78e6a");
    expect(report.strippedNotes).toBe(1);
    expect(report.strippedSeparators).toBe(1);
  });
});
