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
  // The shape mirrors pi's own summarization system prompt: a role statement plus a
  // strict output restriction, and the phase is one supplement pass that ends when the
  // model stops. Measured on a local 27B (docs/vcc-vs-native-notes.md): the check phase
  // stays within one round, which removes the tail of extra rounds the loop produced.
  test("states the role as a single supplement pass that ends with the response", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("You are the supplement pass of this session's compaction");
    expect(text).toContain("your one job is to add what it is missing");
    expect(text).toContain("the phase ends right after this response");
    expect(text).toContain("no second");
    expect(text).toContain("pass, so send everything in one batch");
    expect(text).toContain("do not answer questions");
    expect(text).toContain("in the conversation");
  });

  test("keeps the prompt short", () => {
    const text = buildTailInstruction({ ...base });
    expect(text.length).toBeLessThan(2800);
  });

  test("tells the model its thinking is hard-capped and cut (cap on)", () => {
    const text = buildTailInstruction({ ...base, thinkingCapChars: 8000 });
    expect(text).toContain("Your thinking is hard-capped at 8000 characters");
    expect(text).toContain("stream is aborted");
    expect(text).toContain("vcc_add / vcc_done");
    expect(text).toContain("well under the cap");
  });

  test("omits the thinking-budget block when there is no cap", () => {
    const text = buildTailInstruction({ ...base, thinkingCapChars: 0 });
    expect(text).not.toContain("hard-capped");
  });

  test("wraps the numbered draft in <draft> tags", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("<draft>\n1 | [Session Goal]\n2 | - test\n</draft>");
  });

  test("pins the section list and the bullet format", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("[Format]");
    expect(text).toContain(
      "[Session Goal], [Files And Changes], [Commits], [Key Decisions], [Environment],",
    );
    expect(text).toContain("[Results], [Outstanding Context], [User Preferences].");
    expect(text).toContain("A section with nothing to say may be omitted");
    expect(text).toContain("one fact per line, no prose paragraphs");
    expect(text).toContain("Copy exact paths,");
    expect(text).toContain("IDs and numbers as they are");
  });

  test("says the transcript is dropped and facts must move into a section", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("read-only");
    expect(text).toContain("it is dropped afterwards");
    expect(text).toContain("must move into a section first");
  });

  test("names the fact kinds the mechanical draft most often misses", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("[Task]");
    expect(text).toContain("user constraints, decisions with their");
    expect(text).toContain("environment details");
    expect(text).toContain("unfinished work with its next step");
    expect(text).toContain("measured results");
  });

  test("quotes the budget without pushing the summary shorter", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("Stay under 1000 tokens");
    expect(text).toContain("the draft is ~10");
    // no "shorter is better" pressure: that measurably dropped exact paths
    expect(text).not.toContain("beats a long one");
  });

  test("quotes pi's keepRecentTokens and forbids restating the kept turns", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("pi keeps the last 52 messages (~21345 tokens;");
    expect(text).toContain("keepRecentTokens = 20000");
    expect(text).toContain("not restate them");
    expect(text).toContain("next step: X");
  });

  test("names what the mechanical draft structurally cannot carry", () => {
    // Measured on a 102-message session: the check round answered with 153
    // output / 0 reasoning tokens and left a 535-char summary while 92% of the
    // budget sat unused. The prompt gave an upper bound and no reason to look
    // harder, so the cheapest compliant answer was three bullets. These four
    // checks are what make "nothing to add" an informed decision instead.
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("The draft is mechanical");
    expect(text).toContain("it inventories files, commands and turns");
    expect(text).toContain("why\na choice was made");
    expect(text).toContain("what was ruled out");
    expect(text).toContain("what is still open");
    expect(text).toContain("what you were asked to do");
    expect(text).toContain("Check those four against the transcript");
  });

  test("lets the model decide that nothing needs adding", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("adding nothing is the right answer");
  });

  test("asks for coverage rather than a length target", () => {
    // A hard character floor would pad sparse sessions; the budget stays an
    // upper bound only.
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("length is not\nthe goal, coverage is");
    expect(text).not.toMatch(/at least \d+ (tokens|chars|words)/);
    expect(text).not.toMatch(/no fewer than \d+/);
  });

  test("falls back to wording without numbers when the settings are unavailable", () => {
    const text = buildTailInstruction({ ...base, keptTurns: { keepRecentTokens: 0, messages: 0, tokens: 0 } });
    expect(text).toContain("pi keeps the recent turns at the end of this conversation verbatim right after this");
    expect(text).not.toContain("keepRecentTokens = 0");
  });

  test("documents the three remaining tools and the closed tool set", () => {
    // vcc_delete was dropped: 26% of its calls failed across 71 compactions
    // (models miscount the numbered region), and vcc_add replace:true covers
    // the only thing it did. What must survive is the redirect — 49% of
    // compactions used to call it, so a bare rejection would burn calls.
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("[Edits]");
    expect(text).toContain("only vcc_add / vcc_draft / vcc_done work");
    expect(text).toContain("any other tool\nis rejected");
    expect(text).not.toContain("vcc_delete");
    expect(text).toContain("there is no\nper-line delete");
    expect(text).toContain("Sections you do not touch are kept exactly as they are");
    expect(text).toContain("vcc_draft re-reads");
    expect(text).toContain("Finish with vcc_done once you have sent everything");
  });

  test("asks for vcc_done instead of calling it optional", () => {
    // Measured over 71 compactions: 51% ended their pass with vcc_done and
    // 36 of 36 such calls were the final one. The prompt used to say the model
    // did not need it, which contradicted what every model actually did.
    const text = buildTailInstruction({ ...base });
    expect(text).not.toContain("You do not need vcc_done");
    expect(text).not.toContain("is applied as-is");
  });

  test("custom instructions appear only when provided", () => {
    expect(buildTailInstruction({ ...base })).not.toContain("[User instructions for this summary]");
    expect(buildTailInstruction({ ...base, customInstructions: "focus on errors" })).toContain(
      "[User instructions for this summary] focus on errors",
    );
  });
});
