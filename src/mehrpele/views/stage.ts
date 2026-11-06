/**
 * The view stage: where live views actually live.
 *
 * Mehrpele re-places every overlay label on each Pele render (the label
 * element is moved into a fresh overlay item) and rebuilds labels after a
 * source edit (a node resize). Moving a `<webview>` or `<iframe>` in the DOM
 * reloads it (verified live: scroll position and page state lost), and a
 * rebuilt label would recreate a graph or PDF viewer from scratch. So the
 * label is only a *slot* — a viewport-sized box in the overlay — and the
 * live view sits in a *dock* on a stage layer of the diagram frame
 * (`.mehrpele-frame`), which is never reparented. The stage keeps each dock
 * over its slot (same layout box, same UI scale) whenever the overlay moves
 * or the slot resizes, and a re-rendered label with the same identity
 * (node id + view spec, size excluded) adopts the existing dock: resizing a
 * node, re-flowing the diagram or editing another label keeps the page,
 * PDF position and graph pan.
 *
 * Docks mount lazily when near the viewport, at most `maxLiveViews` at once
 * (pool.ts), and are released after a grace period once their slot is gone.
 * The stage sits under the overlay's embed items, which pass the pointer
 * through except for the node's own resize corner.
 */
import { Component, setIcon, setTooltip, type App } from "obsidian";
import { asButton } from "../../a11y";
import { adoptionKey, planPool, nextExpiry, type PoolEntry } from "./pool";
import { chip, HostError, type LiveView } from "./hosts";

export interface DockSource {
  /** Identity for adoption across re-renders (anchor + spec key). */
  key: string;
  title: string;
  icon: string;
  /** Mount the live view into `content`; throw HostError to show a chip. */
  mount(content: HTMLElement, owner: Component, setTitle: (title: string) => void): Promise<LiveView>;
  openOriginal?(evt: MouseEvent | KeyboardEvent): void;
  originTooltip?: string;
  /** "Open in sidebar" for views that cannot be hosted here. */
  openInSidebar?(): void;
  /** Extra bar actions (folder views: "Save as .base"); run only on a genuine click. */
  actions?: { icon: string; label: string; run(e: MouseEvent | KeyboardEvent): void }[];
}

type DockState = "idle" | "loading" | "live" | "error" | "deferred";

/**
 * A released dock waits this long for a re-rendered slot to adopt it
 * (Reading view re-renders a block after every edit; Live Preview re-creates
 * widgets scrolled back into its viewport). The pool still unloads it first
 * when another view needs the slot.
 */
/** Asks the diagram's edit toolbar to select a node (detail: { id, add }). */
export const NODE_SELECT_EVENT = "pele-node-select";

/** On <body> while a pointer pressed outside a view is held. */
export const DRAGGING_CLASS = "mehrpele-view-dragging";

const ORPHAN_GRACE_MS = 20_000;

let dockSeq = 0;

export class Dock {
  readonly el: HTMLElement;
  readonly content: HTMLElement;
  private bar: HTMLElement;
  private titleEl: HTMLElement;
  private placeholder: HTMLElement | null = null;
  slot: HTMLElement | null = null;
  live: LiveView | null = null;
  state: DockState = "idle";
  readonly entry: PoolEntry;
  private owner = new Component();
  private orphanTimer: number | null = null;
  private mountToken = 0;
  destroyed = false;
  /** Pinned docks (panels, lightbox) always claim a slot in the pool. */
  pinned = false;
  /** Last pointer/key input inside this dock (performance.now()). */
  private lastInput = -Infinity;

  constructor(
    readonly hub: ViewHub,
    public source: DockSource,
    readonly stage: ViewStage | null,
  ) {
    this.owner.load();
    this.el = createDiv({ cls: "mehrpele-view-dock" });
    this.el.dataset.viewKey = source.key;
    (this.el as unknown as { peleDock?: Dock }).peleDock = this; // diagnostics
    this.content = this.el.createDiv({ cls: "mehrpele-view-content" });
    this.bar = this.el.createDiv({ cls: "mehrpele-view-bar" });
    this.titleEl = this.bar.createDiv({ cls: "mehrpele-view-bar-title" });
    this.buildBar();
    this.entry = { id: `dock-${++dockSeq}`, near: false, lastNear: Date.now(), live: false };
    this.showPlaceholder("Loading…", false);
    this.containEvents();
  }

