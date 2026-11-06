/**
 * Views attached to diagram nodes (`%% pele-view A=localgraph; A=backlink %%`):
 * hovering such a node shows a small view button at its top-right corner;
 * clicking it opens a panel anchored to the node with one tab per attached
 * view. Works for plain text nodes, Markdown labels and embed nodes, in
 * plain and Mehrpele diagrams. A view's default note is the node's own note
 * (its note embed or first wikilink), else the note holding the diagram.
 *
 * Button and panel live in the document body (like Obsidian's hover
 * popovers: never clipped by the diagram frame, never moved), follow the
 * node while it scrolls, and close on Escape, the close button, or when the
 * diagram goes away. The panel's live views are pinned in the pool.
 *
 * Keyboard: the button is a button (Tab, Enter/Space) and stays while it has
 * focus. Nodes get no tab stops; the command "Show attached views" opens the
 * panel of the hovered node, else of the first node with views in the diagram
 * holding focus (its action bar), and the next node on each further run.
 * The panel takes focus and gives it back when it closes.
 */
import { setIcon, setTooltip } from "obsidian";
import { asButton, FocusTrap } from "../../a11y";
import { actionBarOf, actionRootOf } from "../../action-bar-location";
import { extractLabels } from "../extract";
import { parseViewDirective, type AttachedView } from "./directive";
import { CORE_VIEWS } from "./state";
import { linkedNoteOf, viewSpecKey } from "./syntax";
import { Dock, type ViewHub } from "./stage";
import { dockSourceFor, resolvePath, type ViewNodesHost } from "./renderer";
import { chip } from "./hosts";

export interface DiagramInfo {
  source: string;
  sourcePath: string;
  /** The diagram's `.pele-host` wrapper. */
  wrapper: HTMLElement;
}

export type DiagramResolver = (el: Element) => DiagramInfo | null;

interface Hovered {
  info: DiagramInfo;
  node: string;
  views: AttachedView[];
}

const HIDE_DELAY_MS = 350;

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

/** The SVG node group of a source node id (Pele writes the id as data-id). */
export function nodeElement(wrapper: HTMLElement, node: string): Element | null {
  const svg = wrapper.querySelector(":scope > .pele-mount svg, :scope .mehrpele-mount > svg");
  return svg?.querySelector(`.pele-node[data-id="${cssEscape(node)}"]`) ?? null;
}

/** Node id under `target` inside `wrapper`, if any. */
export function nodeIdAt(wrapper: HTMLElement, target: Element): string | null {
  const item = target.closest<HTMLElement>(".mehrpele-overlay-item[data-anchor]");
  if (item && item.closest(".pele-host") === wrapper) return item.dataset.anchor ?? null;
  const g = target.closest(".pele-node[data-id]");
  if (g && g.closest(".pele-host") === wrapper) return g.getAttribute("data-id");
  return null;
}

/** Default note of a node's attached views: its note embed / first wikilink, else the note. */
export function nodeDefaultFile(host: ViewNodesHost, info: DiagramInfo, node: string): string {
  const label = extractLabels(info.source).find((l) => l.kind === "node" && l.anchorId === node);
  const written = label ? linkedNoteOf(label.markdown) : null;
  const f = written ? resolvePath(host.app, written, info.sourcePath) : null;
  return f?.path ?? info.sourcePath;
}

export class AttachedViewsLayer {
  private btn: HTMLElement;
  private hovered: Hovered | null = null;
  private hideTimer: number | null = null;
  private moveReq: number | null = null;
  private lastTarget: Element | null = null;
  private panel: AttachedPanel | null = null;
  private cache: { source: string; views: AttachedView[] } | null = null;
  /** The last focused element inside a diagram or panel, for the keyboard route. */
  private lastFocus: Element | null = null;

