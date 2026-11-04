/**
 * Box handles for individual diagram nodes (plain Pele frames and Mehrpele
 * shells). Hovering a sizable node outlines it and shows one corner handle
 * on its bottom-right; dragging the handle previews the new box as a ghost
 * of the node's own outline (node-outline.ts) scaled to the size the solver
 * will draw, and, on a genuine release, writes the node's `%% pele-size … %%` entry
 * through the host. Double-clicking the handle removes the entry.
 *
 * Writes only ever come from a trusted primary press on the handle itself
 * that travelled past the drag threshold and ended in a trusted release
 * (drag-move.ts); clicks, jitter, cancelled or synthetic gestures restore
 * without writing, and an unchanged size is never written.
 */
import { nodeBoxMap, nodeSizeCaps, type SizeCaps } from "pele-render/node-size";
import { isGenuineHandleClick, isGenuineHandlePress, trackHandleDrag } from "./drag-move";
import { committedEntry, dragNodeBox, isSameBox, nodeSizeEntry, settleEntry, writeNodeSize, type Box } from "./node-size";
import { elementOutline, isTextOnly, layoutBox, nodeClientRect, outlinePaths } from "./node-outline";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface NodeHandleHost {
  /** The frame's `.pele-host` wrapper: hover target and the layer's parent. */
  wrapper: HTMLElement;
  /** This diagram's own SVG (nested diagrams have their own layers). */
  svg(): SVGSVGElement | null;
  /** Current block source (with its directive). */
  source(): string;
  /** Handles on (setting "hover", desktop, not in the lightbox). */
  enabled(): boolean;
  /** Font size the diagram renders at (height snaps to 1.5 em lines). */
  fontSize(): number;
  /** Apply an edited source (persist or re-render without saving). */
  persist(next: string): void;
  /** Box the solver renders for `next` (plain diagrams); null when unknown. */
  applied?(next: string, id: string): Box | null;
}

/** Marks a pointer event already handled by a nested diagram's layer. */
const HANDLED = Symbol.for("pele-node-handles.handled");

export const NODE_HANDLE_CLASS = "pele-node-handle";
export const NODE_RESIZING_CLASS = "is-node-resizing";
/** Hides a layer element (`display: none`, styles.css) until removed. */
const HIDDEN_CLASS = "pele-hidden";

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

/** Client px per layout px of `el` (an ancestor may be CSS-scaled). */
function layoutScale(el: HTMLElement): number {
  const w = el.offsetWidth;
  const r = el.getBoundingClientRect().width;
  return w > 0 && r > 0 ? r / w : 1;
}

/** Client px per SVG unit. */
function svgScale(svg: SVGSVGElement): number {
  const vb = svg.viewBox?.baseVal;
  const r = svg.getBoundingClientRect();
  return vb && vb.width > 0 && r.width > 0 ? r.width / vb.width : 1;
}

export class NodeHandleLayer {
  private layer: HTMLElement;
  /** Hover outline: an SVG drawn on the node's own shapes (node-outline.ts). */
  private outline: SVGSVGElement;
  private handle: HTMLElement;
  /** The previewed box (positions the size label). */
  private ghost: HTMLElement;
  private ghostLabel: HTMLElement;
  /** The node's outline, scaled to the previewed box. */
  private ghostShape: SVGSVGElement;
  private current: { id: string; el: SVGGraphicsElement; caps: SizeCaps } | null = null;
  private dragging = false;
  private capsCache: { source: string; caps: Map<string, SizeCaps> | null } | null = null;
  private mutations: MutationObserver | null = null;

  constructor(private host: NodeHandleHost) {
    const mk = (cls: string): HTMLElement => {
      const el = createDiv();
      el.className = cls;
      return el;
    };
    this.layer = mk("pele-node-handles");
    this.outline = document.createElementNS(SVG_NS, "svg");
    this.outline.setAttribute("class", "pele-node-outline");
    this.outline.setAttribute("aria-hidden", "true");
    this.handle = mk(NODE_HANDLE_CLASS);
    this.handle.setAttribute("aria-label", "Drag to resize node, double-click to reset");
    this.ghost = mk("pele-node-ghost");
    this.ghostLabel = mk("pele-node-ghost-size");
    this.ghost.appendChild(this.ghostLabel);
    this.ghostShape = document.createElementNS(SVG_NS, "svg");
    this.ghostShape.setAttribute("class", "pele-node-ghost-shape");
    this.ghostShape.setAttribute("aria-hidden", "true");
    this.layer.append(this.outline, this.ghostShape, this.ghost, this.handle);
    this.hideAll();
    host.wrapper.appendChild(this.layer);
    // A re-render replaces the SVG under a still pointer: drop the stale outline.
    if (typeof MutationObserver !== "undefined") {
      this.mutations = new MutationObserver(() => {
        if (this.current && !this.dragging && !this.current.el.isConnected) this.hideAll();
      });
      this.mutations.observe(host.wrapper, { childList: true, subtree: true });
    }
    host.wrapper.addEventListener("pointermove", this.onHover);
    host.wrapper.addEventListener("pointerleave", this.onLeave);
    this.handle.addEventListener("pointerdown", this.onDown);
    this.handle.addEventListener("dblclick", this.onDblClick);
    this.handle.addEventListener("click", this.swallow);
    this.handle.addEventListener("contextmenu", this.swallow);
  }

