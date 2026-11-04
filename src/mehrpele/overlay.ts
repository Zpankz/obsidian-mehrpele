/**
 * Overlay layer: absolutely-positioned HTML over the SVG,
 * recomputed from the viewBox→client transform on every render/resize.
 * SVG text is hidden only for anchors that got an overlay (fail-safe).
 *
 * Scale: label HTML is laid out at 1:1 (CSS px = SVG user units, the units
 * reservations are measured in) and visually scaled with the SVG via a CSS
 * transform on the intrinsic wrapper. Layout size is therefore independent
 * of how much the diagram is shrunk to fit (or zoomed), so the re-measure
 * pass converges instead of chasing the viewBox→client scale.
 *
 * Interactive embeds are the exception (viewport.ts): their UI renders at a
 * clamped scale k and their layout box grows or shrinks instead, so a bigger
 * diagram gives a Base or graph more room rather than bigger controls.
 *
 * Units: `s` here is layout px per SVG unit in the overlay's own coordinate
 * space (ancestor CSS transforms — a node of an enclosing diagram, lightbox
 * zoom — excluded); the client (on-screen) scale is s × ancestor scale.
 * `--mehrpele-scale` on the overlay is s; `--mehrpele-ui-counter` on each
 * intrinsic wrapper undoes the on-screen scale of its content, so our own
 * handles keep a constant on-screen size.
 */
import {
  anchorScope,
  parseViewBox,
  resolveAnchors,
  svgBoxToClient,
  svgScale,
  type AnchorBox,
} from "./anchors";
import type { RenderedLabel } from "./labels";
import { FILL_MAX, chooseFit, containScale, fitCandidates, type FitChoice } from "../node-fill";
import type { MehrpeleLabelSize } from "./model";
import { bleedArea, shapeBounds, type BleedArea, type BleedShape } from "./bleed";
import {
  bleedViewportBox,
  isViewportMode,
  labelScales,
  registerScreenScale,
  setViewportBox,
  setViewportFactor,
  viewportBoxOf,
  type EmbedScaling,
} from "./viewport";

export interface OverlayOptions {
  maxLabelWidth: number;
  /** Floor for an embed's UI scale (viewport scaling). */
  minEmbedUiScale: number;
  embedScaling: EmbedScaling;
  /**
   * User-sized nodes: the inner box (SVG units) each label may fill. The
   * label reflows to it and scales up to fill it (node-fill.ts).
   */
  fills?: Map<string, MehrpeleLabelSize>;
  /** Full-bleed nodes (bleed.ts): the label covers the node's shape inside its stroke. */
  bleeds?: Set<string>;
  /** Bleed nodes whose height the user set: an auto-height note keeps to it and scrolls. */
  held?: Set<string>;
  /** Note cards show their file name above the node, as Canvas file cards do. */
  cardLabels?: boolean;
}

const DEFAULT_OPTIONS: OverlayOptions = { maxLabelWidth: 480, minEmbedUiScale: 0.75, embedScaling: "viewport" };

interface PlacedItem {
  box: AnchorBox;
  el: HTMLElement;
  intrinsic: HTMLElement;
  /** The label element when it is sized as a viewport (embeds). */
  viewport: HTMLElement | null;
  /** Inner box this label fills (a user-sized node), SVG units. */
  fill?: MehrpeleLabelSize;
  /** The max width the label had before any fit (its own cap). */
  baseMax?: string;
  fit?: FitChoice;
  /** Full bleed: the element's box in its shape (SVG units, diagram coordinates). */
  bleed?: BleedArea;
  /** Note card: the file-name label above the node (Canvas card label). */
  cardLabel?: HTMLElement;
  /** Full bleed: the node's outline box (the anchor box of a circle or diamond is the label's reserved size). */
  outline?: AnchorBox;
}

/** Overlay geometry for the current SVG size. */
interface Geometry {
  viewBox: ReturnType<typeof parseViewBox> & object;
  /** Layout px per SVG unit (overlay space). */
  s: number;
  /** Client px per layout px of the overlay (ancestor transforms). */
  ancestor: number;
  /** SVG size in overlay layout px. */
  width: number;
  height: number;
}

export class MehrpeleOverlay {
  readonly el: HTMLElement;
  private items = new Map<string, PlacedItem[]>();
  private opts: OverlayOptions = DEFAULT_OPTIONS;
  private svg: SVGSVGElement | null = null;
  private svgText = "";

  constructor(parent: HTMLElement) {
    this.el = createDiv();
    this.el.className = "mehrpele-overlay markdown-rendered";
    parent.appendChild(this.el);
  }