  private buildBar(): void {
    this.titleEl.setText(this.source.title);
    // The view fills its node (full bleed): its title selects the node, like a Canvas card's label.
    this.titleEl.addClass("is-clickable");
    setTooltip(this.titleEl, "Select node (Shift: add to selection)");
    const selectNode = (e: MouseEvent | KeyboardEvent): void => {
      const item = this.slot?.closest<HTMLElement>(".mehrpele-overlay-item[data-anchor]");
      const wrapper = this.slot?.closest(".pele-host");
      if (item && wrapper) wrapper.dispatchEvent(new CustomEvent(NODE_SELECT_EVENT, { detail: { id: item.dataset.anchor, add: e.shiftKey || e.metaKey || e.ctrlKey } }));
    };
    this.titleEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.isTrusted) return;
      selectNode(e);
    });
    // These handlers accept trusted events only: a key press runs them with its own (trusted) event.
    asButton(this.titleEl, (e) => {
      if (e.isTrusted) selectNode(e);
    });
    if (this.source.openOriginal) {
      const open = this.bar.createDiv({ cls: "clickable-icon mehrpele-view-bar-action" });
      setIcon(open, "arrow-up-right");
      setTooltip(open, this.source.originTooltip ?? "Open original");
      open.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.source.openOriginal?.(e);
      });
      asButton(open, (e) => this.source.openOriginal?.(e));
    }
    for (const a of this.source.actions ?? []) {
      const b = this.bar.createDiv({ cls: "clickable-icon mehrpele-view-bar-action" });
      setIcon(b, a.icon);
      setTooltip(b, a.label);
      b.setAttribute("aria-label", a.label);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.isTrusted) a.run(e);
      });
      asButton(b, (e) => {
        if (e.isTrusted) a.run(e);
      });
    }
    const reload = asButton(this.bar.createDiv({ cls: "clickable-icon mehrpele-view-bar-action" }));
    setIcon(reload, "rotate-ccw");
    setTooltip(reload, "Reload view");
    reload.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.live?.reload) this.live.reload();
      else {
        this.retry();
        this.unmount();
        this.hub.activate(this);
      }
    });
  }

  /**
   * Interaction stays inside the view: no note scroll (scrollers contain
   * overscroll in CSS), no lightbox zoom, no editor selection or block
   * reveal in Live Preview, no diagram click handlers. Ctrl/⌘ + wheel still
   * reaches the lightbox (zoom), Escape still closes it.
   */
  private containEvents(): void {
    const stop = (e: Event): void => e.stopPropagation();
    this.el.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    }, { passive: true });
    for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "touchstart", "auxclick"]) {
      this.el.addEventListener(type, stop);
    }
    this.el.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
    });
    // Focus guard: views that focus themselves when they mount (Excalidraw
    // does, and focus() scrolls the note to them) never take focus or move
    // the note — only the user's own click / key in the view does.
    const input = (): void => {
      this.lastInput = performance.now();
    };
    this.el.addEventListener("pointerdown", input, { capture: true });
    this.el.addEventListener("keydown", input, { capture: true });
    this.el.addEventListener("focusin", (e) => {
      if (performance.now() - Math.max(this.lastInput, this.hub.lastKeyNav) < 1000) return;
      this.hub.restoreScroll(this.el);
      const target = e.target as HTMLElement | null;
      target?.blur?.();
      const prev = e.relatedTarget as HTMLElement | null;
      if (prev && prev.isConnected && !this.el.contains(prev)) prev.focus?.({ preventScroll: true });
      window.requestAnimationFrame(() => this.hub.restoreScroll(this.el));
    }, { capture: true });
    this.el.addEventListener("pointerenter", () => this.slot?.addClass("is-view-hover"));
    this.el.addEventListener("pointerleave", (e) => {
      this.slot?.removeClass("is-view-hover");
      // Leaving the view, but not into its diagram: the diagram's hover ends too.
      const wrapper = this.slot?.closest(".pele-host");
      const to = e.relatedTarget as Node | null;
      if (wrapper && !(to && wrapper.contains(to))) wrapper.dispatchEvent(new PointerEvent("pointerleave", { pointerType: e.pointerType }));
    });
    // Hover over the view is hover over its node: the diagram's hover outline,
    // edit toolbar and box handle follow (no button held: drags stay the view's).
    let req = 0;
    let last: PointerEvent | null = null;
    this.el.addEventListener("pointermove", (e) => {
      if (e.buttons !== 0 || e.pointerType === "touch" || !this.slot) return;
      last = e;
      if (req) return;
      req = window.requestAnimationFrame(() => {
        req = 0;
        const item = this.slot?.closest(".mehrpele-overlay-item");
        if (!item || !last) return;
        item.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: last.clientX, clientY: last.clientY, pointerType: last.pointerType, isPrimary: true }));
      });
    }, { passive: true });
  }

  setTitle(t: string): void {
    this.titleEl.setText(t);
  }

  private showPlaceholder(text: string, clickable: boolean): void {
    this.placeholder?.remove();
    const ph = this.el.createDiv({ cls: "mehrpele-view-placeholder" });
    setIcon(ph.createDiv({ cls: "mehrpele-view-placeholder-icon" }), this.source.icon);
    ph.createDiv({ cls: "mehrpele-view-placeholder-title", text: this.source.title });
    ph.createDiv({ cls: "mehrpele-view-placeholder-text", text });
    if (clickable) {
      ph.addClass("is-clickable");
      ph.addEventListener("click", (e) => {
        e.preventDefault();
        this.hub.activate(this);
      });
    }
    this.el.insertBefore(ph, this.bar);
    this.placeholder = ph;
  }

  private clearPlaceholder(): void {
    this.placeholder?.remove();
    this.placeholder = null;
  }

  /** Forget an error (reload, re-adoption): the next plan mounts it again. */
  retry(): void {
    if (this.state !== "error") return;
    this.state = "idle";
    this.content.empty();
    this.showPlaceholder("Loading…", false);
    this.hub.schedulePlan();
  }

    setDeferred(): void {
    if (this.state === "live" || this.state === "loading" || this.state === "error") return;
    this.state = "deferred";
    this.showPlaceholder(`Paused — ${this.hub.cap()} views already live. Click to load.`, true);
  }

  async mount(): Promise<void> {
    if (this.destroyed || this.state === "live" || this.state === "loading") return;
    const token = ++this.mountToken;
    this.state = "loading";
    this.entry.live = true;
    this.showPlaceholder("Loading…", false);
    const t0 = performance.now();
    this.hub.noteScroll(this.el);
    try {
      const live = await this.source.mount(this.content, this.owner, (t) => this.setTitle(t));
      if (this.destroyed || token !== this.mountToken) {
        live.destroy();
        return;
      }
      this.live = live;
      this.state = "live";
      this.clearPlaceholder();
      this.el.addClass("is-live");
      this.setTitle(live.title());
      // Time to first interactive frame: mounted + one frame painted.
      window.requestAnimationFrame(() => {
        this.el.dataset.tti = String(Math.round(performance.now() - t0));
      });
    } catch (e) {
      if (this.destroyed || token !== this.mountToken) return;
      this.state = "error";
      this.entry.live = false;
      this.clearPlaceholder();
      this.content.empty();
      const msg = e instanceof HostError ? e.message : `Could not show view: ${(e as Error)?.message ?? e}`;
      // Only views that exist but cannot be hosted here can open in a sidebar.
      const canSidebar = e instanceof HostError ? e.canOpenInSidebar : true;
      chip(this.content, "alert-triangle", msg, canSidebar && this.source.openInSidebar ? [{ label: "Open in sidebar", icon: "panel-right", run: () => this.source.openInSidebar?.() }] : []);
      if (!(e instanceof HostError)) console.warn("[mehrpele] view node failed", e);
    }
  }

  unmount(): void {
    this.mountToken++;
    if (this.live) {
      try {
        this.live.destroy();
      } catch (e) {
        console.warn("[mehrpele] view node teardown failed", e);
      }
    }
    this.live = null;
    this.content.empty();
    this.el.removeClass("is-live");
    this.entry.live = false;
    if (this.state !== "error") {
      this.state = "idle";
      this.showPlaceholder("Paused off screen", true);
    }
  }

  /** Re-fit the live view after a size change. */
  resized(): void {
    this.live?.resize?.();
  }

  setSlot(slot: HTMLElement | null): void {
    if (this.orphanTimer !== null) {
      window.clearTimeout(this.orphanTimer);
      this.orphanTimer = null;
    }
    this.slot?.removeClass("is-view-hover");
    this.slot = slot;
    this.el.toggleClass("is-orphan", !slot);
    if (!slot) {
      this.orphanTimer = window.setTimeout(() => {
        this.orphanTimer = null;
        if (!this.slot) this.stage?.dropDock(this);
      }, ORPHAN_GRACE_MS);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.orphanTimer !== null) window.clearTimeout(this.orphanTimer);
    this.unmount();
    this.owner.unload();
    this.el.remove();
    this.hub.unregister(this);
  }
}

