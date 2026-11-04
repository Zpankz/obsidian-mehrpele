/**
 * Frame handles for companions (api `frames`). A handle stands for one fence, keyed
 * `sourcePath#fenceLine`, and survives re-renders: the DiagramFrame or Mehrpele shell
 * that draws the fence binds to it (a "surface"); a new frame or shell for the same key
 * (Live Preview rebuilding its widget, Reading view re-rendering the section) rebinds the
 * existing handle. When the last surface unbinds, the handle is destroyed only if no
 * surface rebinds it by the next animation frame.
 *
 * Several surfaces can be bound to one key at once: the Reading view and the Live Preview
 * of one leaf (one of them hidden), or the note open in two tabs. One of them is active:
 * the one that last rendered or last became visible (its root went from 0×0 to a size, seen
 * by one ResizeObserver shared by every bound root), or a shown surface when the active one
 * hides. A surface that renders while hidden does not take over from a shown one. Nothing is
 * observed until a companion registers something (`startWatching`).
 *
 * A render counts once the surface's layout is final: `onDidRender` waits out a reflow FLIP
 * into the new layout (`settleMs`), and a reflow that only rescales the diagram reports
 * itself as a render. A Live Preview frame that is suspended stays bound (hidden) until the
 * host revives it (bind) or its TTL destroys it (unbind).
 *
 * Each handle owns one overlay container, `div.mehrpele-overlay` inside the active
 * surface's `.pele-host` right after `.pele-mount` (absolutely positioned, pointer-events
 * none), created on first `overlay()` and holding `div.mehrpele-overlay-layer[data-layer]`
 * children. The same container element moves to the surface that becomes active, and
 * companions get `onDidRender` for it.
 */
import type { FrameHandle, FrameLang, FrameProvenance } from "mehrpele-api";
import type { CompanionActions } from "./frame-actions";

/**
 * Where a fence is now: its opening line (0-based) and info-string rest. `exact` when read
 * from editor state, which is current at once; a Reading view's section info lags an edit.
 */
export interface FenceLocation {
  line: number;
  rest: string;
  exact?: boolean;
}

/** After the last `resyncSoon`, one more resync once the views have caught up with the edit. */
export const RESYNC_SETTLE_MS = 300;

/** What a frame or shell passes to get a handle: the fence's key and the rest of its info string. */
export interface FrameCompanion {
  key: string;
  fenceRest: string;
  /** The fence's live location (see `FrameSurface.locate`). */
  locate?: () => FenceLocation | null;
}

/** A frame or shell, as the handle registry sees it. */
export interface FrameSurface {
  /** Changes only through `HandleRegistry.resync` (the fence moved). */
  key: string;
  readonly sourcePath: string;
  readonly lang: string;
  /** Changes only through `HandleRegistry.resync` (the info string was edited). */
  fenceRest: string;
  /**
   * The fence's live location, read from the editor (exact) or the Reading view's section
   * info; null when that can't be told (view gone or hidden).
   */
  locate?(): FenceLocation | null;
  /** The frame root (`.pele-embed`). */
  readonly root: HTMLElement;
  /** `.pele-host`: the positioned box the overlay covers. */
  readonly host: HTMLElement;
  /** `.pele-mount`: the overlay goes right after it. */
  readonly mount: HTMLElement;
  /** `.embed-actions` (the same element when floated to the body). */
  readonly bar: HTMLElement;
  svg(): SVGSVGElement | null;
  diagramType(): string | null;
  source(): string;
  rerender(): void;
  /** Milliseconds until the shown layout is final (a reflow FLIP still running); 0 when it is. */
  settleMs?(): number;
}

export interface HandleRegistryDeps {
  actions: CompanionActions;
  /** `%% pele-canvas %%` provenance of a source (pele-render's reader), null without one. */
  provenance(source: string): FrameProvenance | null;
  /** Runs `cb` on the next animation frame. */
  nextFrame(cb: () => void): void;
  /**
   * Watches `el`'s size; `cb(shown)` on each change, shown when it has any size (a hidden
   * view's frames are 0×0; a frame laid out but not yet mounted has a width).
   * Returns the disposer. Default: `sharedSizeObserver()`, one per registry.
   */
  observeSize?: (el: HTMLElement, cb: (shown: boolean) => void) => () => void;
  /** Runs `cb` after `ms`; returns its canceller. Default: setTimeout. */
  wait?: (cb: () => void, ms: number) => () => void;
}

