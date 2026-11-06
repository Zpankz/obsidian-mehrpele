// ---------- Mermaid -> Canvas ----------
import { parse, render } from "../pele.js";
import { parseSizeDirective, withSizeDirective, type NodeSize } from "../node-size/index.js";
import { PELE_VERSION } from "../pele-version.js";
import { parseSvgGeometry, type BBox, type SvgGeometry } from "../layout/svg-geom.js";
import { sourceHash, sanitizeId } from "./ids.js";
import { embedNodeBox, parseEmbedLabel } from "./embed.js";
import { parseWebEmbedLabel, webNodeBox } from "./web.js"; // view-nodes
import { parseViewEntries } from "./views.js"; // view-nodes
import { folderBaseBlock, parseFolderLabel } from "./folder.js"; // view-nodes
import { edgeKey, parseLayoutDirective, type CanvasLayout, type EdgePorts, type Side } from "../layout/directive.js";
import { parseProvenance, stripProvenance, type ProvEdge, type Provenance } from "./provenance.js";
import { autoSides } from "../layout/route.js";
import type { CanvasData, CanvasEdge, CanvasNode, PeleCanvasEdge, PeleCanvasNode, ToCanvasOptions } from "./types.js";
import type { MindmapModel, ParsedDiagramModel } from "pele";
import { cmp, dirSides, mapEntries, mapVals, sameUrl, sideFromVector, type AnyRec, type FlowEdge, type FlowModel, type FlowNode, type MindmapNode, type PeleMeta, type StateGraphNode, type StateModelG, type StateRelation, type StateStmt, type Stmt } from "./util.js";
import { borderOf, colourOf, edgeColourOf, edgeDashOf, type ClassDefs } from "./style.js";
import { labelText, nodeSig, shieldQuotes } from "./labels.js";
import { edgeOwnedStyle, mergeKeep, nodeOwnedStyle, ownedKeys } from "./keep.js";
import { canvasMinSize, isStartEnd } from "./size.js";

export interface InternalNode {
  peleId: string; canvasId: string; label: string; rawShape?: string; classes: string[]; styles: string[]; kind: "text" | "file" | "link";
  file?: string; subpath?: string; url?: string; peleKind?: string; section?: number; bbox?: BBox; groupId?: string;
  /** Flowchart click target, as written in the source. */
  link?: string;
  /** Mindmap model id: mindmap edges refer to `mm:<mmId>`. */
  mmId?: string | number;
}
export const SHAPE_TO_AC: Record<string, string> = { stadium: "pill", diamond: "diamond", cylinder: "database", subroutine: "predefined-process", circle: "circle", lean_right: "parallelogram", lean_left: "parallelogram" };

/** Embed nodes reserve their card box in the layout (as Mehrpele does in Obsidian). */
export function withEmbedBoxes(source: string, model: ParsedDiagramModel, skip: Set<string>): string {
  if (model?.type !== "flowchart") return source;
  const sizes = parseSizeDirective(source);
  let added = false;
  for (const n of mapVals((model as FlowModel).nodes)) {
    if (skip.has(n.id) || sizes.has(n.id)) continue;
    const e = parseEmbedLabel(labelText(n.text ?? ""));
    const box = e ? embedNodeBox(e) : null;
    if (box) { sizes.set(n.id, { w: box.w, h: box.h }); added = true; }
  }
  return added ? withSizeDirective(source, sizes) : source;
}

export interface Rect { x: number; y: number; w: number; h: number }
export const overlapsR = (a: Rect, b: Rect, gap: number) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

interface InternalEdge { from: string; to: string; label: string; edgeType?: string; stroke?: string; classes: string[]; styles?: string[] }
interface InternalGroup { peleId: string; canvasId: string; title: string; members: string[]; bbox?: BBox; dir?: string; classes?: string[]; styles?: string[] }
/** A Pele model reduced to cards, links and groups, plus how its references map to canvas ids. */
interface InternalGraph {
  direction: string;
  nodes: InternalNode[];
  edges: InternalEdge[];
  groups: InternalGroup[];
  classDefs: ClassDefs;
  /** Pele id (mindmap: model id) → canvas id. */
  cidMap: Map<string, string>;
  /** Mindmap: edges refer to nodes as `mm:<model id>`. */
  mmMode: boolean;
}
/** The previous canvas (opts.previous): its cards, and whether its layout still applies. */
interface PreviousCanvas { byPele: Map<string, CanvasNode>; byId: Map<string, CanvasNode>; wins: boolean }
/** What every phase of one conversion reads. */
interface Run {
  source: string;
  type: string;
  model: ParsedDiagramModel;
  prov: Provenance | null;
  scale: number;
  origin: { x: number; y: number };
  advanced: boolean;
  /** Write both edge sides even where provenance had none (opts.explicitSides). */
  explicitSides: boolean;
  previous: PreviousCanvas;
  layout: CanvasLayout;
  sourceSizes: Map<string, NodeSize>;
  geom: SvgGeometry;
  dropped: string[];
  /** Next cell of the fallback grid, for nodes the SVG has no box for. */
  fallbackBBox: () => BBox;
}
interface Card { n: InternalNode; cn: PeleCanvasNode; auto: Rect; placed: Rect | null }