/**
 * Where a slot's live view is hosted: the note's scroller (Reading view,
 * Live Preview, embeds/popovers), which outlives re-rendered sections and
 * re-created editor widgets — so a block re-rendered after an edit adopts
 * its docks without moving them. Elsewhere (lightbox) the diagram frame.
 */
export const STAGE_HOSTS = ".markdown-preview-view, .cm-scroller";

export function stageHostOf(slot: HTMLElement): HTMLElement | null {
  const frame = slot.closest<HTMLElement>(".mehrpele-frame");
  const scroller = slot.closest<HTMLElement>(STAGE_HOSTS);
  // A scroller inside the frame (a note embed in a node) is not a stable host.
  if (scroller && (!frame || scroller.contains(frame))) return scroller;
  return frame;
}

/** One stage per host (a note scroller, or a frame). */
export class ViewStage {
  readonly el: HTMLElement;
  private docks = new Map<string, Dock>();
  private mo: MutationObserver;
  private ro: ResizeObserver;
  private frameReq: number | null = null;
  private lateSync: number | null = null;

  constructor(
    readonly hub: ViewHub,
    readonly host: HTMLElement,
  ) {
    this.el = createDiv({ cls: "mehrpele-view-stage" });
    this.el.toggleClass("is-frame-stage", host.classList.contains("mehrpele-frame"));
    // Anything that moves a slot (overlay re-placement, sections above
    // re-rendering, reflow) mutates the host's subtree; our own docks don't count.
    this.mo = new MutationObserver((records) => {
      const moves = records.some((r) => {
        if (this.el.contains(r.target)) return false;
        // Structure changes anywhere (sections, widgets); style changes only
        // in diagrams (overlay placement) — not the caret or selection layers.
        if (r.type === "childList") return true;
        return r.target.instanceOf(Element) && !!r.target.closest(".mehrpele-frame, .pele-embed");
      });
      if (moves) this.scheduleSync(true);
    });
    this.mo.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
    this.ro = new ResizeObserver((entries) => {
      this.scheduleSync(false);
      for (const e of entries) {
        const dock = [...this.docks.values()].find((d) => d.slot === e.target);
        dock?.resized();
      }
    });
    this.ro.observe(host);
    if (host.firstElementChild) this.ro.observe(host.firstElementChild);
    this.ensurePlaced();
  }

