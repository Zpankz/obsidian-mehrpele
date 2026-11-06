// Pure glue: fenced diagram block extraction (no Obsidian imports).
// Delegates to pele-render's extractor so `index=N` counts the same fences
// (mermaid/pele/mehrpele, case-insensitive, ``` or ~~~, LF or CRLF) as
// pele-mermaid's CLI handlers and `pele-render --index N`.
import { extractMermaidBlocks, DIAGRAM_FENCE_LANGS } from "pele-render/extract";

export interface DiagramBlock { lang: string; code: string; startLine: number; endLine: number }

/** Diagram blocks in document order; `startLine`/`endLine` are 0-based fence lines. */
export function extractBlocks(markdown: string): DiagramBlock[] {
  return extractMermaidBlocks(markdown, { langs: DIAGRAM_FENCE_LANGS }).map((b) => ({
    lang: b.lang.toLowerCase(),
    code: b.source,
    startLine: b.startLine - 1,
    endLine: b.endLine - 1,
  }));
}

const QUOTE_MARK = /^ {0,3}> ?/;
const LIST_MARK = /^( *(?:[-*+]|\d{1,9}[.)]))( +|$)/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/; // `* * *` ends a list; it doesn't start one
// Tabs count as one column of indent, as in `extractBlocks`, so top-level fences keep its index.
const OPEN_FENCE = /^([ \t]*)((?:[-*+]|\d{1,9}[.)]) +)?( *)(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE = /^[ \t]{0,3}(`{3,}|~{3,})\s*$/;

/** Remove up to `max` quote markers (`>`); returns how many were removed and the rest of the line. */
function unquote(line: string, max = Infinity): { depth: number; rest: string } {
  let depth = 0;
  let rest = line;
  for (let m = QUOTE_MARK.exec(rest); m && depth < max; m = QUOTE_MARK.exec(rest)) {
    depth++;
    rest = rest.slice(m[0].length);
  }
  return { depth, rest };
}

/**
 * Sources of every diagram fence in document order, including fences inside callouts, blockquotes and
 * list items, which `extractBlocks` skips. Each source is what Obsidian hands the code block processor:
 * quote markers and the list indent are removed.
 */
export function nestedDiagramSources(markdown: string, langs: readonly string[] = DIAGRAM_FENCE_LANGS): string[] {
  const wanted = new Set(langs.map((l) => l.toLowerCase()));
  const lines = markdown.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const out: string[] = [];
  // Content columns of the open list items, innermost last. A line indented less than an item's content ends it.
  let items: number[] = [];
  let listDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const { depth, rest } = unquote(lines[i]);
    if (depth !== listDepth) { items = []; listDepth = depth; }
    const m = OPEN_FENCE.exec(rest);
    const indent = m ? m[1].length : 0;
    const lead = /^[ \t]*/.exec(rest)?.[0].length ?? 0;
    const mark = LIST_MARK.exec(rest);
    const kept = items.filter((c) => c <= lead); // the items this line's indent stays inside
    // A marker opens an item only within 3 spaces of its container's content; past that it is indented code.
    const isItem = !!mark && lead - (kept.length ? kept[kept.length - 1] : 0) <= 3;
    if (THEMATIC_BREAK.test(rest)) items = [];
    else if (mark && isItem) {
      // Up to 4 spaces after the marker belong to it; with more, the content starts 1 space after it.
      items = [...kept, mark[1].length + (mark[2].length >= 1 && mark[2].length <= 4 ? mark[2].length : 1)];
    } else if (rest.trim()) items = kept;
    const inList = items.length > 0;
    // A fence needs at most 3 spaces of indent, counted from the innermost list item's content when in one.
    const base = inList ? items[items.length - 1] : 0;
    if (!m || (m[2] ? !isItem : indent - base > 3)) continue;
    const col = m[1].length + (m[2]?.length ?? 0) + m[3].length;
    const fence = m[4];
    const lang = m[5].trim().split(/\s+/)[0].toLowerCase();
    // The container's content column: the marker's width on its own line, else the list item's content, else 0.
    // In a list item, the fence also ends where the item does (a non-blank line indented less than this), and the
    // closing fence may be indented at most 3 spaces past it, whatever the opener's indent.
    const item = m[2] ? m[1].length + m[2].length : base;
    const container = new RegExp(`^[ \\t]{0,${item}}`);
    const body: string[] = [];
    let j = i + 1;
    let next = lines.length; // the line to scan after this fence
    for (; j < lines.length; j++) {
      const q = unquote(lines[j], depth);
      if (q.depth < depth) { next = j; break; } // the quote ended, and the fence with it
      if (item && q.rest.trim() && (/^[ \t]*/.exec(q.rest)?.[0].length ?? 0) < item) { next = j; break; }
      const line = q.rest.replace(new RegExp(`^[ \\t]{0,${col}}`), "");
      const close = CLOSE_FENCE.exec(q.rest.replace(container, ""));
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) { next = j + 1; break; }
      body.push(line);
    }
    if (wanted.has(lang)) out.push(body.join("\n"));
    i = next - 1;
  }
  return out;
}

/**
 * Index a drawing of the diagram whose source is `source` is named after; -1 if none matches.
 * A top-level diagram keeps its `extractBlocks` index (the CLI's `index=`), so the scanner's heuristics can't change
 * it. Any other diagram gets its document-order position among all fences, nested ones included: an exact match
 * (after trimming) wins, else whitespace at the start and end of each line is ignored.
 */
export function diagramIndexOf(markdown: string, source: string): number {
  const code = source.trim();
  const top = extractBlocks(markdown).findIndex((b) => b.code.trim() === code);
  if (top >= 0) return top;
  const sources = nestedDiagramSources(markdown);
  const exact = sources.findIndex((s) => s.trim() === code);
  if (exact >= 0) return exact;
  const loose = (s: string) => s.split("\n").map((l) => l.trim()).join("\n").trim();
  return sources.findIndex((s) => loose(s) === loose(code));
}

/** Block whose fence range contains `line` (0-based), else the nearest preceding block, else block 0. */
export function blockAtLine(blocks: DiagramBlock[], line: number): DiagramBlock | null {
  if (!blocks.length) return null;
  for (const b of blocks) if (line >= b.startLine && line <= b.endLine) return b;
  let best: DiagramBlock | null = null;
  for (const b of blocks) if (b.startLine <= line) best = b;
  return best ?? blocks[0];
}

/** Default drawing path next to a note: `Dir/Note-diagram[-N].excalidraw.md`, non-colliding via `exists`. */
export function drawingPathFor(notePath: string, index: number, exists: (p: string) => boolean): string {
  const slash = notePath.lastIndexOf("/");
  const dir = slash >= 0 ? notePath.slice(0, slash + 1) : "";
  const base = (slash >= 0 ? notePath.slice(slash + 1) : notePath).replace(/\.(md|markdown|mmd|mermaid|canvas)$/i, "");
  const stem = index > 0 ? `${base}-diagram-${index}` : `${base}-diagram`;
  let candidate = `${dir}${stem}.excalidraw.md`;
  let n = 2;
  while (exists(candidate)) candidate = `${dir}${stem}-${n++}.excalidraw.md`;
  return candidate;
}

/**
 * Validate a caller-supplied drawing path (CLI `out=` / API `path`): vault-relative,
 * no ".." segments, `.excalidraw.md` or `.excalidraw` extension. Returns an error or null.
 */
export function drawingPathError(path: string): string | null {
  if (!path.trim()) return "out= must not be empty";
  if (/^([\\/]|[A-Za-z]:)/.test(path)) return `out= must be a vault-relative path (got "${path}")`;
  if (path.split(/[\\/]/).includes("..")) return `out= must not contain ".." (got "${path}")`;
  if (!/\.excalidraw(\.md)?$/i.test(path)) return `out= must end in .excalidraw.md or .excalidraw (got "${path}")`;
  return null;
}

/** Parse a CLI `index=` param: 0-based, default 0; null when not a valid non-negative integer. */
export function parseIndex(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  return /^\s*\d+\s*$/.test(raw) ? Number(raw) : null;
}
