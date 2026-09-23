import { describe, expect, test } from "bun:test";
import { buildTailInstruction } from "../src/prompt";

const base = { draft: "[Session Goal]\n- test", capTokens: 1000, reserveTokens: 2000, modelMaxTokens: 4096, draftTokens: 10 };

describe("buildTailInstruction", () => {
  test("states that kept recent turns stay and must not be restated", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("kept verbatim and will remain in the context afterwards");
    expect(text).toContain("must NOT restate the content, state, or outcomes of the kept turns");
    expect(text).toContain("do not restate their content, status, or");
  });

  test("states that everything before the kept turns is gone and the summary must carry it", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("everything before them will no longer be present");
    expect(text).toContain("The summary must therefore carry that earlier");
  });

  test("wraps the draft in <draft> tags", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("<draft>\n[Session Goal]\n- test\n</draft>");
  });

  test("budget line shows cap and current draft tokens", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("<= 1000 tokens");
    expect(text).toContain("currently ~10 tokens");
  });

  test("custom instructions appear only when provided", () => {
    expect(buildTailInstruction({ ...base })).not.toContain("[User instructions for this summary]");
    expect(buildTailInstruction({ ...base, customInstructions: "focus on errors" })).toContain(
      "[User instructions for this summary] focus on errors",
    );
  });
});
