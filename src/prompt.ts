/** All model-facing text owned by this extension (outside the tool descriptions). English only. */

export interface KeptTurns {
  /** pi's own compaction setting (settings.keepRecentTokens) for this session. */
  keepRecentTokens: number;
  /** How many messages the cut actually keeps (after firstKeptEntryId). */
  messages: number;
  /** Rough token size of those kept messages. */
  tokens: number;
}

export function buildTailInstruction(args: {
  draft: string;
  capTokens: number;
  reserveTokens: number;
  modelMaxTokens: number;
  draftTokens: number;
  /** What pi keeps verbatim after the cut (quoted from its own settings). */
  keptTurns?: KeptTurns;
  /** Focus instructions from a manual `/compact <instructions>` (manual path only). */
  customInstructions?: string;
}): string {
  const { draft, capTokens, reserveTokens, modelMaxTokens, draftTokens, customInstructions } = args;
  const scope = args.keptTurns;
  const scopeLine =
    scope && scope.keepRecentTokens > 0
      ? `- pi keeps the last ${scope.messages} messages (~${scope.tokens} tokens; this session's\n` +
        `  keepRecentTokens = ${scope.keepRecentTokens}) verbatim right after this summary: do\n` +
        `  not restate them, a one-line forward pointer ("next step: X") is enough.`
      : `- pi keeps the recent turns at the end of this conversation verbatim right after this\n` +
        `  summary: do not restate them, a one-line forward pointer ("next step: X") is enough.`;
  return `You are the supplement pass of this session's compaction. The draft below is already
the summary's skeleton, and your one job is to add what it is missing. Everything you send
is applied to the draft, and the phase ends right after this response: there is no second
pass, so send everything in one batch. Do not continue the work, do not answer questions
in the conversation, and do not plan anything.

<draft>
${renderForModel(draft)}
</draft>

[Format] The numbered lines are the summary's sections. Below them sits a read-only
transcript of the turns being replaced: it is dropped afterwards, so anything worth keeping
that only exists there must move into a section first. Emit exactly these sections, in this
order:
  [Session Goal], [Files And Changes], [Commits], [Key Decisions], [Environment],
  [Results], [Outstanding Context], [User Preferences].
A section with nothing to say may be omitted; the others keep their relative order. Every
section is a bullet list: one fact per line, no prose paragraphs. Copy exact paths,
commands, IDs and numbers as they are.

[Task] Add what the draft misses and matters: user constraints, decisions with their
reasons, exact environment details, unfinished work with its next step, measured results
and failures. Stay under ${capTokens} tokens (the draft is ~${draftTokens}).
${scopeLine}

[Edits] In this phase only vcc_delete / vcc_add / vcc_draft / vcc_done work; any other tool
is rejected. vcc_delete removes numbered lines; vcc_add appends lines to a named section
("replace":true rewrites that section first). You do not need vcc_done: what you send here
is applied as-is.${customInstructions ? `\n\n[User instructions for this summary] ${customInstructions}` : ""}`
}


/** vcc_delete / vcc_add 成功回执：完整 diff，不截断。 */
export function buildDiffReceipt(args: {
  added: number;
  removed: number;
  draftTokens: number;
  capTokens: number;
  sections: Array<{ name: string; removed: string[]; added: string[] }>;
}): string {
  const { added, removed, draftTokens, capTokens, sections } = args;
  const head = `Δ +${added} -${removed} lines (draft now ${draftTokens} tokens / cap ${capTokens} tokens)`;
  const body = sections
    .filter((s) => s.removed.length || s.added.length)
    .map((s) => {
      const lines: string[] = [`[${s.name}]`];
      for (const line of s.removed) lines.push(...prefixed("  − ", line));
      for (const line of s.added) lines.push(...prefixed("  + ", line));
      return lines.join("\n");
    })
    .join("\n");
  return body ? `${head}\n${body}` : `${head}\n(no line-level changes)`;
}

function prefixed(prefix: string, text: string): string[] {
  const lines = text.split("\n");
  return lines.map((line, index) => (index === 0 ? `${prefix}${line}` : `    ${line}`));
}

export const ERR_OVER_CAP = (after: number, cap: number): string =>
  `After applying, the summary is ${after} tokens, over the cap of ${cap} tokens. Delete low-value entries and retry.`;

// ── patch-op errors ─────────────────────────────────────────────────────────
export const ERR_LINE_RANGE = (given: string, min: number, max: number): string =>
  `Line ${given} is not in the draft: the numbered draft's sections region runs 1..${max}. Use the numbers shown next to the lines.`;
export const ERR_LINE_TRANSCRIPT = (number: number): string =>
  `Line ${number} is in the transcript. It is not numbered, cannot be deleted, and is dropped when the summary is finalized; move anything worth keeping into a section instead.`;
export const ERR_LINE_HEADER = (number: number, line: string): string =>
  `Line ${number} is a section header (${line}). Headers are structural: delete the section's bullets, or use vcc_add with "replace":true.`;
