/** Pure re-measure convergence: reservations vs in-place measured sizes. */
import type { MehrpeleLabelSize } from "./model";

export interface SizedAnchor {
  anchorId: string;
  size: MehrpeleLabelSize;
  /** Per-anchor cap (images, nested diagrams); the options' maxima otherwise. */
  max?: MehrpeleLabelSize;
}

export interface RemeasureOptions {
  /** Differences at or below this (SVG units) are stable. */
  tolerance?: number;
  maxWidth: number;
  maxHeight: number;
  /** Max extra Pele re-renders per cycle. */
  maxPasses?: number;
}

export interface RemeasureDecision {
  changed: boolean;
  /** Next reservations (only meaningful when changed). */
  next: SizedAnchor[];
  /** Whether another pass may run after applying `next`. */
  mayContinue: boolean;
}

/**
 * In-place size of an overlay label in SVG user units. Overlay content is
 * laid out at 1:1 and CSS-scaled with the diagram, so its *layout* box
 * (offsetWidth/Height, transform-independent) already is in SVG units; the
 * transformed client rect divided by the scale is used as a sub-pixel
 * cross-check (whichever is larger wins, so rounding never under-reserves).
 */
export function intrinsicSvgSize(
  layout: { offsetWidth: number; offsetHeight: number },
  client: { width: number; height: number } | null,
  scale: number,
): MehrpeleLabelSize {
  const fromClient = client && Number.isFinite(scale) && scale > 0
    ? { width: client.width / scale, height: client.height / scale }
    : { width: 0, height: 0 };
  return {
    width: Math.max(1, Math.ceil(Math.max(layout.offsetWidth, fromClient.width) - 0.01)),
    height: Math.max(1, Math.ceil(Math.max(layout.offsetHeight, fromClient.height) - 0.01)),
  };
}

/** Convert a client-px box to SVG user units at the current viewBox scale. */
export function clientToSvgSize(
  client: { width: number; height: number },
  scale: number,
): MehrpeleLabelSize {
  if (!Number.isFinite(scale) || scale <= 0) return { width: 1, height: 1 };
  return {
    width: Math.max(1, Math.ceil(client.width / scale)),
    height: Math.max(1, Math.ceil(client.height / scale)),
  };
}

function clampSize(size: MehrpeleLabelSize, o: RemeasureOptions): MehrpeleLabelSize {
  return {
    width: Math.max(1, Math.min(Math.ceil(size.width), o.maxWidth)),
    height: Math.max(1, Math.min(Math.ceil(size.height), o.maxHeight)),
  };
}

/**
 * Compare current reservations with in-place measurements. Changed entries
 * adopt the (clamped) measured size; convergence is reached when every
 * difference is within tolerance or the pass budget is exhausted.
 */
export function decideRemeasure(
  current: readonly SizedAnchor[],
  measured: readonly SizedAnchor[],
  pass: number,
  o: RemeasureOptions,
): RemeasureDecision {
  const tol = o.tolerance ?? 2;
  const maxPasses = o.maxPasses ?? 2;
  const measuredById = new Map(measured.map((m) => [m.anchorId, m.size]));
  let changed = false;
  const next = current.map((c) => {
    const m = measuredById.get(c.anchorId);
    if (!m) return c;
    const target = clampSize(m, c.max ? { ...o, maxWidth: c.max.width, maxHeight: c.max.height } : o);
    if (Math.abs(target.width - c.size.width) > tol || Math.abs(target.height - c.size.height) > tol) {
      changed = true;
      return { anchorId: c.anchorId, size: target };
    }
    return c;
  });
  return { changed, next, mayContinue: changed && pass < maxPasses };
}
