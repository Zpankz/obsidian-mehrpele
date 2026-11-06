/** Canvas card sizes: the rule mermaidToCanvas applies and the `pele-size` line canvasToMermaid writes. */
import type { ParsedDiagramModel } from "pele";
import { parse, render } from "../pele.js";
import {
  formatSizeDirective,
  nodeBoxMap,
  nodeSizeCaps,
  withSizeDirective,
  type NodeSize,
  type NodeSizeResult,
  type SizeCaps,
} from "../node-size/index.js";
import { parseSvgGeometry, type SvgGeometry } from "../layout/svg-geom.js";
import { parseWebEmbedLabel } from "./web.js"; // view-nodes
import { shieldQuotes } from "./labels.js";
import type { OutNode } from "./types.js";
import type { AnyRec, StateModelG } from "./util.js";

/** Shape facts the Canvas size rule depends on. */
export interface CanvasShapeInfo { rawShape?: string; peleKind?: string }
export function isStartEnd(n: CanvasShapeInfo): boolean { return n.peleKind === "stateStart" || n.peleKind === "stateEnd"; }

/** Minimum Canvas card size: 80×40, 120×60 for diamonds/parallelograms, ≥40 for state start/end dots. */
export function canvasMinSize(w: number, h: number, n: CanvasShapeInfo): { w: number; h: number } {
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
export function priorNodeSizes(metaPele: AnyRec | undefined): Map<string, NodeSize> {
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
export function canvasShapeInfo(model: ParsedDiagramModel, id: string): CanvasShapeInfo {
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
export function canvasSizeDirective(body: string, outNodes: OutNode[], scale: number, prior: Map<string, NodeSize>): string {
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
    const c = caps.get(o.mermaidId); const bb = geom.nodes.get(o.mermaidId); const u = union.get(o.mermaidId);
    if (!c || !bb || !u) continue;
    const info = canvasShapeInfo(model, o.mermaidId);
    if (isStartEnd(info)) continue;
    const near = (want: { w: number; h: number }) => Math.abs(o.node.width - want.w) <= tol && Math.abs(o.node.height - want.h) <= tol;
    const was = keptPrior.get(o.mermaidId); const pb = priorGeom?.nodes.get(o.mermaidId);
    if (was && pb && near(canvasNodeSize(pb, info, scale))) { sizes.set(o.mermaidId, was); continue; }
    const want = canvasNodeSize(bb, info, scale);
    if (near(want)) continue;
    const dw = c.w && Math.abs(o.node.width - want.w) > tol;
    const dh = c.h && c.lock !== "square" && Math.abs(o.node.height - want.h) > tol;
    const sq = c.lock === "square";
    // Canvas measures the first shape, sizes the whole node box: carry the difference.
    const size: NodeSize = {};
    if (dw || sq) size.w = Math.max(1, Math.round((sq ? Math.max(o.node.width, o.node.height) : o.node.width) / scale + (u.w - bb.width)));
    if (dh) size.h = Math.max(1, Math.round(o.node.height / scale + (u.h - bb.height)));
    if (size.w !== undefined || size.h !== undefined) { sizes.set(o.mermaidId, size); fresh.add(o.mermaidId); }
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
  for (const id of prior.keys()) { const s = sizes.get(id); if (s) ordered.set(id, s); }
  for (const [id, v] of sizes) if (!ordered.has(id)) ordered.set(id, v);
  return formatSizeDirective(ordered);
}