export const ERR_SECTION_REQUIRED = (op: string): string => `${op} needs a "section" name (e.g. "Results").`;
export const ERR_LINES_EMPTY = 'append needs non-empty "lines".';
export const ERR_TARGET_TWICE = (line: string, order: number): string =>
  `Patch ${order} touches a line another patch already touched: ${line.slice(0, 80)}`;
/**
 * Appended after a check round whose response carried no edits at all. The phase is
 * designed to end after the response that carries the additions, so an edit-less
 * response is re-asked (guards.emptyRetries times) instead of finalizing the
 * untouched mechanical draft.
 */
export const EMPTY_ROUND_NUDGE =
  "Your reply carried no tool calls, so the summary is still the mechanical draft. " +
  "Send the vcc_delete / vcc_add calls for what it is still missing - tool calls only.";

export const ERR_TOOL_NOT_ALLOWED =
  "Only vcc_delete / vcc_add / vcc_draft / vcc_done are allowed during the compaction check; other tools (including edit, read, bash) will be rejected.";
export const ERR_TOOL_OUTSIDE_PHASE = "This tool is only usable during the compaction check phase.";
export const ERR_RECALL_IN_CHECK =
  "vcc_recall is for normal turns, not for the compaction check phase. Finish the draft with vcc_delete / vcc_add / vcc_draft / vcc_done.";
export const ERR_DRAFT_READ_CAP = (max: number): string =>
  `vcc_draft has already been called ${max} times; finish based on the diff receipts and call vcc_done.`;
export const ERR_REPEAT_HINT =
  "The same call failed twice in a row; line numbers shift after every successful edit — call vcc_draft for the current numbers, then retry.";
export const TOOL_DONE_OK = "Finalized.";
/**
 * The draft body handed to the model is the raw draft (sections + the
 * mechanical transcript, kept as source material), while the budget only counts
 * what the finalized summary will contain. Report both so the two numbers in
 * front of the model are not contradictory.
 */
export const draftHeader = (tokens: number, cap: number, rawTokens?: number): string =>
  rawTokens !== undefined && rawTokens !== tokens
    ? `Current draft: ${rawTokens} tokens shown (${tokens} tokens after the mechanical strip of the transcript) / cap ${cap} tokens`
    : `Current draft: ${tokens} tokens / cap ${cap} tokens`;

/**
 * The draft as the model sees it: the sections region carries the line numbers
 * it deletes by (`NNN | text`, zero-padded so the bar stays aligned), and the
 * transcript below is left unnumbered and marked read-only. The draft text
 * itself is never changed — this is a view, built the same way for the
 * instruction and for vcc_draft.
 */
export const TRANSCRIPT_MARKER =
  "--- (read-only transcript of the replaced turns: it is not numbered, cannot be deleted, and is DROPPED when " +
  "the summary is finalized - move anything worth keeping into the sections above) ---";

const DRAFT_SEPARATOR = "\n\n---\n\n";

/** Split a draft into its numbered region and the transcript below it. */
export function splitDraft(draft: string): { sections: string[]; transcript: string | null } {
  const joined = draft ?? "";
  const index = joined.indexOf(DRAFT_SEPARATOR);
  if (index < 0) return { sections: joined.split("\n"), transcript: null };
  return {
    sections: joined.slice(0, index).split("\n"),
    transcript: joined.slice(index + DRAFT_SEPARATOR.length),
  };
}

/** `NNN | text` for every line of the sections region (1-based). */
export function numberLines(lines: string[], offset = 0): string[] {
  const width = String(offset + lines.length).length;
  return lines.map((line, i) => `${String(offset + i + 1).padStart(width)} | ${line}`);
}

export function renderForModel(draft: string): string {
  const { sections, transcript } = splitDraft(draft);
  const numbered = numberLines(sections).join("\n");
  if (transcript === null) return numbered;
  return `${numbered}\n\n${TRANSCRIPT_MARKER}\n\n${transcript}`;
}
export const DESC_VCC_DELETE = `Remove lines from the compaction draft by line number. The draft's sections region is numbered (NNN | text); the transcript block below the marker is not numbered and cannot be deleted. Send all the line numbers of one edit in a single call. Only usable during the compaction check.`;
export const DESC_VCC_DELETE_LINES =
  "Line numbers of the draft's sections region, as shown in the numbered draft (one number per line to remove).";
export const DESC_VCC_ADD = `Add lines to the end of a section of the compaction draft, named by section instead of by locating text. "replace": true drops that section's current bullets first, which rewrites the section in one call. Only usable during the compaction check.`;
export const DESC_VCC_ADD_SECTION = 'Section name, e.g. "Results" (aliases such as [Outstanding] resolve to their canonical section; a missing one is created).';
export const DESC_VCC_ADD_LINES = "Lines to append, one bullet per line (e.g. '- cacheRead=37632 (hit)').";
export const DESC_VCC_ADD_REPLACE = "true = clear that section's current bullets first (a full rewrite of the section).";
export const DESC_VCC_DRAFT = `Show the current compaction draft. Only usable during the compaction check; calls in normal turns are rejected. Use it only when the diff receipt is not enough to judge the draft state.`;
export const DESC_VCC_DONE = `Finish revising the compaction draft. Only usable during the compaction check; calls in normal turns are rejected.`;
