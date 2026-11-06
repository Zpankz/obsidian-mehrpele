import type { FlowchartModel } from "pele";
import { parse, render } from "../pele.js";
import type { ExcalidrawElementSkeleton, ExcalidrawFileEntry, PeleToExcalidrawOptions, PeleToExcalidrawResult } from "./types.js";
import { extractGeometry, pathToPoints } from "./svg-geometry.js";
import { base64Encode, fnv1a } from "./base64.js";
import { buildNode, clipEnd, clipStart, shapeKind, type Outline, type Pt } from "./shapes.js";
import { arrowLabelMaxWidth, labelText, longestWordWidth } from "./text-metrics.js";

export type { ExcalidrawElementSkeleton, ExcalidrawFileEntry, PeleToExcalidrawOptions, PeleToExcalidrawResult, SkeletonLabel, Arrowhead } from "./types.js";
export { extractGeometry, pathToPoints } from "./svg-geometry.js";
export type { SvgGeometry } from "./svg-geometry.js";
export { base64Encode, fnv1a } from "./base64.js";
export {
  BOUND_TEXT_PADDING, DEFAULT_FONT_FAMILY, WIDTH_SAFETY, arrowLabelMaxWidth, boundTextMaxHeight, boundTextMaxWidth, estimateLineWidth,
  estimateTextBox, estimateWrappedLines, labelText, lineHeightFor, longestWordWidth, minContainerSide,
} from "./text-metrics.js";
export type { TextContainerType } from "./text-metrics.js";
export { shapeKind } from "./shapes.js";
export type { ShapeKind } from "./shapes.js";

export const DEFAULT_PALETTE: Record<string, string> = {
  "--pele-bg": "#ffffff", "--pele-fg": "#1f1f1f", "--pele-muted": "#6e6e6e",
  "--pele-line": "#1f1f1f", "--pele-surface": "#f3f3f3", "--pele-surface-alt": "#e6e6e6",
  "--pele-border": "#8a8a8a", "--pele-accent": "#5b7bd5",
};

/** A flowchart node as the converter reads it: Pele's node, or one synthesised from SVG geometry. */
interface FlowNodeLike { id: string; text?: string; type?: string; styles?: string[]; classes?: string[]; link?: string }

const sanitize = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
export const nodeSkeletonId = (peleId: string) => `node_${sanitize(peleId)}`;
export const edgeSkeletonId = (edgeId: string) => `edge_${sanitize(edgeId)}`;
export const clusterSkeletonId = (sgId: string) => `cluster_${sanitize(sgId)}`;
export const groupId = (peleId: string) => `group_${sanitize(peleId)}`;

function paletteValue(palette: Record<string, string>, key: string): string {
  return palette[key] ?? palette[key.replace(/^--pele-/, "")] ?? DEFAULT_PALETTE[key];
}

function styleMap(styles: string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of styles ?? []) { const i = s.indexOf(":"); if (i > 0) map.set(s.slice(0, i).trim(), s.slice(i + 1).trim()); }
  return map;
}

function arrowheads(edgeType: string | undefined, markers: number): { start: "arrow" | "bar" | "circle" | null; end: "arrow" | "bar" | "circle" | null } {
  const t = (edgeType ?? "arrow_point").toLowerCase();
  const dbl = t.startsWith("double_") || t.startsWith("double-");
  const base = t.replace(/^double[_-]/, "");
  const one: "arrow" | "bar" | "circle" | null =
    base.includes("cross") ? "bar" : base.includes("circle") ? "circle" : base.includes("open") || base === "none" ? null : "arrow";
  if (dbl) return { start: one, end: one };
  if (edgeType === undefined && markers === 0) return { start: null, end: null };
  return { start: null, end: one };
}

function inlinePalette(svg: string, palette: Record<string, string>): string {
  return svg.replace(/var\(\s*(--pele-[a-z0-9-]+)\s*(?:,([^)]*))?\)/gi, (_m, name: string, fb: string | undefined) =>
    palette[name] ?? palette[name.replace(/^--pele-/, "")] ?? (fb ?? "").trim() ?? "");
}

