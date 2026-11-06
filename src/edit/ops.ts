/**
 * Edit operations behind the toolbar and the inline editor (pure). Given a
 * block's source, its diagram type and a target (node, edge or subgraph as
 * the SVG names it), `analyse` says what can be done and `applyEdit` returns
 * the edited source — one string in, one string out, so every action is one
 * undoable write. Pele's own parse resolves ids and edge order; position
 * edits only run when the scanner agrees with it (`alignsWith`).
 */
import { parse } from "pele-render/pele";
import { mehrpeleCheckSource } from "../mehrpele/validate";
import { alignsWith, scanFlowchart, type EdgeRef, type FlowScan, type FlowStroke, type SubgraphRef } from "./flow-scan";
import {
  deleteEdge,
  deleteNode,
  FLOW_SHAPES,
  headsOf,
  nodeLabelRaw,
  setEdgeLabel,
  setEdgeLink,
  setNodeLabel,
  setNodeShape,
  setSubgraphTitle,
  shapeByKey,
  ungroupSubgraph,
  writtenShape,
  type Heads,
} from "./flow-edit";
import { addRelated, freshId, sharedChildAt, subgraphLines, type Relation, type Side } from "./concept-edit";
import { addPin, addPort, isCanvasLayout, pinBeside, pinBeyond } from "./canvas-pos";
import { formatLabel, labelText, withMehrpeleDirective } from "./label-text";
import {
  deleteMindNode,
  deleteTransition,
  MIND_SHAPES,
  mindNodes,
  setMindShape,
  setMindText,
  setStateText,
  setTransitionLabel,
  stateTextRaw,
  stateTransitions,
} from "./other-edit";
import {
  currentColor,
  currentEdgeColor,
  currentTextSize,
  linkStyleOf,
  PRESETS,
  setColor,
  setEdgeColor,
  setEdgeTextSize,
  setTextSize,
  shiftLinkStylesForInsert,
  TEXT_SIZES,
  type ColorChoice,
  type DiagramKind,
  type TextSize,
} from "./style-lines";
import { shapedVertex } from "./flow-scan";
import { isViewNodeLabel } from "../mehrpele/views/syntax"; // view-nodes
import type { MehrpeleEmbedTarget } from "../mehrpele/model"; // view-nodes

export type EditTarget = { kind: "node"; id: string } | { kind: "edge"; id: string } | { kind: "subgraph"; id: string };

export interface EditContext {
  source: string;
  /** Pele's diagram type (RenderResult.type). */
  type: string;
  /** Quoted labels in this block are Markdown (Mehrpele applies or is written). */
  markdownBlock: boolean;
  /** The block may switch to Mehrpele for Markdown text. */
  canSwitch: boolean;
  /** view-nodes: `![[Name]]` names a folder (a folder view node; needs the vault). */
  isFolderEmbed?: (target: MehrpeleEmbedTarget) => boolean;
}

export interface ShapeOption {
  key: string;
  name: string;
  icon: string;
}

export interface Capabilities {
  target: EditTarget;
  /** Human name for menus ("node A", "edge A → B", "subgraph S"). */
  label: string;
  color: boolean;
  currentColor: ColorChoice;
  textSize: boolean;
  currentSize: TextSize | null;
  shapes: ShapeOption[] | null;
  currentShape: string | null;
  lineStyle: boolean;
  currentStroke: FlowStroke | null;
  heads: boolean;
  currentHeads: Heads | null;
  editText: boolean;
  delete: boolean;
  deleteName: string;
  /** e.g. "Changes 2 edges (A & B --> C)". */
  note?: string;
  /** view-nodes: the node hosts a live view (box styling and structure only, no text editing). */
  viewNode?: boolean;
}

export type EditOp =
  | { op: "color"; value: ColorChoice }
  | { op: "size"; value: TextSize | null }
  | { op: "shape"; key: string }
  | { op: "stroke"; value: Exclude<FlowStroke, "invisible"> }
  | { op: "heads"; value: Heads }
  | { op: "text"; text: string }
  | { op: "delete" };

export type EditResult = { ok: true; source: string; switched: boolean } | { ok: false; error: string };

export function diagramKind(type: string | null | undefined): DiagramKind {
  const t = (type ?? "").toLowerCase();
  if (t === "flowchart" || t === "graph" || t.startsWith("flowchart")) return "flowchart";
  if (t.startsWith("state")) return "state";
  if (t === "class" || t.startsWith("classdiagram")) return "class";
  if (t === "mindmap") return "mindmap";
  return "other";
}