  constructor(
    private host: ViewNodesHost,
    private hub: ViewHub,
    private resolve: DiagramResolver,
  ) {
    this.btn = asButton(document.body.createDiv({ cls: "mehrpele-view-attach-btn" }));
    this.btn.hide();
    setIcon(this.btn.createSpan({ cls: "mehrpele-view-attach-icon" }), "layout-panel-top");
    this.btn.createSpan({ cls: "mehrpele-view-attach-count" });
    this.btn.addEventListener("pointerenter", () => this.cancelHide());
    this.btn.addEventListener("pointerleave", () => this.scheduleHide());
    this.btn.addEventListener("focusin", () => this.cancelHide());
    this.btn.addEventListener("focusout", () => this.scheduleHide());
    this.btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const h = this.hovered;
      if (!h) return;
      // Activated from the keyboard (a mouse click leaves focus where it was): focus follows into the panel.
      if (this.btn.contains(this.btn.ownerDocument.activeElement)) this.openFromKeyboard(h);
      else this.openPanel(h);
    });
  }

  /** Document pointermove (registered by the plugin). */
  onPointerMove = (e: PointerEvent): void => {
    const target = e.target as Element | null;
    this.lastTarget = typeof target?.closest === "function" ? target : null;
    if (this.moveReq !== null) return;
    this.moveReq = window.requestAnimationFrame(() => {
      this.moveReq = null;
      this.update(this.lastTarget);
    });
  };

  /** Document keydown: Escape closes the panel. */
  onKeyDown = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    // Escape in a view's own input (search boxes) belongs to the view.
    if (t?.closest?.("input, textarea, [contenteditable='true']") && this.panel?.el.contains(t)) return;
    if (e.key === "Escape" && this.panel) {
      this.panel.close();
      this.panel = null;
    }
  };

  /** Document focusin (registered by the plugin): remember the diagram or panel that holds focus. */
  onFocusIn = (e: FocusEvent): void => {
    const target = e.target as Element | null;
    const t = typeof target?.closest === "function" ? target : null;
    if (this.hovered && this.hovered.info.wrapper.ownerDocument !== t?.ownerDocument) this.hideNow();
    // The command palette and other dialogs take focus to run the command: keep the diagram.
    if (t?.closest(".modal-container")) return;
    this.lastFocus = t?.closest(".embed-actions, .pele-host, .mehrpele-view-panel") ? t : null;
  };

  private enabled(): boolean {
    const s = this.host.settings();
    return s.enabled && s.attachedViews;
  }

  /**
   * The node whose views the keyboard route opens: the hovered node (the
   * button's), else in the diagram holding focus its first node with views,
   * or the node after the open panel's.
   */
  keyboardTarget(): Hovered | null {
    if (!this.enabled()) return null;
    if (this.hovered) return this.hovered;
    const t = this.lastFocus?.isConnected ? this.lastFocus : null;
    const inPanel = t && this.panel?.el.contains(t) ? this.panel : null;
    const bar = t?.closest<HTMLElement>(".embed-actions");
    const root = (bar ? actionRootOf(bar) : null) ?? t?.closest(".pele-host")?.parentElement;
    const wrapper = inPanel?.info.wrapper ?? root?.querySelector<HTMLElement>(":scope > .pele-host");
    const info = wrapper ? this.resolve(wrapper) : null;
    if (!info) return null;
    const views = this.viewsOf(info.source);
    const nodes = [...new Set(views.map((v) => v.node))].filter((node) => nodeElement(info.wrapper, node));
    const open = this.panel?.info.wrapper === info.wrapper ? nodes.indexOf(this.panel.node) : -1;
    const node = nodes[(open + 1) % nodes.length];
    return node === undefined ? null : { info, node, views: views.filter((v) => v.node === node) };
  }

  /** Open a node's panel from the keyboard: focus moves to its first tab. */
  openFromKeyboard(h: Hovered): void {
    // Opening hides the floating button; return to a stable action in its diagram.
    if (this.btn.contains(this.btn.ownerDocument.activeElement)) {
      const root = h.info.wrapper.parentElement;
      if (root) actionBarOf(root)?.querySelector<HTMLElement>(":scope > [role=button]")?.focus();
    }
    this.openPanel(h).takeFocus();
  }

  private viewsOf(source: string): AttachedView[] {
    if (this.cache?.source !== source) this.cache = { source, views: parseViewDirective(source).views };
    return this.cache.views;
  }

  private update(target: Element | null): void {
    if (!this.host.settings().enabled || !this.host.settings().attachedViews) return this.hideNow();
    if (!target || this.btn.contains(target)) return;
    if (target.closest(".mehrpele-view-dock, .mehrpele-view-panel")) return this.scheduleHide();
    const wrapper = target.closest<HTMLElement>(".pele-host");
    if (!wrapper) return this.scheduleHide();
    const info = this.resolve(wrapper);
    if (!info || !info.source.includes("pele-view")) return this.scheduleHide();
    const node = nodeIdAt(wrapper, target);
    const views = node ? this.viewsOf(info.source).filter((v) => v.node === node) : [];
    if (!node || views.length === 0) return this.scheduleHide();
    this.cancelHide();
    this.hovered = { info, node, views };
    this.place();
  }

  private place(): void {
    const h = this.hovered;
    if (!h) return;
    const el = nodeElement(h.info.wrapper, h.node);
    if (!el) return this.hideNow();
    const r = el.getBoundingClientRect();
    // Coordinates belong to the node's window, including in a popout.
    if (this.btn.ownerDocument !== h.info.wrapper.ownerDocument) h.info.wrapper.ownerDocument.body.appendChild(this.btn);
    this.btn.show();
    this.btn.style.left = `${Math.round(r.right - 26)}px`;
    this.btn.style.top = `${Math.round(r.top - 10)}px`;
    const count = this.btn.querySelector(".mehrpele-view-attach-count");
    count?.setText(h.views.length > 1 ? String(h.views.length) : "");
    setTooltip(this.btn, h.views.length === 1 ? `Show ${titleOf(h.views[0])}` : `Show ${h.views.length} attached views`);
    this.btn.dataset.node = h.node;
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private scheduleHide(): void {
    if (this.hideTimer !== null || !this.hovered) return;
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      if (this.btn.contains(this.btn.ownerDocument.activeElement)) return;
      this.hideNow();
    }, HIDE_DELAY_MS);
  }

  private hideNow(): void {
    this.cancelHide();
    this.hovered = null;
    this.btn.hide();
  }

  openPanel(h: Hovered, index = 0): AttachedPanel {
    this.panel?.close();
    this.panel = new AttachedPanel(this.host, this.hub, h.info, h.node, h.views, () => {
      this.panel = null;
    });
    this.panel.select(index);
    this.hideNow();
    return this.panel;
  }

  /** Layout or active leaf changed: the panel follows its node or closes with it. */
  onWorkspaceChange = (): void => {
    this.panel?.refresh();
  };

    /** The open panel (diagnostics / tests). */
  current(): AttachedPanel | null {
    return this.panel;
  }

  destroy(): void {
    this.panel?.close();
    this.panel = null;
    if (this.moveReq !== null) cancelAnimationFrame(this.moveReq);
    this.cancelHide();
    this.btn.remove();
  }
}

