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
      ? `[Scope] pi keeps the recent turns verbatim. This session's compaction settings are\n` +
        `keepRecentTokens = ${scope.keepRecentTokens} tokens, which for this session means the\n` +
        `last ${scope.messages} messages (~${scope.tokens} tokens) at the end of the\n` +
        `conversation. Those turns - their text, tool calls and tool results - will be in the\n` +
        `next window right after this summary, so the model that reads the summary sees them\n` +
        `directly:`
      : `[Scope] pi keeps the recent turns at the end of this conversation verbatim: their\n` +
        `text, tool calls and tool results will be in the next window right after the summary,\n` +
        `so the model that reads the summary sees them directly:`;
  return `You are a context summarization assistant, not a coding assistant. Your only job in
this phase is to finalize the compaction draft into the summary of this session.
Do NOT continue the conversation. Do NOT do any of the work it describes, answer its
questions, or write user-facing text. Your only outputs are vcc_delete / vcc_add edits and vcc_done.

Create a structured context checkpoint summary that another LLM will use to continue the
work. The block below is a mechanical extraction of the part of the session that is about
to be replaced; your patches turn it into the summary that starts the next context window.

<draft>
${renderForModel(draft)}
</draft>

[Format] The draft's sections region is numbered (NNN | text) for editing; below the marker
sits a mechanical transcript of the turns being replaced (lines like [user], [assistant],
[tool], * tool "..." (#123), more "---" separators and a trailing "Use vcc_recall ..."
note).
- The transcript is READ-ONLY, unnumbered and WILL NOT BE KEPT: it is dropped mechanically
  after you finish. It is raw material only: mine it for facts and put them in the right
  section. Anything worth keeping that exists only there must be added to a section, or it
  is lost.
- Emit exactly these sections, in this order and with these names:
  [Session Goal], [Files And Changes], [Commits], [Key Decisions], [Environment],
  [Results], [Outstanding Context], [User Preferences].
  Do not rename, merge or reorder them, and never invent another header. A section with
  nothing to say may be omitted; the others keep their relative order.
- Every section is a concise bullet list: one fact per line, no prose paragraphs, no
  transcript lines, no "(#123)" markers.
- Preserve exact file paths, commands, PIDs, ports, and error messages.
- Delete stale or low-value lines freely; keep only what the next session needs.

${scopeLine}
- Do NOT restate their content, state or outcomes; a one-line forward pointer
  ("next step: X") is enough.
- Do not re-extract what only they show either: it is already there. Spend the summary on
  what the kept turns no longer carry, i.e. everything before them.

[Coverage] The draft is good at files, commands, and the recent conversation. Check this
conversation for what it most often misses and add it with vcc_add:
- Constraints and safety rules stated by the user ("do not", "never", "must")
- Key decisions and their rationale (why this, why not that)
- Exact environment details (ports, PIDs, paths, environment variables, versions)
- Unfinished items and concrete next steps (with commands and parameters)
- Measured results and failure facts (numbers, error text, failed commands)
Use only what you actually saw in this conversation - do not invent.

[Budget] The final summary must be <= ${capTokens} tokens
         (= min(0.8 x reserveTokens=${reserveTokens}, model.maxTokens=${modelMaxTokens}));
         the draft is currently ~${draftTokens} tokens.
${customInstructions ? `\n[User instructions for this summary] ${customInstructions}\n` : ""}
[How to edit] Two tools; call vcc_done when finished.
- vcc_delete: {"lines":[12,13,27]} removes those lines, addressed by the numbers in the
  numbered draft. Send the whole batch in one call. A number in the transcript, a section
  header, an unknown number or a repeat is rejected with the reason. The receipt lists the
  removed lines with their numbers; the numbers of later lines then shift, so call
  vcc_draft before reusing old numbers.
- vcc_add: {"section":"Results","lines":["- round 1 cacheRead=37632 (hit)"]} appends
  lines to the END of that section - no locating text, no anchor line to repeat. The name
  resolves like the headers above ([Outstanding] counts as [Outstanding Context]) and a
  missing section is created. Add "replace":true to drop the section's current bullets
  first: that one call rewrites the section (typical: refresh [Session Goal] or [Results]).
  Its receipt shows both sides: removed lines with the numbers they had, added lines with
  the numbers they just got (so you can delete one of them later by that number).
- In addition: any fact that only exists in the transcript and matters must be moved into a
  section with vcc_add, because the transcript is dropped at finalize.
- Only vcc_delete / vcc_add / vcc_draft / vcc_done may be called; any other tool (including
  edit, read, bash, vcc_recall) will be rejected during this phase.
- Use vcc_draft only when a diff receipt is not enough to judge the draft (usually not
  needed).
- A mechanical pass then drops the whole transcript, the "---" lines and the vcc_recall
  note, and folds unknown headers into the eight sections above: anything not inside one
  of them is lost.`;
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

export const ERR_NOT_FOUND = (firstLine: string): string =>
  `Could not find this text in the draft: ${firstLine}\noldText must match the draft exactly, including whitespace and newlines.`;
export const ERR_DUPLICATE = (firstLine: string, count: number): string =>
  `Found ${count} occurrences of this text in the draft: ${firstLine}\nInclude more context to make it unique.`;
export const ERR_EMPTY = "oldText must not be empty.";
export const ERR_SECTION = (line: string): string =>
  `Section header (${line.trim()}) must not be deleted or rewritten.`;
export const ERR_OVERLAP = (a: number, b: number): string =>
  `Changes ${a} and ${b} in this call overlap; merge them into one change.`;
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
export const ERR_SECTION_UNKNOWN = (name: string, available: string[]): string =>
  `No section named \"${name}\" in the draft. Sections here: ${available.join(", ") || "(none)"}.`;
export const ERR_LINES_EMPTY = 'append needs non-empty "lines".';
export const ERR_TARGET_TWICE = (line: string, order: number): string =>
  `Patch ${order} touches a line another patch already touched: ${line.slice(0, 80)}`;
export const ERR_TOOL_NOT_ALLOWED =
  "Only vcc_delete / vcc_add / vcc_draft / vcc_done are allowed during the compaction check; other tools (including edit, read, bash) will be rejected.";
export const ERR_TOOL_OUTSIDE_PHASE = "This tool is only usable during the compaction check phase.";
export const ERR_RECALL_IN_CHECK =
  "vcc_recall is for normal turns, not for the compaction check phase. Finish the draft with vcc_delete / vcc_add / vcc_draft / vcc_done.";
export const ERR_DRAFT_READ_CAP = (max: number): string =>
  `vcc_draft has already been called ${max} times; finish based on the diff receipts and call vcc_done.`;
export const ERR_REPEAT_HINT =
  "The same patch failed twice; narrow the pattern (or widen it) and check the sections listed in the error.";
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
