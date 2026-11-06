// ---------- Canvas -> Mermaid ----------
import { parse } from "../pele.js";
import { parseSizeDirective, type NodeSize } from "../node-size/index.js";
import { slugify } from "./ids.js";
import { DASH, isPreset, presetClass, presetClassDefs, presetHex, presetOfClass, tintStyles } from "./palette.js";
import { embedNodeBox, embedSizeForCard, formatEmbedLabel, isImageFile, parseEmbedLabel } from "./embed.js";
import { formatWebEmbedLabel, parseWebEmbedLabel, webNodeBox } from "./web.js"; // view-nodes
import { formatViewLine } from "./views.js"; // view-nodes
import { folderBaseBlock, parseFolderLabel } from "./folder.js"; // view-nodes
import { edgeKey, formatPosDirective, type EdgePorts, type PinnedBox } from "../layout/directive.js";
import { formatProvenance, type ProvBox, type ProvEdge, type Provenance } from "./provenance.js";
import type { CanvasData, CanvasEdge, FromCanvasOptions, FromCanvasResult, OutNode, PeleCanvasEdge, PeleCanvasNode } from "./types.js";
import { cmp, pushTo, type AnyRec, type FlowEdge, type FlowModel, type FlowNode, type PeleMeta } from "./util.js";
import { borderOf, colourOf, edgeColourOf, edgeDashOf, normalizeHex, withoutDecls, type ClassDefs } from "./style.js";
import { labelText, nodeSig, shieldQuotes } from "./labels.js";
import { EDGE_CORE, keepOf, NODE_CORE } from "./keep.js";
import { canvasSizeDirective, priorNodeSizes } from "./size.js";