/** Diagram types the toolbar works on. */
export function supportsEditing(type: string | null | undefined): boolean {
  return diagramKind(type) !== "other";
}

// -- model access -------------------------------------------------------------------

interface FlowModel {
  nodes: Map<string, unknown>;
  edges: Array<{ start: string; end: string; id?: string }>;
  subgraphs: Array<{ id: string; title: string }>;
}

function peleModel(ctx: EditContext): unknown {
  try {
    return parse(ctx.markdownBlock ? mehrpeleCheckSource(ctx.source) : ctx.source);
  } catch {
    try {
      return parse(ctx.source);
    } catch {
      return null;
    }
  }
}

interface FlowResolved {
  source: string;
  model: FlowModel;
  scan: FlowScan;
  aligned: boolean;
}

function flow(ctx: EditContext): FlowResolved | null {
  const model = peleModel(ctx) as FlowModel | null;
  if (!model || !Array.isArray(model.edges)) return null;
  const scan = scanFlowchart(ctx.source);
  return { source: ctx.source, model, scan, aligned: alignsWith(scan, model) };
}

/** Pele's edge index for an SVG edge id (`L_A_B_0`, or a Mehrpele anchor `A->B#2`). */
export function flowEdgeIndex(model: FlowModel, id: string): number {
  const direct = model.edges.findIndex((e) => e.id === id);
  if (direct >= 0) return direct;
  const m = /^(.+)->(.+?)(?:#(\d+))?$/.exec(id);
  if (!m) return -1;
  const n = m[3] !== undefined ? Number(m[3]) : -1;
  if (n >= 0 && model.edges[n]?.start === m[1] && model.edges[n]?.end === m[2]) return n;
  return model.edges.findIndex((e) => e.start === m[1] && e.end === m[2]);
}

/** The scanned subgraph an SVG cluster id names. */
export function flowSubgraph(r: FlowResolved, id: string): SubgraphRef | null {
  const byId = r.scan.subgraphs.filter((s) => s.id === id);
  if (byId.length === 1) return byId[0];
  const i = r.model.subgraphs.findIndex((s) => s.id === id);
  if (i < 0 || r.scan.subgraphs.length !== r.model.subgraphs.length) return null;
  // Pele lists subgraphs as they close (inner first); `subgraph "Title"` takes
  // its title as id and bare multi-word titles get subGraphN. Pair them by
  // closing order and accept only when every pair agrees on id or title.
  const ordered = [...r.scan.subgraphs].sort((a, b) => (a.endLine?.start ?? Infinity) - (b.endLine?.start ?? Infinity));
  const norm = (t: string) => t.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1").replace(/[*_`#~=[\]]/g, "").replace(/\s+/g, " ").trim();
  const agree = ordered.every((sg, k) => {
    const m = r.model.subgraphs[k];
    if (sg.id !== null) return sg.id === m.id;
    const title = sg.title ? norm(r.source.slice(sg.title.span.start, sg.title.span.end)) : "";
    return title === norm(m.title) || title === norm(m.id);
  });
  return agree ? ordered[i] : null;
}

interface StateDoc {
  stmt: string;
  state1?: { id: string };
  state2?: { id: string };
  doc?: StateDoc[];
}

/** Pele's transitions, depth-first in source order (what `edgeN` numbers, minus notes). */
function stateRelations(ctx: EditContext): Array<[string, string]> | null {
  const model = peleModel(ctx) as { rootDoc?: StateDoc[] } | null;
  if (!model?.rootDoc) return null;
  const out: Array<[string, string]> = [];
  const walk = (doc: StateDoc[]) => {
    for (const st of doc) {
      if (st.stmt === "relation" && st.state1 && st.state2) out.push([st.state1.id, st.state2.id]);
      if (st.doc) walk(st.doc);
    }
  };
  walk(model.rootDoc);
  return out;
}

/**
 * Index into stateTransitions() for an SVG id (`edgeN`), or -1. Refused (-1)
 * unless the scanned transitions are Pele's, endpoint for endpoint (`[*]`
 * matches Pele's generated start/end ids).
 */
/** Pele's SVG id of transition `k` (`edgeN`). */
function stateTransitionId(src: string, k: number): string | null {
  const t = stateTransitions(src)[k];
  return t ? `edge${t.edgeNo}` : null;
}

function stateEdgeIndex(ctx: EditContext, id: string): number {
  const m = /^edge(\d+)$/.exec(id);
  if (!m) return -1;
  const ts = stateTransitions(ctx.source);
  const rel = stateRelations(ctx);
  if (!rel || rel.length !== ts.length) return -1;
  const same = (a: string, b: string) => a === b || (a === "[*]" && /_(start|end)$/.test(b));
  if (!ts.every((t, i) => same(t.from, rel[i][0]) && same(t.to, rel[i][1]))) return -1;
  return ts.findIndex((t) => t.edgeNo === Number(m[1]));
}

function mindIndex(ctx: EditContext, id: string): number {
  const model = peleModel(ctx) as { nodes?: Array<{ id: number; nodeId: string }> } | null;
  const n = model?.nodes?.find((x) => x.nodeId === id);
  return n ? n.id : -1;
}

// -- analysis -----------------------------------------------------------------------

const base = (target: EditTarget, label: string): Capabilities => ({
  target,
  label,
  color: false,
  currentColor: null,
  textSize: false,
  currentSize: null,
  shapes: null,
  currentShape: null,
  lineStyle: false,
  currentStroke: null,
  heads: false,
  currentHeads: null,
  editText: false,
  delete: false,
  deleteName: "Delete",
});

function sizeOfLinkStyle(src: string, index: number): TextSize | null {
  const fs = linkStyleOf(src, index)["font-size"];
  if (!fs) return null;
  const px = Number.parseFloat(fs);
  return (Object.entries(TEXT_SIZES).find(([, v]) => v === px)?.[0] as TextSize | undefined) ?? null;
}

/** What the toolbar may offer for `target` (null: nothing editable here). */
export function analyse(ctx: EditContext, target: EditTarget): Capabilities | null {
  const kind = diagramKind(ctx.type);
  const src = ctx.source;
  if (kind === "flowchart") {
    const r = flow(ctx);
    if (!r) return null;
    if (target.kind === "node") {
      if (!r.model.nodes.has(target.id)) return null;
      const c = base(target, `node ${target.id}`);
      c.color = c.textSize = true;
      c.currentColor = currentColor(src, kind, target.id);
      c.currentSize = currentTextSize(src, kind, target.id);
      // Mehrpele draws quoted labels as HTML over the SVG: a font-size class would not reach them.
      if (ctx.markdownBlock && r.aligned && nodeLabelRaw(src, r.scan, target.id)?.trim().startsWith('"')) c.textSize = false;
      if (r.aligned) {
        const v = shapedVertex(r.scan, target.id);
        c.shapes = FLOW_SHAPES.map(({ key, name, icon }) => ({ key, name, icon }));
        c.currentShape = writtenShape(v) ?? (v?.shape?.kind === "data" ? null : "rect");
        c.editText = true;
        c.delete = true;
        c.deleteName = "Delete node";
        // view-nodes: a web page / PDF / workspace view node — its label is the view, not text.
        if (isViewNodeLabel(nodeLabelRaw(src, r.scan, target.id), ctx.isFolderEmbed)) {
          c.editText = false;
          c.viewNode = true;
          c.note = "View node: colour and shape style its box; edit the view in the block source";
        }
      }
      return c;
    }
    if (target.kind === "edge") {
      const index = flowEdgeIndex(r.model, target.id);
      if (index < 0) return null;
      const e = r.model.edges[index];
      const c = base(target, `edge ${e.start} → ${e.end}`);
      c.color = c.textSize = true;
      c.currentColor = currentEdgeColor(src, index);
      c.currentSize = sizeOfLinkStyle(src, index);
      if (r.aligned) {
        const ref = r.scan.edges[index];
        if (ctx.markdownBlock && ref.link.label?.quoted) c.textSize = false;
        c.lineStyle = c.heads = ref.link.stroke !== "invisible";
        c.currentStroke = ref.link.stroke;
        c.currentHeads = headsOf(ref.link);
        c.editText = true;
        c.delete = ref.groupSize === 1;
        c.deleteName = "Delete edge";
        if (ref.groupSize > 1) c.note = `Arrow and label changes apply to all ${ref.groupSize} edges of this & group.`;
      }
      return c;
    }
    const sg = flowSubgraph(r, target.id);
    const c = base(target, `subgraph ${target.id}`);
    c.color = true;
    c.currentColor = currentColor(src, kind, target.id);
    c.textSize = true;
    c.currentSize = currentTextSize(src, kind, target.id);
    if (ctx.markdownBlock && sg?.title?.quoted) c.textSize = false;
    if (sg && r.aligned) {
      c.editText = !!(sg.title || sg.id);
      c.delete = !!sg.endLine;
      c.deleteName = "Ungroup (remove subgraph)";
    }
    return c;
  }
  if (kind === "state") {
    if (target.kind === "edge") {
      const k = stateEdgeIndex(ctx, target.id);
      if (k < 0) return null;
      const c = base(target, `transition ${k + 1}`);
      c.editText = true;
      c.delete = true;
      c.deleteName = "Delete transition";
      return c;
    }
    if (/_(start|end)$/.test(target.id) || target.id.startsWith("root_")) return null;
    const c = base(target, `${target.kind === "subgraph" ? "composite state" : "state"} ${target.id}`);
    c.color = c.textSize = true;
    c.currentColor = currentColor(src, kind, target.id);
    c.currentSize = currentTextSize(src, kind, target.id);
    c.editText = target.kind === "node" && /^[\w.]+$/.test(target.id);
    return c;
  }
  if (kind === "class") {
    if (target.kind !== "node") return null;
    const c = base(target, `class ${target.id}`);
    c.color = c.textSize = true;
    c.currentColor = currentColor(src, kind, target.id);
    c.currentSize = currentTextSize(src, kind, target.id);
    return c;
  }
  if (kind === "mindmap") {
    if (target.kind !== "node") return null;
    const k = mindIndex(ctx, target.id);
    const n = mindNodes(src)[k];
    if (k < 0 || !n) return null;
    const c = base(target, `node ${target.id}`);
    c.shapes = MIND_SHAPES.map(({ key, name, icon }) => ({ key, name, icon }));
    c.currentShape = n.shape.key;
    c.editText = true;
    c.delete = k > 0;
    c.deleteName = "Delete node and children";
    return c;
  }
  return null;
}

// -- text ---------------------------------------------------------------------------

/** The label text the inline editor opens with (null: no text to edit). */
export function readText(ctx: EditContext, target: EditTarget): string | null {
  const kind = diagramKind(ctx.type);
  const src = ctx.source;
  if (kind === "flowchart") {
    const r = flow(ctx);
    if (!r) return null;
    if (target.kind === "node") {
      const raw = nodeLabelRaw(src, r.scan, target.id);
      return raw === null ? target.id : labelText(raw, ctx.markdownBlock).text;
    }
    if (target.kind === "edge") {
      const ref = r.scan.edges[flowEdgeIndex(r.model, target.id)];
      if (!ref) return null;
      return ref.link.label ? labelText(src.slice(ref.link.label.span.start, ref.link.label.span.end), ctx.markdownBlock).text : "";
    }
    const sg = flowSubgraph(r, target.id);
    if (!sg) return null;
    if (sg.title) return labelText(src.slice(sg.title.span.start, sg.title.span.end), ctx.markdownBlock).text;
    return sg.id ?? "";
  }
  if (kind === "state") {
    if (target.kind === "edge") {
      const t = stateTransitions(src)[stateEdgeIndex(ctx, target.id)];
      if (!t) return null;
      return t.label ? stateText(src.slice(t.label.start, t.label.end), ctx.markdownBlock) : "";
    }
    const raw = stateTextRaw(src, target.id);
    return raw ? stateText(raw.raw, ctx.markdownBlock) : target.id;
  }
  if (kind === "mindmap") {
    const n = mindNodes(src)[mindIndex(ctx, target.id)];
    return n ? labelText(src.slice(n.textSpan.start, n.textSpan.end), ctx.markdownBlock).text : null;
  }
  return null;
}

/** State descriptions/transition labels: quotes are Markdown only in Mehrpele blocks. */
function stateText(raw: string, markdownBlock: boolean): string {
  const t = raw.trim();
  if (markdownBlock && t.startsWith('"') && t.endsWith('"')) return labelText(t, true).text;
  return t.replace(/<br\s*\/?>/gi, "\n");
}

function stateRaw(text: string, ctx: EditContext): { raw: string; switched: boolean } {
  const f = formatLabel(text, { markdownBlock: ctx.markdownBlock, canSwitch: ctx.canSwitch, wasQuoted: false });
  if (f.quoted && (ctx.markdownBlock || f.switchToMehrpele)) return { raw: f.raw, switched: f.switchToMehrpele };
  // Plain state text runs to the end of the line: no quotes, `<br>` for newlines.
  return { raw: text.replace(/\r?\n/g, "<br>"), switched: false };
}

// -- apply ------------------------------------------------------------------------------

const fail = (error: string): EditResult => ({ ok: false, error });

function done(before: string, next: string | null, switched = false): EditResult {
  if (next === null) return fail("Pele: could not apply that edit here.");
  const out = switched ? withMehrpeleDirective(next) : next;
  if (out === before) return fail("unchanged");
  return { ok: true, source: out, switched };
}

/** Apply one edit; the result is the whole new block source. */
export function applyEdit(ctx: EditContext, target: EditTarget, op: EditOp): EditResult {
  const caps = analyse(ctx, target);
  if (!caps) return fail("Pele: this element cannot be edited.");
  const kind = diagramKind(ctx.type);
  const src = ctx.source;
  switch (op.op) {
    case "color":
      if (!caps.color) return fail("Pele: colour is not supported here.");
      if (target.kind === "edge") {
        const index = kind === "flowchart" ? flowEdgeIndex(flow(ctx)!.model, target.id) : -1;
        const hex = op.value === null ? null : "custom" in op.value ? op.value.custom : presetHex(op.value.preset);
        return done(src, index < 0 ? null : setEdgeColor(src, index, hex));
      }
      return done(src, setColor(src, kind, target.id, op.value));
    case "size":
      if (!caps.textSize) return fail("Pele: text size is not supported here.");
      if (target.kind === "edge") {
        const index = flowEdgeIndex(flow(ctx)!.model, target.id);
        return done(src, index < 0 ? null : setEdgeTextSize(src, index, op.value));
      }
      return done(src, setTextSize(src, kind, target.id, op.value));
    case "shape": {
      if (!caps.shapes) return fail("Pele: shapes are not supported here.");
      if (kind === "mindmap") return done(src, setMindShape(src, mindIndex(ctx, target.id), op.key));
      if (!shapeByKey(op.key)) return fail("Pele: unknown shape.");
      return done(src, setNodeShape(src, flow(ctx)!.scan, target.id, op.key));
    }
    case "stroke":
    case "heads": {
      if (!caps.lineStyle) return fail("Pele: arrows cannot be changed here.");
      const r = flow(ctx)!;
      const ref = r.scan.edges[flowEdgeIndex(r.model, target.id)];
      if (!ref) return fail("Pele: edge not found.");
      return done(src, setEdgeLink(src, ref, op.op === "stroke" ? { stroke: op.value } : { heads: op.value }));
    }
    case "text":
      if (!caps.editText) return fail("Pele: this text cannot be edited here.");
      return applyText(ctx, kind, target, op.text);
    case "delete":
      if (!caps.delete) return fail("Pele: this element cannot be deleted here.");
      return applyDelete(ctx, kind, target);
  }
}

function presetHex(n: number): string {
  return PRESETS.find((p) => p.n === n)!.hex;
}

function applyText(ctx: EditContext, kind: DiagramKind, target: EditTarget, rawText: string): EditResult {
  const src = ctx.source;
  const text = rawText.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  if (kind === "flowchart") {
    const r = flow(ctx)!;
    const fmt = (raw: string | null, forceQuote = false) => {
      const before = raw === null ? null : labelText(raw, ctx.markdownBlock);
      return formatLabel(text, {
        markdownBlock: ctx.markdownBlock,
        canSwitch: ctx.canSwitch,
        wasQuoted: forceQuote || !!raw?.trim().startsWith('"'),
        wasMarkdownString: before?.markdownString ?? false,
      });
    };
    if (target.kind === "node") {
      if (!text.trim()) return fail("Pele: a node label cannot be empty.");
      const f = fmt(nodeLabelRaw(src, r.scan, target.id));
      return done(src, setNodeLabel(src, r.scan, target.id, f.raw), f.switchToMehrpele);
    }
    if (target.kind === "edge") {
      const ref: EdgeRef | undefined = r.scan.edges[flowEdgeIndex(r.model, target.id)];
      if (!ref) return fail("Pele: edge not found.");
      if (!text.trim()) return done(src, ref.link.label ? setEdgeLabel(src, ref, null) : src);
      const f = fmt(ref.link.label ? src.slice(ref.link.label.span.start, ref.link.label.span.end) : null);
      return done(src, setEdgeLabel(src, ref, f.raw), f.switchToMehrpele);
    }
    const sg = flowSubgraph(r, target.id);
    if (!sg) return fail("Pele: subgraph not found.");
    if (!text.trim()) return fail("Pele: a subgraph title cannot be empty.");
    const quotedForm = sg.titleForm === "quoted" || sg.titleForm === "bare";
    const f = fmt(sg.title ? src.slice(sg.title.span.start, sg.title.span.end) : null, quotedForm);
    let raw = f.raw;
    if (quotedForm && !f.quoted) raw = `"${raw}"`;
    return done(src, setSubgraphTitle(src, sg, raw), f.switchToMehrpele);
  }
  if (kind === "state") {
    if (target.kind === "edge") {
      const k = stateEdgeIndex(ctx, target.id);
      if (!text.trim()) return done(src, setTransitionLabel(src, k, null));
      const s = stateRaw(text, ctx);
      return done(src, setTransitionLabel(src, k, s.raw), s.switched);
    }
    if (!text.trim()) return fail("Pele: a state description cannot be empty.");
    const s = stateRaw(text, ctx);
    return done(src, setStateText(src, target.id, s.raw), s.switched);
  }
  if (kind === "mindmap") {
    const k = mindIndex(ctx, target.id);
    const n = mindNodes(src)[k];
    if (!n || !text.trim()) return fail("Pele: a node needs text.");
    const f = formatLabel(text, { markdownBlock: ctx.markdownBlock, canSwitch: ctx.canSwitch, wasQuoted: src.slice(n.textSpan.start, n.textSpan.end).trim().startsWith('"') });
    let next: string | null;
    if (n.shape.key === "default" && f.quoted) {
      // A bare line cannot hold a quoted label: it gains square brackets.
      const sq = setMindShape(src, k, "rect");
      next = sq === null ? null : setMindText(sq, k, f.raw);
    } else next = setMindText(src, k, f.raw);
    return done(src, next, f.switchToMehrpele);
  }
  return fail("Pele: text editing is not supported for this diagram.");
}

function applyDelete(ctx: EditContext, kind: DiagramKind, target: EditTarget): EditResult {
  const src = ctx.source;
  if (kind === "flowchart") {
    const r = flow(ctx)!;
    if (target.kind === "node") return done(src, deleteNode(src, r.scan, target.id));
    if (target.kind === "edge") return done(src, deleteEdge(src, r.scan, flowEdgeIndex(r.model, target.id)));
    const sg = flowSubgraph(r, target.id);
    return done(src, sg ? ungroupSubgraph(src, sg, target.id) : null);
  }
  if (kind === "state" && target.kind === "edge") return done(src, deleteTransition(src, stateEdgeIndex(ctx, target.id)));
  if (kind === "mindmap") return done(src, deleteMindNode(src, mindIndex(ctx, target.id)));
  return fail("Pele: delete is not supported here.");
}

// -- several targets, concept mapping -----------------------------------------------------

/**
 * Apply one op to several targets as ONE edit (one returned source). Edge
 * ids are resolved to Pele indices up front; deletions run edges (highest
 * index first), then nodes, then subgraphs, so earlier steps never shift a
 * later target.
 */
export function applyEditMany(ctx: EditContext, targets: EditTarget[], op: EditOp): EditResult {
  if (targets.length <= 1) return targets[0] ? applyEdit(ctx, targets[0], op) : fail("Pele: nothing selected.");
  if (op.op === "text") return fail("Pele: edit one label at a time.");
  const kind = diagramKind(ctx.type);
  const model0 = kind === "flowchart" ? flow(ctx)?.model : null;
  type Step = { t: EditTarget; edgeIndex: number };
  const steps: Step[] = targets.map((t) => ({
    t,
    edgeIndex: t.kind !== "edge" ? -1 : model0 ? flowEdgeIndex(model0, t.id) : kind === "state" ? stateEdgeIndex(ctx, t.id) : -1,
  }));
  if (op.op === "delete") {
    const rank = (s: Step) => (s.t.kind === "edge" ? 0 : s.t.kind === "node" ? 1 : 2);
    steps.sort((a, b) => rank(a) - rank(b) || b.edgeIndex - a.edgeIndex);
  }
  let src = ctx.source;
  let switched = false;
  let changed = false;
  for (const s of steps) {
    const cur = { ...ctx, source: src };
    let t = s.t;
    if (t.kind === "edge" && s.edgeIndex >= 0) {
      // Edge ids renumber after an edit: address the edge by its index.
      const id = kind === "flowchart" ? flow(cur)?.model.edges[s.edgeIndex]?.id : kind === "state" ? stateTransitionId(src, s.edgeIndex) : null;
      if (!id) return fail("Pele: an edge changed under the edit; nothing written.");
      t = { kind: "edge", id };
    }
    const r = applyEdit(cur, t, op);
    if (!r.ok) {
      if (r.error === "unchanged") continue;
      // Deleting a node can take selected children / edges with it.
      if (op.op === "delete" && changed && !analyse(cur, t)) continue;
      return r;
    }
    src = r.source;
    switched ||= r.switched;
    changed = true;
  }
  return changed ? { ok: true, source: src, switched } : fail("unchanged");
}

export type AddResult = { ok: true; source: string; id: string } | { ok: false; error: string };

/**
 * "+" on a node's side: a parent, child or sibling with its edge(s), as one
 * edit. In canvas layout mode the new node is also pinned on that side.
 */
export function addNode(ctx: EditContext, id: string, relation: Relation, label = "New", side?: Side): AddResult {
  if (diagramKind(ctx.type) !== "flowchart") return { ok: false, error: "Pele: adding nodes works on flowcharts." };
  const r = flow(ctx);
  if (!r?.aligned || !r.model.nodes.has(id)) return { ok: false, error: "Pele: this diagram can't be edited here." };
  const a = addRelated(ctx.source, r.scan, id, relation, label);
  if (!a) return { ok: false, error: "Pele: could not place the new node." };
  return { ok: true, id: a.id, source: side ? pinBeside(a.source, a.id, id, side) : a.source };
}

/**
 * Where new statements for `ids` go: inside their deepest common subgraph
 * (before its `end`), else after the last top-level statement. `pos` is a
 * line start; `indent` the scope's statement indentation.
 */
function commonScope(ctx: EditContext, r: FlowResolved, ids: string[]): { pos: number; indent: string; common: string | null; owner: (x: string) => string | null } | { error: string } {
  const subs = r.model.subgraphs as Array<{ id: string; nodes?: string[]; title: string }>;
  const owner = (x: string) => subs.find((s) => s.nodes?.includes(x))?.id ?? null;
  const chain = (x: string) => {
    const out: string[] = [];
    for (let s = owner(x); s && !out.includes(s); s = owner(s)) out.push(s);
    return out;
  };
  const chains = ids.map(chain);
  const common = chains[0].find((s) => chains.every((c) => c.includes(s))) ?? null;
  const src = ctx.source;
  if (common) {
    const sg = flowSubgraph(r, common);
    if (!sg?.endLine) return { error: `Pele: could not find subgraph ${common} in the source.` };
    const pos = src.lastIndexOf("\n", sg.endLine.start - 1) + 1;
    const endIndent = /^[ \t]*/.exec(src.slice(pos))![0];
    return { pos, indent: `${endIndent}  `, common, owner };
  }
  const inside = (p: number) => r.scan.subgraphs.some((s) => s.endLine && p > s.line.start && p < s.endLine.end);
  const tops = r.scan.statements.filter((st) => !inside(st.span.start));
  const ends = [...tops.map((st) => st.span.end), ...r.scan.subgraphs.filter((s) => s.endLine && !inside(s.line.start)).map((s) => s.endLine!.end)];
  const at = ends.length ? Math.max(...ends) : (r.scan.header?.end ?? 0);
  const nl = src.indexOf("\n", at);
  // -1: after the last line (which has no newline yet).
  const pos = nl < 0 ? -1 : nl + 1;
  const indent = /^[ \t]*/.exec(src.slice(src.lastIndexOf("\n", (tops[0]?.span.start ?? at) - 1) + 1))![0] || "  ";
  return { pos, indent, common: null, owner };
}

/** Insert whole `lines` (newline-terminated) at a commonScope position. */
function insertLinesAt(src: string, pos: number, lines: string): string {
  if (pos >= 0) return src.slice(0, pos) + lines + src.slice(pos);
  return `${src}\n${lines.replace(/\n$/, "")}`;
}

/** "→" with several nodes selected: one child shared by all of them, in their common scope. */
export function addSharedChild(ctx: EditContext, ids: string[], label = "New", side?: Side): AddResult {
  if (diagramKind(ctx.type) !== "flowchart") return { ok: false, error: "Pele: adding nodes works on flowcharts." };
  const r = flow(ctx);
  if (!r?.aligned || ids.some((id) => !r.model.nodes.has(id))) return { ok: false, error: "Pele: this diagram can't be edited here." };
  const scope = commonScope(ctx, r, ids);
  if ("error" in scope) return { ok: false, error: scope.error };
  const a = sharedChildAt(ctx.source, ids, { pos: scope.pos, indent: scope.indent }, label, insertLinesAt);
  if (!a) return { ok: false, error: "Pele: could not place the new node." };
  return { ok: true, id: a.id, source: side ? pinBeyond(a.source, a.id, ids, side) : a.source };
}

export type ConnectResult =
  | { ok: true; source: string; edgeId: string }
  /** `duplicate`: the edge that already runs from → to; `noop`: nothing to do (a drop on the node itself). */
  | { ok: false; error: string; duplicate?: string; noop?: boolean };

/**
 * A "+" dragged onto another node or a subgraph: one edge `from --> to`, as
 * one edit, in the two's common scope (neither is pulled into a subgraph),
 * linkStyle indices kept. An edge already running from → to is not added
 * again; a drop on the node itself does nothing. In canvas layout the edge
 * leaves `from` on the "+" side (`side`, a pele-pos port).
 */
export function connectNodes(ctx: EditContext, from: string, to: string, side?: Side): ConnectResult {
  if (diagramKind(ctx.type) !== "flowchart") return { ok: false, error: "Pele: connecting works on flowcharts." };
  if (from === to) return { ok: false, error: "", noop: true };
  const r = flow(ctx);
  if (!r?.aligned || !r.model.nodes.has(from)) return { ok: false, error: "Pele: this diagram can't be edited here." };
  const subgraphs = (r.model as { subgraphs?: Array<{ id: string }> }).subgraphs ?? [];
  if (!r.model.nodes.has(to) && !subgraphs.some((s) => s.id === to)) return { ok: false, error: "Pele: drop the arrow on a node or a subgraph." };
  const dup = r.model.edges.find((e) => e.start === from && e.end === to);
  if (dup) return { ok: false, error: `Pele: ${from} → ${to} is already there.`, duplicate: dup.id };
  const scope = commonScope(ctx, r, [from, to]);
  if ("error" in scope) return { ok: false, error: scope.error };
  let next = insertLinesAt(ctx.source, scope.pos, `${scope.indent}${from} --> ${to}\n`);
  // The only from → to edge now: styles of the edges after it keep their lines.
  const index = scanFlowchart(next).edges.findIndex((e) => e.start === from && e.end === to);
  if (index >= 0) next = shiftLinkStylesForInsert(next, index);
  if (side) next = addPort(next, from, to, side);
  const added = (peleModel({ ...ctx, source: next }) as FlowModel | null)?.edges.find((e) => e.start === from && e.end === to);
  if (!added) return { ok: false, error: "Pele: the new edge did not parse; nothing written." };
  return { ok: true, source: next, edgeId: added.id ?? `${from}->${to}` };
}

/**
 * A "+" dragged to empty space: a new node with an edge from `from`, as one
 * edit (a child, as the "+" adds one). In canvas layout it is pinned at
 * `at` (else beside `from` on `side`) and its edge leaves on `side`.
 */
export function addConnectedNode(ctx: EditContext, from: string, side: Side, at?: { x: number; y: number } | null, label = "New"): AddResult {
  if (diagramKind(ctx.type) !== "flowchart") return { ok: false, error: "Pele: adding nodes works on flowcharts." };
  const r = flow(ctx);
  if (!r?.aligned || !r.model.nodes.has(from)) return { ok: false, error: "Pele: this diagram can't be edited here." };
  const a = addRelated(ctx.source, r.scan, from, "child", label);
  if (!a) return { ok: false, error: "Pele: could not place the new node." };
  let next = at && isCanvasLayout(a.source) ? addPin(a.source, a.id, at) : pinBeside(a.source, a.id, from, side);
  next = addPort(next, from, a.id, side);
  return { ok: true, id: a.id, source: next };
}

/**
 * "+" with several nodes selected: wrap them in a new subgraph inside their
 * common enclosing subgraph. Checked against Pele's parse: when a node is
 * claimed by another subgraph (Mermaid keeps a node in the first subgraph
 * that mentions it) nothing is written and the error says which.
 */
export function groupIntoSubgraph(ctx: EditContext, ids: string[], title = "Group"): AddResult {
  if (diagramKind(ctx.type) !== "flowchart") return { ok: false, error: "Pele: grouping works on flowcharts." };
  const r = flow(ctx);
  if (!r?.aligned || ids.length < 2 || ids.some((id) => !r.model.nodes.has(id))) return { ok: false, error: "Pele: this diagram can't be edited here." };
  const scope = commonScope(ctx, r, ids);
  if ("error" in scope) return { ok: false, error: scope.error };
  const gid = freshId(ctx.source, "G");
  const next = insertLinesAt(ctx.source, scope.pos, `${subgraphLines(gid, title, ids, scope.indent)}\n`);
  const check = peleModel({ ...ctx, source: next }) as { subgraphs?: Array<{ id: string; nodes?: string[] }> } | null;
  const got = check?.subgraphs?.find((s) => s.id === gid)?.nodes ?? [];
  const missing = ids.filter((id) => !got.includes(id));
  if (missing.length) {
    const where = missing.map((m) => `${m} (in ${scope.owner(m) ?? "another subgraph"})`).join(", ");
    return { ok: false, error: `Pele: can't group ${where}: Mermaid keeps a node in the first subgraph that lists it. Move it out of that subgraph first.` };
  }
  return { ok: true, source: next, id: gid };
}
