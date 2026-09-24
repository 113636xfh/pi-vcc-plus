/**
 * Mechanical finalizer for the summary vcc-plus hands to pi.
 *
 * The VCC draft (upstream `compileRanked`) is a reader's artifact, not a
 * summary: it is `[Section]` blocks + "---" + a mechanical transcript of the
 * replaced turns (`[user]` / `[assistant]` / `* tool "..." (#123)`) + "---" +
 * the `vcc_recall` note. Its merge step (`mergePrevious` with
 * `preserveFreshBriefOnMerge`) carries the previous draft's transcript into the
 * new one, so the transcript also accumulates across compactions.
 *
 * Left in place that transcript ends up in the next window right after pi's
 * kept turns: content that reads like the last messages were appended to the
 * summary, with `[user]`/`[assistant]` markers and `(#123)` indices instead of
 * a clean section list. The transcript is raw material for the check phase
 * (the model folds what matters into the sections); the summary itself is the
 * section blocks only, in a fixed order with fixed names.
 *
 * This module enforces that mechanically, so the shape of the final summary
 * does not depend on the model following the instruction. It only ever drops
 * transcript / separator / note lines; section bullets and any other prose are
 * preserved (unknown `[Headers]` are folded into a canonical section).
 */

/** The summary's section set and order. The prompt asks for exactly these. */
export const CANONICAL_SECTIONS = [
  "Session Goal",
  "Files And Changes",
  "Commits",
  "Key Decisions",
  "Environment",
  "Results",
  "Outstanding Context",
  "User Preferences",
] as const;

export type CanonicalSection = (typeof CANONICAL_SECTIONS)[number];

/** Same note upstream pi-vcc appends to its compiled drafts. */
export const RECALL_NOTE =
  "Use `vcc_recall` to search for prior work, decisions, and context from before this summary. " +
  "Do not redo work already completed.";