  destroy(): void {
    this.mutations?.disconnect();
    this.mutations = null;
    this.host.wrapper.removeEventListener("pointermove", this.onHover);
    this.host.wrapper.removeEventListener("pointerleave", this.onLeave);
    this.handle.removeEventListener("pointerdown", this.onDown);
    this.handle.removeEventListener("dblclick", this.onDblClick);
    this.handle.removeEventListener("click", this.swallow);
    this.handle.removeEventListener("contextmenu", this.swallow);
    this.layer.remove();
    this.current = null;
  }

  /** The node under the pointer, if this layer may size it. */
  nodeAt(target: EventTarget | null): { id: string; el: SVGGraphicsElement; caps: SizeCaps } | null {
    const svg = this.host.svg();
    if (!svg || !(target instanceof Element)) return null;
    const wrapper = this.host.wrapper;
    let g = target.closest<SVGGraphicsElement>(".pele-node[data-id]");
    if (g && g.closest("svg") !== svg) g = null;
    if (!g) {
      // Mehrpele: the HTML overlay sits above the SVG; resolve through its anchor.
      const item = target.closest<HTMLElement>(".mehrpele-overlay-item[data-anchor]");
      if (item && item.closest(".pele-host") === wrapper) {
        const anchor = item.dataset.anchor ?? "";
        g = svg.querySelector<SVGGraphicsElement>(`.pele-node[data-id="${cssEscape(anchor)}"]`);
      }
    }
    if (!g || g.closest(".pele-host") !== wrapper) return null;
    const id = g.getAttribute("data-id") ?? "";
    const caps = this.caps()?.get(id);
    return caps ? { id, el: g, caps } : null;
  }

