/**
 * DOM side of responsive reflow, shared by DiagramFrame, MehrpeleShell and
 * the lightbox: the layout width a frame offers, the fonts Pele's mount
 * measures with, a debounced column watcher, display sizing (never
 * magnified, floor then scroll) and FLIP transitions between layouts.
 *
 * Reflow output is derived and never persisted: nothing here writes notes.
 */
import { displayScale } from "pele-render/reflow";
import type { ReflowPolicy } from "pele-render/reflow";
import type { SettingsV3 } from "./settings/schema";
import { bodyMermaidFont } from "./core-look";

export const REFLOW_DEBOUNCE_MS = 100;
/** Skip FLIP above this many nodes. */
export const FLIP_MAX_NODES = 150;
const FLIP_MS = 280;
const FADE_MS = 200;
const FADE_DELAY_MS = 140;

/**
 * The SVG carries its display width inline; this class (styles.css) lifts the
 * stylesheet's `max-width: 100%`. Removed where inline sizing is handed back
 * to the stylesheet.
 */
export const REFLOW_SIZED_CLASS = "pele-reflow-sized";
/** Keeps `height: auto` (styles.css) so the inline width rules the height. */
export const REFLOW_HEIGHT_CLASS = "pele-reflow-height";

/**
 * Size the SVG by its inline width (no max-width, auto height). The inline
 * properties are cleared so the classes apply now, while a later inline value
 * (Pele's zoom making room for its controls) still wins over them.
 */
function markReflowSized(svg: SVGSVGElement): void {
  svg.style.removeProperty("max-width");
  svg.style.removeProperty("height");
  svg.classList.add(REFLOW_SIZED_CLASS, REFLOW_HEIGHT_CLASS);
}
/** FLIP classes (styles.css): hold transitions, rest translate, fade, let overflow show. */
const FLIP_HOLD_CLASS = "pele-flip-hold";
const FLIP_MOVE_CLASS = "pele-flip-move";
const FLIP_FADE_CLASS = "pele-flip-fade";
const FLIP_OVERFLOW_CLASS = "pele-flip-overflow";

/** Retired reflow options, now fixed: `width=N` never magnifies; layout changes animate (reduced motion still skips). */
export const LEGACY_MAGNIFY = false;
export const REFLOW_ANIMATE = true;

/** Planner policy from the plugin settings (one switch covers direction switching and auto-turn). */
export function reflowPolicy(s: SettingsV3["features"]["reflow"]): Partial<ReflowPolicy> {
  return { switchDirection: s.switchDirection, autoTurn: s.switchDirection, minTextScale: s.minTextScale };
}

/** Content width of `el` (its client width minus padding); 0 when not laid out. */
export function contentWidth(el: HTMLElement): number {
  try {
    const cs = getComputedStyle(el);
    const w = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    return w > 0 ? Math.floor(w) : 0;
  } catch {
    return 0;
  }
}

/**
 * Layout width L for a frame: the column, capped by the fence `width=N`
 * and the global max width. Nested frames use their node bound instead of
 * the column (their column is the shrink-wrapped label itself).
 */
export function layoutWidthFor(column: number, opts: { width?: number; settingsMax?: number; nestedMax?: number }): number {
  const caps = [opts.width, opts.settingsMax].filter((v): v is number => typeof v === "number" && v > 0);
  if (opts.nestedMax !== undefined && opts.nestedMax > 0) return Math.floor(Math.min(opts.nestedMax, ...caps));
  if (!(column > 0)) return 0;
  return Math.floor(Math.min(column, ...caps));
}

/**
 * The fonts Pele's mount() measures with (its --pele-font / --pele-font-mono lookup).
 * Order: setting > host --pele-font > core's body --font-mermaid > inherited font.
 */
export function cssFonts(el: HTMLElement, configured?: string): { fontFamily?: string; fontFamilyMono?: string } {
  const out: { fontFamily?: string; fontFamilyMono?: string } = {};
  try {
    const cs = getComputedStyle(el);
    const family = configured || cs.getPropertyValue("--pele-font").trim() || bodyMermaidFont() || cs.fontFamily;
    const mono = cs.getPropertyValue("--pele-font-mono").trim();
    if (family) out.fontFamily = family;
    if (mono) out.fontFamilyMono = mono;
  } catch {
    /* no layout */
  }
  return out;
}