export function mermaidToCanvas(source: string, opts: ToCanvasOptions = {}): { canvas: CanvasData; fidelity: "full" | "embed"; dropped: string[] } {
  const prov = parseProvenance(source);
  const scale = opts.scale ?? prov?.scale ?? 2;
  const origin = opts.origin ?? { x: 40, y: 40 };
  const advanced = opts.advancedCanvas ?? false;
  const hash = sourceHash(stripProvenance(source));
  const previous = readPrevious(opts.previous, source, hash, prov);

  const shielded = shieldQuotes(source);
  const model = parse(shielded);
  const type: string = model.type;
  const dropped: string[] = [];

  if (type !== "flowchart" && type !== "state" && type !== "mindmap") return embedOnly(source, shielded, type, hash, scale, origin, prov, previous, dropped);

  const layout: CanvasLayout = type === "flowchart" ? parseLayoutDirective(source) : { mode: "auto", pos: new Map(), ports: new Map() };
  const sourceSizes = parseSizeDirective(source);
  const subgraphIds = new Set<string>(type === "flowchart" ? ((model as FlowModel).subgraphs ?? []).map((s) => s.id) : []);
  const rendered = render(withEmbedBoxes(shielded, model, subgraphIds));
  const geom = parseSvgGeometry(rendered.svg);
  let fallbackIdx = 0;
  const fallbackBBox = (): BBox => { const col = fallbackIdx % 4, row = Math.floor(fallbackIdx / 4); fallbackIdx++; return { x: col * 180, y: row * 120, width: 120, height: 60, cx: col * 180 + 60, cy: row * 120 + 30 }; };
  const run: Run = { source, type, model, prov, scale, origin, advanced, explicitSides: opts.explicitSides ?? false, previous, layout, sourceSizes, geom, dropped, fallbackBBox };

  const graph = buildGraph(run, subgraphIds);
  const cards = makeCards(run, graph);
  placeKnownCards(run, cards);
  placeNewCards(cards, graph);
  const rectOfCard = new Map<string, Rect>();
  for (const c of cards) {
    const r = c.placed ?? c.auto;
    c.cn.x = r.x; c.cn.y = r.y; c.cn.width = r.w; c.cn.height = r.h;
    rectOfCard.set(c.cn.id, r);
  }
  const anyManual = cards.some(c => c.placed);
  const groupNodes = makeGroups(run, graph, rectOfCard, anyManual);
  const canvasNodes: CanvasNode[] = [...groupNodes, ...cards.map(c => c.cn)];
  growGroups(run, graph, groupNodes, canvasNodes, rectOfCard, anyManual);
  const canvasEdges = makeEdges(run, graph, rectOfCard, anyManual);
  const meta = canvasMetadata(run, graph, hash, canvasNodes, canvasEdges);
  const canvas: CanvasData = { metadata: meta, nodes: canvasNodes, edges: canvasEdges };
  return { canvas, fidelity: "full", dropped };
}

/** The previous canvas's cards; its layout wins when it was made from this source. */
function readPrevious(previous: CanvasData | undefined, source: string, hash: string, prov: Provenance | null): PreviousCanvas {
  const byPele = new Map<string, CanvasNode>(); const byId = new Map<string, CanvasNode>();
  let wins = false;
  if (previous) {
    const prevHash = (previous.metadata as { pele?: PeleMeta } | undefined)?.pele?.sourceHash;
    if (prevHash && (prevHash === hash || prevHash === sourceHash(source) || (prov?.sourceHash && prov.sourceHash === prevHash))) wins = true;
    for (const n of (previous.nodes ?? []) as PeleCanvasNode[]) { byId.set(n.id, n); if (n.peleId) byPele.set(String(n.peleId), n); }
  }
  return { byPele, byId, wins };
}