export interface FinalizeReport {
  /** true when the text differs from the input (worth logging). */
  changed: boolean;
  /** Canonical sections present in the result, in canonical order. */
  sections: string[];
  /** Lines dropped as transcript (including orphan blocks inside it). */
  strippedTranscriptLines: number;
  /** "---" separator lines dropped. */
  strippedSeparators: number;
  /** Times the vcc_recall note was removed. */
  strippedNotes: number;
  /** "...(N earlier lines omitted)" markers dropped. */
  strippedOmittedMarkers: number;
  /** Headers renamed to a canonical name (e.g. [Outstanding] -> [Outstanding Context]). */
  renamed: Array<{ from: string; to: string }>;
  /** Headers with no canonical name whose bullets were folded into a section. */
  folded: Array<{ from: string; to: string }>;
  /** Bullets that appeared twice in the same section. */
  dedupedBullets: number;
  /** Unheadered lines that appeared before the first section. */
  preHeaderLines: number;
  /** Character count before/after. */
  charsBefore: number;
  charsAfter: number;
  /** true when no canonical section was found: the non-transcript text was kept as-is. */
  usedFallbackShape: boolean;
  /** true when the input was returned unchanged (nothing but transcript). */
  passthrough: boolean;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches the note even after upstream's wrapLongLines broke it across lines. */
const noteRe = (global: boolean): RegExp =>
  new RegExp(RECALL_NOTE.split(/\s+/).map(escapeRe).join("\\s+"), global ? "g" : "");

const NOTE = noteRe(false);
const NOTE_G = noteRe(true);

const isSeparator = (line: string): boolean => /^-{3,}$/.test(line.trim());
const isOmittedMarker = (line: string): boolean =>
  /^\.{3}\(\d+ earlier lines omitted\)$/.test(line.trim()) ||
  /^\*\s*\(\d+ earlier (?:tool-call|tool call|tool-result|tool result) entries omitted\)$/.test(line.trim());
const isTranscriptHeader = (line: string): boolean =>
  /^\[(?:user|assistant|tool|toolResult|tool_result)\]\s*$/.test(line.trim());
const hasIndexMarker = (line: string): boolean => /\(#\d+(?:\s*,\s*#\d+)*\)/.test(line);
/** `[Name]` on a line of its own: a section marker, unless it names a speaker. */
const bracketHeader = (line: string): string | null => {
  const m = /^\[([^\]\n]{1,80})\]\s*$/.exec(line.trim());
  return m ? m[1] : null;
};
/** `## Name`: a section marker only for a known section name. The transcript
 *  quotes assistant prose that contains markdown headings, so an unknown one
 *  must not open a section (it stays content/transcript). */
const markdownHeader = (line: string): string | null => {
  const m = /^#{1,6}\s+(.{1,80}?)\s*$/.exec(line.trim());
  return m ? m[1] : null;
};

/** Lowercased canonical names and the aliases models reach for. */
const HEADER_ALIASES: Record<string, CanonicalSection> = {
  "session goal": "Session Goal",
  "session goals": "Session Goal",
  goal: "Session Goal",
  goals: "Session Goal",
  objective: "Session Goal",
  "session objective": "Session Goal",
  "files and changes": "Files And Changes",
  "files & changes": "Files And Changes",
  "file changes": "Files And Changes",
  "files changed": "Files And Changes",
  changes: "Files And Changes",
  files: "Files And Changes",
  commits: "Commits",
  commit: "Commits",
  "key decisions": "Key Decisions",
  "key decision": "Key Decisions",
  decisions: "Key Decisions",
  "decisions made": "Key Decisions",
  environment: "Environment",
  "environment details": "Environment",
  env: "Environment",
  results: "Results",
  result: "Results",
  "measured results": "Results",
  "outstanding context": "Outstanding Context",
  outstanding: "Outstanding Context",
  "next steps": "Outstanding Context",
  next: "Outstanding Context",
  todo: "Outstanding Context",
  "open items": "Outstanding Context",
  remaining: "Outstanding Context",
  "user preferences": "User Preferences",
  "user preference": "User Preferences",
  preferences: "User Preferences",
  constraints: "User Preferences",
  "constraints & preferences": "User Preferences",
};

/** Keyword routes for headers that are neither canonical names nor aliases. */
const HEADER_ROUTES: Array<[RegExp, CanonicalSection]> = [
  [/commit|sha|git|branch|merge|push/i, "Commits"],
  [/decision|rationale|why|chose|chosen|approach|trade-?off|决策|取舍/i, "Key Decisions"],
  [/session goal|objective|mandate|目标|诉求/i, "Session Goal"],
  [/prefer|constraint|rule|must|never|do not|policy|偏好|约束|规则/i, "User Preferences"],
  [/env|machine|gpu|cuda|port|version|pid|\bpath\b|config|toolchain|环境|端口|版本/i, "Environment"],
  [/file|edit|rename|patch|diff|文件|改动/i, "Files And Changes"],
  [/result|measure|benchmark|evidence|number|test|verif|cause|bug|fail|error|fix|root|结果|实测|根因|证据/i, "Results"],
  [/next|outstanding|remain|unfinished|pending|todo|block|follow-?up|debt|待办|遗留|未完成/i, "Outstanding Context"],
];

/** Where an unrecognized header's bullets go when no keyword matches. */
const FOLD_FALLBACK: CanonicalSection = "Outstanding Context";

/** Known name (canonical or alias) for a header, case/space-insensitively. */
const knownName = (name: string): CanonicalSection | null =>
  HEADER_ALIASES[name.trim().replace(/\s+/g, " ").toLowerCase()] ?? null;

export function routeHeader(name: string): { to: CanonicalSection; renamed: boolean; folded: boolean } {
  const clean = name.trim().replace(/\s+/g, " ");
  const exact = knownName(clean);
  if (exact) return { to: exact, renamed: exact !== clean, folded: false };
  for (const [re, to] of HEADER_ROUTES) {
    if (re.test(name)) return { to, renamed: false, folded: true };
  }
  return { to: FOLD_FALLBACK, renamed: false, folded: true };
}

type BlockKind = "section" | "transcript" | "note" | "separator" | "omitted" | "content";

function classify(block: string): BlockKind {
  const lines = block.split("\n").filter((l) => l.trim());
  if (!lines.length) return "separator";
  if (lines.every(isSeparator)) return "separator";
  if (lines.every(isOmittedMarker)) return "omitted";
  if (!isTranscriptHeader(lines[0]) && bracketHeader(lines[0])) return "section";
  if (!bracketHeader(lines[0])) {
    const md = markdownHeader(lines[0]);
    if (md && knownName(md)) return "section";
    if (NOTE.test(block) && lines.length <= 3) return "note";
  }
  if (isTranscriptHeader(lines[0]) || isOmittedMarker(lines[0])) return "transcript";
  // A block that is mostly "#123"-indexed tool lines is transcript as well.
  const indexed = lines.filter(hasIndexMarker).length;
  if (indexed > 0 && indexed >= Math.ceil(lines.length / 2)) return "transcript";
  return "content";
}

/**
 * Reduce a draft (or a previous summary) to the canonical section blocks.
 * Never returns an empty string: if no canonical section is found the
 * non-transcript text is kept in its original order, and if that is empty too
 * the input is returned unchanged (a transcript-only summary would be worse
 * than an unclean one).
 */
export function finalizeSummary(raw: string): { text: string; report: FinalizeReport } {
  const input = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  const report: FinalizeReport = {
    changed: false,
    sections: [],
    strippedTranscriptLines: 0,
    strippedSeparators: 0,
    strippedNotes: 0,
    strippedOmittedMarkers: 0,
    renamed: [],
    folded: [],
    dedupedBullets: 0,
    preHeaderLines: 0,
    charsBefore: input.length,
    charsAfter: input.length,
    usedFallbackShape: false,
    passthrough: false,
  };

  // 1. the recall note (upstream appends it; it is not summary content)
  const withoutNotes = input.replace(NOTE_G, () => {
    report.strippedNotes += 1;
    return "";
  });

  // 2. walk the blocks
  const sections = new Map<CanonicalSection, string[]>();
  const fallback: string[] = [];
  const push = (section: CanonicalSection, line: string): void => {
    const trimmed = line.trimEnd();
    if (!trimmed.trim()) return;
    const list = sections.get(section) ?? [];
    if (list.includes(trimmed.trim())) {
      report.dedupedBullets += 1;
      return;
    }
    list.push(trimmed);
    sections.set(section, list);
  };

  let open: CanonicalSection | null = null;
  let inTranscript = false;
  let preHeader: string[] = [];

  for (const block of withoutNotes.split(/\n{2,}/)) {
    if (!block.trim()) continue;
    const kind = classify(block);
    const lines = block.split("\n");
    if (kind === "section") {
      const header = (bracketHeader(lines[0]) ?? markdownHeader(lines[0]) ?? lines[0]).trim();
      const routed = routeHeader(header);
      if (routed.folded) report.folded.push({ from: header.trim(), to: routed.to });
      else if (routed.renamed) report.renamed.push({ from: header.trim(), to: routed.to });
      open = routed.to;
      inTranscript = false;
      fallback.push(block.trimEnd());
      for (const line of lines.slice(1)) {
        if (line.trim()) push(routed.to, line);
      }
      continue;
    }
    if (kind === "separator" || kind === "note") {
      if (kind === "separator") report.strippedSeparators += lines.filter(isSeparator).length;
      continue;
    }
    if (kind === "transcript" || kind === "omitted") {
      if (kind === "omitted") report.strippedOmittedMarkers += lines.filter(isOmittedMarker).length;
      report.strippedTranscriptLines += lines.filter((l) => l.trim() && !isOmittedMarker(l)).length;
      inTranscript = true;
      continue;
    }
    // content: a section body that lost its header, or part of the transcript
    if (inTranscript) {
      report.strippedTranscriptLines += lines.filter((l) => l.trim()).length;
      continue;
    }
    fallback.push(block.trimEnd());
    if (!open) {
      const added = lines.filter((l) => l.trim());
      preHeader.push(...added);
      report.preHeaderLines += added.length;
      continue;
    }
    for (const line of lines) {
      if (line.trim()) push(open, line);
    }
  }

  // 3. unheadered preamble, if any, belongs to the session's goal — but only
  //    when the draft actually had sections: otherwise this is a foreign shape
  //    (a markdown summary) and the fallback path below keeps it verbatim.
  if (preHeader.length && sections.size > 0) {
    for (const line of preHeader) push(CANONICAL_SECTIONS[0], line);
  }

  const parts: string[] = [];
  for (const name of CANONICAL_SECTIONS) {
    const bullets = sections.get(name);
    if (!bullets?.length) continue;
    report.sections.push(name);
    parts.push(`[${name}]\n${bullets.join("\n")}`);
  }

  let text = parts.join("\n\n");
  if (!text.trim()) {
    text = fallback.join("\n\n").trim();
    report.usedFallbackShape = Boolean(text);
  }
  if (!text.trim()) {
    return { text: input, report: { ...report, changed: false, passthrough: true, sections: [] } };
  }
  report.charsAfter = text.length;
  report.changed = text !== input;
  return { text, report };
}
