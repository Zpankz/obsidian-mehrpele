/**
 * Position-preserving flowchart scanner for in-place source edits (pure).
 *
 * Pele's parser gives the model (ids, shapes, edges in order) but no source
 * offsets; edits need to know exactly which characters to replace. This
 * scanner walks the block once and records, for every vertex occurrence,
 * edge (in Pele's edge order, `&` groups expanded), edge label and
 * subgraph, the spans to rewrite. Callers cross-check the result against
 * Pele's model (`alignsWith`) and refuse position edits when they differ, so
 * an unusual statement can never make an edit land on the wrong text.
 *
 * Quoted text follows Mehrpele's rules (`\"` and `\\` escapes), so Markdown
 * labels — multi-line, with nested fences or brackets — are skipped whole.
 */

export interface Span {
  start: number;
  end: number;
}

/** Text between a label's delimiters (quotes included when quoted). */
export interface LabelRef {
  span: Span;
  quoted: boolean;
}

export interface ShapeRef {
  /** From the opener through the closer. */
  span: Span;
  open: string;
  close: string;
  /** "bracket": `A[…]`, `A((…))`; "data": `A@{ shape: …, label: … }`. */
  kind: "bracket" | "data";
  /** Bracket shapes: the label between opener and closer. */
  label: LabelRef | null;
}

export interface VertexRef {
  id: string;
  idSpan: Span;
  shape: ShapeRef | null;
  /** End of the vertex (after its shape and any `:::class`). */
  end: number;
}

export type FlowStroke = "normal" | "thick" | "dotted" | "invisible";
export type LeftHead = "" | "<" | "x" | "o";
export type RightHead = "" | ">" | "x" | "o";

export interface LinkToken {
  /** The whole link: arrow, inline text or `|pipe label|`. */
  span: Span;
  left: LeftHead;
  right: RightHead;
  stroke: FlowStroke;
  /** Mermaid link length (1 = shortest). */
  length: number;
  form: "plain" | "pipe" | "inline";
  label: LabelRef | null;
}

export interface EdgeRef {
  /** Pele's edge index (linkStyle N). */
  index: number;
  start: string;
  end: string;
  link: LinkToken;
  /** Edges this link produces (`A & B --> C` gives 2): >1 shares the link token. */
  groupSize: number;
  /** The statement the edge belongs to. */
  stmt: Span;
}

export interface SubgraphRef {
  /** The id as written (null: `subgraph "Title"`, Pele generates one). */
  id: string | null;
  /** The `subgraph …` line (without its newline). */
  line: Span;
  title: LabelRef | null;
  titleForm: "bracket" | "quoted" | "bare" | null;
  /** The matching `end` line. */
  endLine: Span | null;
}

/** One `A --> B --> C` / `A & B` / `A[..]` statement. */
export interface VertexStatement {
  span: Span;
  vertices: VertexRef[][];
  links: LinkToken[];
}

export interface FlowScan {
  header: Span | null;
  statements: VertexStatement[];
  /** Every vertex occurrence, source order. */
  vertices: VertexRef[];
  edges: EdgeRef[];
  subgraphs: SubgraphRef[];
  /** Statements the scanner could not read (edits then refuse via alignsWith). */
  unknown: Span[];
}

const ID_CHAR = /[\p{L}\p{N}_]/u;

/** Shape openers, longest first, with their closers. */
const OPENERS: Array<{ open: string; close: string[] }> = [
  { open: "(((", close: [")))"] },
  { open: "((", close: ["))"] },
  { open: "([", close: ["])"] },
  { open: "[[", close: ["]]"] },
  { open: "[(", close: [")]"] },
  { open: "[/", close: ["/]", "\\]"] },
  { open: "[\\", close: ["\\]", "/]"] },
  { open: "{{", close: ["}}"] },
  { open: "(", close: [")"] },
  { open: "[", close: ["]"] },
  { open: "{", close: ["}"] },
  { open: ">", close: ["]"] },
];

