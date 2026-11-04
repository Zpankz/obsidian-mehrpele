// Pele flowchart node → Excalidraw construction (native element or grouped composite).
//
// Excalidraw only binds labels and arrows to rectangle / ellipse / diamond
// (VALID_CONTAINER_TYPES, bindable types in the CLI validator), and closed
// `line` loops are the only filled free polygons (shape.ts isPathALoop). So
// shapes with no native container become a *composite*: an invisible host
// rectangle (opacity 0 — bound text keeps its own opacity) that owns the
// label and arrow bindings, plus visible `line`/`ellipse` parts sharing one
// `groupIds` entry. Containers are grown (never shrunk, centre kept) until the
// estimated label fits Excalidraw's bound-text extent, so it never wraps.
import type { ExcalidrawElementSkeleton, SkeletonLabel } from "./types.js";
import type { NodeGeometry } from "./svg-geometry.js";
import {
  BOUND_TEXT_PADDING as PAD, boundTextMaxWidth, estimateTextBox, estimateWrappedLines, lineHeightFor, longestWordWidth, minContainerSide, runWidths,
  type TextContainerType,
} from "./text-metrics.js";

export type Pt = [number, number];

/** Outline in output space, used to trim edges that now start inside a grown node. */
export type Outline =
  | { kind: "rectangle" | "ellipse" | "diamond"; cx: number; cy: number; w: number; h: number }
  | { kind: "polygon"; points: Pt[] };

export interface NodeStyle { fill: string; stroke: string }

export interface NodeBuild {
  /**
   * Paint order. Visible hosts (double circle, subroutine) come first so their
   * unfilled parts draw on top; hidden hosts come last so the bound text paints
   * above the filled outline. Parts never cross the fitted label box.
   */
  elements: ExcalidrawElementSkeleton[];
  outline: Outline;
  grown: boolean;
  dropped: string[];
}

export type ShapeKind =
  | "rectangle" | "round" | "diamond" | "circle" | "doublecircle" | "subroutine" | "cylinder" | "stadium"
  | "hexagon" | "lean_right" | "lean_left" | "trapezoid" | "inv_trapezoid" | "odd";

/** Model type wins; Pele's `pele-shape-*` class is the fallback. */
export function shapeKind(modelType: string, shapeClass: string): { kind: ShapeKind; unknown?: string } {
  const byModel: Record<string, ShapeKind> = {
    square: "rectangle", rect: "rectangle", round: "round", diamond: "diamond", circle: "circle", doublecircle: "doublecircle",
    subroutine: "subroutine", cylinder: "cylinder", stadium: "stadium", hexagon: "hexagon", lean_right: "lean_right",
    lean_left: "lean_left", trapezoid: "trapezoid", inv_trapezoid: "inv_trapezoid", odd: "odd",
  };
  const byClass: Record<string, ShapeKind> = {
    rect: "rectangle", rounded: "round", diam: "diamond", diamond: "diamond", circle: "circle", "dbl-circ": "doublecircle",
    "fr-rect": "subroutine", cyl: "cylinder", stadium: "stadium", hex: "hexagon", "lean-r": "lean_right", "lean-l": "lean_left",
    "trap-b": "trapezoid", "trap-t": "inv_trapezoid", odd: "odd",
  };
  const m = modelType.toLowerCase();
  if (m && byModel[m]) return { kind: byModel[m] };
  if (byClass[shapeClass]) return { kind: byClass[shapeClass] };
  return m ? { kind: "rectangle", unknown: m } : { kind: "rectangle" };
}

const sign = (v: number) => (v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0);

/** Interior horizontal span of a polygon at height y, around x = 0 (handles the concave `odd` notch). */
function spanAt(points: Pt[], y: number): number {
  let left = -Infinity, right = Infinity;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    if ((y1 > y) === (y2 > y) && !(y1 === y && y2 === y)) continue;
    const xs = y1 === y2 ? [x1, x2] : [x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)];
    for (const x of xs) { if (x <= 0) left = Math.max(left, x); if (x >= 0) right = Math.min(right, x); }
  }
  return right - left;
}

