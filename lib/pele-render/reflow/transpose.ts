/**
 * Direction rewrites used by the reflow ladder. They touch only the header
 * line and `direction` statements, so node ids (and therefore `pele-size`
 * pins and Mehrpele anchors) are unchanged. Pure: no Pele, no DOM.
 */

/**
 * 0-based index of the diagram header line: the first line that is not
 * blank, a `%%` comment/directive or part of a YAML frontmatter block.
 */
export function headerLine(lines: readonly string[]): number {
  let i = 0;
  if ((lines[0] ?? "").trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    if (end > 0) i = end + 1;
  }
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "" || t.startsWith("%%")) continue;
    return i;
  }
  return -1;
}

const FLOW_HEADER_RE = /^(\s*(?:flowchart|graph)(?:-elk)?\s+)(LR|RL|TB|TD|BT)\b/;
const DIRECTION_LINE_RE = /^(\s*direction\s+)(LR|RL|TB|TD|BT)\b/;

/** Direction written on a flowchart header (`flowchart LR`), if any. */
export function flowchartDirection(source: string): string | null {
  const lines = source.split("\n");
  const h = headerLine(lines);
  return h < 0 ? null : (FLOW_HEADER_RE.exec(lines[h])?.[2] ?? null);
}

/** Whether any subgraph carries `direction LR` / `direction RL`. */
export function hasHorizontalSubgraph(source: string): boolean {
  return source.split("\n").some((l) => /^(LR|RL)$/.test(DIRECTION_LINE_RE.exec(l)?.[2] ?? ""));
}

/** Whether a `direction …` statement is written anywhere in the block. */
export function hasWrittenDirection(source: string): boolean {
  return source.split("\n").some((l) => DIRECTION_LINE_RE.test(l));
}

/**
 * Flowchart direction flip: level 1 rewrites a horizontal header to TB;
 * level 2 also rewrites horizontal subgraph `direction` lines. `TB`/`BT`
 * are never transposed (narrowing never needs it).
 */
export function flipSource(source: string, level: number): string {
  if (level <= 0) return source;
  const lines = source.split("\n");
  const h = headerLine(lines);
  if (h >= 0) lines[h] = lines[h].replace(FLOW_HEADER_RE, (all, pre: string, dir: string) => (dir === "LR" || dir === "RL" ? `${pre}TB` : all));
  if (level >= 2) {
    for (let i = 0; i < lines.length; i++) {
      if (i === h) continue;
      lines[i] = lines[i].replace(DIRECTION_LINE_RE, (all, pre: string, dir: string) => (dir === "LR" || dir === "RL" ? `${pre}TB` : all));
    }
  }
  return lines.join("\n");
}

/** Types whose top-down layout can turn sideways by injecting `direction LR`. */
export const TURNABLE_TYPES = ["class", "state", "er", "requirement"] as const;

/** Inject `direction LR` after the header (class, state, ER, requirement). */
export function turnSource(source: string): string {
  const lines = source.split("\n");
  const h = headerLine(lines);
  if (h < 0) return source;
  const indent = /^\s*/.exec(lines[h + 1] ?? "")?.[0] || "  ";
  lines.splice(h + 1, 0, `${indent}direction LR`);
  return lines.join("\n");
}
