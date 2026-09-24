import { describe, expect, test } from "bun:test";
import { applyAdd, applyDeletes } from "../src/patch";

const DRAFT = `[Session Goal]
- Discuss why MTP is slow on e5
- old goal that no longer matters

[Files And Changes]
- Modified: /home/xfh/fastllm/fastllm-src/src/models/qwen3_5.cpp

[Outstanding]
- 3 files still downloading, start 8101 after
- next step: run baseline

---

[assistant]
* bash "ls" (#12)

Use \`vcc_recall\` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.`;

const del = (lines: number[], options: { capTokens?: number; draft?: string } = {}) =>
  applyDeletes({
    draft: options.draft ?? DRAFT,
    lines,
    capTokens: options.capTokens ?? 100_000,
    charsPerToken: 4,
  });

/** 1-based line numbers of the DRAFT lines that contain `needle` (via the view). */
const numberOf = (needle: string, draft = DRAFT): number =>
  draft.split(String.fromCharCode(10)).findIndex((line) => line.includes(needle)) + 1;

const add = (
  section: string,
  lines: string[],
  options: { replace?: boolean; capTokens?: number; draft?: string } = {},
) =>
  applyAdd({
    draft: options.draft ?? DRAFT,
    section,
    lines,
    replace: options.replace,
    capTokens: options.capTokens ?? 100_000,
    charsPerToken: 4,
  });