/**
 * One ResizeObserver for every watched element, created on the first watch and
 * disconnected when the last watch stops (none where ResizeObserver is absent).
 */
export function sharedSizeObserver(): (el: HTMLElement, cb: (shown: boolean) => void) => () => void {
  let obs: ResizeObserver | null = null;
  const cbs = new Map<Element, (shown: boolean) => void>();
  return (el, cb) => {
    if (typeof ResizeObserver === "undefined") return () => undefined;
    obs ??= new ResizeObserver((entries) => {
      for (const e of entries) cbs.get(e.target)?.(e.contentRect.width > 0 || e.contentRect.height > 0);
    });
    cbs.set(el, cb);
    obs.observe(el);
    return () => {
      if (cbs.get(el) !== cb) return;
      cbs.delete(el);
      obs?.unobserve(el);
      if (cbs.size === 0) {
        obs?.disconnect();
        obs = null;
      }
    };
  };
}

function waitWithTimeout(cb: () => void, ms: number): () => void {
  const id = window.setTimeout(cb, ms);
  return () => window.clearTimeout(id);
}

export const OVERLAY_CLASS = "mehrpele-overlay";
export const OVERLAY_LAYER_CLASS = "mehrpele-overlay-layer";

const cssEscape = (s: string): string =>
  typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");

