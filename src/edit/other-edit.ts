/**
 * Text and shape edits for state diagrams and mindmaps (pure). Both are
 * line-oriented; quoted (Mehrpele) text may span lines, so statements are
 * read with quotes honoured.
 */
import { quotedEnd } from "./flow-scan";
import { appendLines } from "./style-lines";

interface Stmt {
  start: number;
  end: number;
  text: string;
}

/** Logical lines: a newline inside a quoted string does not end the line. */
export function logicalLines(src: string): Stmt[] {
  const out: Stmt[] = [];
  let start = 0;
  let i = 0;
  while (i <= src.length) {
    if (i === src.length || src[i] === "\n") {
      out.push({ start, end: i, text: src.slice(start, i) });
      start = i + 1;
      i++;
      continue;
    }
    if (src[i] === '"') {
      const q = quotedEnd(src, i);
      i = q < 0 ? src.length : q;
      continue;
    }
    i++;
  }
  return out;
}

const replace = (src: string, start: number, end: number, text: string) => src.slice(0, start) + text + src.slice(end);

function removeStmt(src: string, s: Stmt): string {
  if (s.end < src.length) return src.slice(0, s.start) + src.slice(s.end + 1);
  return src.slice(0, Math.max(0, s.start - 1)) + src.slice(s.end);
}

// -- state diagrams ---------------------------------------------------------------

const TRANSITION = /^(\s*)(\S+)\s*-->\s*(\S+?)(\s*:\s*(.*))?\s*$/s;
const DESCRIPTION = /^(\s*)([\w.]+)\s*:\s?(.*)$/s;
const STATE_AS = /^(\s*)state\s+("(?:\\.|[^"\\])*")\s+as\s+([\w.]+)\s*$/;

export interface StateTransition extends Stmt {
  from: string;
  to: string;
  label: { start: number; end: number } | null;
  /** Pele's SVG id number (`edgeN`): notes take numbers too. */
  edgeNo: number;
}

/** Transitions in source order with Pele's edge numbers (note bodies skipped, notes counted). */
export function stateTransitions(src: string): StateTransition[] {
  const out: StateTransition[] = [];
  let n = 0;
  let inNote = false;
  for (const s of logicalLines(src)) {
    if (inNote) {
      if (/^\s*end\s+note\s*$/.test(s.text)) inNote = false;
      continue;
    }
    if (/^\s*%%/.test(s.text)) continue;
    if (/^\s*note\b/.test(s.text)) {
      n++;
      if (!s.text.includes(":")) inNote = true;
      continue;
    }
    const m = TRANSITION.exec(s.text);
    if (!m) continue;
    let label: { start: number; end: number } | null = null;
    if (m[4] !== undefined) {
      const colon = s.text.indexOf(":", s.text.indexOf("-->") + 3);
      let a = colon + 1;
      while (s.text[a] === " ") a++;
      label = { start: s.start + a, end: s.start + s.text.trimEnd().length };
    }
    out.push({ ...s, from: m[2], to: m[3], label, edgeNo: n++ });
  }
  return out;
}

/** Description statements of state `id` (`id : text`). */
function descriptions(src: string, id: string): Array<Stmt & { textStart: number }> {
  const out: Array<Stmt & { textStart: number }> = [];
  for (const s of logicalLines(src)) {
    if (s.text.includes("-->") || /^\s*(%%|state\b|note\b|classDef\b|class\b|style\b)/.test(s.text)) continue;
    const m = DESCRIPTION.exec(s.text);
    if (!m || m[2] !== id) continue;
    out.push({ ...s, textStart: s.start + s.text.length - m[3].length });
  }
  return out;
}

/** The raw description text of a state (what follows `id :`), joined; null: none written. */
export function stateTextRaw(src: string, id: string): { raw: string; form: "description" | "as" } | null {
  const ds = descriptions(src, id);
  if (ds.length) return { raw: ds.map((d) => src.slice(d.textStart, d.end).trim()).join("\n"), form: "description" };
  for (const s of logicalLines(src)) {
    const m = STATE_AS.exec(s.text);
    if (m && m[3] === id) return { raw: m[2], form: "as" };
  }
  return null;
}

/** Replace a state's text: first description line (others removed), `state "…" as`, or a new line. */
export function setStateText(src: string, id: string, raw: string, indent = "  "): string {
  const ds = descriptions(src, id);
  if (ds.length) {
    let out = src;
    for (const d of ds.slice(1).reverse()) out = removeStmt(out, d);
    const first = ds[0];
    return replace(out, first.textStart, first.end, raw);
  }
  for (const s of logicalLines(src)) {
    const m = STATE_AS.exec(s.text);
    if (m && m[3] === id) {
      const q = s.text.indexOf(m[2]);
      const quoted = raw.startsWith('"') ? raw : `"${raw}"`;
      return replace(src, s.start + q, s.start + q + m[2].length, quoted);
    }
  }
  // After the first statement that mentions the state (same block and indentation).
  const mention = new RegExp(`(^|[\\s:>-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s:{-])`);
  const first = logicalLines(src).find((l) => !/^\s*(%%|note\b|classDef\b|class\b|style\b)/.test(l.text) && mention.test(l.text.trim().startsWith("state ") ? "" : l.text));
  if (first) {
    const ind = /^\s*/.exec(first.text)![0] || indent;
    return `${src.slice(0, first.end)}\n${ind}${id} : ${raw}${src.slice(first.end)}`;
  }
  return appendLines(src, [`${id} : ${raw}`]);
}