  private ensurePlaced(): void {
    if (this.el.parentElement !== this.host) this.host.appendChild(this.el);
  }

  /** A slot rendered for `source`: adopt the dock with the same identity, or make one. */
  attach(slot: HTMLElement, source: DockSource): Dock {
    this.ensurePlaced();
    const key = adoptionKey(source.key, (k) => {
      const d = this.docks.get(k);
      if (!d) return "none";
      if (!d.slot) return "free";
      if (d.slot === slot) return "same";
      // Only a slot placed in an overlay holds its dock.
      return d.slot.isConnected && d.slot.closest(".mehrpele-overlay") ? "other" : "free";
    });
    let dock = this.docks.get(key);
    if (dock?.state === "error") dock.retry();
    if (!dock) {
      dock = new Dock(this.hub, { ...source, key }, this);
      this.docks.set(key, dock);
      this.el.appendChild(dock.el);
      this.hub.register(dock);
    } else {
      dock.source = { ...source, key };
    }
    dock.setSlot(slot);
    this.ro.observe(slot);
    this.scheduleSync(true);
    return dock;
  }

  release(slot: HTMLElement): void {
    // The host went away with the slot (lightbox closed, note closed): no grace.
    if (!this.host.isConnected) queueMicrotask(() => this.syncAll());
    for (const dock of this.docks.values()) {
      if (dock.slot !== slot) continue;
      this.ro.unobserve(slot);
      dock.setSlot(null);
      this.sync(dock);
    }
  }

