import { describe, expect, test } from "bun:test";
import { applyChanges } from "../src/patch";

const DRAFT = `[Session Goal]
- Discuss why MTP is slow on e5

[Files And Changes]
- Modified: /home/xfh/fastllm/fastllm-src/src/models/qwen3_5.cpp

[Outstanding Context]
- 3 files still downloading, start 8101 after
- next step: run baseline

[User Preferences]
- user asked to continue automatically`;

const apply = (changes: Array<{ oldText: string; newText: string }>, capTokens = 100_000) =>
  applyChanges({ draft: DRAFT, changes, capTokens, charsPerToken: 4 });

describe("applyChanges", () => {
  test("deletes a line", () => {
    const result = apply([{ oldText: "- 3 files still downloading, start 8101 after", newText: "" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain("8101 after");
    expect(result.receipt).toContain("[Outstanding Context]");
    expect(result.receipt).toContain("3 files still downloading");
  });

  test("inserts after an anchor line", () => {
    const result = apply([
      {
        oldText: "- next step: run baseline",
        newText: "- next step: run baseline\n- NEVER touch the production service on 8080",
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("NEVER touch the production service on 8080");
    // inserted line must stay inside the same section
    const section = result.text.split("[Outstanding Context]")[1]!.split("[User Preferences]")[0]!;
    expect(section).toContain("NEVER touch the production service on 8080");
  });

  test("replaces text", () => {
    const result = apply([{ oldText: "- Discuss why MTP is slow on e5", newText: "- Discuss MTP efficiency on e5 (V100, no NVLink)" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("(V100, no NVLink)");
    expect(result.receipt).toContain("+1 -1");
  });

  test("rejects unknown text", () => {
    const result = apply([{ oldText: "- this line does not exist", newText: "" }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Could not find this text");
  });

  test("rejects ambiguous text", () => {
    const draft = "[Outstanding Context]\n- same line\n- same line\n";
    const result = applyChanges({
      draft,
      changes: [{ oldText: "- same line", newText: "- only once" }],
      capTokens: 100_000,
      charsPerToken: 4,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Found 2 occurrences");
  });

  test("protects section headers", () => {
    const result = apply([{ oldText: "[Outstanding Context]\n- next step: run baseline", newText: "- next step: run baseline" }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must not be deleted or rewritten");
  });

  test("rejects overlapping changes", () => {
    const result = apply([
      {
        oldText: "- 3 files still downloading, start 8101 after\n- next step: run baseline",
        newText: "- merged line",
      },
      { oldText: "- next step: run baseline", newText: "- next step: run baseline v2" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("overlap");
  });

  test("enforces the token cap", () => {
    const result = apply([{ oldText: "- next step: run baseline", newText: `- ${"x".repeat(4000)}` }], 200);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("over the cap");
  });

  test("rejects empty oldText and empty change lists are a no-op", () => {
    const empty = apply([{ oldText: "", newText: "x" }]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("must not be empty");

    const noop = apply([]);
    expect(noop.ok).toBe(true);
    if (noop.ok) expect(noop.text).toBe(DRAFT);
  });

  test("applies multiple changes back-to-front", () => {
    const result = apply([
      { oldText: "- Discuss why MTP is slow on e5", newText: "- Goal A" },
      { oldText: "- user asked to continue automatically", newText: "- user asked to continue automatically\n- prefers Chinese replies" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("- Goal A");
    expect(result.text).toContain("prefers Chinese replies");
  });
});