/** Pill outline (semicircle ends, 8 segments each), centred at origin. */
function stadiumPoints(w: number, h: number): Pt[] {
  const r = Math.min(h / 2, w / 2), half = w / 2 - r, pts: Pt[] = [];
  for (let i = 0; i <= 8; i++) { const t = -Math.PI / 2 + (Math.PI * i) / 8; pts.push([half + r * Math.cos(t), r * Math.sin(t)]); }
  for (let i = 0; i <= 8; i++) { const t = Math.PI / 2 + (Math.PI * i) / 8; pts.push([-half + r * Math.cos(t), r * Math.sin(t)]); }
  return pts;
}

/** Synthesised polygons when Pele's SVG has none (defensive; Pele 1.6 always emits one). */
function fallbackPolygon(kind: ShapeKind, w: number, h: number): Pt[] {
  const a = w / 2, b = h / 2, i = Math.min(12, w / 6);
  switch (kind) {
    case "hexagon": return [[-a + i, -b], [a - i, -b], [a, 0], [a - i, b], [-a + i, b], [-a, 0]];
    case "lean_right": return [[-a + i, -b], [a, -b], [a - i, b], [-a, b]];
    case "lean_left": return [[-a, -b], [a - i, -b], [a, b], [-a + i, b]];
    case "trapezoid": return [[-a + i, -b], [a - i, -b], [a, b], [-a, b]];
    case "inv_trapezoid": return [[-a, -b], [a, -b], [a - i, b], [-a + i, b]];
    default: return [[-a, -b], [a, -b], [a, b], [-a, b], [-a + i, 0]];
  }
}

function closedLine(id: string, cx: number, cy: number, local: Pt[], style: NodeStyle, fill: string): ExcalidrawElementSkeleton {
  const pts: Pt[] = [...local];
  const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
  if (Math.abs(fx - lx) > 1e-9 || Math.abs(fy - ly) > 1e-9) pts.push([fx, fy]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return {
    id, type: "line", x: cx + fx, y: cy + fy, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), angle: 0,
    strokeColor: style.stroke, backgroundColor: fill, fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roundness: null,
    points: pts.map(([x, y]) => [x - fx, y - fy] as Pt),
  };
}

function openLine(id: string, x0: number, y0: number, x1: number, y1: number, style: NodeStyle): ExcalidrawElementSkeleton {
  return { id, type: "line", x: x0, y: y0, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), angle: 0, strokeColor: style.stroke, backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roundness: null, points: [[0, 0], [x1 - x0, y1 - y0]] };
}

/**
 * Build one node. `g` is in Pele coordinates; `toX`/`toY`/`scale` map to output space.
 * Text is measured at `label.fontSize` with the label's (or Excalidraw's default) font family.
 */
