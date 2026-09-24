import { describe, expect, test } from "bun:test";
import { buildTailInstruction } from "../src/prompt";

const base = { draft: "[Session Goal]\n- test", capTokens: 1000, reserveTokens: 2000, modelMaxTokens: 4096, draftTokens: 10 };

describe("buildTailInstruction", () => {
  test("frames the model as a summarization assistant that must not continue the work", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("You are a context summarization assistant, not a coding assistant");
    expect(text).toContain("Do NOT continue the conversation");
    expect(text).toContain("Do NOT do any of the work it describes");
    expect(text).toContain("write user-facing text");
  });

  test("borrows the native framing: a checkpoint summary for the next LLM", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("structured context checkpoint summary that another LLM will use to continue the");
  });

  test("states that kept recent turns stay and must not be restated", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("kept verbatim");
    expect(text).toContain("will be in the next window right after the summary");
    expect(text).toContain("must NOT restate their content");
  });

  test("pins the format structure: fixed section headers, bullets, no invented sections", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("[Format]");
    expect(text).toContain("[Session Goal], [Files And Changes], [Commits], [Outstanding");
    expect(text).toContain("must not be renamed, merged, or deleted");
    expect(text).toContain("No new section header may be invented");
    expect(text).toContain("one fact per line, no prose paragraphs");
    expect(text).toContain("Preserve exact file paths, commands, PIDs, ports, and error messages");
  });

  test("keeps the coverage checklist for what the mechanical draft misses", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("[Coverage]");
    expect(text).toContain("Constraints and safety rules stated by the user");
    expect(text).toContain("Key decisions and their rationale");
    expect(text).toContain("Exact environment details");
    expect(text).toContain("Unfinished items and concrete next steps");
    expect(text).toContain("Measured results and failure facts");
    expect(text).toContain("do not invent");
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

  test("pins the closed tool set for the check phase", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("Only vcc_patch / vcc_draft / vcc_done may be called");
    expect(text).toContain("will be rejected during this phase");
  });
});