/** Set (raw) or remove (null) the label of transition `k`. */
export function setTransitionLabel(src: string, k: number, raw: string | null): string | null {
  const t = stateTransitions(src)[k];
  if (!t) return null;
  if (t.label) {
    if (raw !== null) return replace(src, t.label.start, t.label.end, raw);
    const colon = src.lastIndexOf(":", t.label.start);
    let a = colon;
    while (a > t.start && src[a - 1] === " ") a--;
    return replace(src, a, t.label.end, "");
  }
  if (raw === null) return src;
  const end = t.start + t.text.trimEnd().length;
  return replace(src, end, end, ` : ${raw}`);
}

/** Delete transition `k`. */
export function deleteTransition(src: string, k: number): string | null {
  const t = stateTransitions(src)[k];
  return t ? removeStmt(src, t) : null;
}

// -- mindmaps -------------------------------------------------------------------------

export interface MindShape {
  key: string;
  name: string;
  open: string;
  close: string;
  icon: string;
}

export const MIND_SHAPES: readonly MindShape[] = [
  { key: "default", name: "Default", open: "", close: "", icon: "type" },
  { key: "rect", name: "Square", open: "[", close: "]", icon: "square" },
  { key: "rounded", name: "Rounded", open: "(", close: ")", icon: "square-round-corner" },
  { key: "circle", name: "Circle", open: "((", close: "))", icon: "circle" },
  { key: "bang", name: "Bang", open: "))", close: "((", icon: "sparkle" },
  { key: "cloud", name: "Cloud", open: ")", close: "(", icon: "cloud" },
  { key: "hexagon", name: "Hexagon", open: "{{", close: "}}", icon: "hexagon" },
];

export interface MindNode extends Stmt {
  indent: string;
  id: string;
  shape: MindShape;
  /** The text (raw, quotes included when quoted). */
  textSpan: { start: number; end: number };
  /** After the node (`:::class`, `::icon` stay). */
}

const MIND_OPEN = ["((", "))", "{{", "(", ")", "["];

/** Mindmap node statements in source (= Pele's tree) order. */
export function mindNodes(src: string): MindNode[] {
  const out: MindNode[] = [];
  let seenHeader = false;
  for (const s of logicalLines(src)) {
    const t = s.text;
    if (!t.trim() || /^\s*%%/.test(t)) continue;
    if (!seenHeader) {
      if (/^\s*mindmap\b/.test(t)) seenHeader = true;
      continue;
    }
    if (/^\s*::icon\(/.test(t) || /^\s*:::/.test(t)) continue;
    const indent = /^\s*/.exec(t)![0];
    const body = t.slice(indent.length).replace(/\s+$/, "");
    const idm = /^[\w-]*/.exec(body)![0];
    const after = body.slice(idm.length);
    const open = MIND_OPEN.find((o) => after.startsWith(o));
    const bodyStart = s.start + indent.length;
    if (open) {
      const shape = MIND_SHAPES.find((m) => m.open === open)!;
      let closeAt = after.lastIndexOf(shape.close);
      if (closeAt <= open.length - 1) closeAt = after.length;
      out.push({
        ...s,
        indent,
        id: idm || after.slice(open.length, closeAt),
        shape,
        textSpan: { start: bodyStart + idm.length + open.length, end: bodyStart + idm.length + closeAt },
      });
    } else {
      out.push({ ...s, indent, id: body, shape: MIND_SHAPES[0], textSpan: { start: bodyStart, end: bodyStart + body.length } });
    }
  }
  return out;
}

/** An id for a bare mindmap node gaining brackets (its text, when that is a word). */
function mindIdFor(text: string): string {
  return /^[\w-]+$/.test(text) ? text : text.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || "node";
}

/** Change mindmap node `k`'s shape. */
export function setMindShape(src: string, k: number, key: string): string | null {
  const n = mindNodes(src)[k];
  const shape = MIND_SHAPES.find((m) => m.key === key);
  if (!n || !shape) return null;
  const text = src.slice(n.textSpan.start, n.textSpan.end);
  if (n.shape.key === "default") {
    if (shape.key === "default") return src;
    return replace(src, n.textSpan.start, n.textSpan.end, `${mindIdFor(text)}${shape.open}${text}${shape.close}`);
  }
  const bodyStart = n.start + n.indent.length;
  const idEnd = n.textSpan.start - n.shape.open.length;
  if (shape.key === "default") return replace(src, bodyStart, n.textSpan.end + n.shape.close.length, text.replace(/^"|"$/g, ""));
  return replace(src, idEnd, n.textSpan.end + n.shape.close.length, `${shape.open}${text}${shape.close}`);
}

/** Replace mindmap node `k`'s text with `raw`. */
export function setMindText(src: string, k: number, raw: string): string | null {
  const n = mindNodes(src)[k];
  if (!n) return null;
  return replace(src, n.textSpan.start, n.textSpan.end, raw);
}

/** Delete mindmap node `k` and its subtree (deeper-indented lines after it). */
export function deleteMindNode(src: string, k: number): string | null {
  const nodes = mindNodes(src);
  const n = nodes[k];
  if (!n || k === 0) return null;
  let last = n;
  for (const m of nodes.slice(k + 1)) {
    if (m.indent.length <= n.indent.length) break;
    last = m;
  }
  const end = last.end < src.length ? last.end + 1 : last.end;
  const start = last.end < src.length ? n.start : Math.max(0, n.start - 1);
  return src.slice(0, start) + src.slice(end);
}
