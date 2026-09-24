/**
 * Draft editing. Pure (no pi imports), unit-testable. Two operations, exposed as
 * two tools (`vcc_delete`, `vcc_add`):
 *
 *   applyDeletes — remove lines by their number in the numbered draft the model
 *     sees (1-based, sections region only). Every number must exist, must not be
 *     a section header, and must not point into the read-only transcript; the
 *     receipt shows the removed lines, numbers included.
 *   applyAdd — append lines to the end of a section, named by the model (no
 *     locating text, no anchor line to repeat). Section names route like
 *     finalizeSummary routes them, so aliases such as [Outstanding] resolve to
 *     their canonical section, and a missing section is created. `replace: true`
 *     drops the section's bullets first, which makes it the whole rewrite op.
 *
 * The draft has two regions: the section blocks (top) and, below the first "---",
 * the mechanical transcript of the replaced turns. The transcript is read-only —
 * finalizeSummary drops it — so every op works inside the sections region only.
 *
 * The budget guard (P4) is measured on the finalized summary, not on the raw
 * draft: the transcript is stripped before pi sees it.
 */
import {
  ERR_LINE_HEADER,
  ERR_LINE_RANGE,
  ERR_LINE_TRANSCRIPT,
  ERR_LINES_EMPTY,
  ERR_OVER_CAP,
  ERR_SECTION_REQUIRED,
  ERR_TARGET_TWICE,
  buildDiffReceipt,
} from "./prompt";
import { finalizeSummary, routeHeader } from "./finalize";

export interface Applied {
  ok: true;
  text: string;
  receipt: string;
  added: number;
  removed: number;
}

export interface Rejected {
  ok: false;
  error: string;
  repeatOf?: string;
}

export const tokensOf = (text: string, charsPerToken: number): number =>
  Math.ceil((text?.length ?? 0) / (charsPerToken || 4));

/**
 * The token count the budget is about: what pi actually receives is the
 * finalized summary (the draft's mechanical transcript, separators and
 * vcc_recall note are stripped by finalizeSummary). Counting the raw draft
 * would let a transcript the model must not spend patches on push a draft over
 * the cap, and would reject edits for a summary that fits.
 */
export const effectiveTokensOf = (text: string, charsPerToken: number): number =>
  tokensOf(finalizeSummary(text).text, charsPerToken);

export const SECTION_RE = /^\[[^\]]+\]\s*$/;

export function sectionHeadersIn(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => SECTION_RE.test(line.trim()))
    .map((line) => line.trim());
}

/** Name of the section a line belongs to (for the receipt grouping). */
export function sectionAt(lines: string[], index: number): string {
  for (let i = Math.min(index, lines.length - 1); i >= 0; i--) {
    const line = lines[i].trim();
    if (SECTION_RE.test(line)) return line.slice(1, -1);
  }
  return "(top)";
}

const REGION_SEP = "\n\n---\n\n";

/** Number of lines in the sections region (everything above the first separator). */
function regionEnd(lines: string[]): number {
  const joined = lines.join("\n");
  const sep = joined.indexOf(REGION_SEP);
  if (sep < 0) return lines.length;
  return joined.slice(0, sep).split("\n").length;
}

/** Next section header strictly after `from`, capped at `end`. */
function nextHeaderLine(lines: string[], from: number, end: number): number {
  for (let i = from + 1; i < end; i++) {
    if (SECTION_RE.test(lines[i].trim())) return i;
  }
  return end;
}

/**
 * The section whose name routes to the same canonical section as `name` — the
 * last such block, so additions land in the freshest copy. `null` when the
 * draft has no such section (the caller then creates one).
 */
function findSection(
  lines: string[],
  end: number,
  name: string,
): { header: number; next: number; last: number } | null {
  const canonical = routeHeader(name).to;
  let header = -1;
  for (let i = 0; i < end; i++) {
    const line = lines[i].trim();
    if (!SECTION_RE.test(line)) continue;
    if (routeHeader(line.slice(1, -1)).to === canonical) header = i;
  }
  if (header < 0) return null;
  const next = nextHeaderLine(lines, header, end);
  let last = header;
  for (let i = header + 1; i < next; i++) if (lines[i].trim()) last = i;
  return { header, next, last };
}

/** Last non-empty line of the sections region (anchor for a brand-new section). */
function lastContentLine(lines: string[], end: number): number {
  for (let i = end - 1; i >= 0; i--) if (lines[i].trim()) return i;
  return -1;
}

/** Shared tail: rebuild the text, enforce the budget, build the receipt. */
function finish(args: {
  lines: string[];
  deletions: Map<number, string>;
  insertions: Map<number, string[]>;
  grouped: Map<string, { name: string; removed: string[]; added: string[] }>;
  capTokens: number;
  charsPerToken: number;
}): Applied | Rejected {
  const { lines, deletions, insertions, grouped, capTokens, charsPerToken } = args;
  const out: string[] = [];
  const emit = (anchor: number) => {
    const list = insertions.get(anchor);
    if (list) out.push(...list);
  };
  emit(-1);
  for (let i = 0; i < lines.length; i++) {
    if (!deletions.has(i)) out.push(lines[i]);
    emit(i);
  }
  const text = out.join("\n");

  // P4: the finalized summary must stay within pi's summarization budget.
  const afterTokens = effectiveTokensOf(text, charsPerToken);
  if (afterTokens > capTokens) return { ok: false, error: ERR_OVER_CAP(afterTokens, capTokens) };

  const sections = [...grouped.values()].filter((s) => s.removed.length || s.added.length);
  const added = sections.reduce((n, s) => n + s.added.length, 0);
  const removed = sections.reduce((n, s) => n + s.removed.length, 0);
  return {
    ok: true,
    text,
    added,
    removed,
    receipt: buildDiffReceipt({ added, removed, draftTokens: afterTokens, capTokens, sections }),
  };
}

