/**
 * Viewport scaling for interactive embed labels (Bases views, base-graph,
 * Canvas portals, note embeds, lazy placeholders).
 *
 * Ordinary labels (text, images, nested diagrams) are diagram content: laid
 * out 1:1 in SVG units and CSS-scaled with the diagram by `s` (layout px per
 * SVG unit). Doing the same to an embedded *view* magnifies or shrinks its UI
 * chrome instead of giving it more room. Embed labels therefore render their
 * content at a UI scale `k = clamp(s, minUi, 1)` and get a layout box of
 * `svgBox × s / k` CSS px, so on screen the box is still `svgBox × s`:
 *   s ≥ 1          → controls at native size, the viewport grows;
 *   minUi ≤ s < 1  → scaled down with the diagram (as before);
 *   s < minUi      → controls stop shrinking at the floor, the viewport
 *                    shrinks instead (content scrolls).
 * Node boxes, reservations and `|WxH` stay in SVG units (zoom-independent).
 */
import type { LabelMode } from "./labels";
import type { EmbedScaling } from "./settings";

export type { EmbedScaling };

/** SVG-unit box of a viewport label; `maxHeight` = auto height up to it. */
export interface ViewportBox {
  width: number;
  height?: number;
  maxHeight?: number;
}

/** Labels hosting interactive views (sized as a viewport, not zoomed). */
export function isViewportMode(mode: LabelMode | undefined): boolean {
  return mode === "embed" || mode === "embed-auto" || mode === "lazy";
}

/**
 * Content scale for an embed's UI given the diagram's scale `s`: never
 * magnified, never below `minUi`. Legacy `zoom` scaling follows `s`.
 */
export function embedUiScale(s: number, minUi: number, scaling: EmbedScaling = "viewport"): number {
  if (!Number.isFinite(s) || s <= 0) return 1;
  if (scaling === "zoom") return s;
  const floor = Number.isFinite(minUi) && minUi > 0 ? Math.min(minUi, 1) : 1;
  return Math.min(1, Math.max(s, floor));
}

/**
 * Content scales for one overlay label. `s` is layout px per SVG unit in the
 * overlay's own space, `ancestor` the CSS scale of the overlay's ancestors
 * (a node of an enclosing diagram, lightbox zoom). Returns the label's local
 * CSS scale, the viewport layout factor (layout px per SVG unit) and the
 * counter-scale that keeps our own handles a constant on-screen size.
 */
export function labelScales(
  s: number,
  ancestor: number,
  viewport: boolean,
  minUi: number,
  scaling: EmbedScaling = "viewport",
): { local: number; factor: number; counter: number } {
  const a = Number.isFinite(ancestor) && ancestor > 0 ? ancestor : 1;
  // Embeds: the clamp is decided on screen, so a node of a scaled parent
  // (or a zoomed lightbox) keeps native-size controls too.
  const local = viewport ? embedUiScale(s * a, minUi, scaling) / a : s;
  return { local, factor: viewport ? s / local : 1, counter: 1 / (local * a) };
}

/**
 * Ask a mounted diagram (an element with `.mehrpele-frame`) to re-place its
 * overlay on the next frame — for changes no ResizeObserver sees (CSS
 * transforms on an ancestor). `detail.cascade` also re-places nested mounts.
 */
export const REPOSITION_EVENT = "mehrpele-reposition";

export function requestReposition(frame: Element, cascade = true): void {
  frame.dispatchEvent(new CustomEvent(REPOSITION_EVENT, { detail: { cascade } }));
}

/** Layout (CSS px at UI scale k) size of an SVG-unit box shown at diagram scale s. */
export function viewportLayoutBox(box: ViewportBox, s: number, k: number): ViewportBox {
  const f = Number.isFinite(s / k) && s > 0 && k > 0 ? s / k : 1;
  const out: ViewportBox = { width: box.width * f };
  if (box.height !== undefined) out.height = box.height * f;
  if (box.maxHeight !== undefined) out.maxHeight = box.maxHeight * f;
  return out;
}

const boxes = new WeakMap<HTMLElement, { box: ViewportBox; factor: number }>();

/** SVG-unit box of a viewport label (null for other labels). */
export function viewportBoxOf(el: HTMLElement): ViewportBox | null {
  return boxes.get(el)?.box ?? null;
}

/** Set a viewport label's SVG-unit box and apply it at its current factor (s/k). */
export function setViewportBox(el: HTMLElement, box: ViewportBox): void {
  const factor = boxes.get(el)?.factor ?? 1;
  boxes.set(el, { box: { ...box }, factor });
  applyStyles(el, box, factor);
}

/** Apply a new layout factor (s/k) to a viewport label; returns whether its size changed. */
export function setViewportFactor(el: HTMLElement, factor: number): boolean {
  const entry = boxes.get(el);
  if (!entry || !(factor > 0)) return false;
  if (Math.abs(entry.factor - factor) < 1e-4) return false;
  entry.factor = factor;
  applyStyles(el, entry.box, factor);
  return true;
}

function applyStyles(el: HTMLElement, box: ViewportBox, factor: number): void {
  const px = (v: number) => `${Math.round(v * factor * 100) / 100}px`;
  el.style.width = px(box.width);
  el.style.height = box.height !== undefined ? px(box.height) : "";
  el.style.maxHeight = box.maxHeight !== undefined ? px(box.maxHeight) : "";
}

/**
 * On-screen scale of overlay content: client px per SVG unit for the overlay
 * a label sits in (the overlay registers a live provider on each intrinsic
 * wrapper). 1 outside an overlay (measure host).
 */
const providers = new WeakMap<HTMLElement, () => number>();

export function registerScreenScale(intrinsic: HTMLElement, provider: () => number): void {
  providers.set(intrinsic, provider);
}

export function screenScaleOf(el: HTMLElement): number {
  const intrinsic = el.closest<HTMLElement>(".mehrpele-intrinsic");
  const s = intrinsic ? providers.get(intrinsic)?.() : undefined;
  // A label filling an enlarged node is scaled once more (overlay.ts fit).
  const filled = el.closest<HTMLElement>("[data-fill-scale]");
  const k = filled && intrinsic?.contains(filled) ? Number(filled.dataset.fillScale) || 1 : 1;
  return (s !== undefined && Number.isFinite(s) && s > 0 ? s : 1) * k;
}

/**
 * A full-bleed viewport label's box for its shape's inner area (SVG units).
 * A view fills the area exactly. An auto-height note keeps its own height up
 * to its cap (the re-measure grows the node to it), unless the user set the
 * node's height (`held`): then it keeps to the node and scrolls.
 */
export function bleedViewportBox(
  mode: LabelMode | undefined,
  held: boolean,
  area: { w: number; h: number },
  current: ViewportBox | null,
): ViewportBox {
  if (mode !== "embed-auto" || held) return { width: area.w, height: area.h };
  return current?.maxHeight !== undefined ? { width: area.w, maxHeight: current.maxHeight } : { width: area.w };
}
