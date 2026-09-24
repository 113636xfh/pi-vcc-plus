import { describe, expect, test } from "bun:test";
import { buildTailInstruction } from "../src/prompt";

const base = {
  draft: "[Session Goal]\n- test",
  capTokens: 1000,
  reserveTokens: 2000,
  modelMaxTokens: 4096,
  draftTokens: 10,
  keptTurns: { keepRecentTokens: 20000, messages: 52, tokens: 21345 },
};

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

  test("quotes pi's keepRecentTokens setting and forbids restating the kept turns", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("pi keeps the recent turns verbatim");
    expect(text).toContain("keepRecentTokens = 20000 tokens");
    expect(text).toContain("last 52 messages (~21345 tokens)");
    expect(text).toContain("will be in the\nnext window");
    expect(text).toContain("Do NOT restate their content, state or outcomes");
    expect(text).toContain("Do not re-extract what only they show either");
  });

  test("falls back to wording without numbers when the settings are unavailable", () => {
    const text = buildTailInstruction({ ...base, keptTurns: { keepRecentTokens: 0, messages: 0, tokens: 0 } });
    expect(text).toContain("pi keeps the recent turns at the end of this conversation verbatim");
    expect(text).not.toContain("keepRecentTokens = 0");
  });

  test("pins the format structure: fixed section headers, bullets, no invented sections", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("[Format]");
    expect(text).toContain(
      "[Session Goal], [Files And Changes], [Commits], [Key Decisions], [Environment],\n  [Results], [Outstanding Context], [User Preferences].",
    );
    expect(text).toContain("The transcript is READ-ONLY, unnumbered and WILL NOT BE KEPT");
    expect(text).toContain("must be added to a section, or it\n  is lost.");
    expect(text).toContain("Do not rename, merge or reorder them, and never invent another header");
    expect(text).toContain("one fact per line, no prose paragraphs");
    expect(text).toContain("Preserve exact file paths, commands, PIDs, ports, and error messages");
    expect(text).toContain("anything not inside one\n  of them is lost");
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
    expect(text).toContain("<draft>\n1 | [Session Goal]\n2 | - test\n</draft>");
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

  test("documents the two edit tools: numbered delete and section append", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("[How to edit] Two tools");
    expect(text).toContain('vcc_delete: {"lines":[12,13,27]} removes those lines, addressed by the numbers');
    expect(text).toContain(
      "A number in the transcript, a section\n  header, an unknown number or a repeat is rejected with the reason",
    );
    expect(text).toContain("The receipt lists the\n  removed lines with their numbers");
    expect(text).toContain('vcc_add: {"section":"Results","lines":["- round 1 cacheRead=37632 (hit)"]} appends');
    expect(text).toContain("no locating text, no anchor line to repeat");
    expect(text).toContain("Its receipt shows both sides: removed lines with the numbers they had, added lines with");
    expect(text).toContain("the numbers they just got");
    expect(text).toContain("Add \"replace\":true to drop the section's current bullets");
    // the draft the model sees is numbered, and the transcript marker separates the regions
    expect(text).toContain("1 | [Session Goal]");
    expect(text).toContain("The draft's sections region is numbered (NNN | text)");
  });

  test("pins the closed tool set for the check phase", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("Only vcc_delete / vcc_add / vcc_draft / vcc_done may be called");
    expect(text).toContain("will be rejected during this phase");
  });
});
