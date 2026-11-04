/**
 * Where the edit toolbar and its submenus go (pure, client px). Nothing the
 * toolbar opens may cover the selected element(s): the toolbar sits beyond
 * the "+" buttons' band above (or below) the selection, and a submenu opens
 * on the far side of the toolbar, away from the selection, flipping or
 * moving sideways when the visible area (scroll container ∩ viewport) has no
 * room there.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Margin kept from the visible area's edges. */
export const EDGE = 4;
/** Gap between a submenu and what it hangs from. */
export const SUB_GAP = 6;

const right = (b: Box) => b.left + b.width;
const bottom = (b: Box) => b.top + b.height;

export function intersects(a: Box, b: Box): boolean {
  return a.left < right(b) && b.left < right(a) && a.top < bottom(b) && b.top < bottom(a);
}

function inside(b: Box, bounds: Box): boolean {
  return b.left >= bounds.left + EDGE - 0.5 && b.top >= bounds.top + EDGE - 0.5 && right(b) <= right(bounds) - EDGE + 0.5 && bottom(b) <= bottom(bounds) - EDGE + 0.5;
}

function clampX(left: number, width: number, bounds: Box): number {
  return Math.min(Math.max(left, bounds.left + EDGE), Math.max(bounds.left + EDGE, right(bounds) - width - EDGE));
}

function clampY(top: number, height: number, bounds: Box): number {
  return Math.min(Math.max(top, bounds.top + EDGE), Math.max(bounds.top + EDGE, bottom(bounds) - height - EDGE));
}

export type Side = "above" | "below";

/**
 * The toolbar: centred over the target, `band` px beyond it (the "+"
 * buttons' reach, so the top "+" and the toolbar never overlap). Above when
 * it fits, else below, else whichever side has more room.
 */
export function placeToolbar(target: Box, menu: Size, bounds: Box, band: number): Box & { side: Side } {
  const left = clampX(target.left + target.width / 2 - menu.width / 2, menu.width, bounds);
  const above = target.top - band - menu.height;
  const below = bottom(target) + band;
  let side: Side;
  if (above >= bounds.top + EDGE) side = "above";
  else if (below + menu.height <= bottom(bounds) - EDGE) side = "below";
  else side = target.top - bounds.top >= bottom(bounds) - bottom(target) ? "above" : "below";
  const top = side === "above" ? above : below;
  return { left, top, width: menu.width, height: menu.height, side };
}

/**
 * A submenu hanging from the toolbar, never over `avoid` (the selection and
 * the "+" band) or the toolbar: first on the toolbar's far side, then beside
 * both, then the near side; the first candidate that fits the visible area
 * whole wins. When none does (a tall menu in a short window) it goes where
 * it fits across, with `maxHeight` set so it scrolls instead of covering.
 */
export function placeSubmenu(
  toolbar: Box & { side: Side },
  sub: Size,
  bounds: Box,
  avoid: Box[],
): Box & { side: Side | "left" | "right"; maxHeight?: number } {
  const all = [...avoid, toolbar];
  const hull = all.reduce((a, b) => {
    const l = Math.min(a.left, b.left);
    const t = Math.min(a.top, b.top);
    return { left: l, top: t, width: Math.max(right(a), right(b)) - l, height: Math.max(bottom(a), bottom(b)) - t };
  });
  const cx = toolbar.left + toolbar.width / 2 - sub.width / 2;
  const far: Side = toolbar.side;
  const near: Side = far === "above" ? "below" : "above";
  const room = {
    above: hull.top - SUB_GAP - (bounds.top + EDGE),
    below: bottom(bounds) - EDGE - (bottom(hull) + SUB_GAP),
    left: hull.left - SUB_GAP - (bounds.left + EDGE),
    right: right(bounds) - EDGE - (right(hull) + SUB_GAP),
  };
  const at = (side: Side | "left" | "right", h = sub.height): Box => {
    switch (side) {
      case "above":
        return { left: clampX(cx, sub.width, bounds), top: hull.top - SUB_GAP - h, width: sub.width, height: h };
      case "below":
        return { left: clampX(cx, sub.width, bounds), top: bottom(hull) + SUB_GAP, width: sub.width, height: h };
      case "left":
        return { left: hull.left - SUB_GAP - sub.width, top: clampY(toolbar.top, h, bounds), width: sub.width, height: h };
      case "right":
        return { left: right(hull) + SUB_GAP, top: clampY(toolbar.top, h, bounds), width: sub.width, height: h };
    }
  };
  const clean = (b: Box) => inside(b, bounds) && !all.some((a) => intersects(a, b));
  for (const side of [far, "right", "left", near] as const) {
    const b = at(side);
    if (clean(b)) return { ...b, side };
  }
  // Nothing fits whole: beside (full visible height, scrolling) when it fits
  // across, else the roomier vertical side, shortened to its room.
  const tall = bounds.height - 2 * EDGE;
  for (const side of ["right", "left"] as const) {
    if (room[side] < sub.width) continue;
    const h = Math.min(sub.height, tall);
    const b = { ...at(side, h), top: bounds.top + EDGE + Math.max(0, Math.min(toolbar.top - bounds.top - EDGE, tall - h)) };
    if (clean(b)) return { ...b, side, ...(h < sub.height ? { maxHeight: h } : {}) };
  }
  const side: Side = room[far] >= room[near] ? far : near;
  const h = Math.max(48, Math.min(sub.height, room[side]));
  return { ...at(side, h), side, ...(h < sub.height ? { maxHeight: h } : {}) };
}

/** The visible part of a scroll container (client px), within the viewport. */
export function visibleBounds(container: Box | null, viewport: Size): Box {
  const v: Box = { left: 0, top: 0, ...viewport };
  if (!container) return v;
  const l = Math.max(container.left, 0);
  const t = Math.max(container.top, 0);
  const r = Math.min(right(container), viewport.width);
  const b = Math.min(bottom(container), viewport.height);
  return r > l && b > t ? { left: l, top: t, width: r - l, height: b - t } : v;
}

/** Gap between the node-actions cluster and the target's corner (the resize handle sits on it). */
export const CLUSTER_GAP = 6;
/** Gap between the cluster and the node resize handle. */
export const HANDLE_GAP = 2;

/**
 * The node-actions cluster (edit, zoom, delete): just outside the target's
 * bottom-right corner, beside its resize handle and clear of the "+" buttons
 * (those sit on the sides' midpoints). Mirrored to the left corner when the
 * right has no room, above the corner when the bottom has none; then kept in
 * the visible area. `handle` (the node's resize handle, when shown at that
 * corner) is kept clear: media nodes shift it out past the corner.
 */
export function placeCluster(target: Box, size: Size, bounds: Box, handle?: Box | null): Box {
  let left = Math.max(right(target) + CLUSTER_GAP, handle ? right(handle) + HANDLE_GAP : -Infinity);
  let top = bottom(target) + CLUSTER_GAP / 2;
  if (left + size.width > right(bounds) - EDGE) left = target.left - CLUSTER_GAP - size.width;
  if (top + size.height > bottom(bounds) - EDGE) top = target.top - CLUSTER_GAP / 2 - size.height;
  return { left: clampX(left, size.width, bounds), top: clampY(top, size.height, bounds), ...size };
}
