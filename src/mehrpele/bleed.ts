/**
 * Full-bleed nodes (pure). A node whose label is one element — a live view,
 * web page, PDF, Base, note embed, image, nested diagram or code block —
 * fills its node edge to edge: no label padding around it, the node box is
 * the element's box.
 *
 * How: Pele pads every reservation (36 × 24 for a rect) and snaps heights to
 * whole lines, so the reservation alone can never give an exact box. A bleed
 * label reserves a minimal placeholder and the render source carries an
 * in-render size entry (`pele-size` machinery, never written to the note)
 * equal to the element's size; the overlay item already covers the node's
 * rect, so the element then covers the node exactly. A user's own size entry
 * for the node wins (the element follows the box: views grow with it).
 *
 * Freely sizable nodes (rect, rounded, subroutine, cylinder …) reserve the
 * element's box; circles, diamonds, pills and other coupled shapes keep
 * their box and the element takes the largest rect inside the shape. A
 * user's entry still sizes those: the reservation drops to nothing and the
 * element shrinks with the inscribed rect, clipped or scrolled inside it.
 * Either way the element stops at the border stroke (bleedArea).
 */
import type { NodeSize, SizeCaps } from "pele-render/node-size";
import type { MehrpeleLabel, MehrpeleLabelSize } from "./model";

/** Modes of RenderedLabel that are one element (labels.ts LabelMode). */
const BLEED_MODES = new Set(["embed", "embed-auto", "lazy", "image", "diagram"]);