  dropDock(dock: Dock): void {
    for (const [k, d] of this.docks) if (d === dock) this.docks.delete(k);
    dock.destroy();
    if (this.docks.size === 0) this.destroy();
  }

  private scheduleSync(late: boolean): void {
    if (this.frameReq === null) {
      this.frameReq = window.requestAnimationFrame(() => {
        this.frameReq = null;
        this.syncAll();
      });
    }
    // Overlay FLIP animations settle after ~300 ms: re-sync once after them.
    if (late) {
      if (this.lateSync !== null) window.clearTimeout(this.lateSync);
      this.lateSync = window.setTimeout(() => {
        this.lateSync = null;
        this.syncAll();
      }, 360);
    }
  }

  syncAll(): void {
    if (!this.host.isConnected) {
      // The note (or frame) is gone: so are its views.
      this.destroy();
      return;
    }
    this.ensurePlaced();
    for (const dock of this.docks.values()) this.sync(dock);
  }

  /** Put the dock exactly over its slot: same layout box, same on-screen scale. */
  sync(dock: Dock): void {
    const slot = dock.slot;
    const el = dock.el;
    const placed = !!slot && slot.isConnected && !!slot.closest(".mehrpele-overlay") && slot.offsetWidth > 0 && slot.offsetHeight > 0;
    if (!placed || !slot) {
      el.addClass("is-hidden");
      return;
    }
    el.removeClass("is-hidden");
    const sr = slot.getBoundingClientRect();
    const gr = this.el.getBoundingClientRect();
    // Client px per stage layout px (lightbox zoom, a scaled parent node).
    const a = ancestorScaleOf(this.el);
    const w = slot.offsetWidth;
    const h = slot.offsetHeight;
    const q = sr.width / (w * a);
    const px = (v: number) => `${Math.round(v * 100) / 100}px`;
    el.style.left = px((sr.left - gr.left) / a);
    el.style.top = px((sr.top - gr.top) / a);
    el.style.width = px(w);
    el.style.height = px(h);
    el.style.transform = Math.abs(q - 1) < 0.001 ? "" : `scale(${Math.round(q * 10000) / 10000})`;
    el.style.setProperty("--mehrpele-view-counter", String(Math.round((1 / (q * a)) * 10000) / 10000));
    // Full bleed: the node's corners (overlay.ts rounds its item to the shape).
    el.style.borderRadius = dockRadius(slot, q * a);
    // In a circle, diamond or pill the view is a rect inside the shape: no notch, the shape's own fill around it.
    el.toggleClass("is-inscribed", !!slot.closest(".mehrpele-overlay-item.is-inscribed"));
    publishViewport(dock.content, { width: Math.round(w * 100) / 100, height: Math.round(h * 100) / 100, scale: Math.round(q * a * 10000) / 10000 });
    // Docks in the lightbox (a modal) claim a live slot first.
    dock.pinned = !!slot.closest(".modal-container, .lightbox");
  }

  destroy(): void {
    this.mo.disconnect();
    this.ro.disconnect();
    if (this.frameReq !== null) cancelAnimationFrame(this.frameReq);
    if (this.lateSync !== null) window.clearTimeout(this.lateSync);
    const docks = [...this.docks.values()];
    this.docks.clear();
    for (const d of docks) d.destroy();
    this.el.remove();
    this.hub.forgetStage(this);
  }
}

/** The viewport a dock gives its content: layout px, and on-screen px per layout px. */
export interface PeleViewport {
  width: number;
  height: number;
  scale: number;
}

/** Event on `.mehrpele-view-content` when its viewport changes (a zoom never fires ResizeObserver). */
export const VIEWPORT_EVENT = "pele-viewport";

/**
 * Publish the viewport on the dock content for hosted code (canvases size
 * their backing store from it): `el.peleViewport`, the CSS variables
 * `--pele-viewport-width|height|scale` and a `pele-viewport` event, on
 * changes only.
 */