/** Diagram types without a node/edge equivalent: one text card holding the source. */
function embedOnly(source: string, shielded: string, type: string, hash: string, scale: number, origin: { x: number; y: number }, prov: Provenance | null, previous: PreviousCanvas, dropped: string[]) {
  const rendered = render(shielded);
  const text = "```mermaid\n" + source + "\n```\n> Converted with Pele — diagram type `" + type + "` has no Canvas node/edge equivalent. Edit the source and use **Convert diagram to canvas** again, or open in the Pele playground.";
  const w = Math.max(200, Math.min(1200, Math.round((rendered.width ?? 400) * scale)));
  const h = Math.max(120, Math.min(800, Math.round((rendered.height ?? 300) * scale)));
  const pv = prov?.nodes.get("__embed__") ?? prov?.nodes.get("n_embed");
  const manual = pv ? { x: pv.x, y: pv.y, width: pv.w, height: pv.h } : previous.wins ? (() => { const p = previous.byPele.get("__embed__") ?? previous.byId.get("n_embed"); return p ? { x: p.x, y: p.y, width: p.width, height: p.height } : null; })() : null;
  const node: PeleCanvasNode = manual ? { id: "n_embed", type: "text", ...manual, text } : { id: "n_embed", type: "text", x: origin.x, y: origin.y, width: w, height: h, text };
  node.peleId = "__embed__";
  const canvas: CanvasData = { metadata: { version: "1.0-1.0", frontmatter: { tags: ["pele-diagram"] }, pele: { schema: 1, type, direction: "", sourceHash: hash, peleVersion: PELE_VERSION, scale, fidelity: "embed", classDefs: {}, dropped: [] } }, nodes: [node], edges: [] };
  return { canvas, fidelity: "embed" as const, dropped };
}

// ---- the internal graph, per diagram type

function buildGraph(run: Run, subgraphIds: Set<string>): InternalGraph {
  const usedCanvasIds = new Map<string, number>();
  const canvasIdFor = (prefix: string, peleId: string): string => {
    const base = prefix + "_" + sanitizeId(peleId);
    const n = (usedCanvasIds.get(base) ?? 0) + 1; usedCanvasIds.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  };
  if (run.type === "flowchart") return flowchartGraph(run, subgraphIds, canvasIdFor);
  if (run.type === "state") return stateGraph(run, canvasIdFor);
  return mindmapGraph(run);
}

function flowchartGraph(run: Run, subgraphIds: Set<string>, canvasIdFor: (prefix: string, peleId: string) => string): InternalGraph {
  const { prov, geom, source } = run;
  const model = run.model as FlowModel;
  // Click targets as written (Pele normalises URLs, e.g. adds a trailing slash).
  const rawLinks = new Map<string, string>();
  for (const m of source.matchAll(/^[ \t]*click[ \t]+([^\s]+)[ \t]+(?:href[ \t]+)?"([^"]+)"/gm)) rawLinks.set(m[1], m[2]);
  const asWritten = (id: string, link: string): string => { const raw = rawLinks.get(id); try { return raw && new URL(raw).href === new URL(link).href ? raw : link; } catch { return link; } };

  const direction = model.direction === "TB" ? "TD" : (model.direction ?? "TD");
  const classDefs: ClassDefs = new Map(mapEntries(model.classes));
  const nodes: InternalNode[] = [];
  const edges: InternalEdge[] = [];
  const groups: InternalGroup[] = [];
  const nodesArr = mapVals(model.nodes).filter(n => !subgraphIds.has(n.id));
  const nodeById = new Map<string, FlowNode>(mapVals(model.nodes).map(n => [n.id, n]));
  const cidMap = new Map<string, string>();
  for (const n of nodesArr) cidMap.set(n.id, prov?.nodes.get(n.id)?.canvasId || canvasIdFor("n", n.id));
  for (const n of nodesArr) {
    const label: string = labelText(n.text ?? n.id);
    const node: InternalNode = { peleId: n.id, canvasId: cidMap.get(n.id)!, label, rawShape: n.type, classes: (n.classes ?? []).filter((c: string) => c !== "clickable"), styles: n.styles ?? [], kind: "text", bbox: geom.nodes.get(n.id) };
    if (n.link) node.link = asWritten(n.id, n.link);
    nodes.push(node);
  }
  for (const e of model.edges ?? []) edges.push({ from: e.start, to: e.end, label: labelText(e.text ?? ""), edgeType: e.type, stroke: e.stroke, classes: e.classes ?? [], styles: (e.style ?? e.styles ?? []).filter((s: string) => !/^\s*fill\s*:\s*none\s*$/.test(s)) });
  for (const sg of model.subgraphs ?? []) {
    const sn = nodeById.get(sg.id);
    groups.push({ peleId: sg.id, canvasId: prov?.groups.get(sg.id)?.canvasId || canvasIdFor("g", sg.id), title: labelText(sg.title ?? sg.id), members: sg.nodes ?? [], bbox: geom.clusters.get(sg.id), dir: sg.dir, classes: [...(sg.classes ?? []), ...(sn?.classes ?? [])].filter((c: string) => c !== "clickable"), styles: sn?.styles ?? [] });
  }
  return { direction, nodes, edges, groups, classDefs, cidMap, mmMode: false };
}

