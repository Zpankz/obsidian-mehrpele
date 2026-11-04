/**
 * Content fills a user-sized node. A node enlarged with its box handle (or
 * a `%% pele-size %%` entry) first reflows its label to the new inner width,
 * then, while the content is still smaller than the box, scales it up
 * uniformly ("contain") so text, formulas, tables and images visibly grow.
 *
 * - Plain SVG labels: the label's `<text>` is scaled about the node's inner
 *   box centre (a transform only: no re-layout, nothing persisted).
 * - Mehrpele labels: overlay.ts picks the wrap width with the largest
 *   contain scale (chooseFit) and scales the label element by it.
 *
 * Never below 1× (a box is never smaller than its content), never above
 * FILL_MAX. Only explicit node sizes fill: automatic container changes never
 * magnify.
 */
import { nodeBoxMap } from "pele-render/node-size";

/** Largest enlargement of a node's content. */
export const FILL_MAX = 3;
/** Below this a fill is not worth a transform. */
const FILL_MIN = 1.02;

export interface FitSample {
  /** max-width offered to the content (SVG units). */
  maxWidth: number;
  /** Content size laid out at that max-width (SVG units). */
  width: number;
  height: number;
}

export interface FitChoice {
  maxWidth: number;
  scale: number;
  /** Content size laid out at maxWidth (wider when it cannot wrap that narrow). */
  width?: number;
  height?: number;
  /** Even at 1× the content is bigger than the inner box: the node grows to it instead. */
  overflow?: boolean;
}

/** Contain scale of a content box in an inner box. */
export function containScale(content: { width: number; height: number }, inner: { width: number; height: number }): number {
  if (!(content.width > 0) || !(content.height > 0)) return 1;
  return Math.min(inner.width / content.width, inner.height / content.height);
}

/**
 * Wrap widths worth trying for an inner box: the box itself and narrower
 * widths that leave room to scale up (a narrower wrap is taller, so the
 * best fill is where width and height limits meet).
 */
export function fitCandidates(inner: { width: number; height: number }, natural: number, min = 16): number[] {
  const out = new Set<number>([Math.round(natural)]);
  const top = Math.floor(inner.width);
  if (top >= min) out.add(top);
  // A fixed ladder (not fractions of this box): a wider box keeps every
  // narrower wrap it had, so growing the box never loses the best fill.
  for (const w of FIT_WRAP_LADDER) if (w < top && w >= min) out.add(w);
  return [...out].filter((w) => w > 0).sort((a, b) => b - a);
}

/** Wrap widths (SVG units) tried under a node's inner width. */
const FIT_WRAP_LADDER = [960, 800, 640, 520, 420, 340, 280, 230, 190, 160, 130, 108, 90, 74, 60, 48, 38, 30, 24, 18] as const;

/**
 * The wrap width with the largest contain scale (ties: the wider wrap).
 * When nothing fits even at 1×, reflow to the inner width at 1× (the node
 * then grows to the content: never clipped, never shrunk).
 */
export function chooseFit(samples: readonly FitSample[], inner: { width: number; height: number }, max = FILL_MAX): FitChoice {
  let best: FitChoice | null = null;
  for (const s of samples) {
    const k = containScale(s, inner);
    if (!best || k > best.scale + 1e-3 || (Math.abs(k - best.scale) <= 1e-3 && s.maxWidth > best.maxWidth)) {
      best = { maxWidth: s.maxWidth, scale: k, width: s.width, height: s.height };
    }
  }
  if (!best) return { maxWidth: Math.max(1, Math.floor(inner.width)), scale: 1 };
  if (best.scale < 1) {
    // Too big even at 1×: wrap at the inner width (or the widest sample
    // under it); the node grows to that content (never clipped).
    const under = samples.filter((s) => s.maxWidth <= inner.width).sort((a, b) => b.maxWidth - a.maxWidth)[0];
    const pick = under ?? best;
    return { maxWidth: pick.maxWidth, scale: 1, width: pick.width, height: pick.height, overflow: true };
  }
  const scale = Math.min(best.scale, max);
  return { ...best, scale: scale < FILL_MIN ? 1 : Math.floor(scale * 1000) / 1000 };
}

// -- plain SVG labels -----------------------------------------------------------

/** Node kinds whose label is not the whole content (compartments, rows): never filled. */
function fillable(g: SVGGraphicsElement, texts: SVGTextElement[]): boolean {
  if (g.classList.contains("pele-class")) return false;
  if (g.classList.contains("pele-entity") && texts.length > 1) return false;
  return !g.querySelector("foreignObject");
}

