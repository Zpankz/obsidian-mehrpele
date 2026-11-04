import type { FlowchartModel, MindmapModel, ParsedDiagramModel, StateModel } from "pele";
import { parse, render } from "../pele.js";
import { parseSvgGeometry, type BBox, type EdgeGeom, type SvgGeometry } from "./svg-geom.js";
import { sourceHash, sanitizeId, slugify } from "./ids.js";
import { formatSize, formatSizeDirective, parseSizeDirective, withSizeDirective, type NodeSize } from "../node-size/directive.js";
import { nodeSizeCaps } from "../node-size/index.js";
import { nodeBoxMap } from "../node-size/svgbox.js";
import type { SizeCaps } from "../node-size/adapters.js";
import type { NodeSizeResult } from "../node-size/solve.js";
import { DASH, isPreset, presetClass, presetClassDefs, presetHex, presetOfClass, presetOfHex, TINT_ALPHA, tintStyles } from "./palette.js";
import { embedNodeBox, embedSizeForCard, formatEmbedLabel, isImageFile, parseEmbedLabel } from "./embed.js";
import { formatWebEmbedLabel, parseWebEmbedLabel, webNodeBox } from "./web.js"; // view-nodes
import { formatViewLine, parseViewEntries } from "./views.js"; // view-nodes
import { folderBaseBlock, parseFolderLabel } from "./folder.js"; // view-nodes
import { edgeKey, formatPosDirective, parseLayoutDirective, type CanvasLayout, type EdgePorts, type PinnedBox, type Side } from "./layout-directive.js";
import { formatProvenance, parseProvenance, stripProvenance, type ProvBox, type ProvEdge, type Provenance } from "./provenance.js";
import { autoSides } from "./route.js";
import { PELE_VERSION } from "../pele-version.js";

export { sourceHash } from "./ids.js";
export { parseSvgGeometry, pathPoints } from "./svg-geom.js";
export type { BBox, SvgGeometry } from "./svg-geom.js";
export { withCanvasLayout, usesCanvasLayout } from "./layout.js";
export {
  edgeKey,
  formatPosDirective,
  hasCanvasLayout,
  lintLayoutDirective,
  lintLayoutWarnings,
  parseLayoutDirective,
  stripLayoutDirective,
} from "./layout-directive.js";
export type { CanvasLayout, EdgePorts, PinnedBox, Side } from "./layout-directive.js";
export { CANVAS_PRESETS, legacyPresetClass, presetClass, presetHex, presetOfClass, presetOfHex, presetThemeCss, TINT_ALPHA, tintStyles } from "./palette.js";
export { EMBED_DEFAULT, EMBED_PAD, parseEmbedLabel } from "./embed.js";
export { formatWebEmbedLabel, parseWebEmbedLabel } from "./web.js"; // view-nodes
export { applyFolderTokens, folderBaseBlock, folderBaseYaml, folderSpecFromEmbed, folderSpecFromParams, formatFolderEmbed, normalizeFolderPath, parseFolderLabel, type FolderSpec } from "./folder.js"; // view-nodes
export { parseProvenance } from "./provenance.js";
export { routeEdge, routeOrthogonal } from "./route.js";

// ---------- Types ----------
export interface CanvasNode {
  id: string; type: "text" | "file" | "link" | "group";
  x: number; y: number; width: number; height: number;
  color?: string; text?: string; file?: string; subpath?: string; url?: string;
  label?: string; background?: string; backgroundStyle?: string;
  styleAttributes?: Record<string, string | null>;
  portal?: boolean; interdimensionalEdges?: CanvasEdge[]; collapsed?: boolean;
  [key: string]: unknown;
}
export interface CanvasEdge {
  id: string; fromNode: string; toNode: string;
  fromSide?: "top" | "right" | "bottom" | "left"; toSide?: "top" | "right" | "bottom" | "left";
  fromEnd?: "none" | "arrow"; toEnd?: "none" | "arrow";
  color?: string; label?: string;
  styleAttributes?: Record<string, string | null>;
  [key: string]: unknown;
}
export interface CanvasData { nodes: CanvasNode[]; edges: CanvasEdge[]; metadata?: Record<string, unknown>; [key: string]: unknown }

export interface ToCanvasOptions {
  advancedCanvas?: boolean;
  /** Canvas px per SVG unit (default: the source's provenance scale, else 2). */
  scale?: number;
  origin?: { x: number; y: number };
  sourcePath?: string;
  mehrpele?: boolean;
  previous?: CanvasData;
  /** Always write `fromSide`/`toSide`, even for edges whose provenance had none (Cannoli requires both). */
  explicitSides?: boolean;
}
export interface FromCanvasOptions {
  /** Markdown labels: true quotes every label, false never, undefined decides (result.mehrpele). */
  mehrpele?: boolean;
  portals?: "link" | "inline";
  portalDepth?: number;
  resolveCanvas?: (path: string) => CanvasData | null;
  direction?: "auto" | "TD" | "LR" | "BT" | "RL";
  includeProvenance?: boolean;
  /** `canvas`: add `%% pele-layout canvas %%` + `%% pele-pos %%` so Pele draws the canvas positions. */
  layout?: "auto" | "canvas";
  /** Canvas px per SVG unit (default: the canvas's `metadata.pele.scale`, else 1). */
  scale?: number;
  /** view-nodes: link cards become live web-view nodes (`![[url|WxH]]`) instead of clickable text nodes. */
  webNodes?: boolean;
}
export interface FromCanvasResult {
  source: string;
  type: string;
  dropped: string[];
  /** True when the labels are Markdown (write a `mehrpele` block). */
  mehrpele: boolean;
}

// ---------- helpers ----------
type AnyRec = Record<string, unknown>;
type Coll<T> = Map<unknown, T> | T[] | Record<string, T> | null | undefined;
function mapVals<T>(m: Coll<T>): T[] { if (!m) return []; if (m instanceof Map) return [...m.values()]; if (Array.isArray(m)) return m; return Object.values(m); }
function mapEntries<T>(m: Coll<T>): [string, T][] { if (!m) return []; if (m instanceof Map) return [...m.entries()].map(([k, v]) => [String(k), v]); if (Array.isArray(m)) return m.map((v: T, i: number) => [String(i), v]); return Object.entries(m); }

// Pele model shapes this module reads (pele exports the models, not their member types).
type MapVal<M> = M extends Map<unknown, infer V> ? V : never;
type FlowNode = MapVal<FlowchartModel["nodes"]>;
/** A flowchart edge; `styles` is read as a fallback for `style`. */
type FlowEdge = FlowchartModel["edges"][number] & { styles?: string[] };
type FlowModel = Omit<FlowchartModel, "edges"> & { edges: FlowEdge[] };
type StateStmt = MapVal<StateModel["states"]>;
type Stmt = StateModel["rootDoc"][number];
type StateRelation = StateModel["relations"][number];
/** Node of the state graph pele's StateDb builds (`graph` is not on the exported StateModel). */
interface StateGraphNode { id: string; shape?: string; label?: string; description?: string[]; isGroup?: boolean; parentId?: string }
type StateModelG = StateModel & { graph?: { nodes?: StateGraphNode[] } };
type MindmapNode = MindmapModel["nodes"][number];
type ClassDef = MapVal<FlowchartModel["classes"]> | MapVal<StateModel["classes"]>;
/** `metadata.pele` as mermaidToCanvas writes it (canvases are user files: every key may be missing). */
interface PeleMeta { type?: string; direction?: string; fidelity?: string; advancedCanvas?: boolean; sourceHash?: string; classDefs?: Record<string, { styles?: string[]; textStyles?: string[] }>; [key: string]: unknown }

const NAMED: Record<string, string> = { red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080", cyan: "#00ffff", magenta: "#ff00ff", black: "#000000", white: "#ffffff", gray: "#808080", grey: "#808080", pink: "#ffc0cb", brown: "#a52a2a", lime: "#00ff00", navy: "#000080", teal: "#008080" };
export function normalizeHex(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) return "#" + s.slice(1).split("").map(c => c + c).join("");
  if (/^#[0-9a-f]{4}$/.test(s)) return "#" + s.slice(1, 4).split("").map(c => c + c).join("");
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{8}$/.test(s)) return s.slice(0, 7);
  return NAMED[s] ?? null;
}
type ClassDefs = Map<string, { styles?: string[] }>;
/** Last value of a CSS declaration in Pele style entries. */
function decl(styles: string[] | undefined, prop: string): string | undefined {
  let v: string | undefined;
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`);
  for (const s of styles ?? []) { const m = re.exec(String(s)); if (m) v = m[1].trim(); }
  return v;
}
function withoutDecls(styles: string[], props: string[]): string[] {
  return styles.filter(s => !props.some(p => new RegExp(`^\\s*${p}\\s*:`).test(String(s))));
}
/** Canvas colour of a node/group: `canvasN` classes → preset, else the effective hex fill. */
function colourOf(classes: string[] | undefined, styles: string[] | undefined, classDefs: ClassDefs): { color?: string; raw?: string } {
  let color: string | undefined, raw: string | undefined;
  // A preset's exact tint (`#rrggbb1a` of its fallback hex) reads back as the preset.
  const take = (fill: string | undefined) => { if (!fill) return; const t = fill.trim().toLowerCase(); const tint = t.length === 9 && t.endsWith(TINT_ALPHA) ? presetOfHex(t.slice(0, 7)) : null; const hx = normalizeHex(fill); if (tint) { color = tint; raw = undefined; } else if (hx) { color = hx; raw = undefined; } else { raw = fill; color = undefined; } };
  for (const c of classes ?? []) { const p = presetOfClass(c); if (p) { color = p; raw = undefined; continue; } take(decl(classDefs.get(c)?.styles, "fill")); }
  take(decl(styles, "fill"));
  return color ? { color } : raw ? { raw } : {};
}
/**
 * Canvas colour of an edge: its stroke; a preset's fallback hex is the preset.
 * Flowchart edge classes reach here via an edge id: `A e1@--> B` + `class e1 canvas3`
 * (or a classDef with a stroke). `e1@{ … }` carries no class. `linkStyle N stroke:<preset hex>`
 * always works and is what `canvasToMermaid` writes.
 */
