/**
 * Quote-aware label scanner. Pure — no DOM, no App.
 *
 * Any double-quoted label is Markdown; any unquoted label is plain text.
 * Handles `\"` escapes (Mehrmaid's regex broke on any inner `"`), edge cases
 * from Mehrmaid's issues (`[[a|"b"]]`, backticks adjacent to quotes, quotes
 * inside subgraph titles), and the `%% mehrpele %%` opt-in directive.
 */
import {
  buildModel,
  markdownToFallback,
  parseSoleEmbed,
  unescapeLabelMarkdown,
  type MehrpeleLabel,
  type MehrpeleModel,
} from "./model";

export { isMehrpeleSource, hasMehrpeleDirective } from "../mehrpele-source";

export const MEHRPELE_DIRECTIVE = "%% mehrpele %%";

/** Remove the opt-in directive (Pele treats it as a comment; keep source clean). */
export function stripMehrpeleDirective(source: string): string {
  return source.replace(/(^|\n)[ \t]*%%\s*mehrpele\s*%%[ \t]*(\n|$)/g, "$1");
}

interface QuotedSpan {
  /** Index of the opening quote. */
  start: number;
  /** Index just past the closing quote. */
  end: number;
  /** Raw (still escaped) inner text. */
  rawInner: string;
}

/** Find every double-quoted span, honouring `\"` and `\\` escapes. */
export function findQuotedSpans(source: string): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] !== '"') {
      i++;
      continue;
    }
    const start = i;
    i++;
    let raw = "";
    let closed = false;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\" && i + 1 < source.length) {
        raw += ch + source[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') {
        closed = true;
        i++;
        break;
      }
      raw += ch;
      i++;
    }
    if (closed) spans.push({ start, end: i, rawInner: raw });
    // Unclosed quote: ignore the span (diagram renders as plain Pele / errors upstream).
  }
  return spans;
}

const ID_CHAR = /[A-Za-z0-9_]/;

/** The identifier token ending just before `pos` (skipping spaces), if any. */
function idBefore(source: string, pos: number): string | null {
  let i = pos - 1;
  while (i >= 0 && (source[i] === " " || source[i] === "\t")) i--;
  const end = i + 1;
  while (i >= 0 && ID_CHAR.test(source[i])) i--;
  const id = source.slice(i + 1, end);
  return id.length > 0 ? id : null;
}

/** The identifier token starting at/after `pos` (skipping spaces), if any. */
function idAfter(source: string, pos: number): string | null {
  let i = pos;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  const start = i;
  while (i < source.length && ID_CHAR.test(source[i])) i++;
  return i > start ? source.slice(start, i) : null;
}

function lineStartOf(source: string, pos: number): number {
  return source.lastIndexOf("\n", pos - 1) + 1;
}

function lineText(source: string, pos: number): string {
  const start = lineStartOf(source, pos);
  const end = source.indexOf("\n", start);
  return source.slice(start, end < 0 ? source.length : end);
}

/** Non-space character immediately before `pos`, or "" at a line/source edge. */
function charBefore(source: string, pos: number): string {
  let i = pos - 1;
  while (i >= 0 && (source[i] === " " || source[i] === "\t")) i--;
  return i >= 0 ? source[i] : "";
}

function makeLabel(
  anchorId: string,
  kind: MehrpeleLabel["kind"],
  span: QuotedSpan,
): MehrpeleLabel {
  const markdown = unescapeLabelMarkdown(span.rawInner);
  const embedTarget = parseSoleEmbed(markdown);
  const label: MehrpeleLabel = {
    anchorId,
    kind,
    markdown,
    fallbackText: markdownToFallback(markdown),
    span: { start: span.start, end: span.end },
  };
  if (embedTarget) label.embedTarget = embedTarget;
  return label;
}

interface EdgeRef {
  start: string;
  end: string;
}

/**
 * Parse flowchart edge endpoints around an edge-label span. Supports
 * `A -->|label| B`, `A -- label --> B`, `A --> label` is not quoted-form.
 * Returns null when the context is not an edge.
 */