const SKIP_KEYWORDS = new Set(["direction", "style", "classDef", "class", "click", "linkStyle", "accTitle", "title", "callback", "call"]);

/** End of a double-quoted string starting at `i` (index after the closing quote), or -1. */
export function quotedEnd(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "\\" && j + 1 < src.length) {
      j += 2;
      continue;
    }
    if (ch === '"') return j + 1;
    j++;
  }
  return -1;
}

function lineEnd(src: string, i: number): number {
  const nl = src.indexOf("\n", i);
  return nl < 0 ? src.length : nl;
}

class Scanner {
  i = 0;
  readonly n: number;
  constructor(readonly src: string) {
    this.n = src.length;
  }

  ws(): void {
    while (this.i < this.n && (this.src[this.i] === " " || this.src[this.i] === "\t")) this.i++;
  }

  peek(s: string): boolean {
    return this.src.startsWith(s, this.i);
  }

  readId(): Span | null {
    const s = this.src;
    const start = this.i;
    let j = this.i;
    while (j < this.n) {
      const ch = s[j];
      if (ID_CHAR.test(ch)) {
        j++;
        continue;
      }
      // `my-node`: a single dash between id characters (never `--`, `-.`, `->`).
      if (ch === "-" && j > start && j + 1 < this.n && ID_CHAR.test(s[j + 1])) {
        j++;
        continue;
      }
      break;
    }
    if (j === start) return null;
    this.i = j;
    return { start, end: j };
  }

  /** Shape after a vertex id (adjacent, no space). */
  readShape(): ShapeRef | null {
    const s = this.src;
    const start = this.i;
    if (this.peek("@{")) {
      let j = this.i + 2;
      while (j < this.n && s[j] !== "}") {
        if (s[j] === '"') {
          const q = quotedEnd(s, j);
          if (q < 0) return null;
          j = q;
          continue;
        }
        j++;
      }
      if (j >= this.n) return null;
      this.i = j + 1;
      return { span: { start, end: j + 1 }, open: "@{", close: "}", kind: "data", label: null };
    }
    const opener = OPENERS.find((o) => this.peek(o.open));
    if (!opener) return null;
    let j = this.i + opener.open.length;
    const contentStart = j;
    // Quoted label: skip it whole (it may hold closers, newlines, fences).
    let k = j;
    while (k < this.n && (s[k] === " " || s[k] === "\t")) k++;
    if (s[k] === '"') {
      const q = quotedEnd(s, k);
      if (q < 0) return null;
      let m = q;
      while (m < this.n && (s[m] === " " || s[m] === "\t")) m++;
      const close = opener.close.find((c) => s.startsWith(c, m));
      if (!close) return null;
      this.i = m + close.length;
      return {
        span: { start, end: this.i },
        open: opener.open,
        close,
        kind: "bracket",
        label: { span: { start: contentStart, end: m }, quoted: true },
      };
    }
    // Unquoted: up to the first closer on this line.
    while (j < this.n && s[j] !== "\n") {
      const close = opener.close.find((c) => s.startsWith(c, j));
      if (close) {
        this.i = j + close.length;
        return {
          span: { start, end: this.i },
          open: opener.open,
          close,
          kind: "bracket",
          label: { span: { start: contentStart, end: j }, quoted: false },
        };
      }
      j++;
    }
    return null;
  }

  readVertex(): VertexRef | null {
    const save = this.i;
    const idSpan = this.readId();
    if (!idSpan) return null;
    const id = this.src.slice(idSpan.start, idSpan.end);
    const shapeAt = this.i;
    const shape = this.readShape();
    if (!shape) this.i = shapeAt;
    if (this.peek(":::")) {
      this.i += 3;
      if (!this.readId()) {
        this.i = save;
        return null;
      }
    }
    return { id, idSpan, shape, end: this.i };
  }

  readGroup(): VertexRef[] | null {
    const first = this.readVertex();
    if (!first) return null;
    const group = [first];
    for (;;) {
      const save = this.i;
      this.ws();
      if (!this.peek("&")) {
        this.i = save;
        return group;
      }
      this.i++;
      this.ws();
      const v = this.readVertex();
      if (!v) return null;
      group.push(v);
    }
  }