function edgeColourOf(classes: string[] | undefined, styles: string[] | undefined, classDefs: ClassDefs): string | undefined {
  let stroke: string | undefined;
  for (const c of classes ?? []) { const p = presetOfClass(c); if (p) return p; stroke = decl(classDefs.get(c)?.styles, "stroke") ?? stroke; }
  stroke = decl(styles, "stroke") ?? stroke;
  const hx = stroke ? normalizeHex(stroke) : null;
  return hx ? (presetOfHex(hx) ?? hx) : undefined;
}
/** Advanced Canvas node border from Mermaid styles (canonical dash patterns). */
function borderOf(styles: string[] | undefined): string | undefined {
  const dash = decl(styles, "stroke-dasharray");
  if (dash) { for (const [k, v] of Object.entries(DASH.node)) if (v === dash.replace(/,/g, " ").replace(/\s+/g, " ")) return k; return "dashed"; }
  if (decl(styles, "stroke") === "none" && decl(styles, "fill") === "none") return "invisible";
  return undefined;
}
function edgeDashOf(styles: string[] | undefined): string | undefined {
  const dash = decl(styles, "stroke-dasharray");
  if (!dash) return undefined;
  const d = dash.replace(/,/g, " ").replace(/\s+/g, " ");
  for (const [k, v] of Object.entries(DASH.edge)) if (v === d) return k;
  return "short-dashed";
}
/** Code-point order (locale-independent). */
function cmp(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function sameUrl(a: string, b: string): boolean { try { return new URL(a).href === new URL(b).href; } catch { return a === b; } }
function sideFromVector(dx: number, dy: number): "top" | "right" | "bottom" | "left" {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}
function dirSides(dir: string): { fromSide: Side; toSide: Side } {
  switch (dir) { case "LR": return { fromSide: "right", toSide: "left" }; case "RL": return { fromSide: "left", toSide: "right" }; case "BT": return { fromSide: "top", toSide: "bottom" }; default: return { fromSide: "bottom", toSide: "top" }; }
}

// Mehrpele escapes (`\"`, `\\` inside quoted labels): Pele has no string
// escapes, so they are swapped for private-use characters around parse/render
// and restored in the label texts. Unquoted text and `%%` lines are untouched.
const QUOTE_PH = "";
const BACKSLASH_PH = "";
function shieldQuotes(src: string): string {
  if (!src.includes("\\")) return src;
  let out = "";
  let inQ = false;
  let lineStart = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (!inQ && lineStart && c === "%" && src[i + 1] === "%") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      out += src.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === "\n") lineStart = true;
    else if (c !== " " && c !== "\t") lineStart = false;
    if (inQ && c === "\\" && (src[i + 1] === '"' || src[i + 1] === "\\")) {
      out += src[i + 1] === '"' ? QUOTE_PH : BACKSLASH_PH;
      i++;
      continue;
    }
    if (c === '"') inQ = !inQ;
    out += c;
  }
  return out;
}
/** Pele label text → the label as written: Mehrpele escapes, `#quot;`-style entities. */
function labelText(t: string | undefined): string {
  if (!t) return t ?? "";
  let s = t.includes(QUOTE_PH) ? t.split(QUOTE_PH).join('"') : t;
  if (s.includes(BACKSLASH_PH)) s = s.split(BACKSLASH_PH).join("\\");
  if (s.includes("ﬂ°")) s = s.replace(/ﬂ°(°?)(\w+)¶ß/g, (m, num: string, name: string) => {
    if (num || /^\d+$/.test(name)) { const n = Number(name); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ({ quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: " ", num: "#" } as Record<string, string>)[name] ?? m;
  });
  return s;
}

/** Signature of a node as written: label, shape and size entry. */
function nodeSig(text: string, shape: string | undefined, size: NodeSize | undefined): string {
  return sourceHash(`${text}\u0000${shape ?? "square"}\u0000${size ? formatSize(size) : ""}`).slice(0, 8);
}

// deterministic stringify
const NODE_ORDER = ["id", "type", "x", "y", "width", "height", "color", "text", "file", "subpath", "url", "label", "background", "backgroundStyle", "styleAttributes", "portal", "interdimensionalEdges", "collapsed"];
const EDGE_ORDER = ["id", "fromNode", "toNode", "fromSide", "toSide", "fromEnd", "toEnd", "color", "label", "styleAttributes"];
const META_ORDER = ["version", "frontmatter", "startNode", "pele"];
const PELE_ORDER = ["schema", "type", "direction", "sourceHash", "peleVersion", "scale", "layout", "fidelity", "classDefs", "dropped", "nodeSizes"];
function ordered(obj: unknown, preferred: string[]): unknown {
  if (Array.isArray(obj)) return (obj as unknown[]).map(v => ordered(v, []));
  if (obj && typeof obj === "object") {
    const out: AnyRec = {};
    for (const k of preferred) if (k in obj) out[k] = ordered((obj as AnyRec)[k], k === "metadata" ? META_ORDER : k === "pele" ? PELE_ORDER : []);
    for (const k of Object.keys(obj).sort()) if (!(k in out)) out[k] = ordered((obj as AnyRec)[k], []);
    return out;
  }
  return obj;
}
function orderCanvas(c: CanvasData): AnyRec {
  const nodes = (c.nodes ?? []).map(n => ordered(n, NODE_ORDER));
  const edges = (c.edges ?? []).map(e => ordered(e, EDGE_ORDER));
  const meta = c.metadata ? ordered(c.metadata, META_ORDER) : undefined;
  const out: AnyRec = {};
  if (meta !== undefined) out.metadata = meta;
  out.nodes = nodes; out.edges = edges;
  for (const k of Object.keys(c).sort()) if (!(k in out) && k !== "nodes" && k !== "edges" && k !== "metadata") out[k] = ordered((c as AnyRec)[k], []);
  return out;
}
export function stringifyCanvas(c: CanvasData): string { return JSON.stringify(orderCanvas(c), null, 2) + "\n"; }

// ---------- what Mermaid expresses (everything else travels in provenance `keep`) ----------
const NODE_CORE = new Set(["id", "type", "x", "y", "width", "height", "color", "text", "file", "subpath", "url", "label"]);
const EDGE_CORE = new Set(["id", "fromNode", "toNode", "fromSide", "toSide", "fromEnd", "toEnd", "color", "label"]);
const AC_SHAPES = new Set(["pill", "diamond", "database", "predefined-process", "circle", "parallelogram"]);
/** styleAttributes keys a Mermaid node expresses (shape syntax, border dash). */
function nodeOwnedStyle(k: string, v: string | null): boolean { return (k === "shape" && v !== null && AC_SHAPES.has(v)) || (k === "border" && (v === "dashed" || v === "dotted" || v === "invisible")); }
function edgeOwnedStyle(k: string, v: string | null): boolean { return (k === "path" && (v === "dotted" || v === "short-dashed" || v === "long-dashed")) || (k === "arrow" && (v === "circle" || v === "blunt")); }
function keepOf(o: AnyRec, core: Set<string>, owned: (k: string, v: string | null) => boolean): Record<string, unknown> | undefined {
  const keep: AnyRec = {};
  for (const [k, v] of Object.entries(o)) {
    if (core.has(k) || k.startsWith("pele") || v === undefined) continue;
    if (k === "styleAttributes" && v && typeof v === "object") {
      const sa: AnyRec = {};
      for (const [sk, sv] of Object.entries(v as AnyRec)) if (!owned(sk, sv as string | null) && sv !== null) sa[sk] = sv;
      if (Object.keys(sa).length) keep.styleAttributes = sa;
      continue;
    }
    keep[k] = v;
  }
  return Object.keys(keep).length ? keep : undefined;
}
function ownedKeys(keep: Record<string, unknown>, owned: (k: string, v: string | null) => boolean): string[] {
  return Object.entries(((keep.styleAttributes as AnyRec) ?? {})).filter(([k, v]) => owned(k, v as string | null)).map(([k]) => k);
}
/** Merge provenance `keep` under the derived card; `drop` removes style keys that no longer apply. */
function mergeKeep<T extends AnyRec>(card: T, keep: Record<string, unknown> | undefined, drop: string[] = []): T {
  if (!keep) return card;
  const out: AnyRec = { ...keep, ...card };
  const ksa = { ...((keep.styleAttributes as AnyRec) ?? {}) };
  for (const d of drop) delete ksa[d];
  const sa = { ...ksa, ...((card.styleAttributes as AnyRec) ?? {}) };
  if (Object.keys(sa).length) out.styleAttributes = sa; else delete out.styleAttributes;
  return out as T;
}

// ---------- Mermaid -> Canvas ----------
interface InternalNode { peleId: string; canvasId: string; label: string; rawShape?: string; classes: string[]; styles: string[]; kind: "text" | "file" | "link"; file?: string; subpath?: string; url?: string; peleKind?: string; section?: number; bbox?: BBox; groupId?: string; _link?: string; _linkTarget?: string; _mmId?: number }
type InternalNodes = InternalNode[] & { _cidMap?: Map<string, string>; _mmMode?: boolean };
const SHAPE_TO_AC: Record<string, string> = { stadium: "pill", diamond: "diamond", cylinder: "database", subroutine: "predefined-process", circle: "circle", lean_right: "parallelogram", lean_left: "parallelogram" };

/** Shape facts the Canvas size rule depends on. */
export interface CanvasShapeInfo { rawShape?: string; peleKind?: string }
function isStartEnd(n: CanvasShapeInfo): boolean { return n.peleKind === "stateStart" || n.peleKind === "stateEnd"; }

/** Minimum Canvas card size: 80×40, 120×60 for diamonds/parallelograms, ≥40 for state start/end dots. */
function canvasMinSize(w: number, h: number, n: CanvasShapeInfo): { w: number; h: number } {
  if (isStartEnd(n)) return { w: Math.max(40, w), h: Math.max(40, h) };
  const wide = n.rawShape === "diamond" || n.peleKind === "choice" || n.rawShape === "lean_right" || n.rawShape === "lean_left";
  return { w: Math.max(wide ? 120 : 80, w), h: Math.max(wide ? 60 : 40, h) };
}

/**
 * Canvas card size for a rendered node box (SVG units) at `scale` — the rule
 * mermaidToCanvas applies, shared with canvasToMermaid so a card the user
 * did not resize never produces a `pele-size` entry.
 */
export function canvasNodeSize(box: { width: number; height: number }, n: CanvasShapeInfo, scale: number): { w: number; h: number } {
  return canvasMinSize(Math.round(box.width * scale), Math.round(box.height * scale), n);
}

/** `pele-size` entries recorded by mermaidToCanvas (metadata.pele.nodeSizes). */
function priorNodeSizes(metaPele: AnyRec | undefined): Map<string, NodeSize> {
  const raw = metaPele?.nodeSizes;
  const out = new Map<string, NodeSize>();
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, AnyRec>)) {
    const w = Number(v?.w), h = Number(v?.h);
    const size: NodeSize = { ...(w > 0 ? { w: Math.round(w) } : {}), ...(h > 0 ? { h: Math.round(h) } : {}) };
    if (size.w !== undefined || size.h !== undefined) out.set(id, size);
  }
  return out;
}

/** Shape facts of node `id` in a parsed flowchart/state model (as mermaidToCanvas derives them). */
function canvasShapeInfo(model: ParsedDiagramModel, id: string): CanvasShapeInfo {
  if (model?.type === "flowchart") { const n = model.nodes?.get?.(id); return n ? { rawShape: n.type } : {}; }
  if (model?.type === "state") {
    const gn = ((model as StateModelG).graph?.nodes ?? []).find((g) => g.id === id);
    if (gn?.shape === "stateStart") return { rawShape: "circle", peleKind: "stateStart" };
    if (gn?.shape === "stateEnd") return { rawShape: "circle", peleKind: "stateEnd" };
    if (gn?.shape === "choice") return { rawShape: "diamond", peleKind: "choice" };
  }
  return {};
}

/**
 * `%% pele-size … %%` for Canvas cards whose size differs from the node's
 * natural box: a card whose size differs (by more than 2 × scale canvas px)
 * from what mermaidToCanvas would give the node gets an entry for that
 * dimension, written as the size that actually renders. Text and link cards
 * of sizable nodes only (file cards size their embed through the label).
 */
function canvasSizeDirective(body: string, outNodes: OutNode[], scale: number, prior: Map<string, NodeSize>): string {
  let svg: string; let model: ParsedDiagramModel; let caps: Map<string, SizeCaps> | null;
  const src = shieldQuotes(body);
  try { model = parse(src); svg = render(src).svg; caps = nodeSizeCaps(src); } catch { return ""; }
  if (!caps || !caps.size) return "";
  const geom = parseSvgGeometry(svg);
  const union = nodeBoxMap(svg);
  // Boxes as the previous entries render them: an unchanged card keeps its entry verbatim.
  let priorGeom: SvgGeometry | null = null;
  const keptPrior = new Map([...prior].filter(([id]) => caps.has(id)));
  if (keptPrior.size) { try { priorGeom = parseSvgGeometry(render(withSizeDirective(src, keptPrior)).svg); } catch { priorGeom = null; } }
  const tol = 2 * scale;
  const sizes = new Map<string, NodeSize>();
  const fresh = new Set<string>();
  for (const o of outNodes) {
    if (o.node.type !== "text" && o.node.type !== "link") continue;
    if (o.node.type === "link" && parseWebEmbedLabel(o.label)) continue; // view-nodes: sized by its embed box, like file cards
    const c = caps.get(o.mid); const bb = geom.nodes.get(o.mid); const u = union.get(o.mid);
    if (!c || !bb || !u) continue;
    const info = canvasShapeInfo(model, o.mid);
    if (isStartEnd(info)) continue;
    const near = (want: { w: number; h: number }) => Math.abs(o.node.width - want.w) <= tol && Math.abs(o.node.height - want.h) <= tol;
    const was = keptPrior.get(o.mid); const pb = priorGeom?.nodes.get(o.mid);
    if (was && pb && near(canvasNodeSize(pb, info, scale))) { sizes.set(o.mid, was); continue; }
    const want = canvasNodeSize(bb, info, scale);
    if (near(want)) continue;
    const dw = c.w && Math.abs(o.node.width - want.w) > tol;
    const dh = c.h && c.lock !== "square" && Math.abs(o.node.height - want.h) > tol;
    const sq = c.lock === "square";
    // Canvas measures the first shape, sizes the whole node box: carry the difference.
    const size: NodeSize = {};
    if (dw || sq) size.w = Math.max(1, Math.round((sq ? Math.max(o.node.width, o.node.height) : o.node.width) / scale + (u.w - bb.width)));
    if (dh) size.h = Math.max(1, Math.round(o.node.height / scale + (u.h - bb.height)));
    if (size.w !== undefined || size.h !== undefined) { sizes.set(o.mid, size); fresh.add(o.mid); }
  }
  if (!sizes.size) return "";
  // New entries: write what renders (snapped, clamped), so the line states the result.
  if (fresh.size) {
    try {
      const sized = render(withSizeDirective(src, sizes)) as unknown as NodeSizeResult;
      for (const id of fresh) {
        const s = sizes.get(id)!; const a = sized.nodeSizes?.[id]?.applied;
        if (!a) continue;
        // Within the solver's precision the requested size stands.
        const pick = (want: number, got: number) => (Math.abs(want - got) <= 2 ? want : got);
        sizes.set(id, { ...(s.w !== undefined ? { w: pick(s.w, a.w) } : {}), ...(s.h !== undefined ? { h: pick(s.h, a.h) } : {}) });
      }
    } catch { /* keep the requested sizes */ }
  }
  // Previous entries keep their order; new ones follow.
  const ordered = new Map<string, NodeSize>();
  for (const id of prior.keys()) if (sizes.has(id)) ordered.set(id, sizes.get(id)!);
  for (const [id, v] of sizes) if (!ordered.has(id)) ordered.set(id, v);
  return formatSizeDirective(ordered);
}

/** Embed nodes reserve their card box in the layout (as Mehrpele does in Obsidian). */
function withEmbedBoxes(source: string, model: ParsedDiagramModel, skip: Set<string>): string {
  if (model?.type !== "flowchart") return source;
  const sizes = parseSizeDirective(source);
  let added = false;
  for (const n of mapVals(model.nodes)) {
    if (skip.has(n.id) || sizes.has(n.id)) continue;
    const e = parseEmbedLabel(labelText(n.text ?? ""));
    const box = e ? embedNodeBox(e) : null;
    if (box) { sizes.set(n.id, { w: box.w, h: box.h }); added = true; }
  }
  return added ? withSizeDirective(source, sizes) : source;
}