describe("vcc_delete (applyDeletes, by line number)", () => {
  test("removes the numbered lines and the receipt shows them", () => {
    const goal = numberOf("- old goal that no longer matters");
    const result = del([goal]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain("old goal");
    expect(result.text).toContain("Discuss why MTP is slow");
    expect(result.removed).toBe(1);
    expect(result.added).toBe(0);
    expect(result.receipt).toContain("[Session Goal]");
    expect(result.receipt).toContain(`${goal} | - old goal that no longer matters`);
  });

  test("several line numbers in one call", () => {
    const result = del([numberOf("- old goal that no longer matters"), numberOf("3 files still downloading")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removed).toBe(2);
    expect(result.text).not.toContain("old goal");
    expect(result.text).not.toContain("still downloading");
    expect(result.receipt).toContain("[Outstanding]");
  });

  test("deleting every non-header line leaves just the headers", () => {
    // the sections region is everything above the "---" separator, exactly as
    // the renderer numbers it
    const region = DRAFT.split(String.fromCharCode(10, 10, 45, 45, 45, 10, 10))[0].split(String.fromCharCode(10));
    const numbers = region.map((_, i) => i + 1).filter((n) => !/^\[[^\]]+\]$/.test(region[n - 1].trim()));
    const result = del(numbers);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removed).toBe(numbers.length);
    const kept = result.text.split(String.fromCharCode(10)).filter((line) => line.trim().startsWith("["));
    expect(kept.slice(0, 3)).toEqual(["[Session Goal]", "[Files And Changes]", "[Outstanding]"]);
    // the transcript is untouched
    expect(result.text).toContain('* bash "ls"');
    expect(result.text).toContain("vcc_recall");
  });

  test("rejects an out-of-range number", () => {
    const result = del([999]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Line 999 is not in the draft");
    expect(result.error).toContain("sections region runs 1..");
  });

  test("rejects a number that points into the transcript", () => {
    const transcriptLine = numberOf('[assistant]');
    const result = del([transcriptLine]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("is in the transcript");
    expect(result.error).toContain("cannot be deleted");
  });

  test("rejects a number that points at a section header", () => {
    const result = del([numberOf("[Outstanding]")]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("is a section header");
    expect(result.error).toContain('use vcc_add with "replace":true');
  });

  test("rejects the same number twice", () => {
    const goal = numberOf("- old goal that no longer matters");
    const result = del([goal, goal]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("already touched");
  });
});

describe("vcc_add (applyAdd)", () => {
  test("appends to the end of a section without any anchor text", () => {
    const result = add("Outstanding", ["- round 1 cacheRead=37632 (hit)"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.text.split("\n");
    expect(lines[lines.indexOf("- next step: run baseline") + 1]).toBe("- round 1 cacheRead=37632 (hit)");
    // it lands in the sections region, before the transcript
    expect(result.text.indexOf("cacheRead=37632")).toBeLessThan(result.text.indexOf("\n---\n"));
    expect(result.receipt).toContain("Outstanding Context");
    expect(result.added).toBe(1);
  });

  test("the receipt shows the appended lines with their new numbers", () => {
    const result = add("Results", ["- 92/92 tests", "- cacheRead=0"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const added = result.receipt.split("\n").filter((line) => line.startsWith("  + "));
    expect(added.length).toBe(2);
    // "  +   9 | - 92/92 tests" — the number must match the new draft
    const newLines = result.text.split("\n");
    for (const entry of added) {
      const match = /^\s*\+\s*(\d+)\s*\|\s*(.*)$/.exec(entry);
      expect(match).not.toBeNull();
      expect(newLines[Number(match![1]) - 1]).toBe(match![2]);
    }
  });

  test("resolves aliases to their canonical section", () => {
    const result = add("Outstanding Context", ["- moved"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.match(/^\[Outstanding\]$/gm)?.length).toBe(1);
    expect(result.text.match(/^\[Outstanding Context\]$/gm)).toBeNull();
    expect(result.text).toContain("- moved");
  });

  test("creates a missing section at the end of the sections region", () => {
    const result = add("Results", ["- 92/92 tests", "- cacheRead=0"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("[Results]\n- 92/92 tests\n- cacheRead=0");
    expect(result.text.indexOf("[Results]")).toBeLessThan(result.text.indexOf("\n---\n"));
    expect(result.added).toBe(2);
  });

  test('replace:true rewrites a section in one call', () => {
    const result = add("Session Goal", ["- 消除压缩期间的双重 prefill"], { replace: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("[Session Goal]\n- 消除压缩期间的双重 prefill\n\n[Files And Changes]");
    expect(result.text).not.toContain("Discuss why MTP");
    expect(result.receipt).toContain("+1 -2");
    // both sides are listed, numbered: removed by their old number, added by their new one
    expect(result.receipt).toMatch(/\n\s*−\s*2 \| - Discuss why MTP is slow on e5/);
    expect(result.receipt).toMatch(/\n\s*\+\s*2 \| - 消除压缩期间的双重 prefill/);
  });

  test("replace:true on a missing section just creates it", () => {
    const result = add("Environment", ["- e5 = 192.168.2.15"], { replace: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("[Environment]\n- e5 = 192.168.2.15");
    expect(result.removed).toBe(0);
  });

  test("rejects a missing section name or empty lines", () => {
    const noSection = add("", ["- x"]);
    expect(noSection.ok).toBe(false);
    if (!noSection.ok) expect(noSection.error).toContain("needs a");

    const empty = add("Results", ["   ", ""]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("non-empty");
  });
});

describe("budget guard (P4)", () => {
  test("an empty delete list is a no-op that still checks the cap", () => {
    const noop = del([]);
    expect(noop.ok).toBe(true);
    if (noop.ok) expect(noop.text).toBe(DRAFT);

    const over = del([], { capTokens: 10 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("over the cap");
  });

  test("blocks an add that pushes the summary over the cap", () => {
    const result = add("Results", [`- ${"x".repeat(4000)}`], { capTokens: 200 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("over the cap");
  });

  test("the cap measures the finalized summary, not the draft's transcript", () => {
    // The transcript alone is over the cap, but it is stripped before pi sees
    // the summary, and the model cannot patch it anyway.
    const draft = [
      "[Session Goal]",
      "- g",
      "",
      "---",
      "",
      "[assistant]",
      `* bash "${"y".repeat(4000)}" (#1)`,
      "",
      "Use `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.",
    ].join("\n");
    const result = add("Session Goal", ["- added"], { capTokens: 200, draft });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("- added");
    expect(result.receipt).toContain("/ cap 200");
    expect(result.receipt).not.toContain("over the cap");
  });

  test("added lines survive finalization (they are above the transcript)", () => {
    const result = add("Results", ["- net effect"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.indexOf("- net effect")).toBeLessThan(result.text.indexOf("\n---\n"));
  });
});