function imageFallback(svg: string, width: number, height: number, palette: Record<string, string>, scale: number, diagType: string): PeleToExcalidrawResult {
  const themed = inlinePalette(svg, palette);
  const fileId = `file_${fnv1a(themed)}`;
  const files: Record<string, ExcalidrawFileEntry> = {
    [fileId]: { mimeType: "image/svg+xml", dataURL: `data:image/svg+xml;base64,${base64Encode(themed)}`, id: fileId, created: 0 },
  };
  return {
    elements: [{ id: "image_0", type: "image", x: 0, y: 0, width: width * scale, height: height * scale, angle: 0, status: "saved", fileId, scale: [1, 1] }],
    files, fidelity: "image",
    dropped: [`native-conversion-unavailable:${diagType}:image-fallback`],
  };
}

export function peleToExcalidraw(source: string, opts: PeleToExcalidrawOptions = {}): PeleToExcalidrawResult {
  const palette = opts.palette ?? {};
  const scale = opts.scale ?? 1;
  const model = parse(source);
  const rendered = render(source);
  const svg = rendered.svg, width = rendered.width, height = rendered.height;

  if (model.type !== "flowchart") {
    if (opts.imageFallback === "none") return { elements: [], files: {}, fidelity: "image", dropped: [`image-fallback-disabled:${model.type}`] };
    return imageFallback(svg, width, height, palette, scale, model.type);
  }

  try {
    return flowchartToExcalidraw(model, svg, palette, scale, opts.fontFamily, opts.groups ?? true);
  } catch {
    if (opts.imageFallback === "none") return { elements: [], files: {}, fidelity: "image", dropped: [`native-conversion-failed:${model.type}`, "image-fallback-disabled"] };
    const fb = imageFallback(svg, width, height, palette, scale, model.type);
    fb.dropped.unshift("native-conversion-failed:flowchart");
    return fb;
  }
}