export function publishViewport(el: HTMLElement, vp: PeleViewport): void {
  const holder = el as HTMLElement & { peleViewport?: PeleViewport };
  const prev = holder.peleViewport;
  if (prev && prev.width === vp.width && prev.height === vp.height && prev.scale === vp.scale) return;
  holder.peleViewport = vp;
  el.style.setProperty("--pele-viewport-width", `${vp.width}px`);
  el.style.setProperty("--pele-viewport-height", `${vp.height}px`);
  el.style.setProperty("--pele-viewport-scale", String(vp.scale));
  el.dispatchEvent(new CustomEvent(VIEWPORT_EVENT, { detail: vp }));
}

/** The bleed item's corner radius under `slot`, in dock layout px (`k` client px per dock px). */
function dockRadius(slot: HTMLElement, k: number): string {
  const item = slot.closest<HTMLElement>(".mehrpele-overlay-item.is-bleed");
  if (!item) return "";
  const r = item.style.borderRadius;
  if (!r) return "0";
  const ir = item.getBoundingClientRect();
  const f = ir.width / Math.max(1, item.offsetWidth) / Math.max(1e-6, k);
  return r.replace(/([\d.]+)px/g, (_, v: string) => `${Math.round(Number(v) * f * 100) / 100}px`);
}

/** Client px per layout px of `el` from ancestor CSS transforms (1 when none). */
function ancestorScaleOf(el: HTMLElement): number {
  // The stage itself has no box: measure a 100px probe inside it.
  let probe = el.querySelector<HTMLElement>(":scope > .mehrpele-view-probe");
  if (!probe) {
    probe = el.createDiv({ cls: "mehrpele-view-probe" });
  }
  const r = probe.getBoundingClientRect().width;
  return r > 0 ? r / 100 : 1;
}

/** Plugin-wide owner of stages, docks and the live-view pool. */
export class ViewHub {
  private stages = new WeakMap<HTMLElement, ViewStage>();
  private docks = new Set<Dock>();
  private io: IntersectionObserver;
  private planTimer: number | null = null;
  private expiryTimer: number | null = null;
  private byEl = new WeakMap<Element, Dock>();
  private destroyed = false;

  /** Scroll offsets as of the last scroll event (pre-focus values for the guard). */
  private scrolls = new WeakMap<Element, { top: number; left: number }>();
  /** Last Tab key (keyboard navigation may focus into a view). */
  lastKeyNav = -Infinity;
  private onScroll = (e: Event): void => {
    const t = e.target instanceof Document ? e.target.scrollingElement : (e.target as Element | null);
    if (t instanceof Element) this.scrolls.set(t, { top: t.scrollTop, left: t.scrollLeft });
  };
  /** Capture Tab before focus enters a dock, including from a popout panel header. */
  onKeyNavigation = (e: KeyboardEvent): void => {
    if (e.key === "Tab") this.lastKeyNav = performance.now();
  };
  /**
   * A press in the host document (not inside a view): until it is released,
   * web pages ignore the pointer. A webview under a moving pointer swallows
   * the events even with pointer capture (resize drags were lost mid-way;
   * Canvas has the same rule while dragging).
   */
  private onDown = (e: PointerEvent): void => {
    const t = e.target as Element | null;
    if (t?.closest?.(".mehrpele-view-dock .mehrpele-view-content")) return;
    document.body.addClass(DRAGGING_CLASS);
  };
  private onUp = (): void => {
    document.body.removeClass(DRAGGING_CLASS);
  };

  constructor(
    readonly app: App,
    readonly cap: () => number,
    readonly keepAliveMs = 30_000,
  ) {
    this.io = new IntersectionObserver(
      (entries) => {
        const now = Date.now();
        for (const e of entries) {
          const dock = this.byEl.get(e.target);
          if (!dock) continue;
          dock.entry.near = e.isIntersecting;
          dock.entry.lastNear = now;
        }
        this.schedulePlan();
      },
      { rootMargin: "300px 0px 300px 0px" },
    );
    document.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    document.addEventListener("keydown", this.onKeyNavigation, { capture: true });
    document.addEventListener("pointerdown", this.onDown, { capture: true });
    window.addEventListener("pointerup", this.onUp, { capture: true });
    window.addEventListener("pointercancel", this.onUp, { capture: true });
    window.addEventListener("blur", this.onUp);
  }