// Mermaid keywords are lowercase (`End` is a fine id, `end` is not).
export const KEYWORDS = new Set(["flowchart","graph","subgraph","end","class","classDef","classdef","style","click","direction","state","mindmap","linkStyle","linkstyle","default","call","href","callback","interpolate","accTitle","accDescr","TB","TD","BT","LR","RL"]);
export function isValidMermaidId(s: string): boolean { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !KEYWORDS.has(s); }
/** A slug that is a Mermaid keyword gets a suffix. */
export function safeId(s: string): string { return KEYWORDS.has(s) ? `${s}_node` : s; }
/** Quoted-label escaping: Mehrpele reads `\"`; plain Mermaid/Pele needs `#quot;`. */
export function escLabel(s: string, mehrpele = true): string { return mehrpele ? s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : s.replace(/"/g, "#quot;"); }
export function needsQuote(s: string, mehrpele: boolean): boolean {
  if (mehrpele) return true;
  return /[[\]{}()|#;"<>*`]|^\s|\s$|\n/.test(s) || s.includes("[[") || s.includes("**");
}
/** Whether a label is Markdown that only Mehrpele renders (embeds, links, emphasis, lists, …). */
export function labelNeedsMarkdown(s: string): boolean {
  return /\[\[|\*\*|__|`|\$[^$\s]|\n|~~|==[^=]|<br|\[[^\]]+\]\([^)]+\)|(^|\s)#[A-Za-z][\w/-]*|^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>)/m.test(s) || /(^|[^\w*])\*[^*\s][^*]*\*(?!\w)/.test(s);
}
export const SHAPE_FOR_AC: Record<string, string> = { pill: "stadium", diamond: "diamond", database: "cylinder", "predefined-process": "subroutine", circle: "circle", parallelogram: "lean_right" };
export function shapeOf(rawShape: string | undefined, acShape: string | null | undefined): string | undefined {
  return rawShape ?? (acShape ? SHAPE_FOR_AC[acShape] : undefined);
}
export function shapeSyntax(mermaidId: string, label: string, shape: string | undefined, mehrpele: boolean): string {
  const q = needsQuote(label, mehrpele);
  const L = q ? `"${escLabel(label, mehrpele)}"` : label;
  switch (shape) {
    case "diamond": return `${mermaidId}{${L}}`;
    case "stadium": return `${mermaidId}([${L}])`;
    case "cylinder": return `${mermaidId}[(${L})]`;
    case "subroutine": return `${mermaidId}[[${L}]]`;
    case "circle": return `${mermaidId}((${L}))`;
    case "doublecircle": return `${mermaidId}(((${L})))`;
    case "hexagon": return `${mermaidId}{{${L}}}`;
    case "lean_right": return `${mermaidId}[/${L}/]`;
    case "lean_left": return `${mermaidId}[\\${L}\\]`;
    case "round": return `${mermaidId}(${L})`;
    case "odd": return `${mermaidId}>${L}]`;
    case "trapezoid": return `${mermaidId}[/${L}\\]`;
    case "inv_trapezoid": return `${mermaidId}[\\${L}/]`;
    default: return `${mermaidId}[${L}]`;
  }
}

export function candidateId(n: PeleCanvasNode): string { return safeId(rawCandidateId(n)); }
export function rawCandidateId(n: PeleCanvasNode): string {
  const peleId = n.peleId;
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
export function labelFallbackLine(md: string): string {
  const line = md.split("\n").map(l => l.replace(/^\s*(#{1,6}|[-*+>]|\d+\.)\s+/, "").replace(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, t: string, a?: string) => a ?? t.split("/").pop() ?? t).replace(/[*_`~=$]/g, "").trim()).find(l => l) ?? "";
  return line || "node";
}
/** Canvas id → Mermaid id for a canvas's cards, as buildGraph assigns them (no portal expansion). */
export function computeMermaidIdMap(c: CanvasData, pfx: string): Map<string, string> {
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
export interface Ctx { dropped: string[]; opts: FromCanvasOptions; depth: number; visited: Set<string>; scale: number; mehrpele: boolean }

/** Label for a file card: the original label while the card is unchanged, else an embed sized like the card. */
export function fileLabel(n: PeleCanvasNode, scale: number): string {
  const file = n.file ?? "", sub = n.subpath ?? "";
  const pt = n.peleText;
  if (pt) {
    const e = parseEmbedLabel(pt);
    const box = e ? embedNodeBox(e) : null;
    if (e && e.file === file && e.subpath === sub && (!box || (Math.abs(box.w * scale - n.width) <= 1 && Math.abs(box.h * scale - n.height) <= 1) || !e.embed)) return pt;
  }
  if (n.peleEmbed === false) return formatEmbedLabel({ embed: false, file, subpath: sub, ...(n.peleLabel ? { alias: String(n.peleLabel) } : {}) });
  return formatEmbedLabel({ embed: true, file, subpath: sub, size: embedSizeForCard(n.width, n.height, scale, isImageFile(file)) });
}

/** view-nodes: a text card that came from a folder embed and still holds its generated base. */
export function folderLabel(n: PeleCanvasNode): string | null {
  const pt = n.peleText;
  const spec = pt ? parseFolderLabel(pt) : null;
  return pt && spec && (n.text ?? "").trim() === folderBaseBlock(spec).trim() ? pt : null;
}

/**
 * view-nodes: the web-view label for a link card, or null (a clickable text
 * node). A card that came from a web-view label keeps it (resized to the
 * card); other link cards become web views only with `webNodes`.
 */
export function webLabel(n: PeleCanvasNode, ctx: Ctx): string | null {
  const url = n.url ?? "";
  const pt = n.peleText;
  const prev = pt ? parseWebEmbedLabel(pt) : null;
  const size = embedSizeForCard(n.width, n.height, ctx.scale, false);
  if (pt && prev && prev.url === url) {
    const box = webNodeBox(prev);
    if (Math.abs(box.w * ctx.scale - n.width) <= 1 && Math.abs(box.h * ctx.scale - n.height) <= 1) return pt;
    return formatWebEmbedLabel(url, size, prev.form, prev.alt);
  }
  if (!ctx.opts.webNodes || n.peleLabel !== undefined || !/^https?:\/\//i.test(url)) return null;
  return parseWebEmbedLabel(formatWebEmbedLabel(url, size)) ? formatWebEmbedLabel(url, size) : null;
}

export interface BuiltGraph {
  nodes: OutNode[];
  edges: CanvasEdge[];
  groups: PeleCanvasNode[];
  /** Card canvas id → canvas id of the smallest group containing it. */
  nodeGroup: Map<string, string | undefined>;
  /** Group canvas id → canvas id of the group containing it. */
  groupParent: Map<string, string | undefined>;
  portalSubgraphs: { header: string; lines: string[] }[];
  /** Canvas id → Mermaid id for the cards of inlined portals. */
  portalInnerMaps: Map<string, string>;
}

export function buildGraph(canvas: CanvasData, ctx: Ctx, prefix: string): BuiltGraph {
  const dropped = ctx.dropped;
  const nodesIn: PeleCanvasNode[] = (canvas.nodes ?? []).filter(n => !(typeof n.id === "string" && n.id.startsWith("acportal||")));
  const groups = nodesIn.filter(n => n.type === "group");
  const regular = nodesIn.filter(n => n.type !== "group");
  // containment: smallest enclosing group (1px tolerance for hand-placed cards)
  const inside = (inner: PeleCanvasNode, outer: PeleCanvasNode) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;
  const groupOf = new Map<string, string | undefined>();
  const groupParent = new Map<string, string | undefined>();
  // Equal boxes nest by id (the later id is inside), so cards go to the inner one.
  const sortedGroupsByArea = [...groups].sort((a, b) => a.width * a.height - b.width * b.height || cmp(b.id, a.id));
  for (const n of regular) { let best: PeleCanvasNode | undefined; for (const g of sortedGroupsByArea) if (inside(n, g)) { best = g; break; } groupOf.set(n.id, best?.id); }
  for (const g of groups) { let best: PeleCanvasNode | undefined; for (const o of sortedGroupsByArea) if (o.id !== g.id && o.width * o.height >= g.width * g.height && inside(g, o) && !(o.width * o.height === g.width * g.height && o.id > g.id)) { best = o; break; } groupParent.set(g.id, best?.id); }
  const sortedRegular = [...regular].sort((a, b) => (a.y - b.y) || (a.x - b.x) || cmp(a.id, b.id));
  const used = new Map<string, number>();
  const assign = (candidate: string): string => {
    const n = (used.get(candidate) ?? 0) + 1; used.set(candidate, n);
    const mermaidId = n === 1 ? candidate : `${candidate}_${n}`;
    return prefix ? `${prefix}_${mermaidId}` : mermaidId;
  };
  const outNodes: OutNode[] = [];
  const portalSubgraphs: { header: string; lines: string[] }[] = [];
  const portalInnerMaps = new Map<string, string>();
  for (const n of sortedRegular) {
    const isPortal = n.type === "file" && n.portal === true;
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
          for (const [cid, mermaidId] of computeMermaidIdMap(inner, pfx)) portalInnerMaps.set(cid, mermaidId);
          portalSubgraphs.push({ header: `subgraph portal_${pSlug}["${escLabel((file.split("/").pop() ?? file), ctx.mehrpele)}"]`, lines: body });
          continue;
        } else dropped.push(`portal unresolved: ${file}`);
      }
    }
    const mermaidId = assign(candidateId(n));
    let label: string;
    let shape: string | undefined;
    if (n.type === "file") label = fileLabel(n, ctx.scale);
    else if (n.type === "link") label = webLabel(n, ctx) ?? String(n.peleLabel ?? n.url ?? ""); // view-nodes
    else { label = folderLabel(n) ?? ((n.text ?? "").replace(/\s+$/g, "") || " "); shape = shapeOf(n.peleShape, n.styleAttributes?.shape); } // view-nodes: folderLabel
    if (n.type !== "text") shape = n.peleShape;
    outNodes.push({ canvasId: n.id, mermaidId, node: n, label, shape, parentGroup: groupOf.get(n.id) });
  }
  const edges = (canvas.edges ?? []).filter(e => !String(e.id).startsWith("acportal||"));
  return { nodes: outNodes, edges, groups, nodeGroup: groupOf, groupParent, portalSubgraphs, portalInnerMaps };
}