function titleOf(v: AttachedView): string {
  return CORE_VIEWS[v.spec.type]?.title ?? v.spec.type;
}

export class AttachedPanel {
  readonly el: HTMLElement;
  private tabs: HTMLElement;
  private body: HTMLElement;
  private docks = new Map<number, Dock | HTMLElement>();
  private selected = -1;
  private raf: number | null = null;
  private ro: ResizeObserver;
  private expanded = false;
  private closed = false;
  private trap: FocusTrap;
  private win: Window & Pick<typeof window, "ResizeObserver">;
  private onScroll = (): void => this.schedulePlace();

  constructor(
    private host: ViewNodesHost,
    private hub: ViewHub,
    readonly info: DiagramInfo,
    readonly node: string,
    private views: AttachedView[],
    private onClose: () => void,
  ) {
    this.el = info.wrapper.ownerDocument.body.createDiv({ cls: "mehrpele-view-panel" });
    this.win = this.el.ownerDocument.defaultView ?? window;
    this.el.dataset.node = node;
    this.trap = new FocusTrap(this.el);
    const head = this.el.createDiv({ cls: "mehrpele-view-panel-head" });
    this.tabs = head.createDiv({ cls: "mehrpele-view-panel-tabs" });
    views.forEach((v, i) => {
      const t = asButton(this.tabs.createDiv({ cls: "mehrpele-view-panel-tab" }));
      setIcon(t.createSpan(), CORE_VIEWS[v.spec.type]?.icon ?? "lucide-layout-panel-top");
      t.createSpan({ text: titleOf(v) });
      t.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.select(i);
      });
    });
    const actions = head.createDiv({ cls: "mehrpele-view-panel-actions" });
    const mk = (icon: string, tip: string, run: () => void): HTMLElement => {
      const b = asButton(actions.createDiv({ cls: "clickable-icon" }));
      setIcon(b, icon);
      setTooltip(b, tip);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        run();
      });
      return b;
    };
    mk("maximize-2", "Larger / smaller", () => {
      this.expanded = !this.expanded;
      this.el.toggleClass("is-expanded", this.expanded);
      this.el.style.removeProperty("width");
      this.el.style.removeProperty("height");
      this.schedulePlace();
    });
    mk("x", "Close", () => this.close());
    this.body = this.el.createDiv({ cls: "mehrpele-view-panel-body" });
    for (const type of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"]) this.el.addEventListener(type, (e) => e.stopPropagation());
    this.el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    this.ro = new this.win.ResizeObserver(() => {
      const d = this.docks.get(this.selected);
      if (d instanceof Dock) d.resized();
    });
    this.ro.observe(this.body);
    this.win.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    this.win.addEventListener("resize", this.onScroll, { passive: true });
    this.place();
  }

  /** Focus the first tab; focus goes back to where it was when the panel closes. */
  takeFocus(): void {
    this.trap.activate(this.tabs.querySelector<HTMLElement>(".mehrpele-view-panel-tab"));
  }

  select(i: number): void {
    if (i === this.selected || !this.views[i]) return;
    const prev = this.docks.get(this.selected);
    if (prev instanceof Dock) prev.pinned = false;
    if (prev) (prev instanceof Dock ? prev.el : prev).hide();
    this.selected = i;
    this.tabs.querySelectorAll(".mehrpele-view-panel-tab").forEach((t, j) => t.toggleClass("is-active", j === i));
    let d = this.docks.get(i);
    if (!d) {
      const v = this.views[i];
      const defaultFile = nodeDefaultFile(this.host, this.info, this.node);
      const src = dockSourceFor(this.host, this.hub, v.spec, `panel\u0000${this.node}\u0000${i}\u0000${viewSpecKey(v.spec)}`, this.info.sourcePath, defaultFile);
      if ("error" in src) {
        const holder = this.body.createDiv({ cls: "mehrpele-view-panel-error" });
        chip(holder, "alert-triangle", src.error);
        d = holder;
      } else {
        const dock = new Dock(this.hub, src, null);
        dock.el.addClass("is-panel");
        this.body.appendChild(dock.el);
        this.hub.register(dock);
        d = dock;
      }
      this.docks.set(i, d);
    }
    if (d instanceof Dock) {
      d.pinned = true;
      d.el.show();
      this.hub.activate(d);
    } else d.show();
  }

  private schedulePlace(): void {
    if (this.raf !== null || this.closed) return;
    this.raf = this.win.requestAnimationFrame(() => {
      this.raf = null;
      this.place();
    });
  }

  /** Re-place now (workspace changes; the diagram may be gone or hidden). */
  refresh(): void {
    this.place();
  }

  /** Below the node (above when there is no room), clamped to the window. */
  private place(): void {
    if (this.closed) return;
    if (!this.info.wrapper.isConnected) return this.close();
    const el = nodeElement(this.info.wrapper, this.node);
    const r = el?.getBoundingClientRect();
    // Node gone or hidden (another tab, collapsed): hide, and let the pool
    // release the views; they come back with the node.
    const hidden = !r || (r.width === 0 && r.height === 0);
    this.el.toggleClass("is-hidden-node", hidden);
    const sel = this.docks.get(this.selected);
    if (sel instanceof Dock && sel.pinned === hidden) {
      sel.pinned = !hidden;
      this.hub.schedulePlan();
    }
    if (hidden || !r) return;
    const w = this.el.offsetWidth || 440;
    const h = this.el.offsetHeight || 340;
    const vw = this.win.innerWidth;
    const vh = this.win.innerHeight;
    let top = r.bottom + 8;
    if (top + h > vh - 8 && r.top - 8 - h > 8) top = r.top - 8 - h;
    top = Math.max(8, Math.min(top, vh - h - 8));
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
    // Off screen with its node: hide (the views stay warm).
    this.el.toggleClass("is-offscreen", r.bottom < 0 || r.top > vh);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.win.removeEventListener("scroll", this.onScroll, { capture: true });
    this.win.removeEventListener("resize", this.onScroll);
    if (this.raf !== null) this.win.cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    for (const d of this.docks.values()) if (d instanceof Dock) d.destroy();
    this.docks.clear();
    // Give focus back only if it is still ours (not when the user moved on).
    const active = this.el.ownerDocument.activeElement;
    if (!active || active === this.el.ownerDocument.body || this.el.contains(active)) this.trap.release();
    this.el.remove();
    this.onClose();
  }
}