function translateOf(el: Element): { x: number; y: number } {
  const m = /translate\(\s*([-\d.e+]+)(?:[ ,]+([-\d.e+]+))?/.exec(el.getAttribute("transform") ?? "");
  return m ? { x: Number(m[1]), y: Number(m[2] ?? 0) } : { x: 0, y: 0 };
}

/**
 * Inner box (node-local SVG units) a label may fill: the shape box less
 * the label padding Pele uses, inscribed for circles and diamonds.
 */
export function innerBox(
  shape: { x: number; y: number; w: number; h: number },
  kind: ShapeKind,
  fontSize: number,
): { x: number; y: number; w: number; h: number } {
  const em = fontSize / 16;
  let w = shape.w;
  let h = shape.h;
  if (kind === "circle") w = h = Math.min(w, h) * Math.SQRT1_2;
  else if (kind === "diamond") {
    w /= 2;
    h /= 2;
  } else if (kind === "polygon") {
    w *= 0.8;
  }
  const padX = kind === "text" ? 12 * em : 18 * em;
  const padY = kind === "text" ? 0 : 12 * em;
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;
  const iw = Math.max(1, w - 2 * padX);
  const ih = Math.max(1, h - 2 * padY);
  return { x: cx - iw / 2, y: cy - ih / 2, w: iw, h: ih };
}

export type ShapeKind = "rect" | "circle" | "diamond" | "polygon" | "text";

/** How a node's label area relates to its box, from its classes. */
export function shapeKind(g: Element | string): ShapeKind {
  const c = typeof g === "string" ? g : (g.getAttribute("class") ?? "");
  if (/\bpele-shape-text\b/.test(c)) return "text";
  if (/\bpele-shape-(circle|circ|dbl-circ|doublecircle|double-circle)\b/.test(c)) return "circle";
  if (/\bpele-shape-(diam|diamond|rhombus|decision|question)\b/.test(c)) return "diamond";
  if (/\bpele-shape-(hex|hexagon|cloud|bang|lean|trap|odd|tri)/.test(c)) return "polygon";
  return "rect";
}

/**
 * Scale the SVG labels of user-sized nodes to fill their boxes. `ids`: the
 * sized nodes (RenderResult.nodeSizes keys). Returns id → scale applied.
 * Only `svg`'s own nodes (not nested diagrams'); the SVG must be laid out.
 */
export function fillSvgLabels(svg: SVGSVGElement, ids: Iterable<string>, fontSize: number): Map<string, number> {
  const out = new Map<string, number>();
  const want = new Set(ids);
  if (want.size === 0) return out;
  let layout: Map<string, { x: number; y: number; w: number; h: number }> | null = null;
  for (const g of svg.querySelectorAll<SVGGraphicsElement>(".pele-node[data-id]")) {
    if (g.ownerSVGElement !== svg) continue;
    const id = g.getAttribute("data-id") ?? "";
    if (!want.has(id)) continue;
    const texts = [...g.querySelectorAll<SVGTextElement>("text.pele-label")].filter((t) => t.closest(".pele-node") === g);
    if (texts.length === 0 || !fillable(g, texts)) continue;
    const t = translateOf(g);
    const kind = shapeKind(g);
    let shape = nodeBoxMap(g.outerHTML).get(id) ?? null;
    if (!shape && kind === "text") {
      layout ??= nodeBoxMap(svg.outerHTML);
      shape = layout.get(id) ?? null;
    }
    if (!shape) continue;
    const local = { x: shape.x - t.x, y: shape.y - t.y, w: shape.w, h: shape.h };
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const el of texts) {
      el.removeAttribute("transform");
      // Blank lines are the solver's height filler, not content.
      const lines = el.querySelectorAll("tspan").length ? [...el.querySelectorAll<SVGTSpanElement>("tspan")] : [el];
      for (const line of lines) {
        if (!(line.textContent ?? "").trim()) continue;
        let b: DOMRect;
        try {
          b = line.getBBox();
        } catch {
          continue;
        }
        if (!(b.width > 0)) continue;
        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.width);
        y1 = Math.max(y1, b.y + b.height);
      }
    }
    if (!Number.isFinite(x0)) continue;
    const inner = innerBox(local, kind, fontSize);
    const k = Math.min(containScale({ width: x1 - x0, height: y1 - y0 }, { width: inner.w, height: inner.h }), FILL_MAX);
    if (!(k >= FILL_MIN)) continue;
    const tcx = (x0 + x1) / 2;
    const tcy = (y0 + y1) / 2;
    const icx = inner.x + inner.w / 2;
    const icy = inner.y + inner.h / 2;
    const r = (v: number) => Math.round(v * 100) / 100;
    const tf = `translate(${r(icx)} ${r(icy)}) scale(${r(k)}) translate(${r(-tcx)} ${r(-tcy)})`;
    for (const el of texts) el.setAttribute("transform", tf);
    g.setAttribute("data-pele-fill", String(r(k)));
    out.set(id, r(k));
  }
  return out;
}
