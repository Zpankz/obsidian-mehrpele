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
 */
import { setIcon, setTooltip } from "obsidian";
import { asButton } from "../../a11y";
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

  constructor(
    private host: ViewNodesHost,
    private hub: ViewHub,
    private resolve: DiagramResolver,
  ) {
    this.btn = document.body.createDiv({ cls: "mehrpele-view-attach-btn" });
    this.btn.hide();
    setIcon(this.btn.createSpan({ cls: "mehrpele-view-attach-icon" }), "layout-panel-top");
    this.btn.createSpan({ cls: "mehrpele-view-attach-count" });
    this.btn.addEventListener("pointerenter", () => this.cancelHide());
    this.btn.addEventListener("pointerleave", () => this.scheduleHide());
    this.btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const h = this.hovered;
      if (!h) return;
      this.openPanel(h);
    });
  }

  /** Document pointermove (registered by the plugin). */
  onPointerMove = (e: PointerEvent): void => {
    this.lastTarget = e.target instanceof Element ? e.target : null;
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
  private onScroll = (): void => this.schedulePlace();

  constructor(
    private host: ViewNodesHost,
    private hub: ViewHub,
    private info: DiagramInfo,
    readonly node: string,
    private views: AttachedView[],
    private onClose: () => void,
  ) {
    this.el = document.body.createDiv({ cls: "mehrpele-view-panel" });
    this.el.dataset.node = node;
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
    this.ro = new ResizeObserver(() => {
      const d = this.docks.get(this.selected);
      if (d instanceof Dock) d.resized();
    });
    this.ro.observe(this.body);
    window.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    window.addEventListener("resize", this.onScroll, { passive: true });
    this.place();
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
    this.raf = window.requestAnimationFrame(() => {
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
    const vw = window.innerWidth;
    const vh = window.innerHeight;
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
    window.removeEventListener("scroll", this.onScroll, { capture: true });
    window.removeEventListener("resize", this.onScroll);
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    for (const d of this.docks.values()) if (d instanceof Dock) d.destroy();
    this.docks.clear();
    this.el.remove();
    this.onClose();
  }
}