export function buildNode(
  id: string, peleId: string, kind: ShapeKind, g: NodeGeometry, label: SkeletonLabel, style: NodeStyle,
  toX: (x: number) => number, toY: (y: number) => number, scale: number, groupId: string | undefined,
  link: string | undefined,
): NodeBuild {
  const cx = toX(g.cx), cy = toY(g.cy);
  // Pele shapes are centred on the node translate; use the bbox only for size.
  let w = g.bbox.width * scale, h = g.bbox.height * scale;
  const text = estimateTextBox(label.text, label.fontSize ?? 16, label.fontFamily);
  const tw = text.width, th = text.height;
  const dropped: string[] = [];
  const W0 = w, H0 = h;
  const fit = (type: TextContainerType, innerInsetX = 0, innerInsetY = 0) => {
    w = Math.max(w, minContainerSide(type, tw) + 2 * innerInsetX);
    h = Math.max(h, minContainerSide(type, th) + 2 * innerInsetY);
  };
  const group = groupId ? { groupIds: [groupId] } : {};
  const host = (type: TextContainerType, extra: Partial<ExcalidrawElementSkeleton> = {}): ExcalidrawElementSkeleton => ({
    id, type, x: cx - w / 2, y: cy - h / 2, width: w, height: h, angle: 0,
    strokeColor: style.stroke, backgroundColor: style.fill, fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid",
    roundness: null, label: extra.groupIds ? { ...label, groupIds: extra.groupIds } : label, ...(link ? { link } : {}), ...extra,
  });
  const box = (k: "rectangle" | "ellipse" | "diamond"): Outline => ({ kind: k, cx, cy, w, h });
  const grownFlag = () => w > W0 + 0.01 || h > H0 + 0.01;
  // Diamonds/circles: Excalidraw's inscribed rule doubles the side per label px, so let
  // Excalidraw wrap at word boundaries and pick the break width with the least area.
  const fitWrapped = (type: "diamond" | "ellipse", square: boolean) => {
    const fs = label.fontSize ?? 16, ff = label.fontFamily, lh = fs * lineHeightFor(ff);
    const word = longestWordWidth(label.text, fs, ff);
    let best: { W: number; H: number; score: number } | undefined;
    for (const t of [word, ...runWidths(label.text, fs, ff).filter((x) => x > word)]) {
      let W = Math.max(w, minContainerSide(type, t));
      const lines = estimateWrappedLines(label.text, boundTextMaxWidth(type, W), fs, ff).length;
      let H = Math.max(h, minContainerSide(type, Math.ceil(lines * lh)));
      if (square) W = H = Math.max(W, H);
      const score = W * H;
      if (!best || score < best.score - 1e-9) best = { W, H, score };
    }
    if (best) { w = best.W; h = best.H; }
  };
  const composite = (detail: string) => { dropped.push(`shape-composite:${peleId}:${detail}`); if (!groupId) dropped.push(`shape-ungrouped:${peleId}`); };

  switch (kind) {
    case "diamond": {
      fitWrapped("diamond", false);
      return { elements: [host("diamond")], outline: box("diamond"), grown: grownFlag(), dropped };
    }
    case "circle": {
      w = h = Math.max(w, h);
      fitWrapped("ellipse", true);
      return { elements: [host("ellipse")], outline: box("ellipse"), grown: grownFlag(), dropped };
    }
    case "doublecircle": {
      const radii = g.radii.length >= 2 ? g.radii : [];
      const inset = (radii.length >= 2 ? Math.abs(radii[0] - radii[1]) : 5) * scale;
      fit("ellipse", inset, inset);
      w = h = Math.max(w, h);
      const inner: ExcalidrawElementSkeleton = { id: `${id}_inner`, type: "ellipse", x: cx - w / 2 + inset, y: cy - h / 2 + inset, width: w - 2 * inset, height: h - 2 * inset, angle: 0, strokeColor: style.stroke, backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roundness: null, ...group };
      if (!groupId) dropped.push(`shape-ungrouped:${peleId}`);
      return { elements: [host("ellipse", group), inner], outline: box("ellipse"), grown: grownFlag(), dropped };
    }
    case "subroutine": {
      const halfW = (g.bbox.width / 2) * scale;
      const inset = g.barXs.length ? Math.max(0, halfW - Math.max(...g.barXs.map(Math.abs)) * scale) : 8 * scale;
      fit("rectangle", inset);
      const top = cy - h / 2, bottom = cy + h / 2, xl = cx - w / 2 + inset, xr = cx + w / 2 - inset;
      if (!groupId) dropped.push(`shape-ungrouped:${peleId}`);
      return {
        elements: [host("rectangle", group), { ...openLine(`${id}_bar_l`, xl, top, xl, bottom, style), ...group }, { ...openLine(`${id}_bar_r`, xr, top, xr, bottom, style), ...group }],
        outline: box("rectangle"), grown: grownFlag(), dropped,
      };
    }
    case "cylinder": {
      const ry = Math.max(2, (g.arcRy ?? Math.min(g.bbox.height * 0.12, 10)) * scale);
      // text band must clear the cap's front rim and the bottom arc: H ≥ th + 4ry + 2·pad
      w = Math.max(w, minContainerSide("rectangle", tw));
      h = Math.max(h, Math.ceil(th) + 4 * ry + 2 * PAD);
      const a = w / 2, top = -h / 2, bottom = h / 2, n = 12, body: Pt[] = [[-a, top + ry], [-a, bottom - ry]];
      for (let i = 1; i < n; i++) { const t = Math.PI - (Math.PI * i) / n; body.push([a * Math.cos(t), bottom - ry + ry * Math.sin(t)]); }
      body.push([a, bottom - ry], [a, top + ry]);
      for (let i = 1; i < n; i++) { const t = (Math.PI * i) / n; body.push([a * Math.cos(t), top + ry - ry * Math.sin(t)]); }
      const cap: ExcalidrawElementSkeleton = { id: `${id}_cap`, type: "ellipse", x: cx - a, y: cy + top, width: w, height: 2 * ry, angle: 0, strokeColor: style.stroke, backgroundColor: style.fill, fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roundness: null, ...group };
      composite("cylinder:line-body+ellipse-cap+hidden-rectangle-host");
      return {
        elements: [{ ...closedLine(`${id}_body`, cx, cy, body, style, style.fill), ...group }, cap, host("rectangle", { opacity: 0, ...group })],
        outline: box("rectangle"), grown: grownFlag(), dropped,
      };
    }
    case "stadium":
    case "hexagon": case "lean_right": case "lean_left": case "trapezoid": case "inv_trapezoid": case "odd": {
      let pts: Pt[] = kind === "stadium" ? stadiumPoints(w, h)
        : g.polygon && g.polygon.length >= 3 ? g.polygon.map(([x, y]) => [x * scale, y * scale] as Pt) : fallbackPolygon(kind, w, h);
      // vertical: host rule (h − 2·pad ≥ th); horizontal: label band must sit inside the outline
      const needH = minContainerSide("rectangle", th);
      if (h < needH) { const d = (needH - h) / 2; pts = pts.map(([x, y]) => [x, y + sign(y) * d] as Pt); h = needH; }
      const band = Math.min(th / 2 + PAD, h / 2);
      const span = Math.min(spanAt(pts, -band), spanAt(pts, 0), spanAt(pts, band));
      const needSpan = Math.ceil(tw) + 2 * PAD;
      if (span < needSpan) { const d = (needSpan - span) / 2; pts = pts.map(([x, y]) => [x + sign(x) * d, y] as Pt); }
      const xs = pts.map((p) => p[0]);
      w = Math.max(w, Math.max(...xs) - Math.min(...xs));
      composite(`${kind}:line-outline+hidden-rectangle-host`);
      const outlineAbs = pts.map(([x, y]) => [cx + x, cy + y] as Pt);
      return {
        elements: [{ ...closedLine(`${id}_outline`, cx, cy, pts, style, style.fill), ...group }, host("rectangle", { opacity: 0, ...group })],
        outline: { kind: "polygon", points: outlineAbs }, grown: grownFlag(), dropped,
      };
    }
    case "round":
    case "rectangle":
    default: {
      fit("rectangle");
      return { elements: [host("rectangle", kind === "round" ? { roundness: { type: 3 } } : {})], outline: box("rectangle"), grown: grownFlag(), dropped };
    }
  }
}