function edgeContext(source: string, span: QuotedSpan): EdgeRef | null {
  const before = charBefore(source, span.start);
  const afterCh = source[span.end] ?? "";
  // Piped form: -->|"..."| or ---|"..."|
  if (before === "|" ) {
    const startId = nearestIdLeftOfArrow(source, span.start);
    const endId = idAfter(source, span.end + 1); // skip closing pipe handled by caller check
    if (startId && endId) return { start: startId, end: endId };
    if (startId) {
      const e = idAfter(source, span.end);
      if (e) return { start: startId, end: e };
    }
  }
  if (afterCh === "|") {
    const startId = nearestIdLeftOfArrow(source, span.start);
    const endId = idAfter(source, span.end + 1);
    if (startId && endId) return { start: startId, end: endId };
  }
  // Inline form: A -- "..." --> B   (quote sits between dashes and arrow)
  const left = source.slice(Math.max(0, span.start - 80), span.start);
  if (/--\s*$/.test(left) || /-\.\s*$/.test(left) || /==\s*$/.test(left)) {
    const startId = nearestIdLeftOfArrow(source, span.start);
    const right = source.slice(span.end, span.end + 80);
    const endId = idAfterArrow(right);
    if (startId && endId) return { start: startId, end: endId };
  }
  return null;
}

function idAfterArrow(right: string): string | null {
  const m = /^\s*(?:-->|---|-\.->|==>|--x|--o|->>|->|---)\s*([A-Za-z0-9_]+)/.exec(right);
  return m ? m[1] : null;
}

/** Walk left from `pos` over an arrow/label pipes to the start node id. */
function nearestIdLeftOfArrow(source: string, pos: number): string | null {
  const left = source.slice(Math.max(0, pos - 120), pos);
  // Find the trailing arrow, strip the node shape group(s) before it
  // (which may contain nested brackets/quoted ids), then take the id
  // heading that node expression. Matching an id immediately before the
  // arrow instead picks up ids inside the previous node's quoted label.
  const arrow = /(?:-->|---|-\.->|==>|--x|--o|->>|->|--)\s*\|?\s*$/.exec(left);
  if (arrow) {
    let head = left.slice(0, arrow.index).trimEnd();
    const openFor: Record<string, string> = { "]": "[", ")": "(", "}": "{" };
    for (;;) {
      const close = head[head.length - 1] ?? "";
      const open = openFor[close];
      if (!open) break;
      let depth = 0;
      let i = head.length - 1;
      for (; i >= 0; i--) {
        if (head[i] === close) depth++;
        else if (head[i] === open) {
          depth--;
          if (depth === 0) break;
        }
      }
      if (i < 0) break;
      head = head.slice(0, i).trimEnd();
    }
    const id = idBefore(head, head.length);
    if (id) return id;
  }
  const m2 = /([A-Za-z0-9_]+)\s*$/.exec(left.replace(/\|\s*$/, ""));
  return m2 ? m2[1] : null;
}

/**
 * Count flowchart-ish edges that start before `pos` so an edge label gets the
 * same index Pele assigns (source order of edge statements).
 */
function countEdgesBefore(source: string, upto: number): number {
  const head = source.slice(0, upto);
  // Each arrow occurrence that links two nodes starts an edge. Label pipes
  // (`|...|`) may contain arrows in text; quoted spans were already excluded
  // by counting only up to the label start, but earlier labels could contain
  // arrows — blank quoted spans first for a stable count.
  const blanked = blankQuotedSpans(head);
  const matches = blanked.match(/-->|-\.->|==>|--x|--o|->>|(?<![-\w])---(?![-\w])|(?<![-\w])--(?=\s)/g);
  return matches ? matches.length : 0;
}

function blankQuotedSpans(text: string): string {
  return text.replace(/"(?:\\.|[^"\\])*"/g, (m) => " ".repeat(m.length));
}