const CODE_FENCE_RE = /^(`{3,}|~{3,})([^\n]*)\n[\s\S]*\n\1[ \t]*$/;
const DIAGRAM_LANG_RE = /^\s*(mermaid|pele|mehrpele)\b/i;

/** A label that is exactly one fenced code block (not a nested diagram). */
export function isSoleCodeBlock(markdown: string): boolean {
  const m = CODE_FENCE_RE.exec(markdown.trim());
  return !!m && !DIAGRAM_LANG_RE.test(m[2] ?? "");
}

export interface BleedCandidate {
  label: Pick<MehrpeleLabel, "kind" | "markdown" | "anchorId">;
  mode?: string;
}

/** Whether a rendered label is one element that should fill its node (any sizable shape). */
export function isBleedLabel(r: BleedCandidate, caps: SizeCaps | undefined): boolean {
  if (r.label.kind !== "node" || !caps || !caps.w) return false;
  if (r.mode && BLEED_MODES.has(r.mode)) return true;
  return r.mode === "markdown" && isSoleCodeBlock(r.label.markdown);
}

/**
 * Whether a bleed node's box is the element's box (rects and other freely
 * sizable shapes: a minimal reservation plus a size entry). Circles,
 * diamonds and other coupled shapes keep Pele's box for the reservation and
 * the element takes the largest rect inside it (bleedArea).
 */
export function reservesBox(caps: SizeCaps | undefined): boolean {
  return !!caps && caps.w && caps.h && caps.lock === "free";
}

/** Pele's rect padding around a reservation. */
export const RECT_PAD = { w: 36, h: 24 };

/**
 * Pele's horizontal padding around a reservation, per free shape (measured:
 * tests/mehrpele/bleed.test.ts). Subroutines add their inner bars.
 */
const SHAPE_PAD_W: Record<string, number> = { square: 36, round: 36, cylinder: 36, subroutine: 52 };
const MAX_PAD_W = Math.max(...Object.values(SHAPE_PAD_W));

/**
 * Width Pele adds around a reservation for this node's shape. Unknown shapes
 * take the widest known pad: a smaller reservation is harmless (the size
 * entry sets the box), a larger one would push the box past the entry.
 */
export function bleedPad(caps: SizeCaps | undefined): number {
  return (caps?.shape && SHAPE_PAD_W[caps.shape]) || MAX_PAD_W;
}

/**
 * The placeholder a bleed label reserves: just enough that its size entry is
 * never smaller than Pele's minimum. A user's narrower width entry caps it
 * (a reservation is a width floor; the height is never reserved), so the
 * box follows the entry on both sides.
 */
export function bleedReservation(size: MehrpeleLabelSize, entry?: NodeSize, caps?: SizeCaps): MehrpeleLabelSize {
  const w = entry?.w !== undefined ? Math.min(size.width, entry.w) : size.width;
  return { width: Math.max(1, Math.round(w) - (caps ? bleedPad(caps) : RECT_PAD.w)), height: 1 };
}

/** Whether the user's entry fully sizes a shape that does not reserve the element's box. */
function userSizesShape(caps: SizeCaps | undefined, entry: NodeSize | undefined): boolean {
  if (!caps || !entry) return false;
  if (caps.lock === "square") return entry.w !== undefined;
  return entry.w !== undefined && entry.h !== undefined;
}

/**
 * What a bleed label reserves, and whether its box is the element's box
 * (`box`: the render adds a size entry for it, withBleedEntries). Circles,
 * diamonds and pills keep Pele's box around the element unless the user
 * sized the node: then nothing is reserved, so the entry wins, and the
 * element shrinks with the inscribed rect. `held`: the user set the node's
 * height, so an auto-height note keeps to it and scrolls inside.
 */
export function bleedPlaceholder(
  size: MehrpeleLabelSize,
  caps: SizeCaps | undefined,
  entry?: NodeSize,
): { size: MehrpeleLabelSize; box: boolean; held: boolean } {
  const held = holdsHeight(caps, entry);
  if (reservesBox(caps)) return { size: bleedReservation(size, entry, caps), box: true, held };
  if (userSizesShape(caps, entry)) return { size: { width: 1, height: 1 }, box: false, held };
  return { size, box: false, held };
}

/** Whether the user's entry sets the node's height (a square shape's one size sets both). */
function holdsHeight(caps: SizeCaps | undefined, entry: NodeSize | undefined): boolean {
  if (!entry) return false;
  return entry.h !== undefined || (caps?.lock === "square" && entry.w !== undefined);
}

/**
 * The node box a bleed label asks for. Pele sizes heights in whole lines
 * (`lineHeight`, 1.5 em), widths exactly: a fixed-aspect element (image,
 * nested diagram) gets the next whole-line height and the width that keeps
 * its aspect, so it can cover the box without cropping; other elements take
 * the box and fill it.
 */
export function bleedBox(size: MehrpeleLabelSize, opts: { aspect?: boolean; lineHeight?: number } = {}): NodeSize {
  const lh = opts.lineHeight && opts.lineHeight > 0 ? opts.lineHeight : 24;
  const h = Math.max(48, Math.ceil(size.height / lh - 1e-6) * lh);
  if (opts.aspect && size.height > 0) return { w: Math.max(48, Math.round((size.width * h) / size.height)), h };
  return { w: Math.max(48, Math.round(size.width)), h };
}

/** Modes whose element keeps its aspect (scaled to cover the box, never stretched). */
export function isAspectMode(mode: string | undefined): boolean {
  return mode === "image" || mode === "diagram";
}

/**
 * Size entries for the render: the user's entries, plus a bleed entry for
 * each bleed node without one. Returns null when nothing is added.
 */
export function withBleedEntries(
  user: Map<string, NodeSize>,
  bleeds: Map<string, MehrpeleLabelSize>,
  opts: { aspect?: (id: string) => boolean; lineHeight?: number } = {},
): Map<string, NodeSize> | null {
  let added = false;
  const out = new Map(user);
  for (const [id, size] of bleeds) {
    const own = out.get(id);
    const box = bleedBox(size, { aspect: opts.aspect?.(id) ?? false, lineHeight: opts.lineHeight ?? 24 });
    if (own && own.w !== undefined && own.h !== undefined) continue;
    // A width-only (or height-only) entry keeps its dimension; the other is the element's.
    out.set(id, { w: own?.w ?? box.w, h: own?.h ?? box.h });
    added = true;
  }
  return added ? out : null;
}

// -- where the element goes in its shape ------------------------------------------------------

/** A node's outline (SVG units, diagram coordinates), as bleedArea needs it. */
export type BleedShape =
  | { kind: "rect"; x: number; y: number; w: number; h: number; rx: number; stroke: number; /** subroutine: inner bars this far in from each side */ bars?: number }
  | { kind: "circle"; cx: number; cy: number; r: number; stroke: number }
  | { kind: "polygon"; points: ReadonlyArray<readonly [number, number]>; stroke: number }
  | { kind: "cylinder"; x: number; y: number; w: number; h: number; /** cap ellipse half-height */ ry: number; stroke: number };

/** The element's box in its shape: inside the stroke, rounded like the shape. */
export interface BleedArea {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner radius (SVG units). */
  r: number;
  /** Cylinder: the bottom edge is a half ellipse this tall (SVG units). */
  bottomRy?: number;
  /** A rect inscribed in a pill, circle or polygon (not the shape's own box). */
  inscribed?: boolean;
}

/** Corner radius above which a rect reads as a pill: inscribe rather than clip the corners away. */
const PILL_RATIO = 0.25;

/** The shape's outline box (diagram coordinates). */
export function shapeBounds(shape: BleedShape): { x: number; y: number; width: number; height: number } {
  switch (shape.kind) {
    case "circle":
      return { x: shape.cx - shape.r, y: shape.cy - shape.r, width: 2 * shape.r, height: 2 * shape.r };
    case "polygon": {
      const xs = shape.points.map((p) => p[0]);
      const ys = shape.points.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    }
    default:
      return { x: shape.x, y: shape.y, width: shape.w, height: shape.h };
  }
}

/**
 * The largest box for a one-element label in its node's shape, inside the
 * border stroke. Rects (and slightly rounded rects) are filled edge to edge
 * and clipped to their corner radius; pills, circles, diamonds and other
 * polygons get the largest centred rect of the element's `aspect` (w / h)
 * that fits; a cylinder's box starts under its rim and its bottom edge
 * follows the base ellipse.
 */
export function bleedArea(shape: BleedShape, aspect: number): BleedArea {
  const s = Math.max(0, shape.stroke) / 2;
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  switch (shape.kind) {
    case "rect": {
      const ix = s + Math.max(0, shape.bars ?? 0);
      const box = { x: shape.x + ix, y: shape.y + s, w: shape.w - 2 * ix, h: shape.h - 2 * s };
      const rx = Math.max(0, shape.rx - s);
      if (rx <= PILL_RATIO * Math.min(box.w, box.h)) return { ...box, r: shape.bars ? 0 : rx };
      const inside = (w: number, h: number): boolean => inRoundedRect(w / 2, h / 2, box.w / 2, box.h / 2, Math.min(rx, box.w / 2, box.h / 2));
      return centred(box.x + box.w / 2, box.y + box.h / 2, a, Math.max(box.w, box.h), inside);
    }
    case "circle": {
      const r = Math.max(0, shape.r - s);
      const h = (2 * r) / Math.sqrt(a * a + 1);
      return { x: shape.cx - (a * h) / 2, y: shape.cy - h / 2, w: a * h, h, r: 0, inscribed: true };
    }
    case "polygon": {
      const pts = shape.points;
      if (pts.length < 3) return { x: 0, y: 0, w: 0, h: 0, r: 0 };
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      const inside = (w: number, h: number): boolean =>
        [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([dx, dy]) => inPolygon(pts, cx + (dx * w) / 2, cy + (dy * h) / 2));
      const box = centred(cx, cy, a, span, inside);
      // Keep the stroke visible: the corners touch the outline's centre line.
      const k = s * Math.SQRT2;
      return { x: box.x + k, y: box.y + k, w: Math.max(0, box.w - 2 * k), h: Math.max(0, box.h - 2 * k), r: 0, inscribed: true };
    }
    case "cylinder": {
      const top = shape.y + 2 * shape.ry + s;
      return { x: shape.x + s, y: top, w: shape.w - 2 * s, h: shape.y + shape.h - s - top, r: 0, bottomRy: Math.max(0, shape.ry - s) };
    }
  }
}

/** Largest rect of aspect `a` centred on (cx, cy) for which `inside(w, h)` holds (bisection). */
function centred(cx: number, cy: number, a: number, span: number, inside: (w: number, h: number) => boolean): BleedArea {
  let lo = 0;
  let hi = Math.max(1, span);
  for (let i = 0; i < 40; i++) {
    const h = (lo + hi) / 2;
    if (inside(a * h, h)) lo = h;
    else hi = h;
  }
  const h = Math.floor(lo * 100) / 100;
  const w = Math.floor(a * h * 100) / 100;
  return { x: cx - w / 2, y: cy - h / 2, w, h, r: 0, inscribed: true };
}

/** (x, y) from the centre of a rounded rect with half sizes (hw, hh) and corner radius r. */
function inRoundedRect(x: number, y: number, hw: number, hh: number, r: number): boolean {
  if (x > hw + 1e-9 || y > hh + 1e-9) return false;
  const dx = x - (hw - r);
  const dy = y - (hh - r);
  return dx <= 0 || dy <= 0 || dx * dx + dy * dy <= r * r + 1e-9;
}

function inPolygon(pts: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  // Convex outline: on the inner side of every edge (either winding).
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const c = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
    if (Math.abs(c) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}
