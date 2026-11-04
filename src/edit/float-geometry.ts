/** Pure geometry for floating a clipped action bar (float-actions.ts). */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Edge gap (px) to the viewport, and the bar's inset from the frame's corner. */
const EDGE = 4;
const INSET = 2;
/** Sub-pixel slack for the clip test (scaled chrome rounds). */
const SLACK = 0.5;

export function intersect(a: Rect, b: Rect): Rect {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}

export function isEmpty(r: Rect): boolean {
  return r.right <= r.left || r.bottom <= r.top;
}

/** True when `bar` is not wholly inside `clip`. */
export function isClipped(bar: Rect, clip: Rect): boolean {
  return bar.left < clip.left - SLACK || bar.top < clip.top - SLACK || bar.right > clip.right + SLACK || bar.bottom > clip.bottom + SLACK;
}

/**
 * Where the floated bar goes: right-aligned to the frame's visible top-right
 * corner (inset like the in-frame bar), shifted into the viewport.
 */
export function floatBarBox(visible: Rect, size: { width: number; height: number }, viewport: Rect): { left: number; top: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  return {
    left: clamp(visible.right - INSET - size.width, viewport.left + EDGE, viewport.right - EDGE - size.width),
    top: clamp(visible.top + INSET, viewport.top + EDGE, viewport.bottom - EDGE - size.height),
  };
}