  /** Place (or replace) all label elements for the current SVG. */
  place(svg: SVGSVGElement, svgText: string, rendered: RenderedLabel[], options?: Partial<OverlayOptions>): void {
    this.clear();
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.svg = svg;
    this.svgText = svgText;
    const g = this.geometry(svg, svgText);
    if (!g) return;
    const sizes = new Map<string, MehrpeleLabelSize>();
    const byAnchor = new Map<string, RenderedLabel>();
    for (const r of rendered) {
      sizes.set(r.label.anchorId, r.size);
      if (!byAnchor.has(r.label.anchorId)) byAnchor.set(r.label.anchorId, r);
    }
    const boxes = resolveAnchors(svgText, rendered.map((r) => r.label), sizes);
    const placed = new Set<string>();
    this.applyScaleVars(g);

    for (const box of boxes) {
      const source = byAnchor.get(box.anchorId);
      if (!source) continue;
      // First box for an anchor takes the real element; twins (sequence
      // header/footer) clone — embeds are never cloned, first box only.
      let el: HTMLElement;
      if (!placed.has(box.anchorId)) {
        el = source.el;
        placed.add(box.anchorId);
      } else if (source.label.embedTarget || source.mode === "diagram") {
        // Embeds and nested diagrams own live components: never cloned.
        continue;
      } else {
        el = source.el.cloneNode(true) as HTMLElement;
      }
      // The item is stretched to the reserved node box; the label lives in
      // an intrinsic wrapper inside it that is never stretched, so its size
      // is the true content size (what the re-measure pass reads).
      // The label's own inline width/height are kept: note/.base embeds pin
      // their fixed box there (labels.ts), and that box is what makes their
      // `overflow: auto` scroll. Clearing it let the embed grow to its full
      // content height, which the item's `overflow: hidden` then clipped.
      el.classList.remove("mehrpele-overlay-item");
      el.style.removeProperty("left");
      el.style.removeProperty("top");
      const viewport = isViewportMode(source.mode) ? el : null;
      const item = createDiv();
      item.className = viewport ? "mehrpele-overlay-item mehrpele-viewport-item" : "mehrpele-overlay-item";
      item.dataset.shape = box.shape;
      // Node box handles resolve the hovered node through this (node-handles.ts).
      if (source.label.kind === "node") item.dataset.anchor = box.svgDataId ?? box.anchorId;
      const intrinsic = createDiv();
      intrinsic.className = "mehrpele-intrinsic";
      // Viewport labels carry an explicit layout box (scaled below).
      intrinsic.style.maxWidth = viewport ? "none" : `${Math.max(1, source.max?.width ?? this.opts.maxLabelWidth)}px`;
      registerScreenScale(intrinsic, () => this.screenScale());
      intrinsic.appendChild(el);
      item.appendChild(intrinsic);
      this.el.appendChild(item);
      const entry: PlacedItem = { box, el: item, intrinsic, viewport };
      // Full bleed: the element covers its shape inside the stroke (bleed.ts bleedArea).
      const shape = this.opts.bleeds?.has(box.anchorId) && source.size.height > 0 ? bleedShapeOf(svg, box.svgDataId ?? box.anchorId) : null;
      if (shape) {
        const area = bleedArea(shape, source.size.width / source.size.height);
        if (area.w > 1 && area.h > 1) {
          entry.bleed = area;
          entry.outline = { ...box, ...shapeBounds(shape) };
          item.classList.add("is-bleed");
          if (area.inscribed) item.classList.add("is-inscribed");
          if (viewport) {
            const held = !!this.opts.held?.has(box.anchorId);
            setViewportBox(viewport, bleedViewportBox(source.mode, held, area, viewportBoxOf(viewport)));
          }
        }
      }
      // Full bleed fills its box even when the element has an explicit size (`|240`).
      const fill = entry.bleed && !viewport
        ? { width: entry.bleed.w, height: entry.bleed.h }
        : source.label.kind === "node" && !viewport && !source.explicitSize ? this.opts.fills?.get(box.anchorId) : undefined;
      if (fill) {
        entry.fill = fill;
        entry.baseMax = intrinsic.style.maxWidth;
        this.fitItem(entry);
      }
      const title = this.opts.cardLabels && source.label.kind === "node" ? source.el.dataset.cardLabel : undefined;
      if (title) {
        entry.cardLabel = this.el.createDiv({ cls: "mehrpele-card-label", text: title });
        entry.cardLabel.dataset.shape = box.shape;
        entry.cardLabel.setAttribute("aria-hidden", "true");
        item.classList.add("has-card-label");
      }
      this.layoutItem(entry, g);
      const list = this.items.get(box.anchorId) ?? [];
      list.push(entry);
      this.items.set(box.anchorId, list);
      hideSvgText(svg, box);
    }
  }

