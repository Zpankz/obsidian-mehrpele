/**
 * In-place flowchart rewrites (pure): a node's shape and label, an edge's
 * arrow, line style and label, a subgraph's title, and deletions. Every
 * edit replaces only the characters it is about (ids, other statements,
 * comments and `%% pele-… %%` lines are untouched), so node ids stay stable.
 * Deleting an edge or node re-indexes `linkStyle` lines so every other edge
 * keeps its style.
 */
import { withNodeSize } from "pele-render/node-size";
import { firstVertex, quotedEnd, scanFlowchart, shapedVertex, type EdgeRef, type FlowScan, type FlowStroke, type LinkToken, type SubgraphRef, type VertexRef, type VertexStatement } from "./flow-scan";
import { dropPins } from "./canvas-pos";
import { dropStyling, reindexLinkStyles } from "./style-lines";

export interface FlowShape {
  key: string;
  name: string;
  open: string;
  close: string;
  /** Pele model `type` values that mean this shape. */
  pele: string[];
  /** `@{ shape: … }` name. */
  data: string;
  icon: string;
}

export const FLOW_SHAPES: readonly FlowShape[] = [
  { key: "rect", name: "Rectangle", open: "[", close: "]", pele: ["square", "rect"], data: "rect", icon: "square" },
  { key: "rounded", name: "Rounded", open: "(", close: ")", pele: ["round", "rounded"], data: "rounded", icon: "square-round-corner" },
  { key: "stadium", name: "Stadium", open: "([", close: "])", pele: ["stadium"], data: "stadium", icon: "pill" },
  { key: "subroutine", name: "Subroutine", open: "[[", close: "]]", pele: ["subroutine"], data: "fr-rect", icon: "columns-3" },
  { key: "cylinder", name: "Cylinder", open: "[(", close: ")]", pele: ["cylinder"], data: "cyl", icon: "database" },
  { key: "circle", name: "Circle", open: "((", close: "))", pele: ["circle"], data: "circle", icon: "circle" },
  { key: "doublecircle", name: "Double circle", open: "(((", close: ")))", pele: ["doublecircle"], data: "dbl-circ", icon: "circle-dot" },
  { key: "diamond", name: "Diamond", open: "{", close: "}", pele: ["diamond"], data: "diam", icon: "diamond" },
  { key: "hexagon", name: "Hexagon", open: "{{", close: "}}", pele: ["hexagon"], data: "hex", icon: "hexagon" },
  { key: "parallelogram", name: "Parallelogram", open: "[/", close: "/]", pele: ["lean_right"], data: "lean-r", icon: "slash" },
  { key: "parallelogram-alt", name: "Parallelogram (alt)", open: "[\\", close: "\\]", pele: ["lean_left"], data: "lean-l", icon: "slash" },
  { key: "trapezoid", name: "Trapezoid", open: "[/", close: "\\]", pele: ["trapezoid"], data: "trap-b", icon: "triangle" },
  { key: "trapezoid-alt", name: "Trapezoid (alt)", open: "[\\", close: "/]", pele: ["inv_trapezoid"], data: "trap-t", icon: "triangle" },
  { key: "asymmetric", name: "Asymmetric", open: ">", close: "]", pele: ["odd"], data: "odd", icon: "flag" },
];

export function shapeByKey(key: string): FlowShape | undefined {
  return FLOW_SHAPES.find((s) => s.key === key);
}

/** The shape key for a vertex's written brackets (null: none written). */
export function writtenShape(v: VertexRef | null): string | null {
  if (!v?.shape || v.shape.kind !== "bracket") return null;
  return FLOW_SHAPES.find((s) => s.open === v.shape!.open && s.close === v.shape!.close)?.key ?? null;
}

const replace = (src: string, start: number, end: number, text: string) => src.slice(0, start) + text + src.slice(end);