function stateGraph(run: Run, canvasIdFor: (prefix: string, peleId: string) => string): InternalGraph {
  const { prov, geom } = run;
  const model = run.model as StateModelG;
  const classDefs: ClassDefs = new Map(mapEntries(model.classes));
  const nodes: InternalNode[] = [];
  const edges: InternalEdge[] = [];
  const groups: InternalGroup[] = [];
  const graphById = new Map<string, StateGraphNode>(); for (const gn of model.graph?.nodes ?? []) graphById.set(gn.id, gn);
  const stateById = new Map<string, StateStmt>(); for (const [k, v] of mapEntries(model.states)) stateById.set(k, v);
  const relations: StateRelation[] = [];
  const walkDoc = (doc: Stmt[]) => { for (const s of doc ?? []) { if (typeof s === "string") continue; if (s.stmt === "relation") { relations.push({ id1: s.state1?.id, id2: s.state2?.id, relationTitle: s.description ?? "" }); if (s.state1) stateById.set(s.state1.id, { ...(stateById.get(s.state1.id) ?? {}), ...s.state1 }); if (s.state2) stateById.set(s.state2.id, { ...(stateById.get(s.state2.id) ?? {}), ...s.state2 }); } else if (s.stmt === "state" && s.doc) walkDoc(s.doc); } };
  walkDoc(model.rootDoc ?? []);
  const rels = relations.length ? relations : (model.relations ?? []);
  const compositeIds = new Set<string>();
  for (const [id, st] of stateById) if (st.doc) compositeIds.add(id);
  for (const gn of graphById.values()) if (gn.isGroup) compositeIds.add(gn.id);
  const cidMap = new Map<string, string>();
  const orderedIds: string[] = [];
  for (const gn of model.graph?.nodes ?? []) if (!orderedIds.includes(gn.id)) orderedIds.push(gn.id);
  for (const id of stateById.keys()) if (!orderedIds.includes(id)) orderedIds.push(id);
  for (const r of rels) { for (const id of [r.id1, r.id2]) if (id && !orderedIds.includes(id)) orderedIds.push(id); }
  for (const id of orderedIds) {
    if (compositeIds.has(id)) {
      const group: InternalGroup = { peleId: id, canvasId: prov?.groups.get(id)?.canvasId || canvasIdFor("g", id), title: graphById.get(id)?.label ?? id, members: (model.graph?.nodes ?? []).filter((n) => n.parentId === id).map((n) => n.id), bbox: geom.clusters.get(id) };
      groups.push(group); cidMap.set(id, group.canvasId);
      continue;
    }
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
    nodes.push({ peleId: id, canvasId: cid, label, rawShape, classes: st?.classes ?? [], styles: st?.styles ?? [], kind: "text", peleKind, bbox: geom.nodes.get(id) });
  }
  for (const r of rels) if (r.id1 && r.id2) edges.push({ from: r.id1, to: r.id2, label: r.relationTitle ?? "", classes: [] });
  return { direction: "TD", nodes, edges, groups, classDefs, cidMap, mmMode: false };
}

function mindmapGraph(run: Run): InternalGraph {
  const { geom } = run;
  const model = run.model as MindmapModel;
  const nodes: InternalNode[] = [];
  const edges: InternalEdge[] = [];
  const flat: MindmapNode[] = model.nodes ?? [];
  const root = flat.find(n => n.isRoot) ?? flat[0];
  const cidMap = new Map<string, string>();
  const walk = (node: MindmapNode, parent: MindmapNode | null) => {
    const cid = `n_m${node.id}`; cidMap.set(String(node.id), cid);
    nodes.push({ peleId: node.nodeId, canvasId: cid, label: labelText(node.descr ?? node.nodeId), rawShape: node.isRoot || node.type === 3 ? "circle" : undefined, classes: node.class ? [node.class] : [], styles: [], kind: "text", section: node.section, peleKind: "mindmap", bbox: geom.nodes.get(node.nodeId), mmId: node.id });
    if (parent) edges.push({ from: `mm:${parent.id}`, to: `mm:${node.id}`, label: "", classes: [] });
    for (const ch of node.children ?? []) walk(ch, node);
  };
  if (root) walk(root, null);
  return { direction: "LR", nodes, edges, groups: [], classDefs: new Map(), cidMap, mmMode: true };
}

/** Canvas id of a node/group reference from an edge or group member list. */
function canvasIdOf(graph: InternalGraph, peleRef: string): string | undefined {
  if (graph.mmMode) { if (peleRef.startsWith("mm:")) return graph.cidMap.get(peleRef.slice(3)); const n = graph.nodes.find(x => x.peleId === peleRef); return n?.canvasId; }
  return graph.cidMap.get(peleRef) ?? graph.nodes.find(x => x.peleId === peleRef)?.canvasId ?? graph.groups.find(g => g.peleId === peleRef)?.canvasId;
}
/** Mermaid id of a reference (mindmap `mm:<id>` refs → the node's Pele id). */
function mermaidIdOfRef(graph: InternalGraph, ref: string): string {
  return graph.mmMode && ref.startsWith("mm:") ? (graph.nodes.find(n => `mm:${n.mmId}` === ref)?.peleId ?? ref) : ref;
}

// ---- cards: content, auto geometry, then the manual geometry where known