export function insideOutline(o: Outline, [x, y]: Pt, eps = 0.5): boolean {
  if (o.kind === "polygon") {
    let inside = false;
    for (let i = 0, j = o.points.length - 1; i < o.points.length; j = i++) {
      const [xi, yi] = o.points[i], [xj, yj] = o.points[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const a = o.w / 2 - eps, b = o.h / 2 - eps, dx = Math.abs(x - o.cx), dy = Math.abs(y - o.cy);
  if (a <= 0 || b <= 0) return false;
  if (o.kind === "rectangle") return dx < a && dy < b;
  if (o.kind === "diamond") return dx / a + dy / b < 1;
  return (dx * dx) / (a * a) + (dy * dy) / (b * b) < 1;
}

/** Drop the leading points that fall inside `o`, replacing them with the boundary crossing. */
export function clipStart(pts: Pt[], o: Outline): Pt[] {
  if (pts.length < 2 || !insideOutline(o, pts[0])) return pts;
  let i = 1;
  while (i < pts.length && insideOutline(o, pts[i])) i++;
  if (i >= pts.length) return pts;
  let a = pts[i - 1], b = pts[i];
  for (let k = 0; k < 40; k++) {
    const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (insideOutline(o, m)) a = m; else b = m;
  }
  const r = (v: number) => Math.round(v * 100) / 100;
  return [[r(b[0]), r(b[1])], ...pts.slice(i)];
}

export function clipEnd(pts: Pt[], o: Outline): Pt[] {
  return clipStart([...pts].reverse(), o).reverse();
}