interface Rect { x: number; y: number; w: number; h: number }
const overlapsR = (a: Rect, b: Rect, gap: number) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

export function mermaidToCanvas(source: string, opts: ToCanvasOptions = {}): { canvas: CanvasData; fidelity: "full" | "embed"; dropped: string[] } {
  const prov = parseProvenance(source);
  const scale = opts.scale ?? prov?.scale ?? 2;
  const origin = opts.origin ?? { x: 40, y: 40 };
  const advanced = opts.advancedCanvas ?? false;
  const hash = sourceHash(stripProvenance(source));
  // previous manual layout
  const prevByPele = new Map<string, CanvasNode>(); const prevById = new Map<string, CanvasNode>();
  let prevWins = false;
  if (opts.previous) {
    const prevHash = (opts.previous.metadata as { pele?: PeleMeta } | undefined)?.pele?.sourceHash;
    if (prevHash && (prevHash === hash || prevHash === sourceHash(source) || (prov?.sourceHash && prov.sourceHash === prevHash))) prevWins = true;
    for (const n of opts.previous.nodes ?? []) { prevById.set(n.id, n); if ((n as AnyRec).peleId) prevByPele.set(String((n as AnyRec).peleId), n); }
  }

  const shielded = shieldQuotes(source);
  const model = parse(shielded);
  const type: string = model.type;
  const dropped: string[] = [];

  if (type !== "flowchart" && type !== "state" && type !== "mindmap") {
    const rendered = render(shielded);
    const text = "```mermaid\n" + source + "\n```\n> Converted with Pele — diagram type `" + type + "` has no Canvas node/edge equivalent. Edit the source and use **Convert diagram to canvas** again, or open in the Pele playground.";
    const w = Math.max(200, Math.min(1200, Math.round((rendered.width ?? 400) * scale)));
    const h = Math.max(120, Math.min(800, Math.round((rendered.height ?? 300) * scale)));
    const pv = prov?.nodes.get("__embed__") ?? prov?.nodes.get("n_embed");
    const manual = pv ? { x: pv.x, y: pv.y, width: pv.w, height: pv.h } : prevWins ? (() => { const p = prevByPele.get("__embed__") ?? prevById.get("n_embed"); return p ? { x: p.x, y: p.y, width: p.width, height: p.height } : null; })() : null;
    const node: CanvasNode = manual ? { id: "n_embed", type: "text", ...manual, text } : { id: "n_embed", type: "text", x: origin.x, y: origin.y, width: w, height: h, text };
    (node as AnyRec).peleId = "__embed__";
    const canvas: CanvasData = { metadata: { version: "1.0-1.0", frontmatter: { tags: ["pele-diagram"] }, pele: { schema: 1, type, direction: "", sourceHash: hash, peleVersion: PELE_VERSION, scale, fidelity: "embed", classDefs: {}, dropped: [] } }, nodes: [node], edges: [] };
    return { canvas, fidelity: "embed", dropped };
  }

  const layout: CanvasLayout = type === "flowchart" ? parseLayoutDirective(source) : { mode: "auto", pos: new Map(), ports: new Map() };
  const sourceSizes = parseSizeDirective(source);
  const subgraphIds = new Set<string>(type === "flowchart" ? ((model as FlowModel).subgraphs ?? []).map((s) => s.id) : []);
  const rendered = render(withEmbedBoxes(shielded, model, subgraphIds));
  const geom = parseSvgGeometry(rendered.svg);

  // Build internal graph per type
  let direction = "TD";
  let internalNodes: InternalNodes = [];
  let internalEdges: { from: string; to: string; label: string; edgeType?: string; stroke?: string; classes: string[]; styles?: string[] }[] = [];
  let groups: { peleId: string; canvasId: string; title: string; members: string[]; bbox?: BBox; dir?: string; classes?: string[]; styles?: string[] }[] = [];
  let classDefs = new Map<string, ClassDef>();

  const usedCanvasIds = new Map<string, number>();
  const canvasIdFor = (prefix: string, peleId: string): string => {
    const base = prefix + "_" + sanitizeId(peleId);
    const n = (usedCanvasIds.get(base) ?? 0) + 1; usedCanvasIds.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  };
  const tooltips = new Map<string, string>(mapEntries((model as Partial<FlowModel>).tooltips).map(([k, v]) => [k, String(v)]));
  // Click targets as written (Pele normalises URLs, e.g. adds a trailing slash).
  const rawLinks = new Map<string, string>();
  for (const m of source.matchAll(/^[ \t]*click[ \t]+([^\s]+)[ \t]+(?:href[ \t]+)?"([^"]+)"/gm)) rawLinks.set(m[1], m[2]);
  const asWritten = (id: string, link: string): string => { const raw = rawLinks.get(id); try { return raw && new URL(raw).href === new URL(link).href ? raw : link; } catch { return link; } };

  if (type === "flowchart") {
    direction = (model as FlowModel).direction === "TB" ? "TD" : ((model as FlowModel).direction ?? "TD");
    for (const [k, v] of mapEntries((model as FlowModel).classes)) classDefs.set(k, v);
    const nodesArr = mapVals((model as FlowModel).nodes).filter((n) => !subgraphIds.has(n.id));
    const nodeById = new Map<string, FlowNode>(mapVals((model as FlowModel).nodes).map((n) => [n.id, n]));
    const cidMap = new Map<string, string>();
    for (const n of nodesArr) cidMap.set(n.id, prov?.nodes.get(n.id)?.canvasId || canvasIdFor("n", n.id));
    for (const n of nodesArr) {
      const label: string = labelText(n.text ?? n.id);
      internalNodes.push({ peleId: n.id, canvasId: cidMap.get(n.id)!, label, rawShape: n.type, classes: (n.classes ?? []).filter((c: string) => c !== "clickable"), styles: n.styles ?? [], kind: "text", bbox: geom.nodes.get(n.id) });
      const inn = internalNodes[internalNodes.length - 1];
      if (n.link) inn._link = asWritten(n.id, n.link);
      if (n.linkTarget) inn._linkTarget = n.linkTarget;
    }
    for (const e of (model as FlowModel).edges ?? []) internalEdges.push({ from: e.start, to: e.end, label: labelText(e.text ?? ""), edgeType: e.type, stroke: e.stroke, classes: e.classes ?? [], styles: (e.style ?? e.styles ?? []).filter((s: string) => !/^\s*fill\s*:\s*none\s*$/.test(s)) });
    for (const sg of (model as FlowModel).subgraphs ?? []) {
      const sn = nodeById.get(sg.id);
      groups.push({ peleId: sg.id, canvasId: prov?.groups.get(sg.id)?.canvasId || canvasIdFor("g", sg.id), title: labelText(sg.title ?? sg.id), members: sg.nodes ?? [], bbox: geom.clusters.get(sg.id), dir: sg.dir, classes: [...(sg.classes ?? []), ...(sn?.classes ?? [])].filter((c: string) => c !== "clickable"), styles: sn?.styles ?? [] });
    }
    internalNodes._cidMap = cidMap;
  } else if (type === "state") {
    direction = "TD";
    for (const [k, v] of mapEntries((model as StateModelG).classes)) classDefs.set(k, v);
    const graphById = new Map<string, StateGraphNode>(); for (const gn of (model as StateModelG).graph?.nodes ?? []) graphById.set(gn.id, gn);
    const stateById = new Map<string, StateStmt>(); for (const [k, v] of mapEntries((model as StateModelG).states)) stateById.set(k, v);
    const relations: StateRelation[] = [];
    const walkDoc = (doc: Stmt[]) => { for (const s of doc ?? []) { if (typeof s === "string") continue; if (s.stmt === "relation") { relations.push({ id1: s.state1?.id, id2: s.state2?.id, relationTitle: s.description ?? "" }); if (s.state1) stateById.set(s.state1.id, { ...(stateById.get(s.state1.id) ?? {}), ...s.state1 }); if (s.state2) stateById.set(s.state2.id, { ...(stateById.get(s.state2.id) ?? {}), ...s.state2 }); } else if (s.stmt === "state" && s.doc) walkDoc(s.doc); } };
    walkDoc((model as StateModelG).rootDoc ?? []);
    const rels = relations.length ? relations : ((model as StateModelG).relations ?? []);
    const compositeIds = new Set<string>();
    for (const [id, st] of stateById) if (st.doc) compositeIds.add(id);
    for (const gn of graphById.values()) if (gn.isGroup) compositeIds.add(gn.id);
    const cidMap = new Map<string, string>();
    const orderedIds: string[] = [];
    for (const gn of (model as StateModelG).graph?.nodes ?? []) if (!orderedIds.includes(gn.id)) orderedIds.push(gn.id);
    for (const id of stateById.keys()) if (!orderedIds.includes(id)) orderedIds.push(id);
    for (const r of rels) { for (const id of [r.id1, r.id2]) if (id && !orderedIds.includes(id)) orderedIds.push(id); }
    for (const id of orderedIds) {
      if (compositeIds.has(id)) { groups.push({ peleId: id, canvasId: prov?.groups.get(id)?.canvasId || canvasIdFor("g", id), title: graphById.get(id)?.label ?? id, members: ((model as StateModelG).graph?.nodes ?? []).filter((n) => n.parentId === id).map((n) => n.id), bbox: geom.clusters.get(id) }); cidMap.set(id, groups[groups.length - 1].canvasId); continue; }
      const st = stateById.get(id); const gn = graphById.get(id);
      let peleKind: string | undefined; let label = "";
      const descs: (string | string[])[] = st?.descriptions ?? gn?.description ?? (st?.description ? [st.description] : []);
      const descText = labelText((Array.isArray(descs) ? descs.join(" ") : String(descs ?? "")).trim());
      if (gn?.shape === "choice") { peleKind = "choice"; label = descText || id; }
      else label = descText || (gn?.label && gn.label !== id ? gn.label : id);
      if (gn?.shape === "stateStart" || (!gn && id === "root_start")) { peleKind = "stateStart"; label = " "; }
      if (gn?.shape === "stateEnd" || (!gn && id === "root_end")) { peleKind = "stateEnd"; label = " "; }
      const rawShape = peleKind === "choice" ? "diamond" : peleKind ? "circle" : undefined;
      const cid = prov?.nodes.get(id)?.canvasId || canvasIdFor("n", id); cidMap.set(id, cid);
      internalNodes.push({ peleId: id, canvasId: cid, label, rawShape, classes: st?.classes ?? [], styles: st?.styles ?? [], kind: "text", peleKind, bbox: geom.nodes.get(id) });
    }
    for (const r of rels) if (r.id1 && r.id2) internalEdges.push({ from: r.id1, to: r.id2, label: r.relationTitle ?? "", classes: [] });
    internalNodes._cidMap = cidMap;
  } else if (type === "mindmap") {
    direction = "LR";
    const flat: MindmapNode[] = (model as MindmapModel).nodes ?? [];
    const root = flat.find((n) => n.isRoot) ?? flat[0];
    const cidMap = new Map<string, string>();
    const walk = (node: MindmapNode, parent: MindmapNode | null) => {
      const cid = `n_m${node.id}`; cidMap.set(String(node.id), cid);
      internalNodes.push({ peleId: node.nodeId, canvasId: cid, label: labelText(node.descr ?? node.nodeId), rawShape: node.isRoot || node.type === 3 ? "circle" : undefined, classes: node.class ? [node.class] : [], styles: [], kind: "text", section: node.section, peleKind: "mindmap", bbox: geom.nodes.get(node.nodeId) });
      internalNodes[internalNodes.length - 1]._mmId = node.id;
      if (parent) internalEdges.push({ from: `mm:${parent.id}`, to: `mm:${node.id}`, label: "", classes: [] });
      for (const ch of node.children ?? []) walk(ch, node);
    };
    if (root) walk(root, null);
    internalNodes._cidMap = cidMap;
    internalNodes._mmMode = true;
  }

  const cidMap: Map<string, string> = internalNodes._cidMap ?? new Map<string, string>();
  const mmMode = Boolean(internalNodes._mmMode);
  const resolveCanvasId = (peleRef: string): string | undefined => {
    if (mmMode) { if (peleRef.startsWith("mm:")) return cidMap.get(peleRef.slice(3)); const n = internalNodes.find(x => x.peleId === peleRef); return n?.canvasId; }
    return cidMap.get(peleRef) ?? internalNodes.find(x => x.peleId === peleRef)?.canvasId ?? groups.find(g => g.peleId === peleRef)?.canvasId;
  };
  const midOfRef = (ref: string): string => mmMode && ref.startsWith("mm:") ? (internalNodes.find(n => `mm:${n._mmId}` === ref)?.peleId ?? ref) : ref;

  // geometry fallback grid
  let fallbackIdx = 0;
  const fallbackBBox = (): BBox => { const col = fallbackIdx % 4, row = Math.floor(fallbackIdx / 4); fallbackIdx++; return { x: col * 180, y: row * 120, width: 120, height: 60, cx: col * 180 + 60, cy: row * 120 + 30 }; };

  // ---- cards: content, auto geometry, then the manual geometry where known
  interface Card { n: InternalNode; cn: CanvasNode; auto: Rect; placed: Rect | null }
  const cards: Card[] = [];
  const attachedViews = parseViewEntries(source); // view-nodes: `%% pele-view %%` rides on its cards
  for (const n of internalNodes) {
    if (!n.bbox) n.bbox = fallbackBBox();
    const bb = n.bbox;
    const label = n.label ?? "";
    const trimmed = label.trim();
    let kind: CanvasNode["type"] = "text";
    // view-nodes: a web-view label (`![[https://…|WxH]]`) is a link card, sized like a file card.
    const web = type === "flowchart" || type === "state" ? parseWebEmbedLabel(trimmed) : null;
    // view-nodes: folder embeds become a text card holding the same inline base (Canvas renders it
    // live); other `view:` nodes a text card with the label (Canvas can't host them). Both come back exactly.
    const folder = !web && (type === "flowchart" || type === "state") ? parseFolderLabel(trimmed) : null;
    const viewText = !web && !folder && /^!\[\[view:/i.test(trimmed);
    const emb = !web && !folder && !viewText && (type === "flowchart" || type === "state") ? parseEmbedLabel(trimmed) : null;
    const link = n._link;
    let url: string | undefined;
    if (web) { kind = "link"; url = web.url; }
    else if (emb) kind = "file";
    else if (type === "flowchart" && link && /^https?:\/\//i.test(link)) { kind = "link"; url = /^https?:\/\/\S+$/.test(trimmed) && sameUrl(trimmed, link) ? trimmed : link; }
    else if (type === "flowchart" && /^https?:\/\/\S+$/.test(trimmed)) { kind = "link"; url = trimmed; }
    let x = Math.round(bb.x * scale + origin.x), y = Math.round(bb.y * scale + origin.y), w = Math.round(bb.width * scale), h = Math.round(bb.height * scale);
    const box = emb ? embedNodeBox(emb) : web ? webNodeBox(web) : null; // view-nodes
    if (box) { const cx = x + w / 2, cy = y + h / 2; w = box.w * scale; h = box.h * scale; x = Math.round(cx - w / 2); y = Math.round(cy - h / 2); }
    else {
      // Same rule canvasToMermaid uses to tell resized nodes apart (pele-size).
      const sz = canvasMinSize(w, h, n);
      if (sz.w > w && !isStartEnd(n)) x -= Math.round((sz.w - w) / 2);
      if (sz.h > h && !isStartEnd(n)) y -= Math.round((sz.h - h) / 2);
      w = sz.w; h = sz.h;
    }
    const cn: CanvasNode = { id: n.canvasId, type: kind, x, y, width: w, height: h };
    (cn as AnyRec).peleId = n.peleId;
    if (n.rawShape) (cn as AnyRec).peleShape = n.rawShape;
    if (n.classes?.length) (cn as AnyRec).peleClasses = [...n.classes];
    if (n.styles?.length && type === "flowchart") (cn as AnyRec).peleStyles = [...n.styles];
    if (n.peleKind) (cn as AnyRec).peleKind = n.peleKind;
    if (attachedViews.has(n.peleId)) (cn as AnyRec).peleViews = [...attachedViews.get(n.peleId)!]; // view-nodes
    if (link && kind !== "link") (cn as AnyRec).peleLink = link;
    const tip = tooltips.get(n.peleId); if (tip) (cn as AnyRec).peleTooltip = tip;
    // An empty card is written as `" "` (Pele rejects empty labels).
    if (kind === "text") cn.text = n.peleKind === "stateStart" || n.peleKind === "stateEnd" ? " " : type === "flowchart" && !label.trim() ? "" : label;
    if (folder) { cn.text = folderBaseBlock(folder); (cn as AnyRec).peleText = trimmed; } // view-nodes
    else if (kind === "file") {
      cn.file = emb!.file; if (emb!.subpath) cn.subpath = emb!.subpath;
      if (emb!.alias) (cn as AnyRec).peleLabel = emb!.alias;
      (cn as AnyRec).peleEmbed = emb!.embed;
      (cn as AnyRec).peleText = trimmed;
      if (emb!.file.toLowerCase().endsWith(".canvas") && advanced) cn.portal = true;
    } else if (kind === "link" && web) { cn.url = url; (cn as AnyRec).peleText = trimmed; } // view-nodes
    else if (kind === "link") { cn.url = url; if (trimmed !== url && trimmed !== n.peleId) (cn as AnyRec).peleLabel = label; }
    // colour
    const fc = colourOf(n.classes, n.styles, classDefs);
    if (fc.color) cn.color = fc.color; else if (fc.raw) { (cn as AnyRec).peleFill = fc.raw; dropped.push(`node ${n.canvasId} fill ${fc.raw} (no hex equivalent)`); }
    if (type === "mindmap" && n.section !== undefined && !n.rawShape?.includes("circle")) cn.color = String((n.section % 6) + 1);
    if (n.peleKind === "stateStart" || n.peleKind === "stateEnd") cn.color = "1";
    if (advanced) {
      const sa: Record<string, string | null> = {};
      const acShape = n.peleKind === "stateStart" || n.peleKind === "stateEnd" ? "circle" : n.peleKind === "choice" ? "diamond" : n.rawShape ? SHAPE_TO_AC[n.rawShape] : undefined;
      if (acShape && kind === "text") sa.shape = acShape;
      if (acShape === "diamond" || acShape === "circle" || acShape === "pill") if (kind === "text") sa.textAlign = "center";
      const border = borderOf(n.styles);
      if (border) sa.border = border;
      if (Object.keys(sa).length) cn.styleAttributes = sa;
    }
    cards.push({ n, cn, auto: { x, y, w, h }, placed: null });
  }

  // manual geometry: provenance (exact while the node is unchanged), pele-pos, previous canvas
  const nodeSigNow = (n: InternalNode): string | undefined => type === "flowchart" ? nodeSig(n.label, n.rawShape, sourceSizes.get(n.peleId)) : undefined;
  for (const c of cards) {
    const mid = c.n.peleId;
    const pv = prov?.nodes.get(mid) ?? prov?.nodes.get(c.n.canvasId);
    const pos = layout.pos.get(mid);
    const prev = prevWins ? (prevByPele.get(mid) ?? prevById.get(c.n.canvasId)) : undefined;
    let w = c.auto.w, h = c.auto.h;
    const sameNode = pv && (pv.sig === undefined || pv.sig === nodeSigNow(c.n));
    if (pv && sameNode) { w = pv.w; h = pv.h; } else if (!pv && prev) { w = prev.width; h = prev.height; }
    let centre: { x: number; y: number } | null = null;
    if (pv) centre = { x: pv.x + pv.w / 2, y: pv.y + pv.h / 2 };
    else if (prev) centre = { x: prev.x + prev.width / 2, y: prev.y + prev.height / 2 };
    if (pos && (!centre || Math.abs(pos.x * scale - centre.x) > 0.5 * scale || Math.abs(pos.y * scale - centre.y) > 0.5 * scale)) centre = { x: pos.x * scale, y: pos.y * scale };
    if (centre) {
      // exact provenance geometry when nothing moved
      if (pv && sameNode && centre.x === pv.x + pv.w / 2 && centre.y === pv.y + pv.h / 2) c.placed = { x: pv.x, y: pv.y, w, h };
      else c.placed = { x: Math.round(centre.x - w / 2), y: Math.round(centre.y - h / 2), w, h };
    }
    // Style keys Mermaid expresses: derived wins with Advanced Canvas on; without it
    // the kept ones stand while the node is unchanged.
    if (pv?.keep) Object.assign(c.cn, mergeKeep(c.cn, pv.keep, advanced ? ownedKeys(pv.keep, nodeOwnedStyle) : sameNode ? [] : ["shape", "border"]));
  }
  // new nodes: next to their placed neighbours, offset as in Pele's layout, off any overlap
  if (cards.some(c => c.placed) && cards.some(c => !c.placed)) {
    const byRef = new Map<string, Card>();
    for (const c of cards) { byRef.set(c.n.peleId, c); if (c.n._mmId !== undefined) byRef.set(`mm:${c.n._mmId}`, c); }
    const centreOf = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const delta = (list: Card[]) => { if (!list.length) return null; let sx = 0, sy = 0; for (const c of list) { const a = centreOf(c.auto), p = centreOf(c.placed!); sx += p.x - a.x; sy += p.y - a.y; } return { x: sx / list.length, y: sy / list.length }; };
    const global = delta(cards.filter(c => c.placed))!;
    const vertical = direction === "TD" || direction === "TB" || direction === "BT";
    const pending = cards.filter(c => !c.placed);
    const neighbours = (c: Card) => internalEdges.flatMap(e => { const f = byRef.get(e.from), t = byRef.get(e.to); return f === c && t?.placed ? [t] : t === c && f?.placed ? [f] : []; });
    for (let guard = 0; pending.length && guard < 4 * cards.length + 4; guard++) {
      const idx = pending.findIndex(c => neighbours(c).length > 0);
      const c = idx >= 0 ? pending.splice(idx, 1)[0] : pending.shift()!;
      const d = delta(neighbours(c)) ?? global;
      const a = centreOf(c.auto);
      const r: Rect = { x: Math.round(a.x + d.x - c.auto.w / 2), y: Math.round(a.y + d.y - c.auto.h / 2), w: c.auto.w, h: c.auto.h };
      for (let step = 0; step < 200; step++) {
        const hit = cards.find(o => o !== c && o.placed && overlapsR(r, o.placed, 20));
        if (!hit) break;
        if (vertical) r.y = hit.placed!.y + hit.placed!.h + 40; else r.x = hit.placed!.x + hit.placed!.w + 40;
      }
      c.placed = r;
    }
  }
  const canvasNodes: CanvasNode[] = [];
  const rectOfCard = new Map<string, Rect>();
  for (const c of cards) {
    const r = c.placed ?? c.auto;
    c.cn.x = r.x; c.cn.y = r.y; c.cn.width = r.w; c.cn.height = r.h;
    rectOfCard.set(c.cn.id, r);
  }
  const anyManual = cards.some(c => c.placed);

  // ---- groups (larger first = shallower), wrapping their members
  const groupNodes: CanvasNode[] = [];
  const sortedGroups = [...groups].sort((a, b) => ((b.bbox?.width ?? 0) * (b.bbox?.height ?? 0)) - ((a.bbox?.width ?? 0) * (a.bbox?.height ?? 0)));
  const memberRects = (g: typeof groups[number], seen = new Set<string>()): Rect[] => {
    if (seen.has(g.peleId)) return []; seen.add(g.peleId);
    const out: Rect[] = [];
    for (const m of g.members) { const cid = resolveCanvasId(m); const r = cid ? rectOfCard.get(cid) : undefined; if (r) out.push(r); const sub = groups.find(x => x.peleId === m); if (sub) out.push(...memberRects(sub, seen)); }
    return out;
  };
  for (const g of sortedGroups) {
    const pv = prov?.groups.get(g.peleId);
    const prev = prevWins ? (prevByPele.get(g.peleId) ?? prevById.get(g.canvasId)) : undefined;
    const pos = layout.pos.get(g.peleId);
    let r: Rect | null = pv ? { x: pv.x, y: pv.y, w: pv.w, h: pv.h } : prev ? { x: prev.x, y: prev.y, w: prev.width, h: prev.height } : null;
    if (!r && pos && pos.w !== undefined && pos.h !== undefined) r = { x: Math.round((pos.x - pos.w / 2) * scale), y: Math.round((pos.y - pos.h / 2) * scale), w: Math.round(pos.w * scale), h: Math.round(pos.h * scale) };
    if (!r && anyManual) {
      const mem = memberRects(g);
      if (mem.length) { const x1 = Math.min(...mem.map(m => m.x)), y1 = Math.min(...mem.map(m => m.y)), x2 = Math.max(...mem.map(m => m.x + m.w)), y2 = Math.max(...mem.map(m => m.y + m.h)); r = { x: x1 - 20 * scale / 2, y: y1 - 50 * scale / 2, w: x2 - x1 + 20 * scale, h: y2 - y1 + 70 * scale / 2 }; }
    }
    if (!r) {
      let bb = g.bbox;
      if (!bb) {
        const mem = internalNodes.filter(n => g.members.includes(n.peleId) && n.bbox);
        if (mem.length) { const x1 = Math.min(...mem.map(n => n.bbox!.x)), y1 = Math.min(...mem.map(n => n.bbox!.y)), x2 = Math.max(...mem.map(n => n.bbox!.x + n.bbox!.width)), y2 = Math.max(...mem.map(n => n.bbox!.y + n.bbox!.height)); bb = { x: x1 - 30, y: y1 - 30, width: x2 - x1 + 60, height: y2 - y1 + 60, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 }; }
        else bb = fallbackBBox();
      }
      r = { x: Math.round(bb.x * scale + origin.x), y: Math.round(bb.y * scale + origin.y), w: Math.round(bb.width * scale), h: Math.round(bb.height * scale) };
    }
    let gn: CanvasNode = { id: g.canvasId, type: "group", x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h), label: g.title };
    (gn as AnyRec).peleId = g.peleId;
    if (g.dir && g.dir !== direction) (gn as AnyRec).peleDir = g.dir;
    if (g.classes?.length) (gn as AnyRec).peleClasses = [...g.classes];
    if (g.styles?.length) (gn as AnyRec).peleStyles = [...g.styles];
    const gc = colourOf(g.classes, g.styles, classDefs);
    if (gc.color) gn.color = gc.color;
    if (pv?.keep) gn = mergeKeep(gn, pv.keep);
    groupNodes.push(gn);
    rectOfCard.set(gn.id, { x: gn.x, y: gn.y, w: gn.width, h: gn.height });
  }
  canvasNodes.push(...groupNodes, ...cards.map(c => c.cn));

  // repair: grow groups to contain members (inner groups first)
  for (const g of [...groupNodes].reverse()) {
    const sg = groups.find(x => x.canvasId === g.id); if (!sg) continue;
    for (const mid of sg.members) {
      const cn = canvasNodes.find(n => n.id === resolveCanvasId(mid)); if (!cn || cn === g) continue;
      let changed = false;
      if (cn.x < g.x) { g.width += g.x - cn.x; g.x = cn.x; changed = true; }
      if (cn.y < g.y) { g.height += g.y - cn.y; g.y = cn.y; changed = true; }
      if (cn.x + cn.width > g.x + g.width) { g.width = cn.x + cn.width - g.x; changed = true; }
      if (cn.y + cn.height > g.y + g.height) { g.height = cn.y + cn.height - g.y; changed = true; }
      if (changed && !anyManual) dropped.push(`group ${g.id} grown to contain ${cn.id}`);
    }
    rectOfCard.set(g.id, { x: g.x, y: g.y, w: g.width, h: g.height });
  }

  // ---- edges
  const canvasEdges: CanvasEdge[] = [];
  const pairCount = new Map<string, number>();
  const keyCount = new Map<string, number>();
  const flowEdges: FlowEdge[] = type === "flowchart" ? ((model as FlowModel).edges ?? []) : [];
  const centreByPele = new Map<string, { cx: number; cy: number }>();
  for (const n of internalNodes) if (n.bbox) { centreByPele.set(n.peleId, { cx: n.bbox.cx, cy: n.bbox.cy }); if (n._mmId !== undefined) centreByPele.set(`mm:${n._mmId}`, { cx: n.bbox.cx, cy: n.bbox.cy }); }
  internalEdges.forEach((e, idx) => {
    const fromC = resolveCanvasId(e.from); const toC = resolveCanvasId(e.to);
    if (!fromC || !toC) { dropped.push(`edge ${e.from}->${e.to} dropped (missing node)`); return; }
    const pairKey = `${fromC}\0${toC}`; const k = pairCount.get(pairKey) ?? 0; pairCount.set(pairKey, k + 1);
    const fromMid = midOfRef(e.from), toMid = midOfRef(e.to);
    const kk = `${fromMid}>${toMid}`; const occ = (keyCount.get(kk) ?? 0) + 1; keyCount.set(kk, occ);
    const pk = edgeKey(fromMid, toMid, occ);
    const pe: ProvEdge | undefined = mmMode ? undefined : prov?.edges.get(pk);
    const fromSan = sanitizeId(mmMode ? e.from : internalNodes.find(n => n.canvasId === fromC)?.peleId ?? fromC);
    const toSan = sanitizeId(mmMode ? e.to : internalNodes.find(n => n.canvasId === toC)?.peleId ?? toC);
    const eid = pe?.id ?? `e_${fromSan}_${toSan}_${k}`;
    // sides: provenance, pele-pos ports, else geometry
    let fromSide: Side | undefined, toSide: Side | undefined;
    const ports: EdgePorts = layout.ports.get(pk) ?? {};
    const fr = rectOfCard.get(fromC), tr = rectOfCard.get(toC);
    const manualEnds = anyManual || layout.mode === "canvas";
    if (manualEnds && fr && tr) { [fromSide, toSide] = autoSides(fr, tr); }
    else {
      let eg: EdgeGeom | undefined;
      if (type === "flowchart") { const fe = flowEdges[idx]; eg = fe?.id ? geom.edges.get(fe.id) : undefined; }
      else if (type === "state") eg = geom.edges.get(`edge${idx}`);
      const fc = centreByPele.get(e.from), tc = centreByPele.get(e.to);
      if (eg && fc && tc) { fromSide = sideFromVector(eg.sx - fc.cx, eg.sy - fc.cy); toSide = sideFromVector(eg.ex - tc.cx, eg.ey - tc.cy); }
      else if (fc && tc && (fc.cx !== tc.cx || fc.cy !== tc.cy)) { fromSide = sideFromVector(tc.cx - fc.cx, tc.cy - fc.cy); toSide = sideFromVector(fc.cx - tc.cx, fc.cy - tc.cy); }
      else { const ds = dirSides(direction); fromSide = ds.fromSide; toSide = ds.toSide; }
    }
    if (ports.from) fromSide = ports.from; if (ports.to) toSide = ports.to;
    if (pe?.fromSide) fromSide = pe.fromSide; if (pe?.toSide) toSide = pe.toSide;
    const rev = pe?.keep && (pe.keep as AnyRec).peleReversed === true;
    // pe sides are in the Mermaid frame; the delete below runs on the canvas edge, so swap when reversed.
    const implicitSides = !opts.explicitSides && pe && !ports.from && !ports.to
      ? (rev ? { from: !pe.toSide, to: !pe.fromSide } : { from: !pe.fromSide, to: !pe.toSide }) : null;
    let ce: CanvasEdge = rev ? { id: eid, fromNode: toC, toNode: fromC, fromSide: toSide, toSide: fromSide } : { id: eid, fromNode: fromC, toNode: toC, fromSide, toSide };
    const edgeType = e.edgeType;
    if (type === "mindmap") { ce.fromEnd = "none"; ce.toEnd = "none"; }
    else if (type === "state") { ce.fromEnd = "none"; ce.toEnd = "arrow"; }
    else {
      switch (edgeType) {
        case "double_arrow_point": case "double_arrow_circle": case "double_arrow_cross": ce.fromEnd = "arrow"; ce.toEnd = "arrow"; break;
        case "arrow_open": case "double_arrow_open": ce.fromEnd = "none"; ce.toEnd = "none"; break;
        default: ce.fromEnd = "none"; ce.toEnd = "arrow";
      }
      if (rev) { const f = ce.fromEnd; ce.fromEnd = ce.toEnd; ce.toEnd = f; }
      if (edgeType && edgeType !== "arrow_point") (ce as AnyRec).peleEdgeType = edgeType;
      if (e.stroke && e.stroke !== "normal") (ce as AnyRec).peleStroke = e.stroke;
      if (e.stroke === "thick") dropped.push(`edge ${eid} thick stroke (no canvas width)`);
      if (e.styles?.length) (ce as AnyRec).peleStyles = [...e.styles];
    }
    if (e.label) ce.label = e.label;
    if (type === "flowchart") { const col = edgeColourOf(e.classes, e.styles, classDefs); if (col) ce.color = col; }
    if (type === "mindmap") { const sec = internalNodes.find(n => n.canvasId === toC)?.section; if (sec !== undefined) ce.color = String((sec % 6) + 1); }
    if (advanced && type !== "mindmap") {
      const sa: Record<string, string | null> = {};
      if (e.stroke === "dotted") sa.path = "dotted";
      else { const dash = edgeDashOf(e.styles); if (dash) sa.path = dash; }
      if (edgeType === "arrow_circle" || edgeType === "double_arrow_circle") sa.arrow = "circle";
      if (edgeType === "arrow_cross" || edgeType === "double_arrow_cross") sa.arrow = "blunt";
      if (Object.keys(sa).length) ce.styleAttributes = sa;
    }
    if (pe?.keep) {
      const keep = { ...pe.keep }; delete keep.peleReversed;
      ce = mergeKeep(ce, Object.keys(keep).length ? keep : undefined, advanced ? ownedKeys(keep, edgeOwnedStyle) : pe.t !== undefined && pe.t !== `${edgeType}/${e.stroke}` ? ["path", "arrow"] : []);
    }
    if (implicitSides) { if (implicitSides.from) delete ce.fromSide; if (implicitSides.to) delete ce.toSide; }
    if (pe?.e) {
      if (pe.e.includes("f") && ce.fromEnd === "none") delete ce.fromEnd;
      if (pe.e.includes("t") && ce.toEnd === "arrow") delete ce.toEnd;
    }
    canvasEdges.push(ce);
  });

  // classDefs serialised sorted
  const classDefsObj: AnyRec = {};
  for (const k of [...classDefs.keys()].sort()) { const cd = classDefs.get(k)!; classDefsObj[k] = { styles: cd.styles ?? [], textStyles: cd.textStyles ?? [] }; }
  // startNode: exactly one indegree 0
  const indeg = new Map<string, number>(); for (const n of canvasNodes.filter(n => n.type !== "group")) indeg.set(n.id, 0);
  for (const e of canvasEdges) if (indeg.has(e.toNode)) indeg.set(e.toNode, indeg.get(e.toNode)! + 1);
  const roots = [...indeg.entries()].filter(([, v]) => v === 0).map(([k]) => k);
  const pmeta: AnyRec = prov?.meta ?? {};
  const meta: AnyRec = { ...pmeta, version: "1.0-1.0", frontmatter: pmeta.frontmatter ?? { tags: ["pele-diagram"] }, pele: { schema: 1, type, direction, sourceHash: hash, peleVersion: PELE_VERSION, scale, ...(layout.mode === "canvas" ? { layout: "canvas" } : {}), fidelity: "full", ...(advanced ? {} : { advancedCanvas: false }), classDefs: classDefsObj, dropped, ...(sourceSizes.size ? { nodeSizes: Object.fromEntries(sourceSizes) } : {}) } };
  if (pmeta.startNode && indeg.has(pmeta.startNode as string)) meta.startNode = pmeta.startNode;
  else { delete meta.startNode; if ((type === "flowchart" || type === "state") && roots.length === 1) meta.startNode = roots[0]; }
  const canvas: CanvasData = { metadata: meta, nodes: canvasNodes, edges: canvasEdges };
  return { canvas, fidelity: "full", dropped };
}

// ---------- Canvas -> Mermaid ----------
// Mermaid keywords are lowercase (`End` is a fine id, `end` is not).
const KEYWORDS = new Set(["flowchart","graph","subgraph","end","class","classDef","classdef","style","click","direction","state","mindmap","linkStyle","linkstyle","default","call","href","callback","interpolate","accTitle","accDescr","TB","TD","BT","LR","RL"]);
function isValidMermaidId(s: string): boolean { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !KEYWORDS.has(s); }
/** A slug that is a Mermaid keyword gets a suffix. */
function safeId(s: string): string { return KEYWORDS.has(s) ? `${s}_node` : s; }
/** Quoted-label escaping: Mehrpele reads `\"`; plain Mermaid/Pele needs `#quot;`. */
function escLabel(s: string, mehrpele = true): string { return mehrpele ? s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : s.replace(/"/g, "#quot;"); }
function needsQuote(s: string, mehrpele: boolean): boolean {
  if (mehrpele) return true;
  return /[[\]{}()|#;"<>*`]|^\s|\s$|\n/.test(s) || s.includes("[[") || s.includes("**");
}
/** Whether a label is Markdown that only Mehrpele renders (embeds, links, emphasis, lists, …). */
export function labelNeedsMarkdown(s: string): boolean {
  return /\[\[|\*\*|__|`|\$[^$\s]|\n|~~|==[^=]|<br|\[[^\]]+\]\([^)]+\)|(^|\s)#[A-Za-z][\w/-]*|^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>)/m.test(s) || /(^|[^\w*])\*[^*\s][^*]*\*(?!\w)/.test(s);
}
const SHAPE_FOR_AC: Record<string, string> = { pill: "stadium", diamond: "diamond", database: "cylinder", "predefined-process": "subroutine", circle: "circle", parallelogram: "lean_right" };
function shapeOf(rawShape: string | undefined, acShape: string | null | undefined): string | undefined {
  return rawShape ?? (acShape ? SHAPE_FOR_AC[acShape] : undefined);
}
function shapeSyntax(mid: string, label: string, shape: string | undefined, mehrpele: boolean): string {
  const q = needsQuote(label, mehrpele);
  const L = q ? `"${escLabel(label, mehrpele)}"` : label;
  switch (shape) {
    case "diamond": return `${mid}{${L}}`;
    case "stadium": return `${mid}([${L}])`;
    case "cylinder": return `${mid}[(${L})]`;
    case "subroutine": return `${mid}[[${L}]]`;
    case "circle": return `${mid}((${L}))`;
    case "doublecircle": return `${mid}(((${L})))`;
    case "hexagon": return `${mid}{{${L}}}`;
    case "lean_right": return `${mid}[/${L}/]`;
    case "lean_left": return `${mid}[\\${L}\\]`;
    case "round": return `${mid}(${L})`;
    case "odd": return `${mid}>${L}]`;
    case "trapezoid": return `${mid}[/${L}\\]`;
    case "inv_trapezoid": return `${mid}[\\${L}/]`;
    default: return `${mid}[${L}]`;
  }
}

function candidateId(n: CanvasNode): string { return safeId(rawCandidateId(n)); }
function rawCandidateId(n: CanvasNode): string {
  const peleId = (n as AnyRec).peleId as string | undefined;
  if (peleId && isValidMermaidId(peleId) && peleId !== "__embed__") return peleId;
  if (n.type === "file") {
    const base = slugify(((n.file ?? "file").split("/").pop() ?? "file").replace(/\.[^.]+$/, ""));
    // `Notes#Plan` → notes_plan, `Notes#^key` → notes_key (unless the heading repeats the name).
    const sub = n.subpath ? slugify(n.subpath.replace(/^#\^?/, "")) : "";
    return sub && sub !== "node" && !sub.startsWith(base) ? slugify(`${base}_${sub}`) : sub && sub.startsWith(base) ? sub : base;
  }
  if (n.type === "link") { try { return slugify(new URL(n.url ?? "").hostname); } catch { return "link"; } }
  return slugify(labelFallbackLine(n.text ?? n.label ?? "node"));
}
/** First meaningful words of a Markdown card, for ids. */
function labelFallbackLine(md: string): string {
  const line = md.split("\n").map(l => l.replace(/^\s*(#{1,6}|[-*+>]|\d+\.)\s+/, "").replace(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, t: string, a?: string) => a ?? t.split("/").pop() ?? t).replace(/[*_`~=$]/g, "").trim()).find(l => l) ?? "";
  return line || "node";
}
function computeMidMap(c: CanvasData, pfx: string): Map<string, string> {
  const regular = (c.nodes ?? []).filter(n => n.type !== "group" && !String(n.id).startsWith("acportal||"));
  const sorted = [...regular].sort((a, b) => (a.y - b.y) || (a.x - b.x) || cmp(a.id, b.id));
  const used = new Map<string, number>(); const out = new Map<string, string>();
  for (const n of sorted) {
    const cand = candidateId(n);
    const cnt = (used.get(cand) ?? 0) + 1; used.set(cand, cnt);
    out.set(n.id, `${pfx ? pfx + "_" : ""}${cnt === 1 ? cand : cand + "_" + cnt}`);
  }
  return out;
}
interface OutNode { canvasId: string; mid: string; node: CanvasNode; label: string; shape?: string; parentGroup?: string }
interface Ctx { dropped: string[]; opts: FromCanvasOptions; depth: number; visited: Set<string>; scale: number; mehrpele: boolean }

/** Label for a file card: the original label while the card is unchanged, else an embed sized like the card. */
function fileLabel(n: CanvasNode, scale: number): string {
  const a = n as CanvasNode & { peleText?: string; peleLabel?: string; peleEmbed?: boolean };
  const file = n.file ?? "", sub = n.subpath ?? "";
  const pt = a.peleText;
  if (pt) {
    const e = parseEmbedLabel(pt);
    const box = e ? embedNodeBox(e) : null;
    const same = e && e.file === file && e.subpath === sub;
    if (same && (!box || (Math.abs(box.w * scale - n.width) <= 1 && Math.abs(box.h * scale - n.height) <= 1) || (!e.embed))) return pt;
  }
  if (a.peleEmbed === false) return formatEmbedLabel({ embed: false, file, subpath: sub, ...(a.peleLabel ? { alias: String(a.peleLabel) } : {}) });
  return formatEmbedLabel({ embed: true, file, subpath: sub, size: embedSizeForCard(n.width, n.height, scale, isImageFile(file)) });
}

/** view-nodes: a text card that came from a folder embed and still holds its generated base. */
function folderLabel(n: CanvasNode): string | null {
  const pt = (n as AnyRec).peleText as string | undefined;
  const spec = pt ? parseFolderLabel(pt) : null;
  return spec && (n.text ?? "").trim() === folderBaseBlock(spec).trim() ? pt! : null;
}

/**
 * view-nodes: the web-view label for a link card, or null (a clickable text
 * node). A card that came from a web-view label keeps it (resized to the
 * card); other link cards become web views only with `webNodes`.
 */
function webLabel(n: CanvasNode, ctx: Ctx): string | null {
  const url = n.url ?? "";
  const a = n as AnyRec;
  const pt = a.peleText as string | undefined;
  const prev = pt ? parseWebEmbedLabel(pt) : null;
  const size = embedSizeForCard(n.width, n.height, ctx.scale, false);
  if (prev && prev.url === url) {
    const box = webNodeBox(prev);
    if (Math.abs(box.w * ctx.scale - n.width) <= 1 && Math.abs(box.h * ctx.scale - n.height) <= 1) return pt!;
    return formatWebEmbedLabel(url, size, prev.form, prev.alt);
  }
  if (!ctx.opts.webNodes || a.peleLabel !== undefined || !/^https?:\/\//i.test(url)) return null;
  return parseWebEmbedLabel(formatWebEmbedLabel(url, size)) ? formatWebEmbedLabel(url, size) : null;
}

function buildGraph(canvas: CanvasData, ctx: Ctx, prefix: string): { nodes: OutNode[]; edges: CanvasEdge[]; groups: CanvasNode[]; nodeGroup: Map<string, string | undefined>; groupParent: Map<string, string | undefined>; portalSubgraphs: { header: string; lines: string[] }[]; portalInnerMaps: Map<string, string> } {
  const dropped = ctx.dropped;
  const nodesIn = (canvas.nodes ?? []).filter(n => !(typeof n.id === "string" && n.id.startsWith("acportal||")));
  const groups = nodesIn.filter(n => n.type === "group");
  const regular = nodesIn.filter(n => n.type !== "group");
  // containment: smallest enclosing group (1px tolerance for hand-placed cards)
  const inside = (inner: CanvasNode, outer: CanvasNode) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;
  const groupOf = new Map<string, string | undefined>();
  const groupParent = new Map<string, string | undefined>();
  // Equal boxes nest by id (the later id is inside), so cards go to the inner one.
  const sortedGroupsByArea = [...groups].sort((a, b) => a.width * a.height - b.width * b.height || cmp(b.id, a.id));
  for (const n of regular) { let best: CanvasNode | undefined; for (const g of sortedGroupsByArea) if (inside(n, g)) { best = g; break; } groupOf.set(n.id, best?.id); }
  for (const g of groups) { let best: CanvasNode | undefined; for (const o of sortedGroupsByArea) if (o.id !== g.id && o.width * o.height >= g.width * g.height && inside(g, o) && !(o.width * o.height === g.width * g.height && o.id > g.id)) { best = o; break; } groupParent.set(g.id, best?.id); }
  const sortedRegular = [...regular].sort((a, b) => (a.y - b.y) || (a.x - b.x) || cmp(a.id, b.id));
  const used = new Map<string, number>(); const midMap = new Map<string, string>();
  const assign = (canvasId: string, candidate: string): string => {
    const n = (used.get(candidate) ?? 0) + 1; used.set(candidate, n);
    let mid = n === 1 ? candidate : `${candidate}_${n}`;
    if (prefix) mid = `${prefix}_${mid}`;
    midMap.set(canvasId, mid); return mid;
  };
  const outNodes: OutNode[] = [];
  const portalSubgraphs: { header: string; lines: string[] }[] = [];
  const portalInnerMaps = new Map<string, string>();
  for (const n of sortedRegular) {
    const isPortal = n.type === "file" && (n as AnyRec).portal === true;
    if (isPortal && ctx.opts.portals === "inline" && ctx.opts.resolveCanvas && ctx.depth < (ctx.opts.portalDepth ?? 1)) {
      const file = n.file ?? "";
      if (ctx.visited.has(file)) { dropped.push(`portal cycle skipped: ${file}`); }
      else {
        const inner = ctx.opts.resolveCanvas(file);
        if (inner) {
          const pSlug = slugify(file.replace(/\.canvas$/i, "").split("/").pop() ?? "portal");
          const pfx = `${prefix ? prefix + "_" : ""}portal_${pSlug}`;
          const subCtx: Ctx = { ...ctx, depth: ctx.depth + 1, visited: new Set([...ctx.visited, file]) };
          const innerSrc = canvasToMermaidInner(inner, subCtx, pfx);
          const all = innerSrc.source.split("\n");
          const hi = all.findIndex(l => /^(flowchart|stateDiagram-v2|mindmap)/.test(l));
          // linkStyle indices count the inner diagram's edges only: drop them.
          const body = all.slice(hi + 1).filter(l => l.trim() && !l.startsWith("%%") && !/^\s*linkStyle\b/.test(l));
          if (all.some(l => /^\s*linkStyle\b/.test(l))) dropped.push(`portal ${file}: inner edge styles dropped`);
          for (const [cid, mid] of computeMidMap(inner, pfx)) portalInnerMaps.set(cid, mid);
          portalSubgraphs.push({ header: `subgraph portal_${pSlug}["${escLabel((file.split("/").pop() ?? file), ctx.mehrpele)}"]`, lines: body });
          continue;
        } else dropped.push(`portal unresolved: ${file}`);
      }
    }
    const mid = assign(n.id, candidateId(n));
    let label: string;
    let shape: string | undefined;
    if (n.type === "file") label = fileLabel(n, ctx.scale);
    else if (n.type === "link") label = webLabel(n, ctx) ?? String((n as AnyRec).peleLabel as string | undefined ?? n.url ?? ""); // view-nodes
    else { label = folderLabel(n) ?? ((n.text ?? "").replace(/\s+$/g, "") || " "); shape = shapeOf((n as AnyRec).peleShape as string | undefined, n.styleAttributes?.shape); } // view-nodes: folderLabel
    if (n.type !== "text") shape = (n as AnyRec).peleShape as string | undefined;
    outNodes.push({ canvasId: n.id, mid, node: n, label, shape, parentGroup: groupOf.get(n.id) });
  }
  const edges = (canvas.edges ?? []).filter(e => !String(e.id).startsWith("acportal||"));
  return { nodes: outNodes, edges, groups, nodeGroup: groupOf, groupParent, portalSubgraphs, portalInnerMaps };
}

interface EdgeOut { e: CanvasEdge; f: string; t: string; reversed: boolean }
/** Mermaid arrow for an edge (Mermaid has no one-sided reverse arrow: the caller swaps those). */
function edgeOp(e: CanvasEdge, reversed: boolean): string {
  const pet = (e as AnyRec).peleEdgeType as string | undefined;
  const pst = (e as AnyRec).peleStroke as string | undefined;
  const path = e.styleAttributes?.path; const arrowA = e.styleAttributes?.arrow;
  const dotted = pst === "dotted" || path === "dotted";
  const thick = pst === "thick";
  const toArrow = reversed ? e.fromEnd === "arrow" : e.toEnd !== "none";
  const fromArrow = reversed ? e.toEnd !== "none" : e.fromEnd === "arrow";
  const line = thick ? "==" : dotted ? "-.-" : "--";
  if (pet === "double_arrow_circle") return thick ? "o==o" : dotted ? "o-.-o" : "o--o";
  if (pet === "double_arrow_cross") return thick ? "x==x" : dotted ? "x-.-x" : "x--x";
  if (pet === "arrow_circle" || (toArrow && !fromArrow && (arrowA === "circle" || arrowA === "circle-outline"))) return thick ? "==o" : dotted ? "-.-o" : "--o";
  if (pet === "arrow_cross" || (toArrow && !fromArrow && arrowA === "blunt")) return thick ? "==x" : dotted ? "-.-x" : "--x";
  if (fromArrow && toArrow) return thick ? "<==>" : dotted ? "<-.->" : "<-->";
  if (!toArrow) return thick ? "===" : dotted ? "-.-" : "---";
  return line === "--" ? "-->" : line === "==" ? "==>" : "-.->";
}
function edgeSyntax(o: EdgeOut, mehrpele: boolean): string {
  const base = edgeOp(o.e, o.reversed);
  const label = o.e.label ?? "";
  if (!label) return base;
  const needsQ = mehrpele || /[|"]/.test(label) || label.includes("[[") || label.includes("**");
  return needsQ ? `${base}|"${escLabel(label, mehrpele)}"|` : `${base}|${label}|`;
}

function inferDirection(canvas: CanvasData, edges?: CanvasEdge[], only?: Set<string>): string {
  const byId = new Map((canvas.nodes ?? []).map(n => [n.id, n]));
  let sx = 0, sy = 0, count = 0;
  for (const e of edges ?? canvas.edges ?? []) {
    if (only && (!only.has(e.fromNode) || !only.has(e.toNode))) continue;
    const a = byId.get(e.fromNode), b = byId.get(e.toNode); if (!a || !b) continue;
    let dx = (b.x + b.width / 2) - (a.x + a.width / 2), dy = (b.y + b.height / 2) - (a.y + a.height / 2);
    // Sides say how the edge runs when the geometry is ambiguous.
    if (e.fromSide === "right" || e.fromSide === "left") dx *= 1.5; else if (e.fromSide) dy *= 1.5;
    sx += dx; sy += dy; count++;
  }
  if (!count) return "TD";
  if (Math.abs(sy) >= Math.abs(sx)) return sy >= 0 ? "TD" : "BT";
  return sx >= 0 ? "LR" : "RL";
}

function canvasToMermaidInner(canvas: CanvasData, ctx: Ctx, prefix: string): FromCanvasResult {
  const dropped = ctx.dropped; const opts = ctx.opts;
  const metaPele: PeleMeta | undefined = (canvas.metadata as { pele?: PeleMeta } | undefined)?.pele;
  const allNodes = canvas.nodes ?? [];
  if (metaPele?.fidelity === "embed" && allNodes.length === 1 && allNodes[0].type === "text" && (allNodes[0].text ?? "").includes("```mermaid")) {
    const t = allNodes[0].text ?? ""; const start = t.indexOf("```mermaid\n");
    if (start >= 0) { const rest = t.slice(start + "```mermaid\n".length); const end = rest.indexOf("\n```"); if (end >= 0) return { source: rest.slice(0, end), type: metaPele.type ?? "flowchart", dropped, mehrpele: false }; }
  }
  const provType: string | undefined = opts.includeProvenance === false ? undefined : metaPele?.type;
  const isState = provType === "state";
  const isMindCandidate = provType === "mindmap";
  // Markdown labels: forced, or whatever the cards need.
  if (ctx.depth === 0 && !prefix) {
    const needs = !isState && !isMindCandidate && allNodes.some(n => (n.type === "file" && !((n as AnyRec).portal === true && opts.portals === "inline" && opts.resolveCanvas)) || (n.type === "text" && labelNeedsMarkdown(n.text ?? "")) || (n.type === "link" && (labelNeedsMarkdown(String((n as AnyRec).peleLabel as string | undefined ?? "")) || webLabel(n, ctx) !== null)) || (n.type === "group" && labelNeedsMarkdown(n.label ?? "")))
      || (canvas.edges ?? []).some(e => labelNeedsMarkdown(e.label ?? ""));
    ctx.mehrpele = opts.mehrpele ?? needs;
  }
  const mehrpele = ctx.mehrpele;
  const built = buildGraph(canvas, ctx, prefix);
  const { nodes: outNodes, groups } = built;
  const midByCanvas = new Map(outNodes.map(n => [n.canvasId, n.mid]));
  const portalFileNodes = allNodes.filter(n => n.type === "file" && (n as AnyRec).portal);
  const groupMid = new Map<string, string>();
  const usedG = new Map<string, number>();
  for (const m of outNodes) usedG.set(m.mid, 1);
  for (const g of [...groups].sort((a, b) => (a.y - b.y) || (a.x - b.x) || cmp(a.id, b.id))) {
    const pid = (g as AnyRec).peleId as string | undefined;
    let base = pid && isValidMermaidId(pid) ? pid : safeId(slugify(g.label || "group"));
    if (prefix) base = `${prefix}_${base}`;
    const n = (usedG.get(base) ?? 0) + 1; usedG.set(base, n); groupMid.set(g.id, n === 1 ? base : `${base}_${n}`);
  }
  for (const [gid, gm] of groupMid) if (!midByCanvas.has(gid)) midByCanvas.set(gid, gm);
  for (const [cid, mid] of built.portalInnerMaps) if (!midByCanvas.has(cid)) midByCanvas.set(cid, mid);

  let type = "flowchart"; let header = "";
  if (isState) { type = "state"; header = "stateDiagram-v2"; }
  else if (isMindCandidate) {
    const childCount = new Map<string, number>(); let ok = outNodes.length > 0;
    for (const e of built.edges) { if (midByCanvas.has(e.fromNode) && midByCanvas.has(e.toNode)) childCount.set(e.toNode, (childCount.get(e.toNode) ?? 0) + 1); }
    if ([...childCount.values()].some(v => v > 1)) ok = false;
    if (ok) { type = "mindmap"; header = "mindmap"; } else { type = "flowchart"; }
  }
  let dir = "TD";
  if (type === "flowchart") {
    dir = !opts.direction || opts.direction === "auto" ? (provType && metaPele?.direction ? String(metaPele.direction).replace("TB", "TD") : inferDirection(canvas)) : opts.direction;
    header = `flowchart ${dir}`;
  }
  const vertical = dir === "TD" || dir === "BT";
  // Declaration order follows the canvas along the cross axis, so Pele's
  // ordering within a rank resembles it.
  const geoCmp = (a: { x: number; y: number; id: string }, b: { x: number; y: number; id: string }) =>
    type === "flowchart" && !vertical ? (a.x - b.x) || (a.y - b.y) || cmp(a.id, b.id) : (a.y - b.y) || (a.x - b.x) || cmp(a.id, b.id);

  const defLine = (o: OutNode): string => {
    const n = o.node;
    if (type === "state") {
      if ((n as AnyRec).peleKind === "stateStart" || (n as AnyRec).peleKind === "stateEnd") return "";
      if (o.label && o.label !== o.mid) return `  state "${escLabel(o.label, false)}" as ${o.mid}`;
      return `  ${o.mid}`;
    }
    if (type === "mindmap") return o.label;
    return `  ${shapeSyntax(o.mid, o.label, o.shape, mehrpele)}`;
  };

  // edges: endpoints, Mermaid order (by declaration order of their nodes)
  const allEdgesPre: CanvasEdge[] = [...built.edges];
  const edgePortalOwner = new Map<string, string>();
  for (const pn of portalFileNodes) for (const ie of (pn.interdimensionalEdges ?? [])) { allEdgesPre.push(ie); edgePortalOwner.set(ie.id, pn.id); }
  const resolveMid = (e: CanvasEdge, cid: string): string | undefined => midByCanvas.get(cid) ?? (edgePortalOwner.has(e.id) ? midByCanvas.get(edgePortalOwner.get(e.id)!) : undefined);
  const rank = new Map<string, number>();
  [...outNodes.map(o => ({ x: o.node.x, y: o.node.y, id: o.mid })), ...groups.map(g => ({ x: g.x, y: g.y, id: groupMid.get(g.id)! }))].sort(geoCmp).forEach((n, i) => rank.set(n.id, i));
  const mappedPre: EdgeOut[] = [];
  for (const e of allEdgesPre) {
    const f = resolveMid(e, e.fromNode), t = resolveMid(e, e.toNode);
    if (!f || !t) { dropped.push(edgePortalOwner.has(e.id) ? `edge ${e.id} dropped (portal endpoint not expanded)` : `edge ${e.id} dropped (missing endpoint)`); continue; }
    // `<--` does not exist in Mermaid: an edge with only a start arrow is written reversed.
    const reversed = type === "flowchart" && e.fromEnd === "arrow" && e.toEnd === "none";
    mappedPre.push(reversed ? { e, f: t, t: f, reversed } : { e, f, t, reversed });
  }
  mappedPre.sort((a, b) => ((rank.get(a.f) ?? 1e9) - (rank.get(b.f) ?? 1e9)) || ((rank.get(a.t) ?? 1e9) - (rank.get(b.t) ?? 1e9)) || cmp(a.e.label ?? "", b.e.label ?? "") || cmp(a.e.id, b.e.id));
  const edgeLines: string[] = [];
  const flowEdges: EdgeOut[] = [];
  const stateInner = new Map<string, string[]>();
  for (const o of mappedPre) {
    const { e, f, t } = o;
    if (type === "state") {
      const fromN = allNodes.find(n => n.id === e.fromNode); const toN = allNodes.find(n => n.id === e.toNode);
      const fm = (fromN as AnyRec)?.peleKind === "stateStart" || (fromN as AnyRec)?.peleKind === "stateEnd" ? "[*]" : f;
      const tm = (toN as AnyRec)?.peleKind === "stateStart" || (toN as AnyRec)?.peleKind === "stateEnd" ? "[*]" : t;
      const line = e.label ? `  ${fm} --> ${tm} : ${e.label}` : `  ${fm} --> ${tm}`;
      const fg = built.nodeGroup.get(e.fromNode); const tg = built.nodeGroup.get(e.toNode);
      const innerGroup = fg && fg === tg ? fg : undefined;
      if (innerGroup) (stateInner.get(innerGroup) ?? stateInner.set(innerGroup, []).get(innerGroup)!).push(line); else edgeLines.push(line);
    } else if (type === "mindmap") { /* tree encodes */ }
    else { edgeLines.push(`  ${f} ${edgeSyntax(o, mehrpele)} ${t}`); flowEdges.push(o); }
  }

  let bodyLines: string[] = [];
  if (type === "mindmap") {
    const children = new Map<string, string[]>(); const hasParent = new Set<string>();
    for (const e of built.edges) { if (midByCanvas.has(e.fromNode) && midByCanvas.has(e.toNode)) { const f = midByCanvas.get(e.fromNode)!, t = midByCanvas.get(e.toNode)!; (children.get(f) ?? children.set(f, []).get(f)!).push(t); hasParent.add(t); } }
    const byMid = new Map(outNodes.map(o => [o.mid, o]));
    const roots = outNodes.filter(o => !hasParent.has(o.mid)).sort((a, b) => (a.node.y - b.node.y) || (a.node.x - b.node.x));
    const emit = (mid: string, depth: number, seen: Set<string>) => {
      if (seen.has(mid)) return; seen.add(mid); const o = byMid.get(mid)!; const indent = "  ".repeat(depth + 1);
      const lbl = o.label.trim().replace(/\n/g, " ");
      if (depth === 0 && ((o.node as AnyRec).peleShape === "circle" || o.node.styleAttributes?.shape === "circle")) bodyLines.push(`${indent}${mid}((${lbl}))`);
      else bodyLines.push(`${indent}${lbl || mid}`);
      for (const c of (children.get(mid) ?? [])) emit(c, depth + 1, seen);
    };
    for (const r of roots) emit(r.mid, 0, new Set());
  } else {
    const groupChildrenNodes = new Map<string, OutNode[]>(); const topNodes: OutNode[] = [];
    for (const o of outNodes) { if (o.parentGroup && groupMid.has(o.parentGroup)) { (groupChildrenNodes.get(o.parentGroup) ?? groupChildrenNodes.set(o.parentGroup, []).get(o.parentGroup)!).push(o); } else topNodes.push(o); }
    const childGroups = new Map<string, CanvasNode[]>(); const topGroups: CanvasNode[] = [];
    for (const g of groups) { const parent = built.groupParent.get(g.id); if (parent) (childGroups.get(parent) ?? childGroups.set(parent, []).get(parent)!).push(g); else topGroups.push(g); }
    const sortNodes = (arr: OutNode[]) => [...arr].sort((a, b) => geoCmp({ x: a.node.x, y: a.node.y, id: a.canvasId }, { x: b.node.x, y: b.node.y, id: b.canvasId }));
    const sortGroups = (arr: CanvasNode[]) => [...arr].sort((a, b) => geoCmp({ x: a.x, y: a.y, id: a.id }, { x: b.x, y: b.y, id: b.id }));
    const hasContent = (g: CanvasNode): boolean => !!(groupChildrenNodes.get(g.id)?.length || (childGroups.get(g.id) ?? []).some(hasContent) || (g as AnyRec).peleId || allEdgesPre.some(e => e.fromNode === g.id || e.toNode === g.id));
    const groupDirection = (g: CanvasNode): string | undefined => {
      const pd = (g as AnyRec).peleDir as string | undefined;
      if (pd) return pd;
      if ((g as AnyRec).peleId || type !== "flowchart") return undefined;
      const members = new Set<string>(); const collect = (x: CanvasNode) => { for (const o of groupChildrenNodes.get(x.id) ?? []) members.add(o.canvasId); for (const c of childGroups.get(x.id) ?? []) collect(c); }; collect(g);
      const inner = built.edges.filter(e => members.has(e.fromNode) && members.has(e.toNode));
      if (!inner.length) return undefined;
      const d = inferDirection(canvas, inner, members);
      return d !== dir ? d : undefined;
    };
    const emitGroup = (g: CanvasNode, indent: string): string[] => {
      const gm = groupMid.get(g.id)!; const title = g.label ?? gm;
      if (type === "state") {
        const out: string[] = [`${indent}state ${gm} {`];
        for (const o of sortNodes(groupChildrenNodes.get(g.id) ?? [])) { const d = defLine(o); if (d) out.push(indent + d); }
        for (const l of stateInner.get(g.id) ?? []) out.push(indent + l);
        for (const cg of sortGroups(childGroups.get(g.id) ?? [])) out.push(...emitGroup(cg, indent + "  "));
        out.push(`${indent}}`);
        return out;
      }
      const out: string[] = [`${indent}subgraph ${gm}["${escLabel(title, mehrpele)}"]`];
      const gd = groupDirection(g); if (gd) out.push(`${indent}  direction ${gd === "TD" ? "TB" : gd}`);
      for (const o of sortNodes(groupChildrenNodes.get(g.id) ?? [])) { const d = defLine(o); if (d) out.push(indent + d); }
      for (const cg of sortGroups(childGroups.get(g.id) ?? [])) if (hasContent(cg)) out.push(...emitGroup(cg, indent + "  ")); else for (const o of sortNodes(groupChildrenNodes.get(cg.id) ?? [])) { const d = defLine(o); if (d) out.push(indent + d); }
      out.push(`${indent}end`);
      return out;
    };
    const emitTopGroups = topGroups.filter(hasContent);
    for (const g of groups) if (!hasContent(g)) dropped.push(`empty group ${g.id} dropped`);
    for (const o of sortNodes(topNodes)) { const d = defLine(o); if (d) bodyLines.push(d); }
    for (const g of sortGroups(emitTopGroups)) bodyLines.push(...emitGroup(g, "  "));
    for (const ps of built.portalSubgraphs) { bodyLines.push(`  ${ps.header}`); for (const l of ps.lines) bodyLines.push(l.startsWith("  ") ? "  " + l : "    " + l); bodyLines.push(`  end`); }
  }

  // classes, styles, colours, clicks
  const classLines: string[] = [];
  const cds: NonNullable<PeleMeta["classDefs"]> = metaPele?.classDefs ?? {};
  const noAc = metaPele?.advancedCanvas === false;
  const classDefMap: ClassDefs = new Map(Object.entries(cds).map(([k, v]) => [k, { styles: v.styles ?? [] }]));
  if (type === "flowchart") {
    const usedClasses = new Map<string, string[]>();
    const styleLines: string[] = [];
    const presetsUsed = new Set<string>();
    const styleOf = (mid: string, n: CanvasNode, group = false) => {
      const a = n as AnyRec;
      let classes: string[] = ((a.peleClasses ?? []) as string[]).filter(c => c !== "clickable");
      let styles: string[] = [...((a.peleStyles ?? []) as string[])];
      const derived = colourOf(classes, styles, classDefMap).color;
      if ((n.color ?? undefined) !== derived) {
        classes = classes.filter(c => !presetOfClass(c));
        styles = withoutDecls(styles, ["fill", "stroke"]);
        // Pele draws no classes on clusters: a group's preset is its tinted fallback.
        if (isPreset(n.color) && group) styles.push(...tintStyles(presetHex(n.color!)!));
        else if (isPreset(n.color)) { classes.push(presetClass(n.color!)); presetsUsed.add(n.color!); }
        else if (n.color) { const hx = normalizeHex(n.color); if (hx) styles.push(...tintStyles(hx)); }
      } else for (const c of classes) { const p = presetOfClass(c); if (p) presetsUsed.add(p); }
      const border = n.styleAttributes?.border ?? undefined;
      // A canvas written without Advanced Canvas has no styleAttributes to compare.
      if (!noAc && border !== borderOf(styles)) {
        styles = withoutDecls(styles, ["stroke-dasharray"]);
        if (border === "dashed" || border === "dotted") styles.push(`stroke-dasharray:${DASH.node[border]}`);
        else if (border === "invisible") { styles = withoutDecls(styles, ["fill", "stroke"]); styles.push("fill:none", "stroke:none"); }
      }
      for (const c of classes) (usedClasses.get(c) ?? usedClasses.set(c, []).get(c)!).push(mid);
      if (styles.length) styleLines.push(`  style ${mid} ${styles.join(",")}`);
    };
    for (const o of [...outNodes].sort((a, b) => cmp(a.mid, b.mid))) styleOf(o.mid, o.node);
    for (const g of [...groups].sort((a, b) => cmp(groupMid.get(a.id) ?? "", groupMid.get(b.id) ?? ""))) if (hasGroupLine(bodyLines, groupMid.get(g.id)!)) styleOf(groupMid.get(g.id)!, g, true);
    for (const name of Object.keys(cds).sort()) { const cd = cds[name]; classLines.push(`  classDef ${name} ${[...(cd.styles ?? []), ...(cd.textStyles ?? []).map((s: string) => "color:" + s)].join(",")}`.replace(/ $/, "")); }
    for (const l of presetClassDefs([...presetsUsed].filter(p => !(presetClass(p) in cds)))) classLines.push(`  ${l}`);
    for (const name of [...usedClasses.keys()].sort()) classLines.push(`  class ${[...new Set(usedClasses.get(name))].sort().join(",")} ${name}`);
    classLines.push(...styleLines);
    for (const o of [...outNodes].sort((a, b) => cmp(a.mid, b.mid))) {
      // view-nodes: a web-view node shows the page itself, no click line.
      const link = o.node.type === "link" ? (parseWebEmbedLabel(o.label) ? undefined : o.node.url) : (o.node as AnyRec).peleLink as string | undefined;
      const tip = (o.node as AnyRec).peleTooltip as string | undefined;
      if (link) classLines.push(`  click ${o.mid} "${escLabel(link, false)}"${tip ? ` "${escLabel(tip, false)}"` : ""}`);
    }
    for (const o of outNodes) { if (o.node.styleAttributes?.border && o.node.type !== "text" && o.node.type !== "file" && o.node.type !== "link") dropped.push(`node ${o.canvasId} border ${o.node.styleAttributes.border} dropped (no Mermaid equivalent)`); }
  }

  // linkStyle: edge colours and dashes (indices count every edge Pele parses)
  const linkLines: string[] = [];
  const edgeStyleOf = (o: EdgeOut): string[] => {
    const e = o.e; const a = e as AnyRec;
    let styles: string[] = [...((a.peleStyles ?? []) as string[])];
    const derived = edgeColourOf([], styles, classDefMap);
    if ((e.color ?? undefined) !== derived) {
      styles = withoutDecls(styles, ["stroke"]);
      if (isPreset(e.color)) styles.unshift(`stroke:${presetHex(e.color!)}`);
      else if (e.color) { const hx = normalizeHex(e.color); if (hx) styles.unshift(`stroke:${hx}`); }
    }
    const path = e.styleAttributes?.path ?? undefined;
    const pst = a.peleStroke as string | undefined;
    const want = (path === "short-dashed" || path === "long-dashed") && pst !== "dotted" ? path : undefined;
    if (!noAc && want !== edgeDashOf(styles)) { styles = withoutDecls(styles, ["stroke-dasharray"]); if (want) styles.push(`stroke-dasharray:${DASH.edge[want]}`); }
    return styles;
  };

  const sizeLineFor = (b: string) => ctx.depth === 0 && !prefix && (type === "flowchart" || type === "state")
    ? canvasSizeDirective(b, outNodes, ctx.scale, priorNodeSizes(metaPele)) : "";
  let body = [header, ...bodyLines, ...edgeLines, ...classLines].join("\n");
  let parsed: FlowModel | null = null;
  if (type === "flowchart") {
    try { parsed = parse(shieldQuotes(body)) as FlowModel; } catch { parsed = null; }
    if (parsed && flowEdges.length) {
      const offset = (parsed.edges?.length ?? 0) - flowEdges.length;
      const byStyle = new Map<string, number[]>();
      flowEdges.forEach((o, i) => { const s = edgeStyleOf(o); if (s.length) { const k = s.join(","); (byStyle.get(k) ?? byStyle.set(k, []).get(k)!).push(offset + i); } });
      for (const [s, idx] of [...byStyle].sort((p, q) => p[1][0] - q[1][0])) linkLines.push(`  linkStyle ${idx.join(",")} ${s}`);
      if (linkLines.length) body = [body, ...linkLines].join("\n");
    }
  }
  // Cards sized unlike their natural box → `%% pele-size … %%`, last line (top level only).
  const sizeLine = sizeLineFor(body);
  const sizes = sizeLine ? parseSizeDirective(sizeLine) : new Map<string, NodeSize>();

  // edge keys in Mermaid order (pele-pos ports, provenance)
  const edgeKeys = new Map<CanvasEdge, string>();
  const keyCount = new Map<string, number>();
  const modelEdges: FlowEdge[] = parsed?.edges ?? [];
  const offset = modelEdges.length - flowEdges.length;
  if (type === "flowchart") {
    for (let i = 0; i < modelEdges.length; i++) {
      const me = modelEdges[i]; const kk = `${me.start}>${me.end}`; const n = (keyCount.get(kk) ?? 0) + 1; keyCount.set(kk, n);
      const o = flowEdges[i - offset]; if (o && i >= offset) edgeKeys.set(o.e, edgeKey(me.start, me.end, n));
    }
    if (!parsed) { const kc = new Map<string, number>(); for (const o of flowEdges) { const kk = `${o.f}>${o.t}`; const n = (kc.get(kk) ?? 0) + 1; kc.set(kk, n); edgeKeys.set(o.e, edgeKey(o.f, o.t, n)); } }
  }

  // canvas layout directives
  const layoutLines: string[] = [];
  if (opts.layout === "canvas" && type === "flowchart" && ctx.depth === 0 && !prefix) {
    const pos = new Map<string, PinnedBox>();
    const s = ctx.scale;
    for (const o of [...outNodes].sort((a, b) => cmp(a.mid, b.mid))) pos.set(o.mid, { x: (o.node.x + o.node.width / 2) / s, y: (o.node.y + o.node.height / 2) / s });
    for (const g of [...groups].sort((a, b) => cmp(groupMid.get(a.id) ?? "", groupMid.get(b.id) ?? ""))) { const gm = groupMid.get(g.id)!; if (hasGroupLine(bodyLines, gm)) pos.set(gm, { x: (g.x + g.width / 2) / s, y: (g.y + g.height / 2) / s, w: g.width / s, h: g.height / s }); }
    const ports = new Map<string, EdgePorts>();
    for (const o of flowEdges) {
      const k = edgeKeys.get(o.e); if (!k) continue;
      const fs = o.e.fromFloating ? undefined : o.e.fromSide, ts = o.e.toFloating ? undefined : o.e.toSide;
      const p: EdgePorts = o.reversed ? { from: ts, to: fs } : { from: fs, to: ts };
      if (p.from || p.to) ports.set(k, p);
    }
    layoutLines.push("%% pele-layout canvas %%");
    const pl = formatPosDirective(pos, ports); if (pl) layoutLines.push(pl);
  }

  // provenance line
  // view-nodes: attached views, under the ids the nodes have now.
  const viewLine = ctx.depth === 0 && !prefix
    ? formatViewLine([...outNodes].flatMap((o) => (((o.node as AnyRec).peleViews as string[] | undefined) ?? []).map((v): [string, string] => [o.mid, v])))
    : "";
  const tail = [...layoutLines, ...(dropped.length && ctx.depth === 0 ? [`%% pele: dropped ${dropped.join("; ")}`] : []), ...(sizeLine ? [sizeLine] : []), ...(viewLine ? [viewLine] : [])];
  if (opts.includeProvenance === false || ctx.depth > 0 || prefix) return { source: [body, ...tail].join("\n") + "\n", type, dropped, mehrpele };
  const modelNodes: Map<string, FlowNode> = parsed?.nodes instanceof Map ? parsed.nodes : new Map<string, FlowNode>();
  // No sourceHash: the line carries the geometry itself, and a hash of the
  // previous source would change on every round trip.
  const prov: Provenance = { schema: 2, type, direction: type === "flowchart" ? dir : undefined, scale: ctx.scale, layout: opts.layout === "canvas" && type === "flowchart" ? "canvas" : undefined, nodes: new Map(), groups: new Map(), edges: new Map() };
  // Canvas metadata other than what mermaidToCanvas writes anyway (frontmatter, …).
  const meta = { ...((canvas.metadata as AnyRec) ?? {}) }; delete meta.pele; delete meta.version;
  if (JSON.stringify(meta.frontmatter) === JSON.stringify({ tags: ["pele-diagram"] })) delete meta.frontmatter;
  if (metaPele) delete meta.startNode;
  if (Object.keys(meta).length) prov.meta = meta;
  for (const o of [...outNodes].sort((a, b) => cmp(a.mid, b.mid))) {
    const pb: ProvBox = { canvasId: o.canvasId, x: o.node.x, y: o.node.y, w: o.node.width, h: o.node.height };
    const mn = modelNodes.get(o.mid);
    if (mn) pb.sig = nodeSig(labelText(mn.text ?? o.mid), mn.type, sizes.get(o.mid));
    // Every style attribute is kept: without Advanced Canvas on the way back they are not re-derived.
    const keep = keepOf(o.node, NODE_CORE, () => false); if (keep) pb.keep = keep;
    prov.nodes.set(o.mid, pb);
  }
  for (const g of [...groups].sort((a, b) => cmp(groupMid.get(a.id) ?? "", groupMid.get(b.id) ?? ""))) {
    const gm = groupMid.get(g.id); if (!gm) continue;
    const pb: ProvBox = { canvasId: g.id, x: g.x, y: g.y, w: g.width, h: g.height };
    const keep = keepOf(g, NODE_CORE, () => false); if (keep) pb.keep = keep;
    prov.groups.set(gm, pb);
  }
  if (type === "flowchart") for (const o of flowEdges) {
    const k = edgeKeys.get(o.e); if (!k) continue;
    const me = parsed ? modelEdges[flowEdges.indexOf(o) + offset] : undefined;
    const pe: ProvEdge = { id: o.e.id };
    if (o.e.fromSide) pe[o.reversed ? "toSide" : "fromSide"] = o.e.fromSide;
    if (o.e.toSide) pe[o.reversed ? "fromSide" : "toSide"] = o.e.toSide;
    if (me) pe.t = `${me.type}/${me.stroke}`;
    const keep: AnyRec = keepOf(o.e, EDGE_CORE, () => false) ?? {};
    if (o.reversed) keep.peleReversed = true;
    // Ends the canvas leaves implicit (fromEnd none, toEnd arrow) stay implicit.
    const implicit = `${o.e.fromEnd === undefined ? "f" : ""}${o.e.toEnd === undefined ? "t" : ""}`;
    if (implicit) pe.e = implicit;
    if (Object.keys(keep).length) pe.keep = keep;
    prov.edges.set(k, pe);
  }
  return { source: `${formatProvenance(prov)}\n${[body, ...tail].join("\n")}\n`, type, dropped, mehrpele };
}

function hasGroupLine(lines: string[], gm: string): boolean {
  return lines.some(l => l.trimStart().startsWith(`subgraph ${gm}[`));
}

export function canvasToMermaid(canvas: CanvasData, opts: FromCanvasOptions = {}): FromCanvasResult {
  const metaScale = Number(((canvas.metadata as AnyRec)?.pele as AnyRec | undefined)?.scale);
  const scale = opts.scale ?? (metaScale > 0 ? metaScale : 1);
  const ctx: Ctx = { dropped: [], opts: { ...opts, portals: opts.portals ?? "link", portalDepth: opts.portalDepth ?? 1 }, depth: 0, visited: new Set(), scale, mehrpele: opts.mehrpele ?? false };
  return canvasToMermaidInner(canvas, ctx, "");
}
