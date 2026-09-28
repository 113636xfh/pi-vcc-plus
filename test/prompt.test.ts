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
    expect(text.length).toBeLessThan(2500);
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

  test("falls back to wording without numbers when the settings are unavailable", () => {
    const text = buildTailInstruction({ ...base, keptTurns: { keepRecentTokens: 0, messages: 0, tokens: 0 } });
    expect(text).toContain("pi keeps the recent turns at the end of this conversation verbatim right after this");
    expect(text).not.toContain("keepRecentTokens = 0");
  });

  test("documents the two edit tools, the closed tool set, and that vcc_done is optional", () => {
    const text = buildTailInstruction({ ...base });
    expect(text).toContain("[Edits]");
    expect(text).toContain("only vcc_delete / vcc_add / vcc_draft / vcc_done work");
    expect(text).toContain("any other tool\nis rejected");
    expect(text).toContain("vcc_delete removes numbered lines");
    expect(text).toContain("vcc_add appends lines to a named section");
    expect(text).toContain('"replace":true rewrites that section first');
    expect(text).toContain("You do not need vcc_done");
    expect(text).toContain("is applied as-is");
  });

  test("custom instructions appear only when provided", () => {
    expect(buildTailInstruction({ ...base })).not.toContain("[User instructions for this summary]");
    expect(buildTailInstruction({ ...base, customInstructions: "focus on errors" })).toContain(
      "[User instructions for this summary] focus on errors",
    );
  });
});
