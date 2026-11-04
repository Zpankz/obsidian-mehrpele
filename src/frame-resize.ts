/**
 * Frame resize corner, pure part. The corner is a physical handle: it
 * follows the pointer on each axis independently (no aspect lock). The
 * frame is centred, so its right edge moves half as far as its width grows
 * (width = start + 2 × dx); its top stays put, so the bottom edge follows dy.
 *
 * What gets written is the box, never a zoom: `width=W` alone (height
 * follows the chart, which reflows to the width and is never magnified), or
 * `width=W height=H` once the drag moved the bottom edge (or the frame
 * already had a height, or a legacy `zoom=` that needs a box to keep its
 * size). A W×H box picks the layout that fills it best and scales it up to
 * fill (reflow/plan.ts planFill), so a bigger box never shows a smaller
 * chart. Legacy `zoom=` is dropped by that write (migrated on the next drag,
 * never on render).
 */

/** Frame as shown when the drag started (layout px). */
export interface FrameStart {
  /** Box width: where the corner sits (a `width=` box can be wider than the chart). */
  width: number;
  /** Frame height: an explicit box height, else the chart's. */
  height: number;
  /** The fence has `height=` (the box keeps a height whatever the drag). */
  hasHeight?: boolean;
  /** The fence has a legacy `zoom=` (its size needs a box height to survive the drag). */
  legacyZoom?: boolean;
}

export interface FrameBounds {
  min: number;
  max: number;
  minHeight: number;
  maxHeight: number;
  /** A box height may be written (reflow on, no legacy magnify, not a Canvas card; nested frames too). */
  boxable: boolean;
}

export interface FrameSize {
  /** Box width (fence `width=`), layout px. */
  width: number;
  /** Box height (fence `height=`), or undefined for none (height follows the chart). */
  height: number | undefined;
  /**
   * A box does not apply here (Canvas card, legacy sizing, reflow off): the
   * fence's own `height=`/`zoom=` are left as they are.
   */
  keepZoom?: boolean;
}

/** Vertical travel (layout px) that makes a corner drag set the box height. */
export const VERTICAL_INTENT = 6;
/** Box height bounds. */
export const MIN_BOX_HEIGHT = 40;
export const MAX_BOX_HEIGHT = 4000;

/**
 * The fence size for a corner drag of (dx, dy) layout px, or null when the
 * drag changes nothing (no write, no preview change).
 */
export function resolveFrameDrag(start: FrameStart, dx: number, dy: number, b: FrameBounds): FrameSize | null {
  const lo = Math.max(1, b.min);
  const hi = Math.max(lo, b.max);
  // Whole px, the start rounded up: a box never starts smaller than the frame shown.
  const w0 = Math.ceil(start.width - 1e-6);
  const h0 = Math.ceil(start.height - 1e-6);
  const width = Math.min(Math.max(w0 + Math.round(2 * dx), lo), Math.floor(hi));
  if (!b.boxable) return width === w0 ? null : { width, height: undefined, keepZoom: true };
  const boxed = !!start.hasHeight || !!start.legacyZoom || Math.abs(dy) >= VERTICAL_INTENT;
  const hlo = Math.max(1, b.minHeight);
  const hhi = Math.max(hlo, b.maxHeight);
  const height = boxed ? Math.min(Math.max(h0 + Math.round(dy), hlo), Math.floor(hhi)) : undefined;
  if (width === w0 && (height === undefined || height === h0)) return null;
  return { width, height };
}

/** Same fence size (no write). A size that keeps the zoom compares widths only. */
export function sameFrameSize(
  a: { width?: number | undefined; height?: number | undefined; keepZoom?: boolean },
  b: { width?: number | undefined; height?: number | undefined; zoom?: number | undefined },
): boolean {
  if (a.keepZoom) return (a.width ?? null) === (b.width ?? null);
  return (a.width ?? null) === (b.width ?? null) && (a.height ?? null) === (b.height ?? null) && (b.zoom ?? null) === null;
}

/**
 * Legacy `zoom=` shown for a box in a column (blocks written before the box
 * model): a column narrower than the box shrinks the zoom first, keeping the
 * layout; only at 1× does the layout reflow. A wider column never raises it.
 */
export function effectiveZoom(zoom: number | undefined, box: number | undefined, column: number): number {
  if (zoom === undefined || !(zoom > 1)) return 1;
  if (box === undefined || !(box > 0) || !(column > 0) || column >= box) return zoom;
  return Math.max(1, (zoom * column) / box);
}