/** Classify one quoted span into a label (or null when it is not a label). */
function classify(source: string, span: QuotedSpan, edgeOrdinal: { n: number }): MehrpeleLabel | null {
  const line = lineText(source, span.start);
  // `%%` comment lines (e.g. quoted ids in `%% pele-size "Make tea"=… %%`) hold no labels.
  if (/^\s*%%/.test(line)) return null;
  const before = charBefore(source, span.start);
  const prevChar = source[span.start - 1] ?? "";

  // Subgraph title: `subgraph "Title"`, `subgraph id "Title"`, `subgraph id["Title"]`.
  const sub = /^\s*subgraph\s+(\S+)?\s*$/.exec(line.slice(0, span.start - lineStartOf(source, span.start)));
  if (/^\s*subgraph\b/.test(line)) {
    const head = line.slice(0, span.start - lineStartOf(source, span.start));
    const toks = head.trim().split(/\s+/);
    // toks: ["subgraph"] or ["subgraph", id] or ["subgraph", id, "["]
    let subId = toks.length >= 2 ? toks[1].replace(/[[\]{}()]+$/, "") : "";
    if (!subId || subId === "[") subId = "cluster";
    return makeLabel(`subgraph:${subId}`, "cluster", span);
  }
  void sub;

  // Sequence participant alias: `participant A as "..."` / `actor A as "..."`.
  if (/^\s*(participant|actor)\s+\S+\s+as\s*$/.test(line.slice(0, span.start - lineStartOf(source, span.start)))) {
    const m = /^\s*(?:participant|actor)\s+(\S+)\s+as\s*$/.exec(
      line.slice(0, span.start - lineStartOf(source, span.start)),
    );
    if (m) return makeLabel(m[1], "node", span);
  }

  // State description: `s1: "..."` at line start.
  {
    const head = line.slice(0, span.start - lineStartOf(source, span.start));
    const m = /^\s*([A-Za-z0-9_[\]*]+)\s*:\s*$/.exec(head);
    if (m && !/^\s*(flowchart|graph|stateDiagram|classDiagram|sequenceDiagram|mindmap)\b/.test(line)) {
      // Only when the colon form is not an edge/message (those contain arrows first).
      if (!head.includes("-") && !head.includes("=")) {
        return makeLabel(m[1], "node", span);
      }
    }
  }

  // Edge labels (pipes or inline dashes).
  const edge = edgeContext(source, span);
  if (edge && (before === "|" || (source[span.end] ?? "") === "|" || /--\s*$/.test(source.slice(Math.max(0, span.start - 4), span.start)))) {
    // Arrows before the label include this edge's own arrow/dashes.
    const idx = Math.max(0, countEdgesBefore(source, span.start) - 1);
    const label = makeLabel(`${edge.start}->${edge.end}#${idx}`, "edge", span);
    edgeOrdinal.n = idx + 1;
    return label;
  }

  // Node labels: ID immediately before a bracket/paren/brace that opens the label,
  // e.g. A[".."], A(".."), A{".."}, A[[".."]], A(("..")).
  if (prevChar === "[" || prevChar === "(" || prevChar === "{") {
    // Walk left over consecutive openers to the node id.
    let i = span.start - 1;
    while (i >= 0 && "[({".includes(source[i])) i--;
    const id = idBefore(source, i + 1);
    if (id) return makeLabel(id, "node", span);
  }
  // Standalone quoted label after an id without brackets (rare): `A "..."`.
  const directId = idBefore(source, span.start);
  if (directId && before !== '"' && before !== "|" && charBefore(source, span.start) !== ":") {
    // Only when nothing else claimed it and the previous token is an id at a
    // statement position (start of line or after whitespace + id).
    const head = source.slice(lineStartOf(source, span.start), span.start).trimEnd();
    if (new RegExp(`(^|\\s)${escapeRegExp(directId)}$`).test(head) && !head.includes("--")) {
      return makeLabel(directId, "node", span);
    }
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract every quoted Markdown label from a diagram source.
 * Pure and deterministic: source order preserved, duplicates kept.
 */
export function extractLabels(source: string): MehrpeleLabel[] {
  const clean = stripMehrpeleDirective(source);
  // Spans are computed on the stripped source; spans refer to that string.
  // Callers that substitute placeholders must use the same stripped source
  // (see placeholderSource, which strips identically).
  const spans = findQuotedSpans(clean);
  const labels: MehrpeleLabel[] = [];
  const edgeOrdinal = { n: 0 };
  void edgeOrdinal;
  for (const span of spans) {
    const label = classify(clean, span, edgeOrdinal);
    if (label) labels.push(label);
  }
  return labels;
}

/** Parse a diagram source into the stable Mehrpele model. */
export function parseMehrpele(source: string): MehrpeleModel {
  return buildModel(extractLabels(source));
}
