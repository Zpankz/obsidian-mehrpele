/** DOM-free fence location/validation over plain text lines. */

/**
 * Opening fence of a diagram block (lang matched case-insensitively, like
 * extractBlocks and pele-render, so CLI indices and write-back agree). `mehrpele` is a diagram (Markdown labels);
 * the integration langs (`pele-tasks`, `pele-datacore`, `pele-breadcrumbs`)
 * are query blocks, not diagram sources, so the lang must end at whitespace
 * or end of line (`\b` would let `pele-tasks` match as `pele`).
 */
export const DIAGRAM_FENCE_RE = /^\s*(`{3,}|~{3,})\s*(mermaid|pele|mehrpele)(?=\s|$)/i;
const ANY_OPEN_FENCE_RE = /^\s*(`{3,}|~{3,})\s*\S/;
const BARE_FENCE_RE = /^\s*(`{3,}|~{3,})\s*$/;

export function isDiagramFenceLine(line: string | undefined): boolean {
  return line !== undefined && DIAGRAM_FENCE_RE.test(line);
}

/**
 * Scan upward from `startLine` (inclusive) for the opening diagram fence.
 * Returns the 0-based line index, or null. Stops at a bare closing fence or
 * at the top of the document — never crosses into a previous block.
 */
export function findOpeningFenceLine(lines: readonly string[], startLine: number): number | null {
  for (let i = Math.min(startLine, lines.length - 1); i >= 0; i--) {
    const line = lines[i] ?? "";
    if (DIAGRAM_FENCE_RE.test(line)) return i;
    if (BARE_FENCE_RE.test(line)) return null; // previous block's closing fence
    if (i !== startLine && ANY_OPEN_FENCE_RE.test(line)) return null; // other block's opening fence
  }
  return null;
}

/** Whether `line` closes a block opened with `open` (same marker char, ≥ length, no info). */
export function isClosingFenceFor(line: string | undefined, open: string): boolean {
  if (line === undefined) return false;
  const m = BARE_FENCE_RE.exec(line);
  return !!m && m[1][0] === open[0] && m[1].length >= open.length;
}

/**
 * Body lines match `source` AND the block ends right there: a closing fence
 * (or end of document for an unclosed block) at `fenceLine + 1 + n`. Without
 * the closing check a short `source` would match the head of a longer block
 * and a replacement would overwrite only part of the wrong block.
 */
export function blockBodyMatches(lines: readonly string[], fenceLine: number, source: string): boolean {
  const open = DIAGRAM_FENCE_RE.exec(lines[fenceLine] ?? "")?.[1];
  if (!open) return false;
  const expected = source.replace(/\n$/, "").split("\n");
  for (let k = 0; k < expected.length; k++) {
    if (lines[fenceLine + 1 + k] !== expected[k]) return false;
  }
  const closeAt = fenceLine + 1 + expected.length;
  return closeAt === lines.length || isClosingFenceFor(lines[closeAt], open);
}

export type LocateResult =
  | { kind: "found"; line: number }
  | { kind: "ambiguous" }
  | { kind: "missing" };

/**
 * Locate the fence line for a persisted-width write. Trusts `expectedLine`
 * only when the fence there is a diagram fence AND the following lines equal
 * `source`; otherwise searches the whole text for a unique fence+source
 * match. Ambiguous (multiple matches) or missing matches abort the write.
 */
export function locateBlockForPersist(
  text: string,
  expectedLine: number,
  source: string,
): LocateResult {
  const lines = text.split("\n");
  if (isDiagramFenceLine(lines[expectedLine]) && blockBodyMatches(lines, expectedLine, source)) {
    return { kind: "found", line: expectedLine };
  }
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isDiagramFenceLine(lines[i]) && blockBodyMatches(lines, i, source)) matches.push(i);
  }
  if (matches.length === 1) return { kind: "found", line: matches[0] };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "missing" };
}

/** Every lang this plugin renders: diagrams plus the integration query blocks. */
export const OUR_BLOCK_LANGS = ["mermaid", "pele", "mehrpele", "pele-tasks", "pele-datacore", "pele-breadcrumbs"] as const;

/**
 * Whether `text` contains an opening fence for one of `langs` — used to only
 * refresh open notes that actually show one of our blocks. Linear scan, no
 * per-line allocation beyond the regex.
 */
export function hasDiagramFence(text: string, langs: readonly string[] = OUR_BLOCK_LANGS): boolean {
  if (!text) return false;
  const alt = langs.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`^[ \\t]*(\`{3,}|~{3,})[ \\t]*(?:${alt})(?=\\s|$)`, "mi").test(text);
}