function makeCards(run: Run, graph: InternalGraph): Card[] {
  const tooltips = new Map<string, string>(mapEntries((run.model as Partial<FlowModel>).tooltips).map(([k, v]) => [k, String(v)]));
  const attachedViews = parseViewEntries(run.source); // view-nodes: `%% pele-view %%` rides on its cards
  return graph.nodes.map(n => makeCard(run, graph, n, tooltips, attachedViews));
}

function makeCard(run: Run, graph: InternalGraph, n: InternalNode, tooltips: Map<string, string>, attachedViews: Map<string, string[]>): Card {
  const { type, scale, origin, advanced } = run;
  if (!n.bbox) n.bbox = run.fallbackBBox();
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
  const link = n.link;
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
  const cn: PeleCanvasNode = { id: n.canvasId, type: kind, x, y, width: w, height: h };
  cn.peleId = n.peleId;
  if (n.rawShape) cn.peleShape = n.rawShape;
  if (n.classes?.length) cn.peleClasses = [...n.classes];
  if (n.styles?.length && type === "flowchart") cn.peleStyles = [...n.styles];
  if (n.peleKind) cn.peleKind = n.peleKind;
  const views = attachedViews.get(n.peleId);
  if (views) cn.peleViews = [...views]; // view-nodes
  if (link && kind !== "link") cn.peleLink = link;
  const tip = tooltips.get(n.peleId); if (tip) cn.peleTooltip = tip;
  // An empty card is written as `" "` (Pele rejects empty labels).
  if (kind === "text") cn.text = n.peleKind === "stateStart" || n.peleKind === "stateEnd" ? " " : type === "flowchart" && !label.trim() ? "" : label;
  if (folder) { cn.text = folderBaseBlock(folder); cn.peleText = trimmed; } // view-nodes
  else if (emb) {
    cn.file = emb.file; if (emb.subpath) cn.subpath = emb.subpath;
    if (emb.alias) cn.peleLabel = emb.alias;
    cn.peleEmbed = emb.embed;
    cn.peleText = trimmed;
    if (emb.file.toLowerCase().endsWith(".canvas") && advanced) cn.portal = true;
  } else if (kind === "link" && web) { cn.url = url; cn.peleText = trimmed; } // view-nodes
  else if (kind === "link") { cn.url = url; if (trimmed !== url && trimmed !== n.peleId) cn.peleLabel = label; }
  // colour
  const fc = colourOf(n.classes, n.styles, graph.classDefs);
  if (fc.color) cn.color = fc.color; else if (fc.raw) { cn.peleFill = fc.raw; run.dropped.push(`node ${n.canvasId} fill ${fc.raw} (no hex equivalent)`); }
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
  return { n, cn, auto: { x, y, w, h }, placed: null };
}