function toLang(lang: string): FrameLang {
  return lang === "pele" || lang === "mehrpele" ? lang : "mermaid";
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  if (typeof DOMRect === "function") return new DOMRect(x, y, width, height);
  const r = { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
  return { ...r, toJSON: () => r };
}

/**
 * What a destroyed handle keeps of its last surface: the info reads answer, and one
 * detached element stands in for the frame DOM (so a kept handle pins no dead frame).
 */
function goneSurface(s: FrameSurface): FrameSurface {
  let source = "";
  let type: string | null = null;
  try {
    source = s.source();
    type = s.diagramType();
  } catch {
    // The frame's state went with it: empty reads.
  }
  const el = createDiv();
  return {
    key: s.key,
    sourcePath: s.sourcePath,
    lang: s.lang,
    fenceRest: s.fenceRest,
    root: el,
    host: el,
    mount: el,
    bar: el,
    svg: () => null,
    diagramType: () => type,
    source: () => source,
    rerender: () => undefined,
  };
}

/** A bound surface's size watch: shown is undefined until the first observation. */
interface SizeWatch {
  shown: boolean | undefined;
  /** A scroll of the mount is waiting for the next frame to notify. */
  scrollQueued: boolean;
  stop(): void;
}

class Handle implements FrameHandle {
  /** Bound surfaces, least recently active first; the last one is the active surface. */
  surfaces: FrameSurface[] = [];
  /** The surface the handle was last bound to (kept for reads after unbind). */
  last: FrameSurface;
  connected = true;
  container: HTMLElement | null = null;
  layers = new Map<string, HTMLElement>();
  /** Cancels an `onDidRender` waiting for the layout to settle. */
  pendingRender: (() => void) | null = null;
  private refreshQueued = false;

  constructor(
    readonly key: string,
    first: FrameSurface,
    private reg: HandleRegistry,
  ) {
    this.last = first;
  }

  get current(): FrameSurface {
    return this.surfaces[this.surfaces.length - 1] ?? this.last;
  }
  get sourcePath(): string {
    return this.current.sourcePath;
  }
  get lang(): FrameLang {
    return toLang(this.current.lang);
  }
  get fenceRest(): string {
    return this.current.fenceRest;
  }
  get diagramType(): string {
    return this.current.diagramType() ?? "";
  }

  getSource(): string {
    return this.current.source();
  }

  provenance(): FrameProvenance | null {
    try {
      return this.reg.deps.provenance(this.getSource());
    } catch {
      return null;
    }
  }

  nodeRect(id: string): DOMRect | null {
    if (!this.connected) return null;
    const s = this.current;
    // Measured in the active surface only; a hidden one has no rect (not a zero rect).
    if (this.reg.isHidden(s) || s.root.isConnected === false) return null;
    const node = s.svg()?.querySelector(`.pele-node[data-id="${cssEscape(id)}"]`);
    if (!node) return null;
    const base = s.host.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    if (!(base.width > 0 && base.height > 0) || !(r.width > 0 && r.height > 0)) return null;
    // The host may be CSS-scaled (legacy zoom, nested labels): overlay coordinates are
    // the host's own layout pixels.
    const scale = s.host.offsetWidth > 0 && base.width > 0 ? base.width / s.host.offsetWidth : 1;
    return rect((r.left - base.left) / scale, (r.top - base.top) / scale, r.width / scale, r.height / scale);
  }

  overlay(layerId: string): HTMLElement {
    const container = this.ensureContainer();
    let layer = this.layers.get(layerId);
    if (!layer) {
      layer = createDiv();
      layer.className = OVERLAY_LAYER_CLASS;
      layer.setAttribute("data-layer", layerId);
      container.appendChild(layer);
      this.layers.set(layerId, layer);
    }
    return layer;
  }

  refreshNode(_id: string): void {
    // No per-node re-render exists: re-render the frame once per animation frame.
    if (this.refreshQueued || !this.connected) return;
    this.refreshQueued = true;
    this.reg.deps.nextFrame(() => {
      this.refreshQueued = false;
      if (this.connected) this.current.rerender();
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Destroyed or host unload: disconnects and lets go of every frame. */
  disconnect(): void {
    this.connected = false;
    this.pendingRender?.();
    this.pendingRender = null;
    this.container?.remove();
    this.last = goneSurface(this.current);
    this.surfaces = [];
  }

  private ensureContainer(): HTMLElement {
    if (!this.container) {
      const el = createDiv();
      el.className = OVERLAY_CLASS;
      this.container = el;
      if (this.connected) this.placeOverlay();
    }
    return this.container;
  }

  /** Puts the overlay container into the active surface, right after its `.pele-mount`. */
  placeOverlay(): void {
    const c = this.container;
    const s = this.surfaces[this.surfaces.length - 1];
    if (!c || !s) return;
    if (c.parentElement === s.host && c.previousSibling === s.mount) return;
    s.host.insertBefore(c, s.mount.nextSibling);
  }
}

export class HandleRegistry {
  private byKey = new Map<string, Handle>();
  /** Frame roots and action bars → their handle (forElement). */
  private byEl = new WeakMap<Element, Handle>();
  private renderCbs = new Set<(f: FrameHandle) => void>();
  private destroyCbs = new Set<(f: FrameHandle) => void>();
  private watches = new Map<FrameSurface, SizeWatch>();
  /** Suspended surfaces: bound, but hidden until revived. */
  private suspended = new Set<FrameSurface>();
  /** Whether bound roots are size-watched (a companion has registered something). */
  private watching = false;
  /** A `resyncSoon` is waiting for the next frame. */
  private resyncQueued = false;
  /** Cancels the pending settle resync (see `resyncSoon`). */
  private settleResync: (() => void) | null = null;
  private readonly observeSize: (el: HTMLElement, cb: (shown: boolean) => void) => () => void;
  private readonly wait: (cb: () => void, ms: number) => () => void;

  constructor(readonly deps: HandleRegistryDeps) {
    this.observeSize = deps.observeSize ?? sharedSizeObserver();
    this.wait = deps.wait ?? waitWithTimeout;
  }

  /**
   * A companion registered something: from now on bound roots are size-watched (the
   * ones bound already included). Until then frames cost no observer.
   */
  startWatching(): void {
    if (this.watching) return;
    this.watching = true;
    for (const h of this.byKey.values()) for (const s of h.surfaces) this.watch(h, s);
  }

  /**
   * A frame or shell for `surface.key` loaded: (re)binds the handle for that key. It is
   * active at once only when no other surface is bound; otherwise from its first render
   * or once it becomes visible. A suspended surface binding again was revived: it shows.
   */
  bind(surface: FrameSurface): FrameHandle {
    let h = this.byKey.get(surface.key);
    if (!h) {
      h = new Handle(surface.key, surface, this);
      this.byKey.set(surface.key, h);
    }
    const revived = this.suspended.delete(surface) && h.surfaces.includes(surface);
    if (!h.surfaces.includes(surface)) {
      h.surfaces.unshift(surface);
      this.watch(h, surface);
    }
    if (h.surfaces.length === 1) h.last = surface;
    this.byEl.set(surface.root, h);
    this.byEl.set(surface.bar, h);
    h.placeOverlay();
    // Revived: it became visible. A size watch that saw it hidden reports that itself.
    if (revived && this.watches.get(surface)?.shown !== false) {
      this.makeActive(h, surface);
      this.fireRender(h);
    }
    return h;
  }

  /**
   * The host suspended the surface (unbound just before): it stays bound, hidden, so the
   * handle lives on until the surface is revived (bind) or destroyed (unbind).
   */
  suspend(surface: FrameSurface): void {
    const h = this.byKey.get(surface.key);
    if (!h?.connected) return;
    this.suspended.add(surface);
    if (!h.surfaces.includes(surface)) {
      h.surfaces.unshift(surface);
      this.watch(h, surface);
    }
    this.byEl.set(surface.root, h);
    this.byEl.set(surface.bar, h);
  }

  /** The frame or shell is gone (destroyed, or suspended: see `suspend`). */
  unbind(surface: FrameSurface): void {
    const h = this.byKey.get(surface.key);
    if (!h || !h.surfaces.includes(surface)) return;
    const wasActive = h.current === surface;
    h.surfaces = h.surfaces.filter((s) => s !== surface);
    this.suspended.delete(surface);
    this.unwatch(surface);
    if (h.surfaces.length && wasActive) {
      // The most recently active surface still attached and not known hidden; else the newest.
      const next =
        [...h.surfaces].reverse().find((s) => s.root.isConnected !== false && !this.isHidden(s)) ??
        h.surfaces[h.surfaces.length - 1];
      this.makeActive(h, next);
      // The layer moved (a split tab closed): companions re-place. A hidden one waits to show.
      if (!this.isHidden(next)) this.fireRender(h);
    }
    // Gone unless bound again (suspended, or a new frame for the key) by the next frame. A
    // resync may have re-keyed it meanwhile: check the handle it is bound to now.
    this.deps.nextFrame(() => {
      const bound = h.surfaces.includes(surface) || this.byKey.get(surface.key)?.surfaces.includes(surface);
      if (!bound) this.deps.actions.forget(surface.bar);
      if (h.surfaces.length || this.byKey.get(h.key) !== h) return;
      this.destroy(h);
    });
  }

  /**
   * The surface finished a render, or reflow moved its nodes without one: sync its
   * companion buttons, make it active (unless it is hidden while the active one is not),
   * then tell companions once its layout has settled.
   */
  rendered(surface: FrameSurface): void {
    const h = this.byKey.get(surface.key);
    if (!h || !h.surfaces.includes(surface)) return;
    // Activate first: action predicates read the handle, which reads the active surface.
    const activate = h.current === surface || !this.isHidden(surface) || this.isHidden(h.current);
    if (!(activate && this.makeActive(h, surface))) this.deps.actions.sync(surface.bar, h);
    this.renderSettled(h, surface);
  }

  /** `onDidRender` for `h` once `surface`'s layout has settled (a reflow FLIP may be running). */
  private renderSettled(h: Handle, surface: FrameSurface): void {
    // A newer layout replaces one still settling: one notice per final layout.
    h.pendingRender?.();
    h.pendingRender = null;
    const ms = surface.settleMs?.() ?? 0;
    if (!(ms > 0)) {
      this.fireRender(h);
      return;
    }
    h.pendingRender = this.wait(() => {
      h.pendingRender = null;
      if (h.connected) this.fireRender(h);
    }, ms);
  }

  /**
   * Fences can move (lines added or removed above them) or get a new info-string rest
   * without a re-render. Each bound surface reports its live location (`locate`); a surface
   * whose key changed rebinds to the handle for the new key. A handle's key never changes:
   * the handle a fence left is destroyed (before anything renders), and the one it lands
   * on renders once. A rest-only change updates in place and renders. Idempotent.
   */
  resync(): void {
    this.resyncQueued = false;
    const moves: { from: Handle; s: FrameSurface; key: string; wasActive: boolean }[] = [];
    const restChanged = new Set<Handle>();
    const locate = (s: FrameSurface): FenceLocation | null => {
      try {
        return s.locate?.() ?? null;
      } catch {
        return null; // The view went away: leave the surface as it is.
      }
    };
    const locs = new Map<FrameSurface, FenceLocation | null>();
    /** `sourcePath#line` → the surfaces whose editor says their fence is there now. */
    const claims = new Map<string, FrameSurface[]>();
    for (const h of this.byKey.values()) {
      for (const s of h.surfaces) {
        const l = locate(s);
        locs.set(s, l);
        if (!l?.exact) continue;
        const at = `${s.sourcePath}#${l.line}`;
        claims.set(at, [...(claims.get(at) ?? []), s]);
      }
    }
    for (const h of this.byKey.values()) {
      const active = h.current;
      // Editor state leads: the most recently active surface with an exact location.
      let lead: FrameSurface | undefined;
      for (let i = h.surfaces.length - 1; i >= 0 && !lead; i--) {
        if (locs.get(h.surfaces[i])?.exact) lead = h.surfaces[i];
      }
      const leadLoc = lead ? (locs.get(lead) ?? null) : null;
      const activeLoc = locs.get(active) ?? null;
      for (const s of h.surfaces) {
        const own = locs.get(s) ?? null;
        let loc: FenceLocation | null;
        if (own?.exact) loc = own;
        // A surface that can't tell (hidden: its section info or doc is stale until shown)
        // follows the editor, else the active surface: same fence, same key.
        else if (!own) loc = leadLoc ?? activeLoc;
        // A view that can tell but lags (Reading view section info) follows the editor. But
        // one key can briefly hold two fences (a view re-rendered at a line another fence's
        // stale surface still claims), so it keeps its own line if it shows another diagram,
        // or if another editor showing its diagram says its fence is at that line now.
        else {
          const src = s.source();
          const claimed = claims.get(`${s.sourcePath}#${own.line}`)?.some((t) => t !== lead && t.source() === src);
          loc = lead && !claimed && lead.source() === src ? leadLoc : own;
        }
        if (!loc) continue;
        const key = `${s.sourcePath}#${loc.line}`;
        if (loc.rest !== s.fenceRest) {
          s.fenceRest = loc.rest;
          if (key === s.key && s === active) restChanged.add(h);
        }
        if (key !== s.key) moves.push({ from: h, s, key, wasActive: s === active });
      }
    }
    // Detach every mover and drop the handles left empty before attaching anything, so a
    // fence moving onto a key another fence just left gets a fresh handle, not that one.
    const shown = new Map<FrameSurface, boolean | undefined>();
    for (const { from, s } of moves) {
      from.surfaces = from.surfaces.filter((x) => x !== s);
      shown.set(s, this.watches.get(s)?.shown);
      this.unwatch(s);
    }
    const left = new Set(moves.map((m) => m.from));
    for (const h of left) {
      if (!h.surfaces.length) {
        if (this.byKey.get(h.key) === h) this.destroy(h);
        continue;
      }
      // Its active surface moved away: hand over, as an unbind does.
      if (!h.surfaces.includes(h.last)) {
        const next =
          [...h.surfaces].reverse().find((s) => s.root.isConnected !== false && !this.isHidden(s)) ??
          h.surfaces[h.surfaces.length - 1];
        this.makeActive(h, next);
        if (!this.isHidden(next)) this.renderSettled(h, next);
      }
    }
    const landed = new Map<Handle, { fresh: boolean; movers: typeof moves }>();
    for (const m of moves) {
      const { s, key } = m;
      s.key = key;
      let t = this.byKey.get(key);
      const fresh = !t;
      if (!t) {
        t = new Handle(key, s, this);
        this.byKey.set(key, t);
      }
      t.surfaces.unshift(s);
      this.byEl.set(s.root, t);
      this.byEl.set(s.bar, t);
      this.watch(t, s);
      const w = this.watches.get(s);
      if (w) w.shown = shown.get(s);
      const entry = landed.get(t) ?? { fresh, movers: [] };
      entry.movers.push(m);
      landed.set(t, entry);
    }
    for (const [t, { fresh, movers }] of landed) {
      const shownMover =
        movers.find((m) => m.wasActive && !this.isHidden(m.s)) ?? movers.find((m) => !this.isHidden(m.s));
      // A fresh handle takes the mover that was active; a handle already there keeps its
      // active surface unless that one is hidden and a mover is shown.
      const take = fresh ? (shownMover ?? movers[0]) : this.isHidden(t.current) ? shownMover : undefined;
      const activated = take ? this.makeActive(t, take.s) : false;
      // Its active rest changed in this pass too: every bar, and one notice, here.
      const restPending = restChanged.delete(t);
      if (restPending) for (const s of t.surfaces) this.deps.actions.sync(s.bar, t);
      else for (const m of movers) if (!(activated && m === take)) this.deps.actions.sync(m.s.bar, t);
      const notify = take && !this.isHidden(take.s) ? take.s : restPending && !this.isHidden(t.current) ? t.current : undefined;
      if (notify) this.renderSettled(t, notify);
    }
    for (const h of restChanged) {
      if (!h.connected) continue;
      // Action predicates can read `fenceRest`.
      for (const s of h.surfaces) this.deps.actions.sync(s.bar, h);
      if (!this.isHidden(h.current)) this.renderSettled(h, h.current);
    }
  }

  /**
   * One `resync` on the next animation frame, however often it is asked for before then,
   * and one more `RESYNC_SETTLE_MS` after the last ask: a Reading view updates its section
   * info after the editor, so a surface left on a stale key catches up then.
   */
  resyncSoon(): void {
    this.settleResync?.();
    this.settleResync = this.wait(() => {
      this.settleResync = null;
      this.resync();
    }, RESYNC_SETTLE_MS);
    if (this.resyncQueued) return;
    this.resyncQueued = true;
    this.deps.nextFrame(() => {
      if (this.resyncQueued) this.resync();
    });
  }

  /** The surface is suspended, or was seen hidden (0×0) at its last size observation. */
  isHidden(surface: FrameSurface): boolean {
    return this.suspended.has(surface) || this.watches.get(surface)?.shown === false;
  }

  /**
   * Makes `surface` the active one. When that changes, its companion buttons are
   * re-evaluated against it (returns true); they were last evaluated against another.
   */
  private makeActive(h: Handle, surface: FrameSurface): boolean {
    const changed = h.current !== surface;
    if (changed) {
      h.surfaces = h.surfaces.filter((s) => s !== surface);
      h.surfaces.push(surface);
    }
    h.last = surface;
    h.placeOverlay();
    if (changed) this.deps.actions.sync(surface.bar, h);
    return changed;
  }

  private fireRender(h: Handle): void {
    for (const cb of [...this.renderCbs]) {
      try {
        cb(h);
      } catch (e) {
        console.error("Mehrpele: a frames.onDidRender callback failed", e);
      }
    }
  }

  private watch(h: Handle, surface: FrameSurface): void {
    if (!this.watching || this.watches.has(surface)) return;
    const w: SizeWatch = { shown: undefined, scrollQueued: false, stop: () => undefined };
    this.watches.set(surface, w);
    // Below the shrink floor the mount scrolls sideways (`.is-scrolling`) and the overlay,
    // outside it, stays put: companions re-place from nodeRect, once per frame.
    const onScroll = (): void => {
      if (w.scrollQueued) return;
      w.scrollQueued = true;
      this.deps.nextFrame(() => {
        w.scrollQueued = false;
        if (this.watches.get(surface) !== w || !h.connected || h.current !== surface || this.isHidden(surface)) return;
        this.fireRender(h);
      });
    };
    surface.mount.addEventListener("scroll", onScroll, { passive: true });
    const stopSize = this.observeSize(surface.root, (shown) => {
      const was = w.shown;
      w.shown = shown;
      // A suspended surface is only recorded: its revival (bind) decides.
      if (shown === was || this.watches.get(surface) !== w || !h.connected || this.suspended.has(surface)) return;
      if (shown && was === false) {
        // Became visible (a mode toggle or tab switch shows a frame without re-rendering it).
        // Its fence may have moved while it was hidden: place it first. A resync that moved
        // it onto a fresh handle already made it active there and rendered.
        this.resync();
        const cur = this.byKey.get(surface.key);
        if (!cur?.connected || !cur.surfaces.includes(surface) || (cur !== h && cur.current === surface)) return;
        this.makeActive(cur, surface);
        this.fireRender(cur);
      } else if (!shown && h.current === surface) {
        // The active surface hid: hand over to the most recently active shown one, if any.
        const next = [...h.surfaces].reverse().find((s) => s !== surface && this.watches.get(s)?.shown === true);
        if (next) {
          this.makeActive(h, next);
          this.fireRender(h);
        }
      }
    });
    w.stop = () => {
      stopSize();
      surface.mount.removeEventListener("scroll", onScroll);
    };
  }

  private unwatch(surface: FrameSurface): void {
    const w = this.watches.get(surface);
    if (!w) return;
    this.watches.delete(surface);
    w.stop();
  }

  /** The handle a bound surface belongs to. */
  handleOf(surface: FrameSurface): FrameHandle | null {
    const h = this.byKey.get(surface.key);
    return h && h.surfaces.includes(surface) ? h : null;
  }

  list(): FrameHandle[] {
    return [...this.byKey.values()].filter((h) => h.connected);
  }

  /** The handle whose frame contains `el` (or its floated action bar). */
  forElement(el: HTMLElement): FrameHandle | null {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const h = this.byEl.get(n);
      if (h?.connected && h.surfaces.some((s) => s.root === n || s.bar === n)) return h;
    }
    return null;
  }

  onDidRender(cb: (f: FrameHandle) => void): () => void {
    this.renderCbs.add(cb);
    return () => this.renderCbs.delete(cb);
  }

  onDidDestroy(cb: (f: FrameHandle) => void): () => void {
    this.destroyCbs.add(cb);
    return () => this.destroyCbs.delete(cb);
  }

  /** Re-evaluates the companion buttons of one handle's frames (api `refreshActions`). */
  refreshActions(frame: FrameHandle): void {
    const h = this.byKey.get(frame.key);
    if (h !== frame) return;
    for (const s of h.surfaces) this.deps.actions.sync(s.bar, h);
  }

  /** Re-evaluates the companion buttons of every frame (an action was added). */
  refreshAllActions(): void {
    for (const h of this.byKey.values()) for (const s of h.surfaces) this.deps.actions.sync(s.bar, h);
  }

  /** Removes the overlay layers `featureId` and `featureId:*` from every frame. */
  removeLayers(featureId: string): void {
    for (const h of this.byKey.values()) {
      for (const [id, layer] of [...h.layers]) {
        if (id === featureId || id.startsWith(`${featureId}:`)) {
          layer.remove();
          h.layers.delete(id);
        }
      }
    }
  }

  private destroy(h: Handle): void {
    h.disconnect();
    this.byKey.delete(h.key);
    for (const cb of [...this.destroyCbs]) {
      try {
        cb(h);
      } catch (e) {
        console.error("Mehrpele: a frames.onDidDestroy callback failed", e);
      }
    }
  }

  /** Host unload: disconnects every handle and drops all callbacks (no destroy events). */
  disposeAll(): void {
    for (const h of this.byKey.values()) h.disconnect();
    for (const s of [...this.watches.keys()]) this.unwatch(s);
    this.watching = false;
    this.resyncQueued = false;
    this.settleResync?.();
    this.settleResync = null;
    this.suspended.clear();
    this.byKey.clear();
    this.renderCbs.clear();
    this.destroyCbs.clear();
  }
}
