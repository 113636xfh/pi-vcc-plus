/** All model-facing text owned by this extension (outside the tool descriptions). English only. */

export function buildTailInstruction(args: {
  draft: string;
  capTokens: number;
  reserveTokens: number;
  modelMaxTokens: number;
  draftTokens: number;
  /** Focus instructions from a manual `/compact <instructions>` (manual path only). */
  customInstructions?: string;
}): string {
  const { draft, capTokens, reserveTokens, modelMaxTokens, draftTokens, customInstructions } = args;
  return `You are a context summarization assistant, not a coding assistant. Your only job in
this phase is to finalize the compaction draft into the summary of this session.
Do NOT continue the conversation. Do NOT do any of the work it describes, answer its
questions, or write user-facing text. Your only outputs are vcc_patch edits and vcc_done.

Create a structured context checkpoint summary that another LLM will use to continue the
work. The block below is a mechanical extraction of the part of the session that is about
to be replaced; your patches turn it into the summary that starts the next context window.

<draft>
${draft}
</draft>

[Format] Keep the draft's exact structure: the [Section] blocks separated by "---" lines,
followed by the chronological transcript.
- The section headers ([Session Goal], [Files And Changes], [Commits], [Outstanding
  Context], [User Preferences]) must not be renamed, merged, or deleted.
  No new section header may be invented.
- Every section stays a concise bullet list: one fact per line, no prose paragraphs.
- The transcript stays a line-oriented chronological account, not a retelling in prose.
- Preserve exact file paths, commands, PIDs, ports, and error messages.
- Delete stale or low-value lines freely; keep only what the next session needs.

[Scope] The recent turns at the end of this conversation are kept verbatim:
they will be in the next window right after the summary, so the model that reads
the summary will see them directly. The summary must NOT restate their content,
state, or outcomes - a one-line forward pointer ("next step: X") is enough.
Everything earlier must be carried by the summary alone.

[Coverage] The draft is good at files, commands, and the recent conversation. Check this
conversation for what it most often misses and add it with vcc_patch:
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
[How to edit] Submit additions, deletions and replacements with vcc_patch; call vcc_done
when finished. Use vcc_draft only when a diff receipt is not enough to judge the draft
(usually not needed).
- Only vcc_patch / vcc_draft / vcc_done may be called; any other tool (including edit,
  read, bash, vcc_recall) will be rejected during this phase.`;
}

/** vcc_patch 成功回执：完整 diff，不截断。 */
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
export const ERR_TOOL_NOT_ALLOWED =
  "Only vcc_patch / vcc_draft / vcc_done are allowed during the compaction check; other tools (including edit, read, bash) will be rejected.";
export const ERR_TOOL_OUTSIDE_PHASE = "This tool is only usable during the compaction check phase.";
export const ERR_RECALL_IN_CHECK =
  "vcc_recall is for normal turns, not for the compaction check phase. Finish the draft with vcc_patch / vcc_draft / vcc_done.";
export const ERR_DRAFT_READ_CAP = (max: number): string =>
  `vcc_draft has already been called ${max} times; finish based on the diff receipts and call vcc_done.`;
export const ERR_REPEAT_HINT =
  "The same oldText failed twice; include the neighbouring line(s) with the anchor, or use a longer exact excerpt.";
export const TOOL_DONE_OK = "Finalized.";
export const draftHeader = (tokens: number, cap: number): string =>
  `Current draft: ${tokens} tokens / cap ${cap} tokens`;

/** Tool descriptions: kept short and stable (they live in the prefix from session start). */
export const DESC_VCC_PATCH = `Correct the compaction draft. Only usable during the compaction check; calls in normal turns are rejected. Same usage as the edit tool: exact, unique oldText → newText; newText: "" deletes.`;
export const DESC_VCC_PATCH_OLD = "Exact unique text from the draft; same as edit's oldText.";
export const DESC_VCC_PATCH_NEW = "Replacement text; same as edit's newText. Empty deletes.";
export const DESC_VCC_DRAFT = `Show the current compaction draft. Only usable during the compaction check; calls in normal turns are rejected. Use it only when the diff receipt is not enough to judge the draft state.`;
export const DESC_VCC_DONE = `Finish revising the compaction draft. Only usable during the compaction check; calls in normal turns are rejected.`;