/** Manual geometry: provenance (exact while the node is unchanged), pele-pos, previous canvas. */
function placeKnownCards(run: Run, cards: Card[]): void {
  const { prov, layout, previous, scale, advanced, type, sourceSizes } = run;
  const nodeSigNow = (n: InternalNode): string | undefined => type === "flowchart" ? nodeSig(n.label, n.rawShape, sourceSizes.get(n.peleId)) : undefined;
  for (const c of cards) {
    const mermaidId = c.n.peleId;
    const pv = prov?.nodes.get(mermaidId) ?? prov?.nodes.get(c.n.canvasId);
    const pos = layout.pos.get(mermaidId);
    const prev = previous.wins ? (previous.byPele.get(mermaidId) ?? previous.byId.get(c.n.canvasId)) : undefined;
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
}

/** New nodes: next to their placed neighbours, offset as in Pele's layout, off any overlap. */
function placeNewCards(cards: Card[], graph: InternalGraph): void {
  const placedCards = cards.filter(c => c.placed);
  if (!placedCards.length || placedCards.length === cards.length) return;
  const byRef = new Map<string, Card>();
  for (const c of cards) { byRef.set(c.n.peleId, c); if (c.n.mmId !== undefined) byRef.set(`mm:${c.n.mmId}`, c); }
  const centreOf = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  /** Mean shift of placed cards from their auto position. */
  const delta = (placed: { c: Card; r: Rect }[]) => { if (!placed.length) return null; let sx = 0, sy = 0; for (const { c, r } of placed) { const a = centreOf(c.auto), p = centreOf(r); sx += p.x - a.x; sy += p.y - a.y; } return { x: sx / placed.length, y: sy / placed.length }; };
  const placedOf = (list: Card[]) => list.flatMap(c => (c.placed ? [{ c, r: c.placed }] : []));
  const global = delta(placedOf(placedCards)) ?? { x: 0, y: 0 };
  const vertical = graph.direction === "TD" || graph.direction === "TB" || graph.direction === "BT";
  const pending = cards.filter(c => !c.placed);
  const neighbours = (c: Card) => graph.edges.flatMap(e => { const f = byRef.get(e.from), t = byRef.get(e.to); return f === c && t?.placed ? [t] : t === c && f?.placed ? [f] : []; });
  for (let guard = 0; pending.length && guard < 4 * cards.length + 4; guard++) {
    const idx = pending.findIndex(c => neighbours(c).length > 0);
    const c = idx >= 0 ? pending.splice(idx, 1)[0] : pending.shift();
    if (!c) break;
    const d = delta(placedOf(neighbours(c))) ?? global;
    const a = centreOf(c.auto);
    const r: Rect = { x: Math.round(a.x + d.x - c.auto.w / 2), y: Math.round(a.y + d.y - c.auto.h / 2), w: c.auto.w, h: c.auto.h };
    for (let step = 0; step < 200; step++) {
      const hit = cards.find(o => o !== c && o.placed && overlapsR(r, o.placed, 20))?.placed;
      if (!hit) break;
      if (vertical) r.y = hit.y + hit.h + 40; else r.x = hit.x + hit.w + 40;
    }
    c.placed = r;
  }
}

// ---- groups (larger first = shallower), wrapping their members

function makeGroups(run: Run, graph: InternalGraph, rectOfCard: Map<string, Rect>, anyManual: boolean): PeleCanvasNode[] {
  const { prov, previous, layout, scale, origin } = run;
  const { groups } = graph;
  const groupNodes: PeleCanvasNode[] = [];
  const sortedGroups = [...groups].sort((a, b) => ((b.bbox?.width ?? 0) * (b.bbox?.height ?? 0)) - ((a.bbox?.width ?? 0) * (a.bbox?.height ?? 0)));
  const memberRects = (g: InternalGroup, seen = new Set<string>()): Rect[] => {
    if (seen.has(g.peleId)) return []; seen.add(g.peleId);
    const out: Rect[] = [];
    for (const m of g.members) { const cid = canvasIdOf(graph, m); const r = cid ? rectOfCard.get(cid) : undefined; if (r) out.push(r); const sub = groups.find(x => x.peleId === m); if (sub) out.push(...memberRects(sub, seen)); }
    return out;
  };
  for (const g of sortedGroups) {
    const pv = prov?.groups.get(g.peleId);
    const prev = previous.wins ? (previous.byPele.get(g.peleId) ?? previous.byId.get(g.canvasId)) : undefined;
    const pos = layout.pos.get(g.peleId);
    let r: Rect | null = pv ? { x: pv.x, y: pv.y, w: pv.w, h: pv.h } : prev ? { x: prev.x, y: prev.y, w: prev.width, h: prev.height } : null;
    if (!r && pos && pos.w !== undefined && pos.h !== undefined) r = { x: Math.round((pos.x - pos.w / 2) * scale), y: Math.round((pos.y - pos.h / 2) * scale), w: Math.round(pos.w * scale), h: Math.round(pos.h * scale) };
    if (!r && anyManual) {
      const mem = memberRects(g);
      if (mem.length) { const x1 = Math.min(...mem.map(m => m.x)), y1 = Math.min(...mem.map(m => m.y)), x2 = Math.max(...mem.map(m => m.x + m.w)), y2 = Math.max(...mem.map(m => m.y + m.h)); r = { x: x1 - 20 * scale / 2, y: y1 - 50 * scale / 2, w: x2 - x1 + 20 * scale, h: y2 - y1 + 70 * scale / 2 }; }
    }
    if (!r) {
      const bb = g.bbox ?? membersBBox(graph, g) ?? run.fallbackBBox();
      r = { x: Math.round(bb.x * scale + origin.x), y: Math.round(bb.y * scale + origin.y), w: Math.round(bb.width * scale), h: Math.round(bb.height * scale) };
    }
    let gn: PeleCanvasNode = { id: g.canvasId, type: "group", x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h), label: g.title };
    gn.peleId = g.peleId;
    if (g.dir && g.dir !== graph.direction) gn.peleDir = g.dir;
    if (g.classes?.length) gn.peleClasses = [...g.classes];
    if (g.styles?.length) gn.peleStyles = [...g.styles];
    const gc = colourOf(g.classes, g.styles, graph.classDefs);
    if (gc.color) gn.color = gc.color;
    if (pv?.keep) gn = mergeKeep(gn, pv.keep);
    groupNodes.push(gn);
    rectOfCard.set(gn.id, { x: gn.x, y: gn.y, w: gn.width, h: gn.height });
  }
  return groupNodes;
}

/** SVG box around a group's member nodes (30 units of padding), or null without any. */
function membersBBox(graph: InternalGraph, g: InternalGroup): BBox | null {
  const mem = graph.nodes.flatMap(n => (g.members.includes(n.peleId) && n.bbox ? [n.bbox] : []));
  if (!mem.length) return null;
  const x1 = Math.min(...mem.map(b => b.x)), y1 = Math.min(...mem.map(b => b.y)), x2 = Math.max(...mem.map(b => b.x + b.width)), y2 = Math.max(...mem.map(b => b.y + b.height));
  return { x: x1 - 30, y: y1 - 30, width: x2 - x1 + 60, height: y2 - y1 + 60, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 };
}

