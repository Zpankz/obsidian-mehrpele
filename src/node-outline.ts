/**
 * The on-screen outline of a diagram node, taken from its rendered shapes
 * (not a padded box): every filled, stroked shape the node draws itself —
 * the rect of a rect/state/class/entity, the polygon of a diamond or
 * hexagon, the circle, the stadium's rounded rect, the cylinder body, a C4
 * person's body and head — each grown outward by its own half stroke plus
 * a small gap, mapped to client px through getScreenCTM (so CSS transforms,
 * the frame's display scale, zoom and the lightbox are all included).
 * Text-only nodes (plain mindmap leaves) fall back to their layout box.
 *
 * One module on purpose: the hover outline (node-handles.ts), the edit
 * toolbar's hover and selection outlines (src/edit/outline.ts), its menu
 * placement, marquee and inline-editor geometry all read it, so they
 * coincide pixel for pixel. `elementOutline` covers nodes, subgraphs
 * (clusters) and edges; `outlinePaths` is the one serialiser both outline
 * layers draw with.
 */
import { nodeBoxMap } from "pele-render/node-size";

export interface OutlinePiece {
  /** Path data in the shape's own user units, already grown outward. */
  d: string;
  /** Shape units → client px. */
  matrix: DOMMatrix;
  /** An edge's line (not a closed outline): drawn as a wide halo, not grown. */
  line?: boolean;
  /** Polygon vertices (shape units), for the corner a handle sits on. */
  vertices?: [number, number][];
}

export interface NodeOutline {
  pieces: OutlinePiece[];
  /** Client-px bounds of the grown outline. */
  bounds: DOMRect;
  /** Where a resize handle goes: the outline's bottom-right corner (bbox corner for curved shapes). */
  corner: { x: number; y: number };
}

/** Gap between a shape's stroke and its outline, in client px. */
export const OUTLINE_GAP_PX = 1.5;

function num(v: string | null | undefined): number {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : 0;
}

function roundedRect(x: number, y: number, w: number, h: number, rx: number, ry: number): string {
  rx = Math.max(0, Math.min(rx, w / 2));
  ry = Math.max(0, Math.min(ry, h / 2));
  if (rx === 0 || ry === 0) return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
  return (
    `M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}` +
    `A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}` +
    `V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`
  );
}

const OWNER = ".pele-node, .pele-cluster";

/**
 * The element's own outline shapes: filled and stroked, not text, not a
 * nested node's (a cluster's rect, not the nodes inside it).
 */
export function outlineShapes(node: Element): SVGGraphicsElement[] {
  return [...node.querySelectorAll<SVGGraphicsElement>("rect, circle, ellipse, polygon, path")].filter((s) => {
    if (s.closest(OWNER) !== node || s.closest("text, foreignObject, marker")) return false;
    const cs = getComputedStyle(s);
    return cs.fill !== "none" && cs.stroke !== "none" && cs.display !== "none" && cs.visibility !== "hidden";
  });
}

/** Shape-local path data grown by `g` (shape units) on every side. */
function grownPath(s: SVGGraphicsElement, g: number): { d: string; vertices?: [number, number][]; scale?: { cx: number; cy: number; sx: number; sy: number } } | null {
  const tag = s.tagName.toLowerCase();
  if (tag === "rect") {
    const cs = getComputedStyle(s);
    const w = num(s.getAttribute("width"));
    const h = num(s.getAttribute("height"));
    if (!(w > 0) || !(h > 0)) return null;
    // rx may come from CSS (`style="rx:var(--_r)"`): the computed value wins.
    const rx = num(cs.getPropertyValue("rx")) || num(s.getAttribute("rx"));
    const ry = num(cs.getPropertyValue("ry")) || num(s.getAttribute("ry")) || rx;
    const x = num(s.getAttribute("x"));
    const y = num(s.getAttribute("y"));
    return { d: roundedRect(x - g, y - g, w + 2 * g, h + 2 * g, rx ? rx + g : 0, ry ? ry + g : 0) };
  }
  if (tag === "circle" || tag === "ellipse") {
    const cx = num(s.getAttribute("cx"));
    const cy = num(s.getAttribute("cy"));
    const rx = (tag === "circle" ? num(s.getAttribute("r")) : num(s.getAttribute("rx"))) + g;
    const ry = (tag === "circle" ? num(s.getAttribute("r")) : num(s.getAttribute("ry"))) + g;
    if (!(rx > g)) return null;
    return { d: `M${cx - rx},${cy}A${rx},${ry} 0 1 0 ${cx + rx},${cy}A${rx},${ry} 0 1 0 ${cx - rx},${cy}Z` };
  }
  // Polygons and paths (diamonds, hexagons, cylinders, clouds): the shape
  // itself, scaled about its centre so its bbox grows by g on each side.
  let d = "";
  let vertices: [number, number][] | undefined;
  if (tag === "polygon") {
    const pts = (s.getAttribute("points") ?? "").trim();
    if (!pts) return null;
    d = `M${pts.replace(/\s+/g, " L")}Z`;
    const n = pts.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g)?.map(Number) ?? [];
    vertices = [];
    for (let i = 0; i + 1 < n.length; i += 2) vertices.push([n[i], n[i + 1]]);
  } else d = s.getAttribute("d") ?? "";
  if (!d) return null;
  let b: DOMRect;
  try {
    b = (s).getBBox();
  } catch {
    return null;
  }
  if (!(b.width > 0) || !(b.height > 0)) return null;
  return { d, ...(vertices ? { vertices } : {}), scale: { cx: b.x + b.width / 2, cy: b.y + b.height / 2, sx: (b.width + 2 * g) / b.width, sy: (b.height + 2 * g) / b.height } };
}

