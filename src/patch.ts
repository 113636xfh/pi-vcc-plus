/**
 * Draft patching (P1–P4). No pi imports on purpose: pure, unit-testable.
 */
import {
  ERR_DUPLICATE,
  ERR_EMPTY,
  ERR_NOT_FOUND,
  ERR_OVERLAP,
  ERR_OVER_CAP,
  ERR_SECTION,
  buildDiffReceipt,
} from "./prompt";

export interface Change {
  oldText: string;
  newText: string;
}

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

export const SECTION_RE = /^\[[^\]]+\]\s*$/;

export function sectionHeadersIn(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => SECTION_RE.test(line.trim()))
    .map((line) => line.trim());
}

export function sectionAt(draft: string, offset: number): string {
  const before = draft.slice(0, offset).split("\n");
  for (let i = before.length - 1; i >= 0; i--) {
    const line = before[i].trim();
    if (SECTION_RE.test(line)) return line.slice(1, -1);
  }
  return "(top)";
}

export function countOccurrences(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    hits.push(index);
    from = index + needle.length;
  }
  return hits;
}

export function applyChanges(args: {
  draft: string;
  changes: Change[];
  capTokens: number;
  charsPerToken: number;
}): Applied | Rejected {
  const { draft, changes, capTokens, charsPerToken } = args;
  if (!Array.isArray(changes)) return { ok: false, error: "changes must be an array." };
  if (changes.length === 0) {
    // P4 applies to no-op patches too: an empty patch list must not paper over
    // a draft that is already over the cap.
    const tokens = tokensOf(draft, charsPerToken);
    if (tokens > capTokens) return { ok: false, error: ERR_OVER_CAP(tokens, capTokens) };
    return {
      ok: true,
      text: draft,
      added: 0,
      removed: 0,
      receipt: buildDiffReceipt({
        added: 0,
        removed: 0,
        draftTokens: tokens,
        capTokens,
        sections: [],
      }),
    };
  }

  const matched: Array<{ index: number; change: Change; section: string; order: number }> = [];

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i] ?? ({} as Change);
    const oldText = typeof change.oldText === "string" ? change.oldText : "";
    const newText = typeof change.newText === "string" ? change.newText : "";
    if (!oldText) return { ok: false, error: ERR_EMPTY };

    // P3: section headers are immutable.
    for (const header of sectionHeadersIn(oldText)) {
      if (!newText.includes(header)) return { ok: false, error: ERR_SECTION(header) };
    }

    const hits = countOccurrences(draft, oldText);
    if (hits.length === 0) {
      return { ok: false, error: ERR_NOT_FOUND(oldText.split("\n")[0] ?? ""), repeatOf: oldText };
    }
    if (hits.length > 1) {
      return {
        ok: false,
        error: ERR_DUPLICATE(oldText.split("\n")[0] ?? "", hits.length),
        repeatOf: oldText,
      };
    }
    matched.push({
      index: hits[0],
      change: { oldText, newText },
      section: sectionAt(draft, hits[0]),
      order: i + 1,
    });
  }

  // Overlap check — same rule as pi's native edit tool.
  const byIndex = [...matched].sort((a, b) => a.index - b.index);
  for (let i = 1; i < byIndex.length; i++) {
    const prev = byIndex[i - 1];
    const cur = byIndex[i];
    if (cur.index < prev.index + prev.change.oldText.length) {
      return { ok: false, error: ERR_OVERLAP(prev.order, cur.order) };
    }
  }

  // Apply back-to-front so earlier offsets stay valid.
  let text = draft;
  for (const item of [...byIndex].reverse()) {
    text = text.slice(0, item.index) + item.change.newText + text.slice(item.index + item.change.oldText.length);
  }

  // P4: the merged summary must stay within pi's own summarization budget.
  const afterTokens = tokensOf(text, charsPerToken);
  if (afterTokens > capTokens) return { ok: false, error: ERR_OVER_CAP(afterTokens, capTokens) };

  const grouped = new Map<string, { name: string; removed: string[]; added: string[] }>();
  let removed = 0;
  let added = 0;
  for (const item of byIndex) {
    const bucket = grouped.get(item.section) ?? { name: item.section, removed: [], added: [] };
    if (item.change.oldText) {
      bucket.removed.push(item.change.oldText);
      removed += item.change.oldText.split("\n").length;
    }
    if (item.change.newText) {
      bucket.added.push(item.change.newText);
      added += item.change.newText.split("\n").length;
    }
    grouped.set(item.section, bucket);
  }

  return {
    ok: true,
    text,
    added,
    removed,
    receipt: buildDiffReceipt({
      added,
      removed,
      draftTokens: afterTokens,
      capTokens,
      sections: [...grouped.values()],
    }),
  };
}
