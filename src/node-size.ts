/**
 * Per-node box resizing, pure part: drag geometry and the source edits a
 * committed drag makes. Sizes are SVG units (diagram units), stored in the
 * block's `%% pele-size … %%` line (pele-render/node-size), so they survive
 * re-layouts and direction switches.
 */
import { nodeSizeCaps, parseSizeDirective, withNodeSize, type NodeSize, type SizeCaps } from "pele-render/node-size";
import { extractBlocks } from "./extract-blocks";

export type { NodeSize, SizeCaps };

/** Box bounds (SVG units). */
export const NODE_BOX_MIN = 16;
export const NODE_BOX_MAX = 1600;

export interface Box {
  w: number;
  h: number;
}

export interface DragBoxOptions {
  /** Height step (one label line, 1.5 em); 0 = no snapping. */
  lineHeight: number;
  min?: number;
  max?: number;
}

/**
 * Box size during a box-handle drag. Nodes are centred, so the corner moves
 * half as far as the box grows: both axes take twice the pointer delta.
 * Square-locked nodes follow the larger delta; height snaps to whole lines
 * (what Pele can render), so the ghost shows the size that will be written.
 */
export function dragNodeBox(start: Box, delta: { x: number; y: number }, caps: SizeCaps, o: DragBoxOptions): Box {
  const lo = o.min ?? NODE_BOX_MIN;
  const hi = o.max ?? NODE_BOX_MAX;
  const clamp = (v: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  if (caps.lock === "square") {
    const s = Math.round(clamp(Math.max(start.w + 2 * delta.x, start.h + 2 * delta.y)));
    return { w: s, h: s };
  }
  const w = caps.w ? clamp(start.w + 2 * delta.x) : start.w;
  let h = caps.h ? clamp(start.h + 2 * delta.y) : start.h;
  if (caps.h && o.lineHeight > 0) {
    h = start.h + Math.round((h - start.h) / o.lineHeight) * o.lineHeight;
    while (h < lo) h += o.lineHeight;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

/**
 * The entry a finished drag writes: only the dimensions that changed, merged
 * with the node's existing entry. null = nothing changed (no write).
 */
export function committedEntry(start: Box, end: Box, existing: NodeSize | undefined, caps: SizeCaps): NodeSize | null {
  const dw = caps.w && Math.abs(end.w - start.w) >= 1;
  const dh = caps.h && caps.lock !== "square" && Math.abs(end.h - start.h) >= 1;
  if (!dw && !dh) return null;
  const next: NodeSize = { ...(existing ?? {}) };
  if (dw) next.w = Math.round(end.w);
  if (dh) next.h = Math.round(end.h);
  if (caps.lock === "square") delete next.h;
  if (!caps.w) delete next.w;
  if (existing && existing.w === next.w && existing.h === next.h) return null;
  return next;
}

/**
 * Prefer the size that actually renders when the solver had to clamp (a
 * coupled shape, a word that cannot wrap): the line then states the result.
 */
export function settleEntry(want: NodeSize, applied: Box | null, tolerance = 2): NodeSize {
  if (!applied) return want;
  const pick = (v: number, got: number) => (Math.abs(v - got) <= tolerance ? v : Math.round(got));
  return {
    ...(want.w !== undefined ? { w: pick(want.w, applied.w) } : {}),
    ...(want.h !== undefined ? { h: pick(want.h, applied.h) } : {}),
  };
}

/** An entry that states (within 1 unit) the box a node already has. */
export function isSameBox(size: NodeSize, box: Box): boolean {
  return (size.w === undefined || Math.abs(size.w - box.w) <= 1) && (size.h === undefined || Math.abs(size.h - box.h) <= 1);
}

/** Set or remove one node's entry, pruning entries for nodes that are gone. */
export function writeNodeSize(source: string, id: string, size: NodeSize | null): string {
  const caps = nodeSizeCaps(source);
  // The node vanished (source edited mid-drag): nothing to size.
  if (size && caps && !caps.has(id)) return source;
  return withNodeSize(source, id, size, caps ? { keep: (k) => caps.has(k) } : {});
}

/** The node's current entry, if any. */
export function nodeSizeEntry(source: string, id: string): NodeSize | undefined {
  return parseSizeDirective(source).get(id);
}

/** Box padding Pele adds around a node label (flowchart rect at 16 px). */
export const BOX_PAD = { w: 36, h: 24 };

/**
 * A media node's content was resized (image `|W`, embed `|WxH`, nested
 * `width=`): its box entry, when it has one, moves by the same delta so the
 * margin the user chose is kept. A dimension that would fall under the new
 * content plus padding is dropped (the box follows the content again).
 */
export function shiftBoxEntry(
  source: string,
  id: string,
  delta: { dw: number; dh: number },
  content: { width: number; height: number },
  pad: { w: number; h: number } = BOX_PAD,
): string {
  const cur = parseSizeDirective(source).get(id);
  if (!cur) return source;
  const next: NodeSize = {};
  if (cur.w !== undefined) {
    const w = Math.round(cur.w + delta.dw);
    if (w >= content.width + pad.w) next.w = w;
  }
  if (cur.h !== undefined) {
    const h = Math.round(cur.h + delta.dh);
    if (h >= content.height + pad.h) next.h = h;
  }
  return withNodeSize(source, id, next.w === undefined && next.h === undefined ? null : next);
}

/**
 * A media node's content handle dragged to a box larger than the content
 * it now shows (an image dragged against its aspect): its box entry moves
 * with the content as shiftBoxEntry does, then grows on each axis where the
 * dragged box is larger than the content, to that box plus the padding.
 * The content is centred in the taller/wider node.
 */
export function fitBoxEntry(
  source: string,
  id: string,
  delta: { dw: number; dh: number },
  content: { width: number; height: number },
  box: { width: number; height: number },
  pad: { w: number; h: number } = BOX_PAD,
  /** The node's rendered box before the edit: it grows by exactly the dragged excess. */
  node?: { w: number; h: number },
): string {
  const out = shiftBoxEntry(source, id, delta, content, pad);
  const cur = parseSizeDirective(out).get(id) ?? {};
  const next: NodeSize = { ...cur };
  let grew = false;
  const want = (axis: "w" | "h"): number => {
    const excess = axis === "w" ? box.width - content.width : box.height - content.height;
    const d = axis === "w" ? delta.dw : delta.dh;
    if (node && node[axis] > 0) return Math.round(node[axis] + d + excess);
    return Math.round((axis === "w" ? box.width : box.height) + pad[axis]);
  };
  if (box.width > content.width + 0.5) {
    const w = want("w");
    if (!(cur.w !== undefined && cur.w >= w)) {
      next.w = w;
      grew = true;
    }
  }
  if (box.height > content.height + 0.5) {
    const h = want("h");
    if (!(cur.h !== undefined && cur.h >= h)) {
      next.h = h;
      grew = true;
    }
  }
  return grew ? withNodeSize(out, id, next) : out;
}

/** Remove every entry for nodes the diagram no longer has. */
export function pruneStaleSizes(source: string): string {
  const caps = nodeSizeCaps(source);
  if (!caps) return source;
  const sizes = parseSizeDirective(source);
  let out = source;
  for (const id of sizes.keys()) if (!caps.has(id)) out = withNodeSize(out, id, null);
  return out;
}

/** Remove every entry (the line goes too). */
export function clearNodeSizes(source: string): string {
  let out = source;
  for (const id of parseSizeDirective(source).keys()) out = withNodeSize(out, id, null);
  return out;
}

/** One block body to replace (0-based inclusive body lines). */
export interface NoteSizeEdit {
  firstLine: number;
  lastLine: number;
  body: string;
}

/**
 * "Remove stale node sizes in this note": per diagram block, the body with
 * entries for vanished nodes removed. Blocks that need no change are omitted.
 */
export function pruneNoteSizes(markdown: string): NoteSizeEdit[] {
  const out: NoteSizeEdit[] = [];
  for (const b of extractBlocks(markdown, ["mermaid", "pele", "mehrpele"])) {
    if (b.endLine <= b.startLine + 1) continue;
    // Closed fences only: the body is exactly the lines between the fences
    // (extractBlocks joins them with "\n", so trailing blank lines are kept).
    if (b.code.split("\n").length !== b.endLine - b.startLine - 1) continue;
    const next = pruneStaleSizes(b.code);
    if (next === b.code) continue;
    out.push({ firstLine: b.startLine + 1, lastLine: b.endLine - 1, body: next });
  }
  return out;
}