  /** Remember the scroll offsets of `el`'s scroll ancestors (seed before anything moves them). */
  noteScroll(el: Element): void {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth) {
        if (!this.scrolls.has(p)) this.scrolls.set(p, { top: p.scrollTop, left: p.scrollLeft });
      }
    }
  }

  /** Undo a scroll of `el`'s ancestors that no scroll event has reported yet (focus scrolling). */
  restoreScroll(el: Element): void {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const known = this.scrolls.get(p);
      if (!known) continue;
      if (p.scrollTop !== known.top) p.scrollTop = known.top;
      if (p.scrollLeft !== known.left) p.scrollLeft = known.left;
    }
  }

  /** The stage for a slot (null while the slot is not in the document). */
  stageFor(slot: HTMLElement): ViewStage | null {
    const host = stageHostOf(slot);
    if (!host || !host.isConnected) return null;
    let s = this.stages.get(host);
    if (!s) {
      s = new ViewStage(this, host);
      this.stages.set(host, s);
    }
    return s;
  }

  forgetStage(stage: ViewStage): void {
    if (this.stages.get(stage.host) === stage) this.stages.delete(stage.host);
  }

  register(dock: Dock): void {
    this.docks.add(dock);
    this.byEl.set(dock.el, dock);
    this.io.observe(dock.el);
    this.schedulePlan();
  }

  unregister(dock: Dock): void {
    this.docks.delete(dock);
    this.io.unobserve(dock.el);
    this.schedulePlan();
  }

  /** User asked for this view (click to load / reload): it gets a slot first. */
  activate(dock: Dock): void {
    dock.entry.activated = Date.now();
    dock.entry.near = true;
    dock.entry.lastNear = Date.now();
    this.plan();
  }

  schedulePlan(): void {
    if (this.planTimer !== null || this.destroyed) return;
    // Next frame: coalesces a burst of observer entries without delaying a mount.
    this.planTimer = window.setTimeout(() => {
      this.planTimer = null;
      this.plan();
    }, 16);
  }

  plan(): void {
    if (this.destroyed) return;
    const now = Date.now();
    // Stages whose note/frame left the document (leaf closed, lightbox closed).
    for (const d of [...this.docks]) if (d.stage && !d.stage.host.isConnected) d.stage.destroy();
    const docks = [...this.docks];
    for (const d of docks) {
      d.entry.live = d.state === "live" || d.state === "loading";
      d.entry.pinned = d.pinned;
      // An errored dock shows its chip; it never takes a slot.
      if (d.state === "error") d.entry.near = false;
    }
    const policy = { cap: this.cap(), keepAliveMs: this.keepAliveMs };
    const plan = planPool(docks.map((d) => d.entry), policy, now);
    const byId = new Map(docks.map((d) => [d.entry.id, d] as const));
    for (const id of plan.unmount) byId.get(id)?.unmount();
    for (const id of plan.mount) void byId.get(id)?.mount();
    for (const id of plan.deferred) byId.get(id)?.setDeferred();
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const next = nextExpiry(docks.map((d) => d.entry), policy, now);
    if (next !== null) {
      this.expiryTimer = window.setTimeout(() => {
        this.expiryTimer = null;
        this.plan();
      }, Math.max(50, next - now + 20));
    }
  }

  liveCount(): number {
    return [...this.docks].filter((d) => d.state === "live").length;
  }

  /** Diagnostics for live verification. */
  stats(): { docks: number; live: number; states: Record<string, number> } {
    const states: Record<string, number> = {};
    for (const d of this.docks) states[d.state] = (states[d.state] ?? 0) + 1;
    return { docks: this.docks.size, live: this.liveCount(), states };
  }

  destroy(): void {
    this.destroyed = true;
    document.removeEventListener("scroll", this.onScroll, { capture: true });
    document.removeEventListener("keydown", this.onKeyNavigation, { capture: true });
    document.removeEventListener("pointerdown", this.onDown, { capture: true });
    window.removeEventListener("pointerup", this.onUp, { capture: true });
    window.removeEventListener("pointercancel", this.onUp, { capture: true });
    window.removeEventListener("blur", this.onUp);
    document.body.removeClass(DRAGGING_CLASS);
    this.io.disconnect();
    if (this.planTimer !== null) window.clearTimeout(this.planTimer);
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    for (const d of [...this.docks]) {
      if (d.stage) d.stage.dropDock(d);
      else d.destroy();
    }
  }
}