  /**
   * Re-anchor after the SVG changed size without a re-render (CSS zoom,
   * window/frame resize, lightbox). Viewport labels get their new layout
   * box here too.
   */
  reposition(svg: SVGSVGElement, svgText: string): void {
    this.svg = svg;
    this.svgText = svgText;
    const g = this.geometry(svg, svgText);
    if (!g) return;
    this.applyScaleVars(g);
    for (const list of this.items.values()) {
      for (const entry of list) this.layoutItem(entry, g);
    }
  }

  /** Current on-screen scale (client px per SVG unit) of the diagram. */
  scaleFor(svg: SVGSVGElement, svgText: string): number {
    const viewBox = parseViewBox(svgText);
    if (!viewBox) return 1;
    const s = svgScale(viewBox, svg.getBoundingClientRect());
    return Number.isFinite(s) && s > 0 ? s : 1;
  }

  private screenScale(): number {
    return this.svg && this.svgText ? this.scaleFor(this.svg, this.svgText) : 1;
  }

  private geometry(svg: SVGSVGElement, svgText: string): Geometry | null {
    const viewBox = parseViewBox(svgText);
    if (!viewBox || !(viewBox.width > 0)) return null;
    const rect = svg.getBoundingClientRect();
    const ancestor = ancestorScale(this.el);
    const width = rect.width / ancestor;
    const height = rect.height / ancestor;
    const s = width / viewBox.width;
    return { viewBox, s: Number.isFinite(s) && s > 0 ? s : 1, ancestor, width, height };
  }

  private applyScaleVars(g: Geometry): void {
    this.el.style.setProperty("--mehrpele-scale", String(round4(g.s)));
  }

  /**
   * Re-choose the fit of every filling label (its content changed size:
   * math typeset, an image decoded). Deterministic, so a second call with
   * the same content changes nothing (no observer loop).
   */
  refit(): void {
    const svg = this.svg;
    const g = svg ? this.geometry(svg, this.svgText) : null;
    for (const list of this.items.values()) {
      for (const entry of list) {
        if (!entry.fill) continue;
        this.fitItem(entry);
        if (g) this.layoutItem(entry, g);
      }
    }
  }

  /**
   * Fit a label into its node's inner box: try a few wrap widths (laid out
   * 1:1, SVG units) and keep the one with the largest contain scale. The
   * intrinsic wrapper keeps the chosen layout size (what the re-measure
   * reads); only the label inside it is scaled.
   */
  private fitItem(entry: PlacedItem): void {
    const fill = entry.fill;
    const label = entry.intrinsic.firstElementChild as HTMLElement | null;
    if (!fill || !label) return;
    label.style.removeProperty("transform");
    label.classList.remove("mehrpele-fill-scaled");
    label.style.removeProperty("--mehrpele-ui-counter");
    delete label.dataset.fillScale;
    const base = parseFloat(entry.baseMax ?? "") || this.opts.maxLabelWidth;
    entry.intrinsic.style.maxWidth = `${base}px`;
    const natural = entry.intrinsic.offsetWidth;
    if (!(natural > 0)) {
      entry.fit = undefined;
      return; // not laid out (detached): place() runs again when it is
    }
    const samples = fitCandidates(fill, base).map((m) => {
      entry.intrinsic.style.maxWidth = `${m}px`;
      // scroll sizes: fixed-size content (images, formulas) overflows a narrow wrap.
      const el = entry.intrinsic;
      return { maxWidth: m, width: Math.max(el.offsetWidth, el.scrollWidth), height: Math.max(el.offsetHeight, el.scrollHeight) };
    });
    let fit = chooseFit(samples, fill);
    // Full bleed: the element is its box, so it is scaled to fit it exactly
    // (no minimum step, and down too: never cut by its own viewport).
    if (entry.bleed && fit.width && fit.height) {
      const k = Math.min(FILL_MAX, containScale({ width: fit.width, height: fit.height }, fill));
      fit = { ...fit, scale: Math.floor(k * 10000) / 10000, overflow: false };
    }
    entry.fit = fit;
    // Content that cannot wrap that narrow (a table) would overflow its
    // wrapper and sit off centre: the wrapper takes the content's width.
    entry.intrinsic.style.maxWidth = `${Math.max(fit.maxWidth, Math.ceil(fit.width ?? 0))}px`;
    if (fit.scale !== 1) {
      label.style.transform = `scale(${fit.scale})`;
      label.classList.add("mehrpele-fill-scaled"); // transform-origin: center center (styles.css)
      label.dataset.fillScale = String(fit.scale);
    }
  }