/** Label raw text must be quoted to sit inside `shape`'s brackets. */
function fitsUnquoted(raw: string): boolean {
  return !/[()[\]{}<>/\\|"]/.test(raw);
}

/** Unquoted labels never hold `"`; quoting plain text is harmless in a Markdown block too. */
function quoteRawForBrackets(raw: string): string {
  return fitsUnquoted(raw) ? raw : `"${raw}"`;
}

/** Change a node's shape (its last shaped definition; a bare node gains one). */
export function setNodeShape(src: string, scan: FlowScan, id: string, key: string): string | null {
  const shape = shapeByKey(key);
  if (!shape) return null;
  const v = shapedVertex(scan, id);
  if (v?.shape?.kind === "data") {
    const body = src.slice(v.shape.span.start, v.shape.span.end);
    const m = /(\bshape\s*:\s*)([\w-]+)/.exec(body);
    const next = m
      ? body.slice(0, m.index) + m[1] + shape.data + body.slice(m.index + m[0].length)
      : body.replace(/^@\{\s*/, (h) => `${h}shape: ${shape.data}, `);
    return replace(src, v.shape.span.start, v.shape.span.end, next);
  }
  if (v?.shape?.label) {
    const raw = src.slice(v.shape.label.span.start, v.shape.label.span.end);
    const inner = v.shape.label.quoted ? raw : quoteRawForBrackets(raw);
    return replace(src, v.shape.span.start, v.shape.span.end, shape.open + inner + shape.close);
  }
  const bare = firstVertex(scan, id);
  if (!bare) return null;
  return replace(src, bare.idSpan.end, bare.idSpan.end, shape.open + quoteRawForBrackets(id) + shape.close);
}

/** The raw label of a node (between its brackets), or null when it has none written. */
export function nodeLabelRaw(src: string, scan: FlowScan, id: string): string | null {
  const v = shapedVertex(scan, id);
  if (!v?.shape) return null;
  if (v.shape.kind === "data") {
    const body = src.slice(v.shape.span.start, v.shape.span.end);
    const m = /\blabel\s*:\s*/.exec(body);
    if (!m) return null;
    const at = m.index + m[0].length;
    if (body[at] === '"') {
      const q = quotedEnd(body, at);
      return q > 0 ? body.slice(at, q) : null;
    }
    const e = /[,}]/.exec(body.slice(at));
    return e ? body.slice(at, at + e.index).trim() : null;
  }
  return v.shape.label ? src.slice(v.shape.label.span.start, v.shape.label.span.end) : null;
}

/** Replace a node's label with `raw` (already formatted: quoted or safe plain). */
export function setNodeLabel(src: string, scan: FlowScan, id: string, raw: string): string | null {
  const v = shapedVertex(scan, id);
  if (v?.shape?.kind === "data") {
    const span = v.shape.span;
    const body = src.slice(span.start, span.end);
    const m = /\blabel\s*:\s*/.exec(body);
    const quoted = raw.startsWith('"') ? raw : `"${raw}"`;
    if (!m) return replace(src, span.start, span.end, body.replace(/^@\{\s*/, (h) => `${h}label: ${quoted}, `));
    const at = m.index + m[0].length;
    let end: number;
    if (body[at] === '"') end = quotedEnd(body, at);
    else end = at + (/[,}]/.exec(body.slice(at))?.index ?? 0);
    if (end <= at) return null;
    return replace(src, span.start + at, span.start + end, quoted);
  }
  if (v?.shape?.label) return replace(src, v.shape.label.span.start, v.shape.label.span.end, raw);
  const bare = firstVertex(scan, id);
  if (!bare) return null;
  return replace(src, bare.idSpan.end, bare.idSpan.end, `[${raw}]`);
}

// -- edges ----------------------------------------------------------------------------

/** none / arrow at the end / arrows at both ends; circle and cross set that tip (Mermaid `--o`, `x--x`), keeping one or both ends. */
export type Heads = "none" | "one" | "both" | "circle" | "cross";

export interface LinkStyleChange {
  stroke?: Exclude<FlowStroke, "invisible">;
  heads?: Heads;
}

export function headsOf(link: LinkToken): Heads {
  if (link.right === "o") return "circle";
  if (link.right === "x") return "cross";
  return link.left && link.right ? "both" : link.right ? "one" : "none";
}

/** Arrow syntax for a stroke, heads and length (no label). */
export function arrowSyntax(stroke: FlowStroke, left: string, right: string, length: number): string {
  const n = Math.max(1, length);
  if (stroke === "invisible") return "~".repeat(n + 2);
  if (stroke === "dotted") return `${left}-${".".repeat(n)}-${right}`;
  const ch = stroke === "thick" ? "=" : "-";
  return `${left}${ch.repeat(right ? n + 1 : n + 2)}${right}`;
}

function linkSyntax(link: LinkToken, labelRaw: string | null, change: LinkStyleChange = {}): string {
  const stroke = change.stroke ?? link.stroke;
  let left: string = link.left;
  let right: string = link.right;
  if (change.heads) {
    const both = !!(left && right);
    if (change.heads === "circle" || change.heads === "cross") {
      right = change.heads === "circle" ? "o" : "x";
      left = both ? right : "";
    } else {
      right = change.heads === "none" ? "" : ">";
      left = change.heads === "both" ? "<" : "";
    }
  }
  // A left head needs a right one (`<--` alone is not a link).
  if (left && !right) right = left === "<" ? ">" : left;
  const arrow = arrowSyntax(stroke, left, right, link.length);
  return labelRaw === null ? arrow : `${arrow}|${labelRaw}|`;
}

function currentLabelRaw(src: string, link: LinkToken): string | null {
  return link.label ? src.slice(link.label.span.start, link.label.span.end) : null;
}

/** Change an edge's line style and/or arrowheads (the label is kept, as a pipe label). */
export function setEdgeLink(src: string, edge: EdgeRef, change: LinkStyleChange): string {
  const label = currentLabelRaw(src, edge.link);
  let syntax = linkSyntax(edge.link, label === null ? null : label.trim(), change);
  // A circle / cross tail glued to the node id would join it (`Ao--oB` is node `Ao`).
  if (/^[ox]/.test(syntax) && /\S/.test(src[edge.link.span.start - 1] ?? " ")) syntax = ` ${syntax}`;
  return replace(src, edge.link.span.start, edge.link.span.end, syntax);
}

/** Set (raw, formatted) or remove (null) an edge's label. */
export function setEdgeLabel(src: string, edge: EdgeRef, raw: string | null): string {
  const link = edge.link;
  if (raw !== null && link.label && link.form !== "plain") {
    return replace(src, link.label.span.start, link.label.span.end, raw);
  }
  return replace(src, link.span.start, link.span.end, linkSyntax(link, raw));
}

// -- subgraphs ------------------------------------------------------------------------

/** Set a subgraph's title (raw, formatted). Quoted-only subgraphs keep quotes. */
export function setSubgraphTitle(src: string, sg: SubgraphRef, raw: string): string | null {
  if (sg.title && sg.titleForm === "bracket") return replace(src, sg.title.span.start, sg.title.span.end, raw);
  if (sg.title && sg.titleForm === "quoted") {
    const quoted = raw.startsWith('"') ? raw : `"${raw}"`;
    return replace(src, sg.title.span.start, sg.title.span.end, quoted);
  }
  if (sg.id && !sg.title) {
    const lineText = src.slice(sg.line.start, sg.line.end);
    const at = sg.line.start + lineText.indexOf(sg.id, lineText.indexOf("subgraph") + 8) + sg.id.length;
    return replace(src, at, at, ` [${raw}]`);
  }
  if (sg.title && sg.titleForm === "bare") {
    const quoted = raw.startsWith('"') ? raw : `"${raw}"`;
    return replace(src, sg.title.span.start, sg.title.span.end, quoted);
  }
  return null;
}

/** Remove a subgraph's `subgraph`/`end` lines (its contents stay, ungrouped). */
export function ungroupSubgraph(src: string, sg: SubgraphRef, kindId: string | null): string | null {
  if (!sg.endLine) return null;
  let out = removeLineAt(src, sg.endLine.start);
  out = removeLineAt(out, sg.line.start);
  return kindId ? dropStyling(out, "flowchart", kindId) : out;
}

function lineBounds(src: string, pos: number): { start: number; end: number } {
  const start = src.lastIndexOf("\n", pos - 1) + 1;
  const nl = src.indexOf("\n", pos);
  return { start, end: nl < 0 ? src.length : nl };
}

function removeLineAt(src: string, pos: number): string {
  const { start, end } = lineBounds(src, pos);
  if (end < src.length) return src.slice(0, start) + src.slice(end + 1);
  return src.slice(0, Math.max(0, start - 1));
}

// -- deletion ---------------------------------------------------------------------------

/** Marks a lone leftover id written by a delete, until pruneLone decides on it. */
const LONE = "%%pele-lone%%";

/**
 * Rewrite one statement without some vertices/links; "" when nothing is left.
 * Pieces left as lone unshaped, unclassed ids (`B --> D` minus B leaves `D`)
 * are tagged: pruneLone drops them only if the id still occurs elsewhere in
 * the rewritten source.
 */
function rebuildStatement(src: string, st: VertexStatement, dropVertex: (v: VertexRef) => boolean, dropLink: (k: number) => boolean): string {
  const vtext = (v: VertexRef) => src.slice(v.idSpan.start, v.end);
  const segments: string[] = [];
  let cur = "";
  let lone: VertexRef[] | null = null;
  const flush = () => {
    const bare = lone !== null && lone.every((v) => !v.shape && v.end === v.idSpan.end);
    if (cur) segments.push(bare ? `${cur} ${LONE}` : cur);
    cur = "";
    lone = null;
  };
  for (let k = 0; k < st.vertices.length; k++) {
    const group = st.vertices[k].filter((v) => !dropVertex(v));
    const linkIn = k > 0 ? st.links[k - 1] : null;
    const linked = linkIn && !dropLink(k - 1) && cur !== "" && group.length > 0;
    if (!linked && cur) flush();
    if (group.length === 0) continue;
    const gtext = group.map(vtext).join(" & ");
    if (linked) {
      cur = `${cur} ${src.slice(linkIn.span.start, linkIn.span.end)} ${gtext}`;
      lone = null;
    } else {
      cur = gtext;
      lone = group;
    }
  }
  flush();
  return segments.join("\n");
}

/**
 * Resolve tagged lone ids against the rewritten source: one is dropped when
 * its id(s) still occur in another statement, else its tag is removed. One at
 * a time with a rescan, so the last occurrence of an id always stays.
 */
function pruneLone(src: string): string {
  let out = src;
  for (let guard = 0; guard < 1000 && out.includes(LONE); guard++) {
    const scan = scanFlowchart(out);
    const tagged = scan.statements.find((st) => out.slice(st.span.end, st.span.end + LONE.length + 2).trimStart().startsWith(LONE));
    if (!tagged) break;
    const ids = tagged.vertices.flat().map((v) => v.id);
    const elsewhere = ids.every((id) => scan.statements.some((o) => o !== tagged && o.vertices.some((g) => g.some((v) => v.id === id))));
    const tagAt = out.indexOf(LONE, tagged.span.end);
    if (elsewhere) {
      out = replaceStatement(out, { ...tagged, span: { start: tagged.span.start, end: tagAt + LONE.length } }, "");
    } else {
      let a = tagAt;
      while (a > 0 && out[a - 1] === " ") a--;
      out = out.slice(0, a) + out.slice(tagAt + LONE.length);
    }
  }
  return out.split(` ${LONE}`).join("").split(LONE).join("");
}

function replaceStatement(src: string, st: VertexStatement, text: string): string {
  if (text) {
    const { start } = lineBounds(src, st.span.start);
    const indent = /^[ \t]*/.exec(src.slice(start))![0];
    return replace(src, st.span.start, st.span.end, text.split("\n").join(`\n${indent}`));
  }
  // Nothing left: drop the statement, and its line when that empties it.
  const out = replace(src, st.span.start, st.span.end, "");
  const { start, end } = lineBounds(out, st.span.start);
  const line = out.slice(start, end).replace(/;/g, "");
  return line.trim() === "" ? removeLineAt(out, start) : out;
}

/**
 * Delete edge `index` (Pele order). Its statement splits around the link;
 * the nodes stay. Links shared by an `&` group (one arrow, several edges)
 * cannot be removed alone: null.
 */
export function deleteEdge(src: string, scan: FlowScan, index: number): string | null {
  const edge = scan.edges[index];
  if (!edge || edge.groupSize > 1) return null;
  const st = scan.statements.find((s) => s.span.start === edge.stmt.start);
  if (!st) return null;
  const k = st.links.indexOf(edge.link);
  if (k < 0) return null;
  const out = pruneLone(replaceStatement(src, st, rebuildStatement(src, st, () => false, (j) => j === k)));
  return reindexLinkStyles(out, index);
}

/**
 * Delete a node: every occurrence leaves its statements (edges through it go,
 * chains split), then its style/class/click lines and its size entry.
 */
export function deleteNode(src: string, scan: FlowScan, id: string): string | null {
  if (!scan.vertices.some((v) => v.id === id)) return null;
  const removed = scan.edges.filter((e) => e.start === id || e.end === id).map((e) => e.index);
  let out = src;
  for (const st of [...scan.statements].reverse()) {
    if (!st.vertices.some((g) => g.some((v) => v.id === id))) continue;
    out = replaceStatement(out, st, rebuildStatement(out, st, (v) => v.id === id, () => false));
  }
  out = pruneLone(out);
  for (const i of [...removed].sort((a, b) => b - a)) out = reindexLinkStyles(out, i);
  out = dropStyling(out, "flowchart", id);
  out = withNodeSize(out, id, null);
  // Canvas layout: its pin and its edges' ports go too.
  return dropPins(out, id);
}