/** Repair: grow groups to contain their members (inner groups first). */
function growGroups(run: Run, graph: InternalGraph, groupNodes: CanvasNode[], canvasNodes: CanvasNode[], rectOfCard: Map<string, Rect>, anyManual: boolean): void {
  for (const g of [...groupNodes].reverse()) {
    const sg = graph.groups.find(x => x.canvasId === g.id); if (!sg) continue;
    for (const member of sg.members) {
      const cn = canvasNodes.find(n => n.id === canvasIdOf(graph, member)); if (!cn || cn === g) continue;
      let changed = false;
      if (cn.x < g.x) { g.width += g.x - cn.x; g.x = cn.x; changed = true; }
      if (cn.y < g.y) { g.height += g.y - cn.y; g.y = cn.y; changed = true; }
      if (cn.x + cn.width > g.x + g.width) { g.width = cn.x + cn.width - g.x; changed = true; }
      if (cn.y + cn.height > g.y + g.height) { g.height = cn.y + cn.height - g.y; changed = true; }
      if (changed && !anyManual) run.dropped.push(`group ${g.id} grown to contain ${cn.id}`);
    }
    rectOfCard.set(g.id, { x: g.x, y: g.y, w: g.width, h: g.height });
  }
}

// ---- edges

function makeEdges(run: Run, graph: InternalGraph, rectOfCard: Map<string, Rect>, anyManual: boolean): CanvasEdge[] {
  const { type, model, prov, layout, geom, advanced, dropped } = run;
  const canvasEdges: CanvasEdge[] = [];
  const pairCount = new Map<string, number>();
  const keyCount = new Map<string, number>();
  const flowEdges: FlowEdge[] = type === "flowchart" ? ((model as FlowModel).edges ?? []) : [];
  const centreByPele = new Map<string, { cx: number; cy: number }>();
  for (const n of graph.nodes) if (n.bbox) { centreByPele.set(n.peleId, { cx: n.bbox.cx, cy: n.bbox.cy }); if (n.mmId !== undefined) centreByPele.set(`mm:${n.mmId}`, { cx: n.bbox.cx, cy: n.bbox.cy }); }
  graph.edges.forEach((e, idx) => {
    const fromC = canvasIdOf(graph, e.from); const toC = canvasIdOf(graph, e.to);
    if (!fromC || !toC) { dropped.push(`edge ${e.from}->${e.to} dropped (missing node)`); return; }
    const pairKey = `${fromC}\0${toC}`; const k = pairCount.get(pairKey) ?? 0; pairCount.set(pairKey, k + 1);
    const fromId = mermaidIdOfRef(graph, e.from), toId = mermaidIdOfRef(graph, e.to);
    const kk = `${fromId}>${toId}`; const occ = (keyCount.get(kk) ?? 0) + 1; keyCount.set(kk, occ);
    const pk = edgeKey(fromId, toId, occ);
    const pe: ProvEdge | undefined = graph.mmMode ? undefined : prov?.edges.get(pk);
    const fromSan = sanitizeId(graph.mmMode ? e.from : graph.nodes.find(n => n.canvasId === fromC)?.peleId ?? fromC);
    const toSan = sanitizeId(graph.mmMode ? e.to : graph.nodes.find(n => n.canvasId === toC)?.peleId ?? toC);
    const eid = pe?.id ?? `e_${fromSan}_${toSan}_${k}`;
    // sides: provenance, pele-pos ports, else geometry
    let fromSide: Side | undefined, toSide: Side | undefined;
    const ports: EdgePorts = layout.ports.get(pk) ?? {};
    const fr = rectOfCard.get(fromC), tr = rectOfCard.get(toC);
    const manualEnds = anyManual || layout.mode === "canvas";
    if (manualEnds && fr && tr) { [fromSide, toSide] = autoSides(fr, tr); }
    else {
      const eg = type === "flowchart" ? (flowEdges[idx]?.id ? geom.edges.get(flowEdges[idx].id) : undefined) : type === "state" ? geom.edges.get(`edge${idx}`) : undefined;
      const fc = centreByPele.get(e.from), tc = centreByPele.get(e.to);
      if (eg && fc && tc) { fromSide = sideFromVector(eg.sx - fc.cx, eg.sy - fc.cy); toSide = sideFromVector(eg.ex - tc.cx, eg.ey - tc.cy); }
      else if (fc && tc && (fc.cx !== tc.cx || fc.cy !== tc.cy)) { fromSide = sideFromVector(tc.cx - fc.cx, tc.cy - fc.cy); toSide = sideFromVector(fc.cx - tc.cx, fc.cy - tc.cy); }
      else ({ fromSide, toSide } = dirSides(graph.direction));
    }
    if (ports.from) fromSide = ports.from;
    if (ports.to) toSide = ports.to;
    if (pe?.fromSide) fromSide = pe.fromSide;
    if (pe?.toSide) toSide = pe.toSide;
    const rev = pe?.keep?.peleReversed === true;
    // pe sides are in the Mermaid frame; the delete below runs on the canvas edge, so swap when reversed.
    const implicitSides = !run.explicitSides && pe && !ports.from && !ports.to
      ? (rev ? { from: !pe.toSide, to: !pe.fromSide } : { from: !pe.fromSide, to: !pe.toSide }) : null;
    let ce: PeleCanvasEdge = rev ? { id: eid, fromNode: toC, toNode: fromC, fromSide: toSide, toSide: fromSide } : { id: eid, fromNode: fromC, toNode: toC, fromSide, toSide };
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
      if (edgeType && edgeType !== "arrow_point") ce.peleEdgeType = edgeType;
      if (e.stroke && e.stroke !== "normal") ce.peleStroke = e.stroke;
      if (e.stroke === "thick") dropped.push(`edge ${eid} thick stroke (no canvas width)`);
      if (e.styles?.length) ce.peleStyles = [...e.styles];
    }
    if (e.label) ce.label = e.label;
    if (type === "flowchart") { const col = edgeColourOf(e.classes, e.styles, graph.classDefs); if (col) ce.color = col; }
    if (type === "mindmap") { const sec = graph.nodes.find(n => n.canvasId === toC)?.section; if (sec !== undefined) ce.color = String((sec % 6) + 1); }
    if (advanced && type !== "mindmap") {
      const sa: Record<string, string | null> = {};
      if (e.stroke === "dotted") sa.path = "dotted";
      else { const dash = edgeDashOf(e.styles); if (dash) sa.path = dash; }
      if (edgeType === "arrow_circle" || edgeType === "double_arrow_circle") sa.arrow = "circle";
      if (edgeType === "arrow_cross" || edgeType === "double_arrow_cross") sa.arrow = "blunt";
      if (Object.keys(sa).length) ce.styleAttributes = sa;
    }
    if (pe?.keep) {
      const keep: Record<string, unknown> = { ...pe.keep }; delete keep.peleReversed;
      ce = mergeKeep(ce, Object.keys(keep).length ? keep : undefined, advanced ? ownedKeys(keep, edgeOwnedStyle) : pe.t !== undefined && pe.t !== `${edgeType}/${e.stroke}` ? ["path", "arrow"] : []);
    }
    if (implicitSides) { if (implicitSides.from) delete ce.fromSide; if (implicitSides.to) delete ce.toSide; }
    if (pe?.e) {
      if (pe.e.includes("f") && ce.fromEnd === "none") delete ce.fromEnd;
      if (pe.e.includes("t") && ce.toEnd === "arrow") delete ce.toEnd;
    }
    canvasEdges.push(ce);
  });
  return canvasEdges;
}