export interface EdgeOut { e: PeleCanvasEdge; f: string; t: string; reversed: boolean }
/** Mermaid arrow for an edge (Mermaid has no one-sided reverse arrow: the caller swaps those). */
export function edgeOp(e: PeleCanvasEdge, reversed: boolean): string {
  const pet = e.peleEdgeType;
  const pst = e.peleStroke;
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
export function edgeSyntax(o: EdgeOut, mehrpele: boolean): string {
  const base = edgeOp(o.e, o.reversed);
  const label = o.e.label ?? "";
  if (!label) return base;
  const needsQ = mehrpele || /[|"]/.test(label) || label.includes("[[") || label.includes("**");
  return needsQ ? `${base}|"${escLabel(label, mehrpele)}"|` : `${base}|${label}|`;
}

export function inferDirection(canvas: CanvasData, edges?: CanvasEdge[], only?: Set<string>): string {
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

/** A position to order declarations by. */
interface Placed { x: number; y: number; id: string }
/** What every emit phase of one conversion reads. */
interface Emit {
  canvas: CanvasData;
  ctx: Ctx;
  built: BuiltGraph;
  type: string;
  dir: string;
  mehrpele: boolean;
  groupMermaidId: Map<string, string>;
  /** Canvas id → Mermaid id for cards, groups and inlined portal cards. */
  mermaidIdByCanvas: Map<string, string>;
  /** Declaration order: along the cross axis of the flow. */
  geoCmp: (a: Placed, b: Placed) => number;
}
/** Edge styling inputs: classDefs from the canvas metadata, and whether styleAttributes count. */
interface StyleInputs { classDefMap: ClassDefs; noAc: boolean }

export function canvasToMermaidInner(canvas: CanvasData, ctx: Ctx, prefix: string): FromCanvasResult {
  const dropped = ctx.dropped; const opts = ctx.opts;
  const metaPele: PeleMeta | undefined = (canvas.metadata as { pele?: PeleMeta } | undefined)?.pele;
  const embedded = embeddedSource(canvas, metaPele, dropped);
  if (embedded) return embedded;
  const provType: string | undefined = opts.includeProvenance === false ? undefined : metaPele?.type;
  const topLevel = ctx.depth === 0 && !prefix;
  // Markdown labels: forced, or whatever the cards need.
  if (topLevel) ctx.mehrpele = opts.mehrpele ?? needsMarkdown(canvas, ctx, provType === "state" || provType === "mindmap");
  const mehrpele = ctx.mehrpele;
  const built = buildGraph(canvas, ctx, prefix);
  const groupMermaidId = groupMermaidIds(built, prefix);
  const mermaidIdByCanvas = new Map(built.nodes.map(n => [n.canvasId, n.mermaidId]));
  for (const [gid, gm] of groupMermaidId) if (!mermaidIdByCanvas.has(gid)) mermaidIdByCanvas.set(gid, gm);
  for (const [cid, mermaidId] of built.portalInnerMaps) if (!mermaidIdByCanvas.has(cid)) mermaidIdByCanvas.set(cid, mermaidId);
  const { type, header, dir } = diagramKind(canvas, opts, metaPele, provType, built, mermaidIdByCanvas);
  const vertical = dir === "TD" || dir === "BT";
  // Declaration order follows the canvas along the cross axis, so Pele's
  // ordering within a rank resembles it.
  const geoCmp = (a: Placed, b: Placed) =>
    type === "flowchart" && !vertical ? (a.x - b.x) || (a.y - b.y) || cmp(a.id, b.id) : (a.y - b.y) || (a.x - b.x) || cmp(a.id, b.id);
  const em: Emit = { canvas, ctx, built, type, dir, mehrpele, groupMermaidId, mermaidIdByCanvas, geoCmp };

  const { allEdges, mapped } = mapEdges(em);
  const { edgeLines, flowEdges, stateInner } = edgeStatements(em, mapped);
  const bodyLines = type === "mindmap" ? mindmapBody(em) : groupedBody(em, allEdges, stateInner);

  const cds: NonNullable<PeleMeta["classDefs"]> = metaPele?.classDefs ?? {};
  const style: StyleInputs = {
    classDefMap: new Map(Object.entries(cds).map(([k, v]) => [k, { styles: v.styles ?? [] }])),
    noAc: metaPele?.advancedCanvas === false,
  };
  const classLines = type === "flowchart" ? flowchartClassLines(em, bodyLines, cds, style) : [];

  let body = [header, ...bodyLines, ...edgeLines, ...classLines].join("\n");
  let parsed: FlowModel | null = null;
  if (type === "flowchart") {
    try { parsed = parse(shieldQuotes(body)) as FlowModel; } catch { parsed = null; }
    if (parsed && flowEdges.length) {
      const linkLines = linkStyleLines(flowEdges, (parsed.edges?.length ?? 0) - flowEdges.length, style);
      if (linkLines.length) body = [body, ...linkLines].join("\n");
    }
  }
  // Cards sized unlike their natural box → `%% pele-size … %%`, last line (top level only).
  const sizeLine = topLevel && (type === "flowchart" || type === "state") ? canvasSizeDirective(body, built.nodes, ctx.scale, priorNodeSizes(metaPele)) : "";
  const sizes = sizeLine ? parseSizeDirective(sizeLine) : new Map<string, NodeSize>();

  const modelEdges: FlowEdge[] = parsed?.edges ?? [];
  const offset = modelEdges.length - flowEdges.length;
  const edgeKeys = type === "flowchart" ? flowEdgeKeys(flowEdges, parsed ? modelEdges : null, offset) : new Map<PeleCanvasEdge, string>();
  const layoutLines = opts.layout === "canvas" && type === "flowchart" && topLevel ? canvasLayoutLines(em, bodyLines, flowEdges, edgeKeys) : [];

  // view-nodes: attached views, under the ids the nodes have now.
  const viewLine = topLevel
    ? formatViewLine([...built.nodes].flatMap((o) => (o.node.peleViews ?? []).map((v): [string, string] => [o.mermaidId, v])))
    : "";
  const tail = [...layoutLines, ...(dropped.length && ctx.depth === 0 ? [`%% pele: dropped ${dropped.join("; ")}`] : []), ...(sizeLine ? [sizeLine] : []), ...(viewLine ? [viewLine] : [])];
  if (opts.includeProvenance === false || ctx.depth > 0 || prefix) return { source: [body, ...tail].join("\n") + "\n", type, dropped, mehrpele };
  const prov = provenanceOf(em, metaPele, parsed, modelEdges, offset, flowEdges, edgeKeys, sizes);
  return { source: `${formatProvenance(prov)}\n${[body, ...tail].join("\n")}\n`, type, dropped, mehrpele };
}

/** A canvas made by the embed fallback gives back the source it holds; null otherwise. */
function embeddedSource(canvas: CanvasData, metaPele: PeleMeta | undefined, dropped: string[]): FromCanvasResult | null {
  const allNodes = canvas.nodes ?? [];
  const only = allNodes.length === 1 ? allNodes[0] : undefined;
  if (metaPele?.fidelity !== "embed" || !only || only.type !== "text" || !(only.text ?? "").includes("```mermaid")) return null;
  const t = only.text ?? ""; const start = t.indexOf("```mermaid\n");
  if (start < 0) return null;
  const rest = t.slice(start + "```mermaid\n".length); const end = rest.indexOf("\n```");
  return end >= 0 ? { source: rest.slice(0, end), type: metaPele.type ?? "flowchart", dropped, mehrpele: false } : null;
}

/** Whether any card or edge label needs Mehrpele's Markdown (cards are not checked for state/mindmap). */
function needsMarkdown(canvas: CanvasData, ctx: Ctx, skipCards: boolean): boolean {
  const opts = ctx.opts;
  const cardNeeds = (n: PeleCanvasNode) => (n.type === "file" && !(n.portal === true && opts.portals === "inline" && opts.resolveCanvas))
    || (n.type === "text" && labelNeedsMarkdown(n.text ?? ""))
    || (n.type === "link" && (labelNeedsMarkdown(String(n.peleLabel ?? "")) || webLabel(n, ctx) !== null))
    || (n.type === "group" && labelNeedsMarkdown(n.label ?? ""));
  return (!skipCards && (canvas.nodes ?? []).some(cardNeeds)) || (canvas.edges ?? []).some(e => labelNeedsMarkdown(e.label ?? ""));
}

/** Mermaid ids for groups, unique against the card ids, in canvas reading order. */
function groupMermaidIds(built: BuiltGraph, prefix: string): Map<string, string> {
  const groupMermaidId = new Map<string, string>();
  const used = new Map<string, number>();
  for (const m of built.nodes) used.set(m.mermaidId, 1);
  for (const g of [...built.groups].sort((a, b) => (a.y - b.y) || (a.x - b.x) || cmp(a.id, b.id))) {
    const pid = g.peleId;
    let base = pid && isValidMermaidId(pid) ? pid : safeId(slugify(g.label || "group"));
    if (prefix) base = `${prefix}_${base}`;
    const n = (used.get(base) ?? 0) + 1; used.set(base, n); groupMermaidId.set(g.id, n === 1 ? base : `${base}_${n}`);
  }
  return groupMermaidId;
}

/** Diagram type, header line and flow direction (a mindmap canvas that is not a tree becomes a flowchart). */
function diagramKind(canvas: CanvasData, opts: FromCanvasOptions, metaPele: PeleMeta | undefined, provType: string | undefined, built: BuiltGraph, mermaidIdByCanvas: Map<string, string>): { type: string; header: string; dir: string } {
  let type = "flowchart"; let header = "";
  if (provType === "state") { type = "state"; header = "stateDiagram-v2"; }
  else if (provType === "mindmap") {
    const childCount = new Map<string, number>(); let ok = built.nodes.length > 0;
    for (const e of built.edges) { if (mermaidIdByCanvas.has(e.fromNode) && mermaidIdByCanvas.has(e.toNode)) childCount.set(e.toNode, (childCount.get(e.toNode) ?? 0) + 1); }
    if ([...childCount.values()].some(v => v > 1)) ok = false;
    if (ok) { type = "mindmap"; header = "mindmap"; }
  }
  let dir = "TD";
  if (type === "flowchart") {
    dir = !opts.direction || opts.direction === "auto" ? (provType && metaPele?.direction ? String(metaPele.direction).replace("TB", "TD") : inferDirection(canvas)) : opts.direction;
    header = `flowchart ${dir}`;
  }
  return { type, header, dir };
}

/** A card's declaration line ("" for state start/end cards, which edges write as `[*]`). */
function defLine(em: Emit, o: OutNode): string {
  const n = o.node;
  if (em.type === "state") {
    if (isStateTerminal(n)) return "";
    if (o.label && o.label !== o.mermaidId) return `  state "${escLabel(o.label, false)}" as ${o.mermaidId}`;
    return `  ${o.mermaidId}`;
  }
  if (em.type === "mindmap") return o.label;
  return `  ${shapeSyntax(o.mermaidId, o.label, o.shape, em.mehrpele)}`;
}
function isStateTerminal(n: PeleCanvasNode | undefined): boolean {
  return n?.peleKind === "stateStart" || n?.peleKind === "stateEnd";
}

/** Edges (plus inlined portals' interdimensional edges) with Mermaid endpoints, in declaration order of their nodes. */
function mapEdges(em: Emit): { allEdges: PeleCanvasEdge[]; mapped: EdgeOut[] } {
  const { canvas, built, ctx, mermaidIdByCanvas, groupMermaidId } = em;
  const allEdges: PeleCanvasEdge[] = [...built.edges];
  const edgePortalOwner = new Map<string, string>();
  for (const pn of (canvas.nodes ?? []).filter(n => n.type === "file" && n.portal)) for (const ie of (pn.interdimensionalEdges ?? [])) { allEdges.push(ie); edgePortalOwner.set(ie.id, pn.id); }
  const resolve = (e: CanvasEdge, cid: string): string | undefined => {
    const owner = edgePortalOwner.get(e.id);
    return mermaidIdByCanvas.get(cid) ?? (owner !== undefined ? mermaidIdByCanvas.get(owner) : undefined);
  };
  const rank = new Map<string, number>();
  [...built.nodes.map(o => ({ x: o.node.x, y: o.node.y, id: o.mermaidId })), ...built.groups.map(g => ({ x: g.x, y: g.y, id: groupMermaidId.get(g.id)! }))].sort(em.geoCmp).forEach((n, i) => rank.set(n.id, i));
  const mapped: EdgeOut[] = [];
  for (const e of allEdges) {
    const f = resolve(e, e.fromNode), t = resolve(e, e.toNode);
    if (!f || !t) { ctx.dropped.push(edgePortalOwner.has(e.id) ? `edge ${e.id} dropped (portal endpoint not expanded)` : `edge ${e.id} dropped (missing endpoint)`); continue; }
    // `<--` does not exist in Mermaid: an edge with only a start arrow is written reversed.
    const reversed = em.type === "flowchart" && e.fromEnd === "arrow" && e.toEnd === "none";
    mapped.push(reversed ? { e, f: t, t: f, reversed } : { e, f, t, reversed });
  }
  mapped.sort((a, b) => ((rank.get(a.f) ?? 1e9) - (rank.get(b.f) ?? 1e9)) || ((rank.get(a.t) ?? 1e9) - (rank.get(b.t) ?? 1e9)) || cmp(a.e.label ?? "", b.e.label ?? "") || cmp(a.e.id, b.e.id));
  return { allEdges, mapped };
}

/**
 * Edge lines: flowchart arrows, state transitions (those inside one composite
 * state go in its block, under `stateInner`); mindmap edges are the tree itself.
 */
function edgeStatements(em: Emit, mapped: EdgeOut[]): { edgeLines: string[]; flowEdges: EdgeOut[]; stateInner: Map<string, string[]> } {
  const allNodes: PeleCanvasNode[] = em.canvas.nodes ?? [];
  const edgeLines: string[] = [];
  const flowEdges: EdgeOut[] = [];
  const stateInner = new Map<string, string[]>();
  for (const o of mapped) {
    const { e, f, t } = o;
    if (em.type === "state") {
      const fm = isStateTerminal(allNodes.find(n => n.id === e.fromNode)) ? "[*]" : f;
      const tm = isStateTerminal(allNodes.find(n => n.id === e.toNode)) ? "[*]" : t;
      const line = e.label ? `  ${fm} --> ${tm} : ${e.label}` : `  ${fm} --> ${tm}`;
      const fg = em.built.nodeGroup.get(e.fromNode); const tg = em.built.nodeGroup.get(e.toNode);
      const innerGroup = fg && fg === tg ? fg : undefined;
      if (innerGroup) pushTo(stateInner, innerGroup, line); else edgeLines.push(line);
    } else if (em.type !== "mindmap") { edgeLines.push(`  ${f} ${edgeSyntax(o, em.mehrpele)} ${t}`); flowEdges.push(o); }
  }
  return { edgeLines, flowEdges, stateInner };
}

/** Mindmap body: the tree under each root card, indented by depth. */
function mindmapBody(em: Emit): string[] {
  const { built, mermaidIdByCanvas } = em;
  const bodyLines: string[] = [];
  const children = new Map<string, string[]>(); const hasParent = new Set<string>();
  for (const e of built.edges) {
    const f = mermaidIdByCanvas.get(e.fromNode), t = mermaidIdByCanvas.get(e.toNode);
    if (f !== undefined && t !== undefined) { pushTo(children, f, t); hasParent.add(t); }
  }
  const byId = new Map(built.nodes.map(o => [o.mermaidId, o]));
  const roots = built.nodes.filter(o => !hasParent.has(o.mermaidId)).sort((a, b) => (a.node.y - b.node.y) || (a.node.x - b.node.x));
  const emit = (mermaidId: string, depth: number, seen: Set<string>) => {
    if (seen.has(mermaidId)) return; seen.add(mermaidId); const o = byId.get(mermaidId)!; const indent = "  ".repeat(depth + 1);
    const lbl = o.label.trim().replace(/\n/g, " ");
    if (depth === 0 && (o.node.peleShape === "circle" || o.node.styleAttributes?.shape === "circle")) bodyLines.push(`${indent}${mermaidId}((${lbl}))`);
    else bodyLines.push(`${indent}${lbl || mermaidId}`);
    for (const c of (children.get(mermaidId) ?? [])) emit(c, depth + 1, seen);
  };
  for (const r of roots) emit(r.mermaidId, 0, new Set());
  return bodyLines;
}

/** Flowchart/state body: top-level cards, then groups as subgraphs (state: composite states), then inlined portals. */
function groupedBody(em: Emit, allEdges: PeleCanvasEdge[], stateInner: Map<string, string[]>): string[] {
  const { built, groupMermaidId, type, dir, canvas, mehrpele } = em;
  const bodyLines: string[] = [];
  const groupChildrenNodes = new Map<string, OutNode[]>(); const topNodes: OutNode[] = [];
  for (const o of built.nodes) { if (o.parentGroup && groupMermaidId.has(o.parentGroup)) pushTo(groupChildrenNodes, o.parentGroup, o); else topNodes.push(o); }
  const childGroups = new Map<string, PeleCanvasNode[]>(); const topGroups: PeleCanvasNode[] = [];
  for (const g of built.groups) { const parent = built.groupParent.get(g.id); if (parent) pushTo(childGroups, parent, g); else topGroups.push(g); }
  const sortNodes = (arr: OutNode[]) => [...arr].sort((a, b) => em.geoCmp({ x: a.node.x, y: a.node.y, id: a.canvasId }, { x: b.node.x, y: b.node.y, id: b.canvasId }));
  const sortGroups = (arr: PeleCanvasNode[]) => [...arr].sort((a, b) => em.geoCmp({ x: a.x, y: a.y, id: a.id }, { x: b.x, y: b.y, id: b.id }));
  const hasContent = (g: PeleCanvasNode): boolean => !!(groupChildrenNodes.get(g.id)?.length || (childGroups.get(g.id) ?? []).some(hasContent) || g.peleId || allEdges.some(e => e.fromNode === g.id || e.toNode === g.id));
  const groupDirection = (g: PeleCanvasNode): string | undefined => {
    const pd = g.peleDir;
    if (pd) return pd;
    if (g.peleId || type !== "flowchart") return undefined;
    const members = new Set<string>(); const collect = (x: PeleCanvasNode) => { for (const o of groupChildrenNodes.get(x.id) ?? []) members.add(o.canvasId); for (const c of childGroups.get(x.id) ?? []) collect(c); }; collect(g);
    const inner = built.edges.filter(e => members.has(e.fromNode) && members.has(e.toNode));
    if (!inner.length) return undefined;
    const d = inferDirection(canvas, inner, members);
    return d !== dir ? d : undefined;
  };
  const pushDefs = (out: string[], indent: string, nodes: OutNode[] | undefined) => { for (const o of sortNodes(nodes ?? [])) { const d = defLine(em, o); if (d) out.push(indent + d); } };
  const emitGroup = (g: PeleCanvasNode, indent: string): string[] => {
    const gm = groupMermaidId.get(g.id)!; const title = g.label ?? gm;
    if (type === "state") {
      const out: string[] = [`${indent}state ${gm} {`];
      pushDefs(out, indent, groupChildrenNodes.get(g.id));
      for (const l of stateInner.get(g.id) ?? []) out.push(indent + l);
      for (const cg of sortGroups(childGroups.get(g.id) ?? [])) out.push(...emitGroup(cg, indent + "  "));
      out.push(`${indent}}`);
      return out;
    }
    const out: string[] = [`${indent}subgraph ${gm}["${escLabel(title, mehrpele)}"]`];
    const gd = groupDirection(g); if (gd) out.push(`${indent}  direction ${gd === "TD" ? "TB" : gd}`);
    pushDefs(out, indent, groupChildrenNodes.get(g.id));
    for (const cg of sortGroups(childGroups.get(g.id) ?? [])) if (hasContent(cg)) out.push(...emitGroup(cg, indent + "  ")); else pushDefs(out, indent, groupChildrenNodes.get(cg.id));
    out.push(`${indent}end`);
    return out;
  };
  const emitTopGroups = topGroups.filter(hasContent);
  for (const g of built.groups) if (!hasContent(g)) em.ctx.dropped.push(`empty group ${g.id} dropped`);
  pushDefs(bodyLines, "", topNodes);
  for (const g of sortGroups(emitTopGroups)) bodyLines.push(...emitGroup(g, "  "));
  for (const ps of built.portalSubgraphs) { bodyLines.push(`  ${ps.header}`); for (const l of ps.lines) bodyLines.push(l.startsWith("  ") ? "  " + l : "    " + l); bodyLines.push(`  end`); }
  return bodyLines;
}

/** Flowchart classDef/class/style/click lines from the cards' colours, borders and kept classes. */
function flowchartClassLines(em: Emit, bodyLines: string[], cds: NonNullable<PeleMeta["classDefs"]>, { classDefMap, noAc }: StyleInputs): string[] {
  const { built, groupMermaidId } = em;
  const classLines: string[] = [];
  const usedClasses = new Map<string, string[]>();
  const styleLines: string[] = [];
  const presetsUsed = new Set<string>();
  const styleOf = (mermaidId: string, n: PeleCanvasNode, group = false) => {
    let classes: string[] = (n.peleClasses ?? []).filter(c => c !== "clickable");
    let styles: string[] = [...(n.peleStyles ?? [])];
    const derived = colourOf(classes, styles, classDefMap).color;
    const color = n.color;
    if ((color ?? undefined) !== derived) {
      classes = classes.filter(c => !presetOfClass(c));
      styles = withoutDecls(styles, ["fill", "stroke"]);
      // Pele draws no classes on clusters: a group's preset is its tinted fallback.
      if (color && isPreset(color) && group) styles.push(...tintStyles(presetHex(color)!));
      else if (color && isPreset(color)) { classes.push(presetClass(color)); presetsUsed.add(color); }
      else if (color) { const hx = normalizeHex(color); if (hx) styles.push(...tintStyles(hx)); }
    } else for (const c of classes) { const p = presetOfClass(c); if (p) presetsUsed.add(p); }
    const border = n.styleAttributes?.border ?? undefined;
    // A canvas written without Advanced Canvas has no styleAttributes to compare.
    if (!noAc && border !== borderOf(styles)) {
      styles = withoutDecls(styles, ["stroke-dasharray"]);
      if (border === "dashed" || border === "dotted") styles.push(`stroke-dasharray:${DASH.node[border]}`);
      else if (border === "invisible") { styles = withoutDecls(styles, ["fill", "stroke"]); styles.push("fill:none", "stroke:none"); }
    }
    for (const c of classes) pushTo(usedClasses, c, mermaidId);
    if (styles.length) styleLines.push(`  style ${mermaidId} ${styles.join(",")}`);
  };
  const byMermaidId = [...built.nodes].sort((a, b) => cmp(a.mermaidId, b.mermaidId));
  for (const o of byMermaidId) styleOf(o.mermaidId, o.node);
  for (const g of [...built.groups].sort((a, b) => cmp(groupMermaidId.get(a.id) ?? "", groupMermaidId.get(b.id) ?? ""))) {
    const gm = groupMermaidId.get(g.id);
    if (gm !== undefined && hasGroupLine(bodyLines, gm)) styleOf(gm, g, true);
  }
  for (const name of Object.keys(cds).sort(cmp)) { const cd = cds[name]; classLines.push(`  classDef ${name} ${[...(cd.styles ?? []), ...(cd.textStyles ?? []).map((s: string) => "color:" + s)].join(",")}`.replace(/ $/, "")); }
  for (const l of presetClassDefs([...presetsUsed].filter(p => !(presetClass(p) in cds)))) classLines.push(`  ${l}`);
  for (const [name, ids] of [...usedClasses].sort(([a], [b]) => cmp(a, b))) classLines.push(`  class ${[...new Set(ids)].sort(cmp).join(",")} ${name}`);
  classLines.push(...styleLines);
  for (const o of byMermaidId) {
    // view-nodes: a web-view node shows the page itself, no click line.
    const link = o.node.type === "link" ? (parseWebEmbedLabel(o.label) ? undefined : o.node.url) : o.node.peleLink;
    const tip = o.node.peleTooltip;
    if (link) classLines.push(`  click ${o.mermaidId} "${escLabel(link, false)}"${tip ? ` "${escLabel(tip, false)}"` : ""}`);
  }
  for (const o of built.nodes) { if (o.node.styleAttributes?.border && o.node.type !== "text" && o.node.type !== "file" && o.node.type !== "link") em.ctx.dropped.push(`node ${o.canvasId} border ${o.node.styleAttributes.border} dropped (no Mermaid equivalent)`); }
  return classLines;
}

/** An edge's linkStyle declarations: kept styles, with colour and dash re-derived when the card changed them. */
function edgeStyleOf(o: EdgeOut, { classDefMap, noAc }: StyleInputs): string[] {
  const e = o.e;
  let styles: string[] = [...(e.peleStyles ?? [])];
  const derived = edgeColourOf([], styles, classDefMap);
  const color = e.color;
  if ((color ?? undefined) !== derived) {
    styles = withoutDecls(styles, ["stroke"]);
    if (color && isPreset(color)) styles.unshift(`stroke:${presetHex(color)}`);
    else if (color) { const hx = normalizeHex(color); if (hx) styles.unshift(`stroke:${hx}`); }
  }
  const path = e.styleAttributes?.path ?? undefined;
  const want = (path === "short-dashed" || path === "long-dashed") && e.peleStroke !== "dotted" ? path : undefined;
  if (!noAc && want !== edgeDashOf(styles)) { styles = withoutDecls(styles, ["stroke-dasharray"]); if (want) styles.push(`stroke-dasharray:${DASH.edge[want]}`); }
  return styles;
}

/** linkStyle lines: edge colours and dashes (indices count every edge Pele parses, so `offset` skips the ones before ours). */
function linkStyleLines(flowEdges: EdgeOut[], offset: number, style: StyleInputs): string[] {
  const byStyle = new Map<string, number[]>();
  flowEdges.forEach((o, i) => { const s = edgeStyleOf(o, style); if (s.length) pushTo(byStyle, s.join(","), offset + i); });
  return [...byStyle].sort((p, q) => p[1][0] - q[1][0]).map(([s, idx]) => `  linkStyle ${idx.join(",")} ${s}`);
}

/** Edge keys in Mermaid order (pele-pos ports, provenance), from the parsed model or, failing that, the edges as written. */
function flowEdgeKeys(flowEdges: EdgeOut[], modelEdges: FlowEdge[] | null, offset: number): Map<PeleCanvasEdge, string> {
  const edgeKeys = new Map<PeleCanvasEdge, string>();
  if (!modelEdges) {
    const kc = new Map<string, number>();
    for (const o of flowEdges) { const kk = `${o.f}>${o.t}`; const n = (kc.get(kk) ?? 0) + 1; kc.set(kk, n); edgeKeys.set(o.e, edgeKey(o.f, o.t, n)); }
    return edgeKeys;
  }
  const keyCount = new Map<string, number>();
  for (let i = 0; i < modelEdges.length; i++) {
    const me = modelEdges[i]; const kk = `${me.start}>${me.end}`; const n = (keyCount.get(kk) ?? 0) + 1; keyCount.set(kk, n);
    const o = flowEdges[i - offset]; if (o && i >= offset) edgeKeys.set(o.e, edgeKey(me.start, me.end, n));
  }
  return edgeKeys;
}

/** `%% pele-layout canvas %%` and the pele-pos line pinning every card, group and edge port. */
function canvasLayoutLines(em: Emit, bodyLines: string[], flowEdges: EdgeOut[], edgeKeys: Map<PeleCanvasEdge, string>): string[] {
  const { built, groupMermaidId } = em;
  const pos = new Map<string, PinnedBox>();
  const s = em.ctx.scale;
  for (const o of [...built.nodes].sort((a, b) => cmp(a.mermaidId, b.mermaidId))) pos.set(o.mermaidId, { x: (o.node.x + o.node.width / 2) / s, y: (o.node.y + o.node.height / 2) / s });
  for (const g of [...built.groups].sort((a, b) => cmp(groupMermaidId.get(a.id) ?? "", groupMermaidId.get(b.id) ?? ""))) {
    const gm = groupMermaidId.get(g.id);
    if (gm !== undefined && hasGroupLine(bodyLines, gm)) pos.set(gm, { x: (g.x + g.width / 2) / s, y: (g.y + g.height / 2) / s, w: g.width / s, h: g.height / s });
  }
  const ports = new Map<string, EdgePorts>();
  for (const o of flowEdges) {
    const k = edgeKeys.get(o.e); if (!k) continue;
    const fs = o.e.fromFloating ? undefined : o.e.fromSide, ts = o.e.toFloating ? undefined : o.e.toSide;
    const p: EdgePorts = o.reversed ? { from: ts, to: fs } : { from: fs, to: ts };
    if (p.from || p.to) ports.set(k, p);
  }
  const layoutLines = ["%% pele-layout canvas %%"];
  const pl = formatPosDirective(pos, ports); if (pl) layoutLines.push(pl);
  return layoutLines;
}

/** The provenance line's content: geometry, kept attributes and node signatures, keyed by Mermaid id. */
function provenanceOf(em: Emit, metaPele: PeleMeta | undefined, parsed: FlowModel | null, modelEdges: FlowEdge[], offset: number, flowEdges: EdgeOut[], edgeKeys: Map<PeleCanvasEdge, string>, sizes: Map<string, NodeSize>): Provenance {
  const { canvas, built, groupMermaidId, type, dir, ctx } = em;
  const opts = ctx.opts;
  const modelNodes: Map<string, FlowNode> = parsed?.nodes instanceof Map ? parsed.nodes : new Map<string, FlowNode>();
  // No sourceHash: the line carries the geometry itself, and a hash of the
  // previous source would change on every round trip.
  const prov: Provenance = { schema: 2, type, direction: type === "flowchart" ? dir : undefined, scale: ctx.scale, layout: opts.layout === "canvas" && type === "flowchart" ? "canvas" : undefined, nodes: new Map(), groups: new Map(), edges: new Map() };
  // Canvas metadata other than what mermaidToCanvas writes anyway (frontmatter, …).
  const meta = { ...((canvas.metadata as AnyRec) ?? {}) }; delete meta.pele; delete meta.version;
  if (JSON.stringify(meta.frontmatter) === JSON.stringify({ tags: ["pele-diagram"] })) delete meta.frontmatter;
  if (metaPele) delete meta.startNode;
  if (Object.keys(meta).length) prov.meta = meta;
  for (const o of [...built.nodes].sort((a, b) => cmp(a.mermaidId, b.mermaidId))) {
    const pb: ProvBox = { canvasId: o.canvasId, x: o.node.x, y: o.node.y, w: o.node.width, h: o.node.height };
    const mn = modelNodes.get(o.mermaidId);
    if (mn) pb.sig = nodeSig(labelText(mn.text ?? o.mermaidId), mn.type, sizes.get(o.mermaidId));
    // Every style attribute is kept: without Advanced Canvas on the way back they are not re-derived.
    const keep = keepOf(o.node, NODE_CORE, () => false); if (keep) pb.keep = keep;
    prov.nodes.set(o.mermaidId, pb);
  }
  for (const g of [...built.groups].sort((a, b) => cmp(groupMermaidId.get(a.id) ?? "", groupMermaidId.get(b.id) ?? ""))) {
    const gm = groupMermaidId.get(g.id); if (!gm) continue;
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
  return prov;
}

export function hasGroupLine(lines: string[], gm: string): boolean {
  return lines.some(l => l.trimStart().startsWith(`subgraph ${gm}[`));
}

export function canvasToMermaid(canvas: CanvasData, opts: FromCanvasOptions = {}): FromCanvasResult {
  const metaScale = Number(((canvas.metadata as AnyRec)?.pele as AnyRec | undefined)?.scale);
  const scale = opts.scale ?? (metaScale > 0 ? metaScale : 1);
  const ctx: Ctx = { dropped: [], opts: { ...opts, portals: opts.portals ?? "link", portalDepth: opts.portalDepth ?? 1 }, depth: 0, visited: new Set(), scale, mehrpele: opts.mehrpele ?? false };
  return canvasToMermaidInner(canvas, ctx, "");
}