  /** A link at the cursor (after whitespace), or null. */
  readLink(): LinkToken | null {
    const s = this.src;
    const start = this.i;
    const rest = s.slice(start, start + 400);
    // Dotted inline text: `-. text .->`
    const dotInline = /^(<?)-\.(?=\s)/.exec(rest);
    const m = /^([<xo]?)(-{2,}|={2,}|-\.+-|~{3,})([>xo]?)/.exec(rest);
    if (dotInline && !m) return this.readInline(start, dotInline[1] as LeftHead, "dotted", dotInline[0].length);
    if (!m) return null;
    let [all, left, body, right] = m as unknown as [string, string, string, string];
    // `x`/`o` heads must stand alone (`A --oB` would eat the next id).
    if ((right === "x" || right === "o") && rest[all.length] !== undefined && !/[\s|]/.test(rest[all.length])) {
      all = all.slice(0, -1);
      right = "";
    }
    if (!right && (body === "--" || body === "==") && /\s/.test(rest[all.length] ?? "")) {
      return this.readInline(start, left as LeftHead, body === "==" ? "thick" : "normal", all.length);
    }
    if (body === "--" || body === "==") {
      // `--`/`==` without a head is not a link.
      if (!right) return null;
    }
    const stroke: FlowStroke = body[0] === "~" ? "invisible" : body[0] === "=" ? "thick" : body.includes(".") ? "dotted" : "normal";
    let length: number;
    if (stroke === "dotted") length = body.length - 2;
    else if (stroke === "invisible") length = body.length - 2;
    else length = right ? body.length - 1 : body.length - 2;
    this.i = start + all.length;
    // Optional `|label|`.
    const afterArrow = this.i;
    this.ws();
    if (s[this.i] === "|") {
      const open = this.i;
      let j = open + 1;
      let quoted = false;
      let k = j;
      while (k < this.n && (s[k] === " " || s[k] === "\t")) k++;
      if (s[k] === '"') {
        const q = quotedEnd(s, k);
        if (q < 0) return null;
        j = q;
        while (j < this.n && (s[j] === " " || s[j] === "\t")) j++;
        if (s[j] !== "|") return null;
        quoted = true;
      } else {
        while (j < this.n && s[j] !== "|" && s[j] !== "\n") j++;
        if (s[j] !== "|") return null;
      }
      this.i = j + 1;
      return {
        span: { start, end: this.i },
        left: left as LeftHead,
        right: right as RightHead,
        stroke,
        length: Math.max(1, length),
        form: "pipe",
        label: { span: { start: open + 1, end: j }, quoted },
      };
    }
    this.i = afterArrow;
    return {
      span: { start, end: afterArrow },
      left: left as LeftHead,
      right: right as RightHead,
      stroke,
      length: Math.max(1, length),
      form: "plain",
      label: null,
    };
  }

  /** `-- text -->`, `== text ==>`, `-. text .->` from `start` (opener length `openLen`). */
  private readInline(start: number, left: LeftHead, stroke: FlowStroke, openLen: number): LinkToken | null {
    const s = this.src;
    let j = start + openLen;
    while (j < this.n && (s[j] === " " || s[j] === "\t")) j++;
    const textStart = j;
    let quoted = false;
    let searchFrom = j;
    if (s[j] === '"') {
      const q = quotedEnd(s, j);
      if (q < 0) return null;
      quoted = true;
      searchFrom = q;
    }
    const closeRe =
      stroke === "thick" ? /(={2,})([>xo]?)/g : stroke === "dotted" ? /(\.+-)([>xo]?)/g : /(-{2,})([>xo]?)/g;
    closeRe.lastIndex = searchFrom;
    const line = lineEnd(s, searchFrom);
    for (let m = closeRe.exec(s); m && m.index < line; m = closeRe.exec(s)) {
      const body = m[1];
      let right = (m[2] ?? "") as RightHead;
      let end = m.index + m[0].length;
      if ((right === "x" || right === "o") && end < this.n && !/\s/.test(s[end])) {
        right = "";
        end--;
      }
      if (stroke !== "dotted" && !right && body.length < 3) continue;
      // The text ends before the closer's leading whitespace.
      let textEnd = m.index;
      if (!quoted) while (textEnd > textStart && (s[textEnd - 1] === " " || s[textEnd - 1] === "\t")) textEnd--;
      else textEnd = searchFrom;
      if (textEnd <= textStart) return null;
      const length = stroke === "dotted" ? body.length - 1 : right ? body.length - 1 : body.length - 2;
      this.i = end;
      return {
        span: { start, end },
        left,
        right,
        stroke,
        length: Math.max(1, length),
        form: "inline",
        label: { span: { start: textStart, end: textEnd }, quoted },
      };
    }
    return null;
  }