// ---- metadata

function canvasMetadata(run: Run, graph: InternalGraph, hash: string, canvasNodes: CanvasNode[], canvasEdges: CanvasEdge[]): Record<string, unknown> {
  const { type, prov, scale, layout, advanced, sourceSizes, dropped } = run;
  // classDefs serialised sorted
  const classDefsObj: AnyRec = {};
  for (const [k, cd] of [...graph.classDefs].sort(([a], [b]) => cmp(a, b))) classDefsObj[k] = { styles: cd.styles ?? [], textStyles: cd.textStyles ?? [] };
  // startNode: exactly one indegree 0
  const indeg = new Map<string, number>(); for (const n of canvasNodes.filter(n => n.type !== "group")) indeg.set(n.id, 0);
  for (const e of canvasEdges) { const d = indeg.get(e.toNode); if (d !== undefined) indeg.set(e.toNode, d + 1); }
  const roots = [...indeg.entries()].filter(([, v]) => v === 0).map(([k]) => k);
  const pmeta: AnyRec = prov?.meta ?? {};
  const meta: AnyRec = { ...pmeta, version: "1.0-1.0", frontmatter: pmeta.frontmatter ?? { tags: ["pele-diagram"] }, pele: { schema: 1, type, direction: graph.direction, sourceHash: hash, peleVersion: PELE_VERSION, scale, ...(layout.mode === "canvas" ? { layout: "canvas" } : {}), fidelity: "full", ...(advanced ? {} : { advancedCanvas: false }), classDefs: classDefsObj, dropped, ...(sourceSizes.size ? { nodeSizes: Object.fromEntries(sourceSizes) } : {}) } };
  if (pmeta.startNode && indeg.has(pmeta.startNode as string)) meta.startNode = pmeta.startNode;
  else { delete meta.startNode; if ((type === "flowchart" || type === "state") && roots.length === 1) meta.startNode = roots[0]; }
  return meta;
}