/**
 * The node's outline in client px. `fallback`: a client rect for nodes that
 * draw no shape (text-only); null when there is nothing to outline.
 */
export function nodeOutlineGeometry(node: SVGGraphicsElement, fallback?: DOMRect | null, gapPx = OUTLINE_GAP_PX): NodeOutline | null {
  const pieces: OutlinePiece[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const extend = (m: DOMMatrix, x: number, y: number): void => {
    const p = new DOMPoint(x, y).matrixTransform(m);
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  };
  for (const s of outlineShapes(node)) {
    const ctm = s.getScreenCTM();
    if (!ctm) continue;
    const unit = Math.sqrt(Math.abs(ctm.a * ctm.d - ctm.b * ctm.c)) || 1;
    // Outside the stroke: half its width (shape units) plus the gap (client px).
    const g = num(getComputedStyle(s).strokeWidth) / 2 + gapPx / unit;
    const grown = grownPath(s, g);
    if (!grown) continue;
    let m = DOMMatrix.fromMatrix(ctm);
    if (grown.scale) {
      const { cx, cy, sx, sy } = grown.scale;
      m = m.multiply(new DOMMatrix().translate(cx, cy).scale(sx, sy).translate(-cx, -cy));
    }
    pieces.push({ d: grown.d, matrix: m, ...(grown.vertices ? { vertices: grown.vertices } : {}) });
    let b: DOMRect;
    try {
      b = s.getBBox();
    } catch {
      continue;
    }
    const gb = grown.scale ? { x: b.x, y: b.y, w: b.width, h: b.height } : { x: b.x - g, y: b.y - g, w: b.width + 2 * g, h: b.height + 2 * g };
    const mm = grown.scale ? m : ctm;
    for (const [px, py] of [[gb.x, gb.y], [gb.x + gb.w, gb.y], [gb.x, gb.y + gb.h], [gb.x + gb.w, gb.y + gb.h]] as const) extend(mm, px, py);
  }
  if (pieces.length === 0) {
    if (!fallback || !(fallback.width > 0)) return null;
    const f = new DOMRect(fallback.x - gapPx, fallback.y - gapPx, fallback.width + 2 * gapPx, fallback.height + 2 * gapPx);
    return {
      pieces: [{ d: roundedRect(f.x, f.y, f.width, f.height, 0, 0), matrix: new DOMMatrix() }],
      bounds: f,
      corner: { x: f.right, y: f.bottom },
    };
  }
  const bounds = new DOMRect(x0, y0, x1 - x0, y1 - y0);
  return { pieces, bounds, corner: polygonCorner(pieces, bounds) ?? { x: bounds.right, y: bounds.bottom } };
}

/**
 * A single polygon with a real bottom-right vertex (hexagon, trapezoid,
 * slanted shapes): the handle sits on it. Diamonds have none (their nearest
 * vertex is far from the corner), so they keep the bbox corner, like
 * curved shapes.
 */
function polygonCorner(pieces: OutlinePiece[], bounds: DOMRect): { x: number; y: number } | null {
  const only = pieces.length === 1 ? pieces[0] : null;
  if (!only?.vertices?.length) return null;
  let best: { x: number; y: number; d: number } | null = null;
  for (const [vx, vy] of only.vertices) {
    const p = new DOMPoint(vx, vy).matrixTransform(only.matrix);
    const d = Math.hypot(bounds.right - p.x, bounds.bottom - p.y);
    if (!best || d < best.d) best = { x: p.x, y: p.y, d };
  }
  return best && best.d <= 0.3 * Math.min(bounds.width, bounds.height) ? { x: best.x, y: best.y } : null;
}

// -- shared by every outline consumer -------------------------------------------------------

/** Boxes of text-only nodes (plain mindmap leaves), read from the whole SVG once per render. */
const layoutBoxes = new WeakMap<SVGSVGElement, Map<string, { x: number; y: number; w: number; h: number }>>();

/** A node that draws no shape of its own: its box is the layout's, not its text's. */
export function isTextOnly(el: Element): boolean {
  return el.classList.contains("pele-shape-text");
}

export function layoutBox(el: SVGGraphicsElement): { x: number; y: number; w: number; h: number } | null {
  const svg = el.ownerSVGElement;
  if (!svg) return null;
  let map = layoutBoxes.get(svg);
  if (!map) {
    map = nodeBoxMap(svg.outerHTML);
    layoutBoxes.set(svg, map);
  }
  return map.get(el.getAttribute("data-id") ?? "") ?? null;
}

/**
 * On-screen rect of a node: its shapes, or for a text-only node its layout
 * box (the label's text extent is narrower than the box the solver sizes).
 */
export function nodeClientRect(el: SVGGraphicsElement): DOMRect {
  const r = el.getBoundingClientRect();
  if (!isTextOnly(el)) return r;
  const b = layoutBox(el);
  const m = el.getScreenCTM();
  const t = /translate\(\s*([-\d.e+]+)(?:[ ,]+([-\d.e+]+))?/.exec(el.getAttribute("transform") ?? "");
  if (!b || !m) return r;
  const tx = t ? Number(t[1]) : 0;
  const ty = t ? Number(t[2] ?? 0) : 0;
  // getScreenCTM includes the node's own translate: box coordinates are in its parent's space.
  const x0 = m.a * (b.x - tx) + m.c * (b.y - ty) + m.e;
  const y0 = m.b * (b.x - tx) + m.d * (b.y - ty) + m.f;
  return new DOMRect(x0, y0, b.w * m.a, b.h * m.d);
}

/**
 * The outline of any diagram element in client px: a node (its shapes,
 * text-only nodes their layout box), a subgraph (its own rect), or an edge
 * (its line paths, as `line` pieces). `gapPx` 0 gives the shapes' own
 * extent including their stroke (placement); the default is the outline.
 */
export function elementOutline(el: SVGGraphicsElement, gapPx = OUTLINE_GAP_PX): NodeOutline | null {
  if (el.classList.contains("pele-edge")) return edgeOutline(el);
  if (el.classList.contains("pele-node")) {
    return nodeOutlineGeometry(el, isTextOnly(el) ? nodeClientRect(el) : null, gapPx) ?? nodeOutlineGeometry(el, el.getBoundingClientRect(), gapPx);
  }
  return nodeOutlineGeometry(el, el.getBoundingClientRect(), gapPx);
}

/** An edge's own line paths (not arrowheads, not hit areas), as line pieces. */
function edgeOutline(edge: SVGGraphicsElement): NodeOutline | null {
  const pieces: OutlinePiece[] = [];
  let box: DOMRect | null = null;
  for (const p of edge.querySelectorAll<SVGGraphicsElement>("path")) {
    if (p.classList.contains("pele-marker") || p.classList.contains("pele-edit-hit") || p.closest(".pele-edge") !== edge) continue;
    const m = p.getScreenCTM();
    const d = p.getAttribute("d");
    if (!m || !d) continue;
    pieces.push({ d, matrix: DOMMatrix.fromMatrix(m), line: true });
    const r = p.getBoundingClientRect();
    box = box ? new DOMRect(Math.min(box.x, r.x), Math.min(box.y, r.y), Math.max(box.right, r.right) - Math.min(box.x, r.x), Math.max(box.bottom, r.bottom) - Math.min(box.y, r.y)) : r;
  }
  if (!pieces.length || !box) return null;
  return { pieces, bounds: box, corner: { x: box.right, y: box.bottom } };
}

/**
 * `<path>` attributes for an outline in a layer whose coordinates are
 * `toLayer` × client px (identity for a fixed, full-window layer). Both the
 * hover layer and the selection layer draw with this, so equal outlines are
 * equal strings.
 */
export function outlinePaths(outline: NodeOutline, toLayer: DOMMatrix = new DOMMatrix()): Array<{ d: string; transform: string; line: boolean }> {
  return outline.pieces.map((p) => {
    const m = toLayer.multiply(p.matrix);
    return { d: p.d, transform: `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map((v) => Math.round(v * 1e4) / 1e4).join(" ")})`, line: !!p.line };
  });
}