  /** Skip to the end of the current statement (newline or `;`, quotes honoured). */
  skipStatement(): void {
    const s = this.src;
    while (this.i < this.n && s[this.i] !== "\n" && s[this.i] !== ";") {
      if (s[this.i] === '"') {
        const q = quotedEnd(s, this.i);
        this.i = q < 0 ? this.n : q;
        continue;
      }
      this.i++;
    }
  }

  atStatementEnd(): boolean {
    const save = this.i;
    this.ws();
    const ch = this.src[this.i];
    const ok = this.i >= this.n || ch === "\n" || ch === ";" || this.peek("%%");
    this.i = save;
    return ok;
  }
}

function wordAt(src: string, i: number): string {
  const m = /^[A-Za-z][\w-]*/.exec(src.slice(i, i + 40));
  return m ? m[0] : "";
}

/** Scan a flowchart block body. */
export function scanFlowchart(source: string): FlowScan {
  const sc = new Scanner(source);
  const out: FlowScan = { header: null, statements: [], vertices: [], edges: [], subgraphs: [], unknown: [] };
  const open: SubgraphRef[] = [];
  const src = source;
  // Frontmatter.
  if (/^\s*---[ \t]*\n/.test(src)) {
    const close = src.indexOf("\n---", src.indexOf("---") + 3);
    if (close >= 0) sc.i = lineEnd(src, close + 1);
  }
  while (sc.i < sc.n) {
    sc.ws();
    const ch = src[sc.i];
    if (ch === "\n" || ch === ";" || ch === "\r") {
      sc.i++;
      continue;
    }
    if (sc.i >= sc.n) break;
    if (sc.peek("%%")) {
      sc.i = lineEnd(src, sc.i);
      continue;
    }
    const stmtStart = sc.i;
    const word = wordAt(src, sc.i);
    const afterWord = src[sc.i + word.length] ?? "";
    const isKeyword = (w: string) => word === w && (afterWord === "" || /[\s;]/.test(afterWord));
    if (!out.header && (word === "flowchart" || word === "graph" || word === "flowchart-elk")) {
      const e = lineEnd(src, sc.i);
      out.header = { start: stmtStart, end: e };
      sc.i = e;
      continue;
    }
    if (isKeyword("subgraph")) {
      const e = lineEnd(src, sc.i);
      out.subgraphs.push(parseSubgraph(src, stmtStart, e));
      open.push(out.subgraphs[out.subgraphs.length - 1]);
      sc.i = e;
      continue;
    }
    if (isKeyword("end")) {
      const sg = open.pop();
      let e = sc.i + 3;
      if (sg) sg.endLine = { start: stmtStart, end: e };
      sc.i = e;
      continue;
    }
    if (word === "accDescr" && /^accDescr\s*\{/.test(src.slice(sc.i, sc.i + 40))) {
      const close = src.indexOf("}", sc.i);
      sc.i = close < 0 ? sc.n : close + 1;
      continue;
    }
    if (SKIP_KEYWORDS.has(word) && (afterWord === "" || /[\s:;]/.test(afterWord))) {
      sc.i = lineEnd(src, sc.i);
      continue;
    }
    // Vertex / edge statement.
    const groups: VertexRef[][] = [];
    const links: LinkToken[] = [];
    const g0 = sc.readGroup();
    let ok = !!g0;
    if (g0) {
      groups.push(g0);
      for (;;) {
        const save = sc.i;
        sc.ws();
        const link = sc.readLink();
        if (!link) {
          sc.i = save;
          break;
        }
        sc.ws();
        const g = sc.readGroup();
        if (!g) {
          ok = false;
          break;
        }
        links.push(link);
        groups.push(g);
      }
      if (ok && !sc.atStatementEnd()) ok = false;
    }
    if (!ok) {
      sc.i = stmtStart;
      sc.skipStatement();
      out.unknown.push({ start: stmtStart, end: sc.i });
      continue;
    }
    sc.ws();
    const span = { start: stmtStart, end: sc.i };
    out.statements.push({ span, vertices: groups, links });
    for (const g of groups) out.vertices.push(...g);
    links.forEach((link, k) => {
      const from = groups[k];
      const to = groups[k + 1];
      for (const a of from)
        for (const b of to)
          out.edges.push({ index: out.edges.length, start: a.id, end: b.id, link, groupSize: from.length * to.length, stmt: span });
    });
  }
  return out;
}

function parseSubgraph(src: string, start: number, end: number): SubgraphRef {
  const line = src.slice(start, end);
  const head = /^subgraph[ \t]+/.exec(line);
  const base = { line: { start, end }, endLine: null } as const;
  if (!head) return { ...base, id: null, title: null, titleForm: null };
  let i = head[0].length;
  const rest = line.slice(i);
  if (rest.startsWith('"')) {
    const q = quotedEnd(line, i);
    if (q > 0) return { ...base, id: null, title: { span: { start: start + i, end: start + q }, quoted: true }, titleForm: "quoted" };
  }
  const idm = /^[\p{L}\p{N}_-]+/u.exec(rest);
  if (!idm) return { ...base, id: null, title: null, titleForm: null };
  const id = idm[0];
  i += id.length;
  let j = i;
  while (line[j] === " " || line[j] === "\t") j++;
  if (line[j] === "[") {
    const contentStart = j + 1;
    let k = contentStart;
    while (line[k] === " ") k++;
    if (line[k] === '"') {
      const q = quotedEnd(line, k);
      if (q > 0) {
        let m = q;
        while (line[m] === " ") m++;
        if (line[m] === "]") return { ...base, id, title: { span: { start: start + contentStart, end: start + m }, quoted: true }, titleForm: "bracket" };
      }
    }
    const close = line.lastIndexOf("]");
    if (close > j) return { ...base, id, title: { span: { start: start + contentStart, end: start + close }, quoted: false }, titleForm: "bracket" };
  }
  const tail = line.slice(j).trimEnd();
  if (tail) return { ...base, id: null, title: { span: { start: start + i - id.length, end: start + j + tail.length }, quoted: false }, titleForm: "bare" };
  return { ...base, id, title: null, titleForm: null };
}

/** The model fields alignment needs (Pele's FlowchartModel subset). */
export interface FlowModelLike {
  edges: Array<{ start: string; end: string; id?: string }>;
}

/** The scan's edges are Pele's edges, in order (position edits are safe). */
export function alignsWith(scan: FlowScan, model: FlowModelLike): boolean {
  if (scan.unknown.length > 0) return false;
  if (scan.edges.length !== model.edges.length) return false;
  return scan.edges.every((e, i) => e.start === model.edges[i].start && e.end === model.edges[i].end);
}

/** Last occurrence of `id` that carries a shape (Mermaid: the last definition wins). */
export function shapedVertex(scan: FlowScan, id: string): VertexRef | null {
  let hit: VertexRef | null = null;
  for (const v of scan.vertices) if (v.id === id && v.shape) hit = v;
  return hit;
}

/** First occurrence of `id` anywhere. */
export function firstVertex(scan: FlowScan, id: string): VertexRef | null {
  return scan.vertices.find((v) => v.id === id) ?? null;
}