  /**
   * Text-only nodes (plain mindmap leaves) are hit only on their glyphs:
   * also accept the pointer anywhere inside their layout box.
   */
  private textNodeAt(ev: PointerEvent): { id: string; el: SVGGraphicsElement; caps: SizeCaps } | null {
    const svg = this.host.svg();
    if (!svg || !(ev.target instanceof Element) || !this.host.wrapper.contains(ev.target)) return null;
    for (const g of svg.querySelectorAll<SVGGraphicsElement>(".pele-node.pele-shape-text[data-id]")) {
      if (g.ownerSVGElement !== svg) continue;
      const r = nodeClientRect(g);
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) continue;
      const hit = this.nodeAt(g);
      if (hit) return hit;
    }
    return null;
  }

  private caps(): Map<string, SizeCaps> | null {
    const source = this.host.source();
    if (this.capsCache?.source !== source) this.capsCache = { source, caps: nodeSizeCaps(source) };
    return this.capsCache.caps;
  }

  private onHover = (ev: PointerEvent): void => {
    if (this.dragging) return;
    if (ev.target === this.handle) return;
    const marked = (ev as unknown as Record<symbol, unknown>)[HANDLED];
    // A "+" being dragged to connect (edit toolbar) owns the pointer.
    const connecting = this.host.wrapper.classList.contains("is-pele-connecting");
    if (marked || connecting || !this.host.enabled() || ev.pointerType === "touch") {
      if (!marked || this.current) this.hideAll();
      return;
    }
    const hit = this.nodeAt(ev.target) ?? this.textNodeAt(ev);
    if (!hit) {
      // Diamonds, circles, stadiums: the handle sits on the bounding-box
      // corner, outside the shape. Keep it while the pointer is still inside
      // the node's box (plus the handle's reach) on its way there.
      if (this.current?.el.isConnected && this.nearCurrent(ev)) return;
      this.hideAll();
      return;
    }
    // An inner diagram's layer owns this event; enclosing layers stand down.
    (ev as unknown as Record<symbol, unknown>)[HANDLED] = true;
    this.current = hit;
    this.place(hit.el);
  };

  private nearCurrent(ev: PointerEvent): boolean {
    const r = nodeClientRect(this.current!.el);
    const reach = 12;
    return ev.clientX >= r.left - reach && ev.clientX <= r.right + reach && ev.clientY >= r.top - reach && ev.clientY <= r.bottom + reach;
  }

  private onLeave = (): void => {
    if (!this.dragging) this.hideAll();
  };

  private hideAll(): void {
    this.outline.classList.add(HIDDEN_CLASS);
    this.handle.classList.add(HIDDEN_CLASS);
    this.ghost.classList.add(HIDDEN_CLASS);
    this.ghostShape.classList.add(HIDDEN_CLASS);
    if (!this.dragging) this.current = null;
  }

  /** Wrapper-local layout coordinates of a client rect. */
  private local(r: DOMRect): { x: number; y: number; w: number; h: number; k: number } {
    const wr = this.host.wrapper.getBoundingClientRect();
    const k = layoutScale(this.host.wrapper);
    return { x: (r.left - wr.left) / k, y: (r.top - wr.top) / k, w: r.width / k, h: r.height / k, k };
  }

  private place(el: SVGGraphicsElement): void {
    const wr0 = this.host.wrapper.getBoundingClientRect();
    const k0 = layoutScale(this.host.wrapper);
    // The same outline the edit toolbar draws on selection (node-outline.ts).
    const outline = elementOutline(el);
    if (!outline) return;
    // Client px → this layer's layout px (the wrapper may sit in a scaled node).
    const toLayer = new DOMMatrix().scale(1 / k0).translate(-wr0.left, -wr0.top);
    this.outline.replaceChildren(
      ...outlinePaths(outline, toLayer).map((p) => {
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", p.d);
        path.setAttribute("transform", p.transform);
        return path;
      }),
    );
    this.outline.classList.remove(HIDDEN_CLASS);
    const r = this.local(outline.bounds);
    let hx = (outline.corner.x - wr0.left) / k0;
    let hy = (outline.corner.y - wr0.top) / k0;
    // Media nodes also carry a content handle near the same corner: keep the
    // two apart so both stay grabbable.
    const content = this.contentCorner(el);
    if (content) {
      const c = this.local(content);
      if (Math.hypot(c.x + c.w - hx, c.y + c.h - hy) * r.k < 14) {
        hx += 8 / r.k;
        hy += 8 / r.k;
      }
    }
    // On the outline's corner, even next to the frame's resize corner: this
    // layer stacks above it (styles.css), and only the 12 px handle takes
    // pointer events, so the rest of the frame corner stays grabbable.
    this.handle.classList.remove(HIDDEN_CLASS);
    Object.assign(this.handle.style, { left: `${hx}px`, top: `${hy}px`, scale: String(1 / r.k) });
  }

  /** The content handle of a Mehrpele media node (image/embed corner or nested frame corner). */
  private contentCorner(el: SVGGraphicsElement): DOMRect | null {
    const id = el.getAttribute("data-id") ?? "";
    const item = this.host.wrapper.querySelector(`.mehrpele-overlay-item[data-anchor="${cssEscape(id)}"]`);
    const corner = item?.querySelector(".mehrpele-node-resize, .image-resize-corner");
    return corner ? corner.getBoundingClientRect() : null;
  }

  private swallow = (e: Event): void => {
    e.stopPropagation();
    e.preventDefault();
  };

  private onDblClick = (e: MouseEvent): void => {
    if (!isGenuineHandleClick(e, this.handle)) return;
    e.preventDefault();
    e.stopPropagation();
    const hit = this.current;
    if (!hit) return;
    const source = this.host.source();
    if (!nodeSizeEntry(source, hit.id)) return; // nothing to reset: no write
    const next = writeNodeSize(source, hit.id, null);
    if (next !== source) this.host.persist(next);
  };

  private onDown = (e: PointerEvent): void => {
    if (!isGenuineHandlePress(e, this.handle) || !this.current) return;
    e.preventDefault();
    e.stopPropagation();
    const svg = this.host.svg();
    if (!svg) return;
    const hit = this.current;
    const start = this.startBox(hit.el);
    if (!start) return;
    const scale = svgScale(svg) || 1;
    const rect = nodeClientRect(hit.el);
    const lineHeight = 1.5 * (this.host.fontSize() || 16);
    const source0 = this.host.source();
    const existing = nodeSizeEntry(source0, hit.id);
    // Timers and frames of the window the diagram is in (a popout keeps running when the main one is hidden).
    const win = this.host.wrapper.ownerDocument.defaultView ?? window;
    let end: Box = start;
    /** What the ghost shows: the box the solver draws for `end` (it may clamp a shape or a word). */
    let shown: Box = start;
    /** What the label states: the entry a release writes now (settleEntry, as on release). */
    let written: Box = start;
    let solvedAt = 0;
    let raf = 0;
    let trailing = 0;
    this.dragging = true;
    this.host.wrapper.classList.add(NODE_RESIZING_CLASS);
    this.outline.classList.add(HIDDEN_CLASS);
    // The ghost is the node's own outline, scaled about its centre (constant stroke: styles.css).
    const r0 = this.local(rect);
    const cx = r0.x + r0.w / 2;
    const cy = r0.y + r0.h / 2;
    const wr0 = this.host.wrapper.getBoundingClientRect();
    const outline = elementOutline(hit.el);
    const group = document.createElementNS(SVG_NS, "g");
    if (outline) {
      const toLayer = new DOMMatrix().scale(1 / r0.k).translate(-wr0.left, -wr0.top);
      for (const p of outlinePaths(outline, toLayer)) {
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", p.d);
        path.setAttribute("transform", p.transform);
        group.appendChild(path);
      }
    }
    this.ghostShape.replaceChildren(group);
    const solve = (): void => {
      solvedAt = performance.now();
      const want = committedEntry(start, end, existing, hit.caps);
      const applied = want && this.host.applied ? this.host.applied(writeNodeSize(source0, hit.id, want), hit.id) : null;
      shown = applied ? { w: Math.round(applied.w), h: Math.round(applied.h) } : end;
      const settled = want ? settleEntry(want, applied) : null;
      const w = settled?.w ?? end.w;
      written = { w, h: settled?.h ?? (hit.caps.lock === "square" ? w : end.h) };
    };
    const showGhost = (): void => {
      const w = (shown.w * scale) / r0.k;
      const h = (shown.h * scale) / r0.k;
      group.setAttribute("transform", `translate(${cx} ${cy}) scale(${shown.w / start.w} ${shown.h / start.h}) translate(${-cx} ${-cy})`);
      this.ghostShape.classList.toggle(HIDDEN_CLASS, !outline);
      this.ghost.classList.remove(HIDDEN_CLASS);
      Object.assign(this.ghost.style, { left: `${cx - w / 2}px`, top: `${cy - h / 2}px`, width: `${w}px`, height: `${h}px` });
      this.ghost.classList.toggle("is-boxed", !outline);
      this.ghostLabel.textContent = `${written.w} × ${written.h}`;
      this.ghostLabel.style.scale = String(1 / r0.k);
      Object.assign(this.handle.style, { left: `${cx + w / 2}px`, top: `${cy + h / 2}px` });
    };
    const frame = (): void => {
      if (!raf) {
        raf = win.requestAnimationFrame(() => {
          raf = 0;
          showGhost();
        });
      }
    };
    trackHandleDrag(this.handle, e, {
      onMove: (dx, dy) => {
        end = dragNodeBox(start, { x: dx / scale, y: dy / scale }, hit.caps, { lineHeight });
        // The solver renders the diagram: at most every 80 ms, and once the pointer rests.
        win.clearTimeout(trailing);
        if (performance.now() - solvedAt >= 80) solve();
        else
          trailing = win.setTimeout(() => {
            if (!this.dragging) return;
            solve();
            frame();
          }, 80);
        frame();
      },
      onEnd: (commit) => {
        if (raf) win.cancelAnimationFrame(raf);
        raf = 0;
        win.clearTimeout(trailing);
        this.dragging = false;
        this.host.wrapper.classList.remove(NODE_RESIZING_CLASS);
        this.ghost.classList.add(HIDDEN_CLASS);
        this.ghostShape.classList.add(HIDDEN_CLASS);
        if (!commit) {
          // Click, jitter, cancel: restore, write nothing. The handle stays
          // put so a second click can complete a double-click reset.
          if (hit.el.isConnected) this.place(hit.el);
          return;
        }
        this.hideAll();
        const source = this.host.source();
        const existing = nodeSizeEntry(source, hit.id);
        const want = committedEntry(start, end, existing, hit.caps);
        if (!want) return;
        let next = writeNodeSize(source, hit.id, want);
        const applied = this.host.applied?.(next, hit.id) ?? null;
        if (applied) {
          const settled = settleEntry(want, applied);
          // Clamped back to the size it already had (a shape or word that
          // cannot shrink): nothing changed, so nothing is written.
          if (!existing && isSameBox(settled, start)) return;
          next = writeNodeSize(source, hit.id, settled);
        }
        if (next !== source) this.host.persist(next);
      },
    });
  };

  /** The node's box in SVG units (its shapes, not its text). */
  private startBox(el: SVGGraphicsElement): Box | null {
    const id = el.getAttribute("data-id") ?? "";
    const b = nodeBoxMap(el.outerHTML).get(id) ?? (isTextOnly(el) ? layoutBox(el) : null);
    if (b && b.w > 0 && b.h > 0) return { w: Math.round(b.w), h: Math.round(b.h) };
    try {
      const bb = el.getBBox();
      return bb.width > 0 ? { w: Math.round(bb.width), h: Math.round(bb.height) } : null;
    } catch {
      return null;
    }
  }
}