function noopCheck(draft: string, capTokens: number, charsPerToken: number): Applied | Rejected {
  const tokens = effectiveTokensOf(draft, charsPerToken);
  if (tokens > capTokens) return { ok: false, error: ERR_OVER_CAP(tokens, capTokens) };
  return {
    ok: true,
    text: draft,
    added: 0,
    removed: 0,
    receipt: buildDiffReceipt({ added: 0, removed: 0, draftTokens: tokens, capTokens, sections: [] }),
  };
}

/**
 * Delete lines by their 1-based number in the numbered draft.
 */
export function applyDeletes(args: {
  draft: string;
  lines: number[];
  capTokens: number;
  charsPerToken: number;
}): Applied | Rejected {
  const { draft, capTokens, charsPerToken } = args;
  const wanted = Array.isArray(args.lines) ? args.lines : [];
  if (wanted.length === 0) return noopCheck(draft, capTokens, charsPerToken);

  const lines = draft.split("\n");
  const end = regionEnd(lines);
  const width = String(lines.length).length;
  const deletions = new Map<number, string>();
  const grouped = new Map<string, { name: string; removed: string[]; added: string[] }>();

  for (let i = 0; i < wanted.length; i++) {
    const order = i + 1;
    const raw = wanted[i];
    const number = typeof raw === "number" ? raw : Number.NaN;
    const signature = `delete:${String(raw)}`;
    if (!Number.isInteger(number) || number < 1 || number > lines.length) {
      return { ok: false, error: ERR_LINE_RANGE(String(raw), 1, lines.length), repeatOf: signature };
    }
    const index = number - 1;
    if (index >= end) return { ok: false, error: ERR_LINE_TRANSCRIPT(number), repeatOf: signature };
    const text = lines[index];
    if (SECTION_RE.test(text.trim())) {
      return { ok: false, error: ERR_LINE_HEADER(number, text.trim()), repeatOf: signature };
    }
    if (deletions.has(index)) {
      return { ok: false, error: ERR_TARGET_TWICE(`${number} | ${text.trim()}`, order), repeatOf: signature };
    }
    deletions.set(index, text);
    const name = sectionAt(lines, index);
    const bucket = grouped.get(name) ?? { name, removed: [], added: [] };
    bucket.removed.push(`${String(number).padStart(width)} | ${text}`);
    grouped.set(name, bucket);
  }

  return finish({ lines, deletions, insertions: new Map(), grouped, capTokens, charsPerToken });
}

/**
 * Append lines to the end of a section (creating it when absent). With
 * `replace: true` the section's bullets are dropped first, so one call rewrites
 * a section.
 */
export function applyAdd(args: {
  draft: string;
  section: string;
  lines: string[];
  replace?: boolean;
  capTokens: number;
  charsPerToken: number;
}): Applied | Rejected {
  const { draft, capTokens, charsPerToken, replace } = args;
  const section = typeof args.section === "string" ? args.section.trim() : "";
  if (!section) return { ok: false, error: ERR_SECTION_REQUIRED("vcc_add") };
  const lines = Array.isArray(args.lines)
    ? args.lines.filter((line) => typeof line === "string").map((line) => line.replace(/\s+$/, ""))
    : [];
  if (!lines.some((line) => line.trim())) return { ok: false, error: ERR_LINES_EMPTY };

  const draftLines = draft.split("\n");
  const end = regionEnd(draftLines);
  const deletions = new Map<number, string>();
  const grouped = new Map<string, { name: string; removed: string[]; added: string[] }>();
  const canonical = routeHeader(section).to;
  const bucket = grouped.get(canonical) ?? { name: canonical, removed: [], added: [] };
  grouped.set(canonical, bucket);

  const span = findSection(draftLines, end, section);
  if (replace && span) {
    for (let i = span.header + 1; i < span.next; i++) {
      if (!draftLines[i].trim()) continue;
      deletions.set(i, draftLines[i]);
      bucket.removed.push(draftLines[i]);
    }
  }

  const body = lines.filter((line, i) => line.trim() || (i > 0 && i < lines.length - 1));
  const anchor = span ? span.last : lastContentLine(draftLines, end);
  const insert: string[] = [];
  if (!span) {
    if (anchor >= 0 && draftLines[anchor].trim()) insert.push("");
    insert.push(`[${canonical}]`);
  }
  insert.push(...body);
  const insertions = new Map<number, string[]>([[anchor, insert]]);
  bucket.added.push(...body);

  return finish({ lines: draftLines, deletions, insertions, grouped, capTokens, charsPerToken });
}
