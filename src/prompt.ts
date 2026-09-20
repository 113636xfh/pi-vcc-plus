/** All model-facing text owned by this extension (outside the tool descriptions). English only. */

export function buildTailInstruction(args: {
  draft: string;
  capTokens: number;
  reserveTokens: number;
  modelMaxTokens: number;
  draftTokens: number;
}): string {
  const { draft, capTokens, reserveTokens, modelMaxTokens, draftTokens } = args;
  return `The block below is the mechanical compaction draft for this window. The draft plus your patches
becomes the summary at the start of the next context window; the last few turns of this
conversation are kept verbatim, and everything else will no longer be present afterwards.

<draft>
${draft}
</draft>

[Budget] The final summary must be <= ${capTokens} tokens
         (= min(0.8 x reserveTokens=${reserveTokens}, model.maxTokens=${modelMaxTokens}));
         the draft is currently ~${draftTokens} tokens.

[How to edit] Submit additions, deletions and replacements with vcc_patch; call vcc_done when finished.

The draft is good at files, commands and the recent conversation. It most often misses the
following, so check this conversation for them and add whatever is missing:
- Constraints and safety rules stated by the user ("do not", "never", "only", "must"; services
  or resources that must not be touched)
- Key decisions and their rationale (why this was chosen, why another option was rejected)
- Exact environment details (ports, PIDs, paths, environment variables, free disk space, versions)
- Unfinished items and concrete next steps (including commands and parameters)
- Measured results and failure facts (measured numbers, error text, failed commands)

- Only vcc_patch / vcc_draft / vcc_done may be called; any other tool (including edit, read,
  bash and vcc_recall) will be rejected during this phase
- Do not restate the draft, do not continue the conversation, and do not write user-facing
  explanations or filler
- Section headers (lines such as [Outstanding Context]) must not be deleted or rewritten
- Content that is no longer relevant may be deleted; only use what you actually saw in this
  conversation - do not invent
- Keep each section concise. Preserve exact file paths, function names, and error messages.
- Use vcc_draft only when the diff receipt is not enough to judge the draft (usually not needed)`;
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