  /** Position one item; viewport labels also get their layout box. */
  private layoutItem(entry: PlacedItem, g: Geometry): void {
    // A filling label's item is the node's inner box (circles and diamonds
    // included), centred on the node.
    const b = entry.bleed && !entry.fit?.overflow
      ? { x: entry.bleed.x, y: entry.bleed.y, width: entry.bleed.w, height: entry.bleed.h }
      : entry.fill && !entry.fit?.overflow
      ? {
          x: entry.box.x + entry.box.width / 2 - entry.fill.width / 2,
          y: entry.box.y + entry.box.height / 2 - entry.fill.height / 2,
          width: entry.fill.width,
          height: entry.fill.height,
        }
      : entry.box;
    const client = svgBoxToClient(b, g.viewBox, { width: g.width, height: g.height });
    entry.el.style.left = `${client.left}px`;
    entry.el.style.top = `${client.top}px`;
    entry.el.style.width = `${client.width}px`;
    entry.el.style.height = `${client.height}px`;
    if (entry.bleed) entry.el.style.borderRadius = bleedRadius(entry.bleed, g.s);
    if (entry.cardLabel) {
      // Above the node's box: left-aligned on rects (as on a Canvas card), centred on other shapes.
      const nb = svgBoxToClient(entry.outline ?? entry.box, g.viewBox, { width: g.width, height: g.height });
      // A top-row node has no room above inside the (clipping) frame: the label
      // then sits on the node's top border instead.
      const centred = !!entry.bleed?.inscribed;
      const onBorder = nb.top < (entry.cardLabel.offsetHeight || 16) + 4;
      entry.cardLabel.toggleClass("is-on-border", onBorder);
      const dy = onBorder ? "0" : "calc(-100% - 4px)";
      Object.assign(entry.cardLabel.style, {
        left: `${centred ? nb.left + nb.width / 2 : nb.left + (onBorder ? 8 : 0)}px`,
        top: `${onBorder ? 0 : nb.top}px`,
        maxWidth: `${Math.max(40, nb.width)}px`,
        transform: centred ? `translate(-50%, ${dy})` : `translate(0, ${dy})`,
      });
    }
    const { local, factor, counter } = labelScales(
      g.s,
      g.ancestor,
      !!entry.viewport,
      this.opts.minEmbedUiScale,
      this.opts.embedScaling,
    );
    if (entry.viewport) setViewportFactor(entry.viewport, factor);
    entry.intrinsic.style.transform = overlayTransform(local);
    entry.intrinsic.style.setProperty("--mehrpele-ui-counter", String(round4(counter)));
    // Handles inside a filled label keep their on-screen size too.
    const label = entry.fit && entry.fit.scale !== 1 ? (entry.intrinsic.firstElementChild as HTMLElement | null) : null;
    if (label) label.style.setProperty("--mehrpele-ui-counter", String(round4(counter / entry.fit!.scale)));
  }

  clear(): void {
    this.el.replaceChildren();
    this.items.clear();
  }

  destroy(): void {
    this.clear();
    this.el.remove();
  }

  /** The intrinsic (never-stretched) content wrapper for an anchor. */
  intrinsicElement(anchorId: string): HTMLElement | null {
    return this.items.get(anchorId)?.[0]?.intrinsic ?? null;
  }

  /** The live label element placed for an anchor. */
  labelElement(anchorId: string): HTMLElement | null {
    const item = this.items.get(anchorId)?.[0]?.el;
    if (!item) return null;
    return item.querySelector<HTMLElement>(".mehrpele-label") ?? item;
  }

  /** Fill scale per anchor (filled labels only), for diagnostics. */
  fillScales(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, list] of this.items) if (list[0]?.fit) out.set(id, list[0].fit.scale);
    return out;
  }

  get placedAnchors(): string[] {
    return [...this.items.keys()];
  }
}

/** Client px per layout px of `el` (CSS transforms on its ancestors); 1 when unknown. */
export function ancestorScale(el: HTMLElement): number {
  const w = el.offsetWidth;
  const r = el.getBoundingClientRect().width;
  const a = w > 0 && r > 0 ? r / w : 1;
  // offsetWidth is rounded: within a px of r means "not transformed".
  if (!Number.isFinite(a) || a <= 0 || Math.abs(r - w) <= 1) return 1;
  return a;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** CSS transform scaling 1:1 label layout to the SVG's client scale. */
export function overlayTransform(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0 || Math.abs(scale - 1) < 0.001) return "";
  return `scale(${Math.round(scale * 10000) / 10000})`;
}