/**
 * Debounced width watcher. The observer callback only schedules; layout
 * changes run later (timer + animation frame), never inside the callback.
 * Height-only changes (our own re-layouts) are ignored.
 */
export class ColumnWatcher {
  private obs: ResizeObserver | null = null;
  private timer: number | null = null;
  private frame: number | null = null;
  private last = -1;
  /** Extra observed elements (Canvas card): width and height both count. */
  private extra = new Map<Element, string>();

  constructor(
    private el: HTMLElement,
    private onWidth: (width: number) => void,
    private delay = REFLOW_DEBOUNCE_MS,
  ) {
    if (typeof ResizeObserver === "undefined") return;
    this.obs = new ResizeObserver((entries) => {
      let changed = false;
      let first = false;
      for (const e of entries) {
        if (e.target === this.el) {
          const w = Math.round(e.contentRect.width);
          if (w === this.last) continue;
          // First sighting (the frame was just laid out): no debounce.
          first ||= this.last <= 0;
          this.last = w;
          changed = true;
        } else {
          const size = `${Math.round(e.contentRect.width)}x${Math.round(e.contentRect.height)}`;
          if (this.extra.get(e.target) === size) continue;
          this.extra.set(e.target, size);
          changed = true;
        }
      }
      if (changed) this.schedule(first ? 0 : this.delay);
    });
    this.obs.observe(el);
  }

  private schedule(delay: number): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.frame !== null) return;
      this.frame = window.requestAnimationFrame(() => {
        this.frame = null;
        if (this.el.isConnected) this.onWidth(contentWidth(this.el));
      });
    }, delay);
  }

  /** Also watch another element (Canvas card content for fit-box height). */
  observe(other: Element): void {
    this.extra.set(other, "");
    this.obs?.observe(other);
  }

  disconnect(): void {
    this.obs?.disconnect();
    this.obs = null;
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.timer = this.frame = null;
  }
}

export interface DisplayOptions {
  /** Layout width the diagram must fit. */
  layoutWidth: number;
  /** Shrink floor. */
  floor: number;
  /** Legacy magnify: scale up to this width (the fence width within the column). */
  magnifyTo?: number;
  /**
   * Explicit user zoom (fence `zoom=`, from a corner drag): the layout is
   * planned for layoutWidth already divided by it, and the display scale is
   * multiplied by it. Never set by container changes.
   */
  zoom?: number;
}

/**
 * Size the SVG for display: never above 1× (unless legacy magnify or an
 * explicit zoom), shrunk to the floor at most, then the scroll host
 * scrolls. Returns the scale.
 */
export function applyDisplaySize(
  svg: SVGSVGElement,
  naturalWidth: number,
  scrollHost: HTMLElement,
  o: DisplayOptions,
): { scale: number; scroll: boolean } {
  let { scale, scroll } = displayScale(o.layoutWidth, naturalWidth, o.floor);
  if (o.zoom !== undefined && o.zoom > 1) scale *= o.zoom;
  if (o.magnifyTo !== undefined && naturalWidth > 0 && o.magnifyTo > naturalWidth * scale) {
    scale = o.magnifyTo / naturalWidth;
    scroll = false;
  }
  if (naturalWidth > 0) {
    svg.style.width = `${Math.round(naturalWidth * scale * 100) / 100}px`;
    markReflowSized(svg);
  }
  scrollHost.classList.toggle("is-scrolling", scroll);
  return { scale, scroll };
}

/**
 * Size the SVG for a frame box plan (planFill: `width=W height=H`): shown at
 * the plan's fill scale (above 1× when the box has room on both sides),
 * top-aligned in the box; below the floor the box scrolls. Returns the scale.
 */
export function applyBoxDisplay(
  svg: SVGSVGElement,
  naturalWidth: number,
  scrollHost: HTMLElement,
  plan: { scale: number; scroll: boolean },
  boxHeight: number,
): { scale: number; scroll: boolean } {
  if (naturalWidth > 0) {
    svg.style.width = `${Math.round(naturalWidth * plan.scale * 100) / 100}px`;
    markReflowSized(svg);
  }
  scrollHost.classList.toggle("is-scrolling", plan.scroll);
  scrollHost.style.maxHeight = `${Math.max(1, Math.round(boxHeight))}px`;
  scrollHost.style.overflowY = plan.scroll ? "auto" : "hidden";
  return { scale: plan.scale, scroll: plan.scroll };
}