function flowchartToExcalidraw(
  model: FlowchartModel,
  svg: string, palette: Record<string, string>, scale: number, fontFamily: number | undefined, groups: boolean,
): PeleToExcalidrawResult {
  const geo = extractGeometry(svg);
  const dropped: string[] = [];
  const nodes: FlowNodeLike[] = [...model.nodes.values()];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // Nodes present in SVG but not in model (defensive): synthesise from geometry
  for (const [id, g] of geo.nodes) if (!nodeById.has(id)) { const n = { id, text: g.label }; nodes.push(n); nodeById.set(id, n); }

  const surface = paletteValue(palette, "--pele-surface");
  const altSurface = paletteValue(palette, "--pele-surface-alt");
  const border = paletteValue(palette, "--pele-border");
  const fg = paletteValue(palette, "--pele-fg");
  const line = paletteValue(palette, "--pele-line");
  // Excalidraw's CLI `create` rejects label.strokeColor, as it does groupIds: groups:false leaves both out.
  const textColor = (c: string) => (groups ? { strokeColor: c } : {});

  const classDefs = model.classes;

  // ---- normalisation offset
  let minX = Infinity, minY = Infinity;
  for (const g of geo.nodes.values()) { minX = Math.min(minX, g.bbox.x); minY = Math.min(minY, g.bbox.y); }
  for (const c of geo.clusters.values()) { minX = Math.min(minX, c.bbox.x); minY = Math.min(minY, c.bbox.y); }
  for (const e of geo.edges.values()) for (const [x, y] of pathToPoints(e.d)) { minX = Math.min(minX, x); minY = Math.min(minY, y); }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; }
  const X = (x: number) => (x - minX) * scale;
  const Y = (y: number) => (y - minY) * scale;

  const elements: ExcalidrawElementSkeleton[] = [];
  const emittedNodeIds = new Set<string>();

  const outlines = new Map<string, Outline>();
  const grownNodes = new Set<string>();
  const nodeParts = new Map<string, string[]>();

  for (const node of nodes) {
    const g = geo.nodes.get(node.id);
    if (!g) { dropped.push(`node-missing-geometry:${node.id}`); continue; }
    const id = nodeSkeletonId(node.id);
    emittedNodeIds.add(node.id);
    const { kind, unknown } = shapeKind(node.type ?? "", g.shapeClass);
    if (unknown) dropped.push(`shape-degraded:${node.id}:${unknown}->rectangle`);

    // author styles: classDefs + node styles; literal SVG colours win
    // label text: the text colour (as in Pele's SVG), or the author's `color:`; never the border
    let fill = surface, strokeC = border, textC = fg;
    for (const cls of node.classes ?? []) { const st = styleMap(classDefs.get(cls)?.styles); fill = st.get("fill") || fill; strokeC = st.get("stroke") || strokeC; textC = st.get("color") || textC; }
    const own = styleMap(node.styles); fill = own.get("fill") || fill; strokeC = own.get("stroke") || strokeC; textC = own.get("color") || textC;
    if (g.fill) fill = g.fill; if (g.stroke) strokeC = g.stroke;

    const label = { text: labelText(node.text ?? g.label ?? node.id), fontSize: 16 * scale, ...(fontFamily !== undefined ? { fontFamily } : {}), textAlign: "center" as const, verticalAlign: "middle" as const, ...textColor(textC) };
    const built = buildNode(id, node.id, kind, g, label, { fill, stroke: strokeC }, X, Y, scale, groups ? groupId(node.id) : undefined, node.link);
    elements.push(...built.elements);
    dropped.push(...built.dropped);
    outlines.set(node.id, built.outline);
    nodeParts.set(node.id, built.elements.map((e) => e.id));
    if (built.grown) { grownNodes.add(node.id); dropped.push(`node-grown-for-label:${node.id}`); }
  }

  // grown nodes can reach neighbours (no relayout): report every overlap involving one
  const hostBoxes = nodes.filter((n) => emittedNodeIds.has(n.id)).map((n) => ({ id: n.id, el: elements.find((e) => e.id === nodeSkeletonId(n.id))! }));
  for (let i = 0; i < hostBoxes.length; i++) for (let j = i + 1; j < hostBoxes.length; j++) {
    const a = hostBoxes[i], b = hostBoxes[j];
    if (!grownNodes.has(a.id) && !grownNodes.has(b.id)) continue;
    const ox = Math.min(a.el.x! + a.el.width!, b.el.x! + b.el.width!) - Math.max(a.el.x!, b.el.x!);
    const oy = Math.min(a.el.y! + a.el.height!, b.el.y! + b.el.height!) - Math.max(a.el.y!, b.el.y!);
    if (ox > 0.5 && oy > 0.5) dropped.push(`node-overlap:${a.id}:${b.id}`);
  }

  // ---- edges
  const edgeSkeletonByModelId = new Map<string, string>();
  for (const [idx, edge] of (model.edges ?? []).entries()) {
    const edgeId = edge.id ?? `L_${edge.start}_${edge.end}_${idx}`;
    const sid = edgeSkeletonId(edgeId);
    edgeSkeletonByModelId.set(edgeId, sid);
    const eg = geo.edges.get(edgeId);
    const ptsAbs = eg ? pathToPoints(eg.d) : [];
    if (ptsAbs.length < 2) { dropped.push(`edge-missing-geometry:${edgeId}`); continue; }
    let out: Pt[] = ptsAbs.map(([x, y]) => [X(x), Y(y)]);
    const startOutline = grownNodes.has(edge.start) ? outlines.get(edge.start) : undefined;
    const endOutline = grownNodes.has(edge.end) ? outlines.get(edge.end) : undefined;
    if (startOutline) out = clipStart(out, startOutline);
    if (endOutline) out = clipEnd(out, endOutline);
    const [x0, y0] = out[0];
    const points: [number, number][] = out.map(([x, y]) => [x - x0, y - y0]);
    const heads = arrowheads(edge.type, eg?.markers ?? 1);
    const bindStart = emittedNodeIds.has(edge.start), bindEnd = emittedNodeIds.has(edge.end);
    if (!bindStart) dropped.push(`edge-endpoint-missing:${edgeId}:start:${edge.start}`);
    if (!bindEnd) dropped.push(`edge-endpoint-missing:${edgeId}:end:${edge.end}`);
    const dashed = edge.stroke === "dotted" || eg?.dashed || (edge.style ?? []).some((s) => s.includes("dash"));
    const thick = edge.stroke === "thick" || eg?.thick;
    elements.push({
      id: sid, type: "arrow", x: x0, y: y0, angle: 0,
      strokeColor: line, backgroundColor: "transparent", strokeWidth: thick ? 4 : 2,
      strokeStyle: dashed ? "dashed" : "solid", roundness: { type: 2 },
      points, startArrowhead: heads.start, endArrowhead: heads.end,
      ...(bindStart ? { start: { id: nodeSkeletonId(edge.start) } } : {}),
      ...(bindEnd ? { end: { id: nodeSkeletonId(edge.end) } } : {}),
      ...(edge.text ? { label: { text: labelText(edge.text), fontSize: 14 * scale, ...(fontFamily !== undefined ? { fontFamily } : {}) } } : {}),
    });
    if (edge.text) {
      // arrow labels can't be resized: Excalidraw wraps them at words; flag only a mid-word break risk
      const xs = points.map((p) => p[0]);
      if (longestWordWidth(labelText(edge.text), 14 * scale, fontFamily) > arrowLabelMaxWidth(Math.max(...xs) - Math.min(...xs), 14 * scale)) dropped.push(`edge-label-word-too-wide:${edgeId}`);
    }
  }

  // ---- clusters -> frames (outermost wins; nested -> rectangle)
  const subgraphs = model.subgraphs ?? [];
  const sorted = [...subgraphs].sort((a, b) => {
    const area = (id: string) => { const c = geo.clusters.get(id); return c ? c.bbox.width * c.bbox.height : 0; };
    return area(b.id) - area(a.id);
  });
  const claimed = new Set<string>();
  const frameElements: ExcalidrawElementSkeleton[] = [];
  for (const sg of sorted) {
    const c = geo.clusters.get(sg.id);
    if (!c) { dropped.push(`cluster-missing-geometry:${sg.id}`); continue; }
    const memberNodes = (sg.nodes ?? []).filter((n) => emittedNodeIds.has(n));
    const unclaimed = memberNodes.filter((n) => !claimed.has(nodeSkeletonId(n)));
    const title = sg.title ?? c.title ?? sg.id;
    if (unclaimed.length === memberNodes.length && memberNodes.length > 0 || (memberNodes.length === 0 && claimed.size === 0)) {
      const children: string[] = [];
      for (const n of memberNodes) { const nid = nodeSkeletonId(n); if (!claimed.has(nid)) { claimed.add(nid); children.push(...(nodeParts.get(n) ?? [nid])); } }
      for (const [modelEdgeId, sid] of edgeSkeletonByModelId) {
        const e = (model.edges ?? []).find((x) => (x.id ?? "") === modelEdgeId);
        if (e && memberNodes.includes(e.start) && memberNodes.includes(e.end) && !claimed.has(sid)) { claimed.add(sid); children.push(sid); }
      }
      frameElements.push({ id: clusterSkeletonId(sg.id), type: "frame", name: title || null, children });
    } else {
      elements.push({ id: clusterSkeletonId(sg.id), type: "rectangle", x: X(c.bbox.x), y: Y(c.bbox.y), width: c.bbox.width * scale, height: c.bbox.height * scale, angle: 0, strokeColor: border, backgroundColor: altSurface, fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", label: { text: title, fontSize: 14 * scale, ...(fontFamily !== undefined ? { fontFamily } : {}), ...textColor(fg) } });
      dropped.push(`cluster-nested:${sg.id}:rectangle-instead-of-frame`);
    }
  }

  // grown nodes may poke past Pele's origin: re-normalise so the scene starts at (0,0)
  let shiftX = Infinity, shiftY = Infinity;
  for (const e of elements) {
    if (e.x === undefined || e.y === undefined) continue;
    const px = e.points?.map((p) => p[0]) ?? [0], py = e.points?.map((p) => p[1]) ?? [0];
    shiftX = Math.min(shiftX, e.x + Math.min(...px)); shiftY = Math.min(shiftY, e.y + Math.min(...py));
  }
  if (Number.isFinite(shiftX) && (Math.abs(shiftX) > 1e-9 || Math.abs(shiftY) > 1e-9)) for (const e of elements) { if (e.x !== undefined) e.x -= shiftX; if (e.y !== undefined) e.y -= shiftY; }

  return { elements: [...frameElements, ...elements], files: {}, fidelity: "native", dropped };
}

// ---- Minimal materialiser for headless .excalidraw JSON (native subset) ----

function seedFrom(id: string): number { return parseInt(fnv1a(id), 16) % 2147483647; }

export function materialiseElements(skeletons: ExcalidrawElementSkeleton[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const bound = new Map<string, { id: string; type: string }[]>();
  const addBound = (elId: string, entry: { id: string; type: string }) => { const a = bound.get(elId) ?? []; a.push(entry); bound.set(elId, a); };
  const frameOf = new Map<string, string>();
  for (const s of skeletons) if (s.type === "frame") for (const ch of s.children ?? []) frameOf.set(ch, s.id);

  for (const s of skeletons) {
    if (s.type === "frame") {
      out.push({ id: s.id, type: "frame", x: 0, y: 0, width: 0, height: 0, angle: 0, strokeColor: "transparent", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null, seed: seedFrom(s.id), version: 1, versionNonce: seedFrom(s.id + ":n"), isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, name: s.name ?? null, children: undefined });
      continue;
    }
    if (s.type === "image") {
      out.push({ id: s.id, type: "image", x: s.x ?? 0, y: s.y ?? 0, width: s.width ?? 0, height: s.height ?? 0, angle: 0, strokeColor: "transparent", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: frameOf.get(s.id) ?? null, index: null, roundness: null, seed: seedFrom(s.id), version: 1, versionNonce: seedFrom(s.id + ":n"), isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, status: s.status ?? "saved", fileId: s.fileId ?? null, scale: s.scale ?? [1, 1], crop: null });
      continue;
    }
    const labelId = s.label ? `${s.id}_label` : undefined;
    if (labelId) addBound(s.id, { id: labelId, type: "text" });
    if (s.type === "arrow") {
      if (s.start) addBound(s.start.id, { id: s.id, type: "arrow" });
      if (s.end) addBound(s.end.id, { id: s.id, type: "arrow" });
    }
    const el: Record<string, unknown> = {
      id: s.id, type: s.type, x: s.x ?? 0, y: s.y ?? 0, width: s.width ?? 0, height: s.height ?? 0, angle: s.angle ?? 0,
      strokeColor: s.strokeColor ?? "#1e1e1e", backgroundColor: s.backgroundColor ?? "transparent",
      fillStyle: s.fillStyle ?? "solid", strokeWidth: s.strokeWidth ?? 2, strokeStyle: s.strokeStyle ?? "solid",
      roughness: 1, opacity: s.opacity ?? 100, groupIds: s.groupIds ?? [], frameId: frameOf.get(s.id) ?? null, index: null,
      roundness: s.roundness ?? null, seed: seedFrom(s.id), version: 1, versionNonce: seedFrom(s.id + ":n"),
      isDeleted: false, boundElements: null, updated: 1, link: s.link ?? null, locked: false,
    };
    if (s.type === "arrow" || s.type === "line") {
      el.points = s.points ?? [[0, 0], [s.width ?? 0, s.height ?? 0]];
      el.lastCommittedPoint = null;
      el.startBinding = s.start ? { elementId: s.start.id, focus: 0, gap: 1, fixedPoint: null } : null;
      el.endBinding = s.end ? { elementId: s.end.id, focus: 0, gap: 1, fixedPoint: null } : null;
      el.startArrowhead = s.startArrowhead ?? null;
      el.endArrowhead = s.endArrowhead ?? null;
      if (s.width === undefined) { const pts = (el.points as [number, number][]); el.width = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])); el.height = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])); }
    }
    if (s.type === "text") { el.text = s.text ?? s.label?.text ?? ""; el.fontSize = s.fontSize ?? 16; el.fontFamily = s.fontFamily ?? 1; el.textAlign = "left"; el.verticalAlign = "top"; el.containerId = null; el.originalText = el.text; el.lineHeight = 1.25; }
    out.push(el);
    if (labelId && s.label) {
      out.push({ id: labelId, type: "text", x: s.x ?? 0, y: s.y ?? 0, width: s.width ?? 0, height: s.height ?? 0, angle: 0, strokeColor: s.label.strokeColor ?? s.strokeColor ?? "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: s.label.groupIds ?? s.groupIds ?? [], frameId: frameOf.get(s.id) ?? null, index: null, roundness: null, seed: seedFrom(labelId), version: 1, versionNonce: seedFrom(labelId + ":n"), isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, text: s.label.text, fontSize: s.label.fontSize ?? 16, fontFamily: s.label.fontFamily ?? 1, textAlign: s.label.textAlign ?? "center", verticalAlign: s.label.verticalAlign ?? "middle", containerId: s.id, originalText: s.label.text, lineHeight: 1.25 });
    }
  }
  for (const el of out) { const b = bound.get(el.id as string); el.boundElements = b && b.length ? b : (el.type === "frame" ? null : []); if (el.type === "frame") delete el.children; }
  return out;
}

export function buildExcalidrawFile(source: string, opts: PeleToExcalidrawOptions = {}): { file: Record<string, unknown>; result: PeleToExcalidrawResult } {
  const result = peleToExcalidraw(source, opts);
  const files: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result.files)) files[k] = { mimeType: v.mimeType, dataURL: v.dataURL, lastRetrieved: v.created };
  return { result, file: { type: "excalidraw", version: 2, source: "pele-render", elements: materialiseElements(result.elements), appState: { gridSize: null }, files } };
}