/** CSS border-radius (layout px) of a bleed box at `s` layout px per SVG unit. */
export function bleedRadius(a: BleedArea, s: number): string {
  const px = (v: number): string => `${Math.round(v * s * 100) / 100}px`;
  if (a.bottomRy) return `0 0 50% 50% / 0 0 ${px(a.bottomRy)} ${px(a.bottomRy)}`;
  return a.r > 0 ? px(a.r) : "";
}

/** A node's outline (diagram coordinates) for full bleed; null for shapes it cannot place in. */
function bleedShapeOf(svg: SVGSVGElement, dataId: string): BleedShape | null {
  const id = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(dataId) : dataId;
  const g = svg.querySelector(`.pele-node[data-id="${id}"]`);
  if (!g) return null;
  const t = /translate\(\s*([-\d.e+]+)(?:[ ,]+([-\d.e+]+))?/.exec(g.getAttribute("transform") ?? "");
  const tx = t ? Number(t[1]) : 0;
  const ty = t ? Number(t[2] ?? 0) : 0;
  const n = (el: Element, a: string): number => Number(el.getAttribute(a) ?? 0) || 0;
  const strokeOf = (el: Element): number => {
    const w = typeof getComputedStyle === "function" ? Number.parseFloat(getComputedStyle(el).strokeWidth) : Number.NaN;
    return Number.isFinite(w) ? w : n(el, "stroke-width") || 1;
  };
  const shapes = [...g.children].filter((c) => /^(rect|circle|ellipse|polygon|path)$/i.test(c.tagName));
  const first = shapes[0];
  if (!first) return null;
  const tag = first.tagName.toLowerCase();
  const cls = g.getAttribute("class") ?? "";
  if (tag === "rect") {
    // A subroutine's inner bars (`M-120,-84V84M120,-84V84`): stay between them.
    const bar = shapes.slice(1).map((p) => /^M\s*([-\d.e+]+)[ ,]/i.exec(p.getAttribute("d") ?? "")).find(Boolean);
    const x = n(first, "x");
    return {
      kind: "rect",
      x: tx + x,
      y: ty + n(first, "y"),
      w: n(first, "width"),
      h: n(first, "height"),
      rx: n(first, "rx") || n(first, "ry"),
      stroke: strokeOf(first),
      ...(bar ? { bars: Math.abs(Number(bar[1]) - x) } : {}),
    };
  }
  if (tag === "circle") return { kind: "circle", cx: tx + n(first, "cx"), cy: ty + n(first, "cy"), r: n(first, "r"), stroke: strokeOf(first) };
  if (tag === "polygon") {
    const nums = (first.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number);
    const points: Array<[number, number]> = [];
    for (let i = 0; i + 1 < nums.length; i += 2) points.push([tx + nums[i], ty + nums[i + 1]]);
    return points.length >= 3 && points.every((p) => p.every(Number.isFinite)) ? { kind: "polygon", points, stroke: strokeOf(first) } : null;
  }
  if (tag === "path" && /\bpele-shape-(cyl|cylinder|db|database|das)\b/.test(cls)) {
    // M-120,-84 A120,12 0 0 1 120,-84 V84 A120,12 0 0 1 -120,84 Z: the body between the caps.
    const m = /^M\s*([-\d.e+]+)[ ,]([-\d.e+]+)\s*A\s*([-\d.e+]+)[ ,]([-\d.e+]+)[^V]*V\s*([-\d.e+]+)/i.exec(first.getAttribute("d") ?? "");
    if (!m) return null;
    const [x, y, rx, ry, y2] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
    return { kind: "cylinder", x: tx + x, y: ty + y - ry, w: 2 * rx, h: y2 - y + 2 * ry, ry, stroke: strokeOf(first) };
  }
  return null;
}

/** Hide the SVG `<text>` for an anchored label only (kept for a11y/export).
 *  Twins (sequence header/footer) each hide their own group's text. */
function hideSvgText(svg: SVGSVGElement, box: AnchorBox): void {
  const at = anchorScope(box);
  const scope = at ? svg.querySelectorAll(at.selector)[at.index] : undefined;
  scope?.querySelectorAll("text").forEach((t) => {
    t.classList.add("mehrpele-text-hidden"); // visibility: hidden (styles.css)
  });
}