/** Undo applyBoxDisplay's box styles (the frame lost its height). */
export function clearBoxDisplay(scrollHost: HTMLElement): void {
  scrollHost.style.removeProperty("max-height");
  scrollHost.style.removeProperty("overflow-y");
}

/**
 * Run a synchronous re-render of `root`; when its height changed, tell the
 * host (`heightChanged`) so a virtualised Reading view re-measures the
 * section. Obsidian caches section heights when the width changes, before a
 * debounced re-layout lands; a stale height makes its spacer jump the
 * reading position once sections above are unloaded.
 */
export function withHeightCheck(root: HTMLElement, change: () => void, heightChanged?: (el: HTMLElement) => void): void {
  const before = root.isConnected ? root.offsetHeight : -1;
  change();
  if (!heightChanged || before < 0) return;
  if (root.offsetHeight !== before) heightChanged(root);
  // FLIP holds the old height while it animates: measure again after it.
  window.setTimeout(() => {
    if (root.isConnected) heightChanged(root);
  }, FLIP_MS + 160);
}

/** Whether `el` intersects the viewport (off-screen layout changes don't animate). */
export function inViewport(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < (window.innerHeight || 0) && r.width > 0;
}

/** Whether layout changes should animate here and now. */
export function canAnimate(root: HTMLElement, enabled: boolean): boolean {
  if (!enabled || !root.isConnected || !inViewport(root)) return false;
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if (root.closest(".lightbox, .is-resizing, .is-node-resizing")) return false;
  return !root.querySelector(".is-resizing, .is-node-resizing, .mehrpele-resizing");
}

export interface FlipSnapshot {
  nodes: Map<string, DOMRect>;
  items: Map<string, DOMRect>;
  height: number;
}

/** This diagram's own nodes (not nested diagrams'). */
function ownNodes(svg: SVGSVGElement): SVGGraphicsElement[] {
  return [...svg.querySelectorAll<SVGGraphicsElement>(".pele-node[data-id]")].filter((g) => g.ownerSVGElement === svg);
}

/** Overlay items placed by the Mehrpele mount in `container` (not nested ones). */
function ownItems(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".mehrpele-overlay-item[data-anchor]")].filter(
    (el) => el.closest(".mehrpele-frame") === container,
  );
}

/** Client rects before a layout change; null when there is nothing to animate. */
export function snapshotLayout(svg: SVGSVGElement | null, heightEl: HTMLElement, overlayContainer?: HTMLElement | null): FlipSnapshot | null {
  if (!svg) return null;
  const nodes = ownNodes(svg);
  if (nodes.length === 0 || nodes.length > FLIP_MAX_NODES) return null;
  const snap: FlipSnapshot = { nodes: new Map(), items: new Map(), height: heightEl.getBoundingClientRect().height };
  for (const g of nodes) snap.nodes.set(g.getAttribute("data-id")!, g.getBoundingClientRect());
  if (overlayContainer) for (const el of ownItems(overlayContainer)) snap.items.set(el.dataset.anchor!, el.getBoundingClientRect());
  return snap;
}

/** Latest FLIP per height element: an older run's cleanup must not undo a newer one. */
const flipRuns = new WeakMap<HTMLElement, number>();
/** When the latest FLIP on a height element has cleaned up (Date.now() ms). */
const flipEnds = new WeakMap<HTMLElement, number>();
/** How long a FLIP runs, cleanup included. */
const FLIP_SETTLE_MS = FLIP_MS + 120;

/** Milliseconds until the FLIP playing on `heightEl` has finished (0: none is playing). */
export function flipRemaining(heightEl: HTMLElement): number {
  const end = flipEnds.get(heightEl);
  return end === undefined ? 0 : Math.max(0, end - Date.now());
}

const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/**
 * FLIP: move each node (and overlay item) from its old position to its new
 * one. Nodes travel in SVG units (CSS `translate` composes with Pele's
 * transform attribute), overlay items in client px. The SVG overflows
 * visibly and the frame's height tweens, so nothing is clipped and content
 * below doesn't jump. Edges, edge labels and clusters cross-fade.
 */
export function playFlip(snap: FlipSnapshot, svg: SVGSVGElement, heightEl: HTMLElement, overlayContainer?: HTMLElement | null): number {
  const vbw = svg.viewBox?.baseVal?.width || 0;
  const rect = svg.getBoundingClientRect();
  const s = vbw > 0 && rect.width > 0 ? rect.width / vbw : 1;
  const moved: (SVGGraphicsElement | HTMLElement)[] = [];
  for (const g of ownNodes(svg)) {
    const a = snap.nodes.get(g.getAttribute("data-id")!);
    if (!a) continue;
    const from = centre(a);
    const to = centre(g.getBoundingClientRect());
    const dx = (from.x - to.x) / s;
    const dy = (from.y - to.y) / s;
    if (Math.abs(dx) + Math.abs(dy) < 1) continue;
    // Hold (no transition) at the old offset; the class also fixes the rest
    // position (translate 0 0) the inline offset is released to.
    g.classList.add(FLIP_HOLD_CLASS, FLIP_MOVE_CLASS);
    g.style.translate = `${dx}px ${dy}px`;
    moved.push(g);
  }
  if (overlayContainer) {
    for (const el of ownItems(overlayContainer)) {
      const a = snap.items.get(el.dataset.anchor!);
      if (!a) continue;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) continue;
      el.classList.add(FLIP_HOLD_CLASS, FLIP_MOVE_CLASS);
      el.style.translate = `${dx}px ${dy}px`;
      moved.push(el);
    }
  }
  if (moved.length === 0) return 0;
  const run = (flipRuns.get(heightEl) ?? 0) + 1;
  flipRuns.set(heightEl, run);
  flipEnds.set(heightEl, Date.now() + FLIP_SETTLE_MS);
  const fades = [...svg.querySelectorAll<SVGElement>(".pele-edges, .pele-edge, .pele-edge-label, .pele-edge-labels, .pele-cluster, .pele-clusters")].filter(
    (e) => e.ownerSVGElement === svg,
  );
  // Hidden without a transition (class: transition none, opacity 0).
  for (const e of fades) e.classList.add(FLIP_FADE_CLASS);
  const newHeight = heightEl.getBoundingClientRect().height;
  svg.classList.add(FLIP_OVERFLOW_CLASS);
  heightEl.classList.add(FLIP_OVERFLOW_CLASS);
  heightEl.style.height = `${snap.height}px`;
  void heightEl.getBoundingClientRect(); // commit the "first" positions
  window.requestAnimationFrame(() => {
    if (flipRuns.get(heightEl) !== run) return;
    const ease = "cubic-bezier(.2,.8,.2,1)";
    for (const el of moved) {
      // Release the hold and the inline offset: the class's rest translate
      // (0 0) takes over and the inline transition tweens to it.
      el.classList.remove(FLIP_HOLD_CLASS);
      el.style.transition = `translate ${FLIP_MS}ms ${ease}`;
      el.style.removeProperty("translate");
    }
    for (const e of fades) {
      // Dropping the class restores the opacity; the inline transition fades it in.
      e.style.transition = `opacity ${FADE_MS}ms ease-out ${FADE_DELAY_MS}ms`;
      e.classList.remove(FLIP_FADE_CLASS);
    }
    heightEl.style.transition = `height ${FLIP_MS}ms ${ease}`;
    heightEl.style.height = `${newHeight}px`;
  });
  window.setTimeout(() => {
    if (flipRuns.get(heightEl) !== run) return;
    for (const el of moved) {
      el.style.removeProperty("transition");
      el.classList.remove(FLIP_HOLD_CLASS, FLIP_MOVE_CLASS);
    }
    for (const e of fades) e.style.removeProperty("transition");
    svg.classList.remove(FLIP_OVERFLOW_CLASS);
    heightEl.classList.remove(FLIP_OVERFLOW_CLASS);
    heightEl.style.removeProperty("transition");
    heightEl.style.removeProperty("height");
  }, FLIP_SETTLE_MS);
  return moved.length;
}
