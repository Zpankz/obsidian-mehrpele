import { finishRenderMath, loadMathJax, Notice, Platform, renderMath } from "obsidian";
import { mount, render, type Mounted, type RenderResult } from "pele-render/pele";
import { effectiveZoom, MAX_BOX_HEIGHT, MIN_BOX_HEIGHT, resolveFrameDrag, sameFrameSize, type FrameSize, type FrameStart } from "./frame-resize";
import { isGenuineHandleClick, isGenuineHandlePress, trackHandleDrag } from "./drag-move";
import { normaliseZoom, type FenceSize, type FenceSizeEdit } from "./info-width";
import { formatError } from "./format-error";
import { makeIconResolver } from "./icons";
import { nextIdPrefix } from "./id-prefix";
import { NodeHandleLayer } from "./node-handles";
import { fillSvgLabels } from "./node-fill";
import { buildActionBar } from "./action-bar";
import { sourceDiagramType } from "./diagram-type";
import { markExternalLinks, PELE_HOST_CLASS, zoomOption } from "./core-look";
import { createDiagramMath, type DiagramMath, type MathJaxDeps } from "./math-resolver";
import { flattenSvg } from "./svg-markup";
import { noticeWithUndo } from "./size-undo";
import { routeDiagramLink } from "./link-classify";
import { extractAccTitle } from "./render-policy";
import { sanitizeSvg, svgElementFromMarkup } from "./sanitize-svg";
import { toMountOptions } from "./settings";
import type { SettingsV3 } from "./settings/schema";
import type { FrameCompanion, FrameSurface } from "./api/frame-handles";
import { applyPlanSource, parseReflowDirective, ReflowPlanner, type ReflowPlan } from "pele-render/reflow";
import {
  applyBoxDisplay,
  applyDisplaySize,
  clearBoxDisplay,
  canAnimate,
  ColumnWatcher,
  contentWidth,
  cssFonts,
  flipRemaining,
  withHeightCheck,
  layoutWidthFor,
  playFlip,
  LEGACY_MAGNIFY,
  REFLOW_ANIMATE,
  REFLOW_SIZED_CLASS,
  reflowPolicy,
  snapshotLayout,
  type FlipSnapshot,
} from "./reflow-frame";

/** Hides frame chrome (`display: none`, styles.css) until removed. */
const HIDDEN_CLASS = "pele-hidden";

export interface FrameHost {
  settings(): SettingsV3;
  /** Undo for a Reading-view "saved" notice: the latest recorded edit of the note (Mod+Z's stack). */
  undoLatest?(sourcePath: string): (() => void) | null;
  repair(frame: DiagramFrame): void;
  openLightbox(frame: DiagramFrame): void;
  internalLink(href: string, sourcePath: string, evt?: MouseEvent): void;
  hoverLink(evt: MouseEvent, anchor: HTMLElement, href: string, frame: DiagramFrame): void;
  contextMenu(frame: DiagramFrame, evt: MouseEvent): void;
  /** Trusted SVG markup for a Lucide name (Obsidian-generated), if it resolves. */
  iconSvg(lucideName: string): string | undefined;
  registerFrame(frame: DiagramFrame): void;
  unregisterFrame(frame: DiagramFrame): void;
  /** A re-layout changed this element's height (Reading view re-measures its section). */
  heightChanged?(el: HTMLElement): void;
  /** pele-edit: attach the edit toolbar / inline editor; returns its disposer. */
  attachEdit?(frame: DiagramFrame, writable: () => boolean): () => void;
  /**
   * Hold a suspended frame (unregistered, waiting for its DOM to come back)
   * and destroy it if it isn't revived soon. Without this hook, suspend destroys.
   */
  suspendFrame?(frame: DiagramFrame): void;
  /** A render finished (the first one included): companion frame handles hear it. */
  frameRendered?(frame: DiagramFrame): void;
}

/** Pele CSS variables copied into exported/flattened SVG. */
export const PELE_THEME_VARS = [
  "--pele-bg", "--pele-fg", "--pele-muted", "--pele-line", "--pele-surface",
  "--pele-surface-alt", "--pele-border", "--pele-accent", "--pele-font",
  "--pele-font-mono", "--pele-radius", "--pele-critical", "--pele-error",
  "--pele-title-weight", "--pele-heading-weight", "--pele-bold-weight",
  ...Array.from({ length: 8 }, (_, i) => `--pele-series-${i + 1}`),
] as const;

export interface FrameOptions {
  source: string;
  lang: string;
  sourcePath: string;
  width?: number;
  /** Fence `height=H`: the box height of a corner-dragged frame. */
  height?: number;
  /** Fence `zoom=Z`: legacy display zoom from an earlier corner drag. */
  zoom?: number;
  inEmbed?: boolean;
  /** Code-reveal action (LP: move cursor into block; Reading: host toggles panel via frame). */
  onRevealCode: (frame: DiagramFrame) => void;
  /**
   * Persist the fence size (null removes a token, an absent key keeps it);
   * undefined = live-only (embeds). Nested frames never set a zoom.
   */
  onPersistSize?: (edit: FenceSizeEdit) => void;
  /** Apply a repaired source as one edit; undefined = repair cannot apply here. */
  onApplyRepaired?: (newSource: string, expectedCurrent: string) => Promise<boolean>;
  /**
   * Ensure a `^block-id` follows the closing fence (one undoable edit) and
   * resolve to the id in use; null = could not locate. Undefined = this
   * frame cannot be written (embeds, Canvas, generated diagrams).
   */
  onEnsureBlockId?: (source: string) => Promise<string | null>;
  /** Rendered inside a Mehrpele node: compact chrome, own context menu only. */
  nested?: boolean;
  /** Resize-corner bounds (layout px); default 20px .. the parent's width. */
  minWidth?: number;
  maxWidth?: number;
  /** Box height bounds (layout px); default 40 .. 4000. */
  minHeight?: number;
  maxHeight?: number;
  /**
   * A nested frame whose source lives in an enclosing label: node resizes
   * hand the edited source there instead of writing the note.
   */
  onSourceChange?: (next: string) => void;
  /** A top-level fence: its companion frame-handle key and info-string rest (api `frames`). */
  companion?: FrameCompanion;
}

/**
 * One rendered diagram with Obsidian's native image-embed UX:
 * div.image-embed.pele-embed > div.image-wrapper.pele-host (SVG) + resize
 * corner + div.embed-actions (zoom-in / code-2). Shared by Reading view,
 * Live Preview (patched widget) and the `pele` processor branch.
 */
export class DiagramFrame {
  /** Block source; changes in memory when a node is resized where it cannot be written. */
  source: string;
  readonly lang: string;
  readonly sourcePath: string;
  width: number | undefined;
  /** Box height (fence `height=`); undefined = the chart's own height. */
  height: number | undefined;
  /** Legacy display zoom (fence `zoom=`); undefined = none. */
  zoom: number | undefined;
  currentSvg: string | null = null;
  diagramType: string | null = null;
  diagramWidth = 0;
  diagramHeight = 0;
  readonly accTitle: string | null;
  readonly idPrefix: string;

  root: HTMLElement;
  wrapper: HTMLElement;
  /** Pele mount target inside the wrapper (mount() replaces its children). */
  private mountEl: HTMLElement;
  private errorEl: HTMLPreElement;
  private host: FrameHost;
  private opts: FrameOptions;
  private mounted: Mounted | null = null;
  private lastLinks: RenderResult["links"] = [];
  private sourcePanel: HTMLPreElement | null = null;
  private destroyed = false;
  private wrenchBtn!: HTMLElement;
  /** The `.embed-actions` bar (the same element when float-actions moves it to the body). */
  actionBar!: HTMLElement;
  private surface: FrameSurface | null | undefined;
  private errorRepairBtn!: HTMLButtonElement;
  private repairBusy = false;
  private nodeHandles: NodeHandleLayer | null = null;
  /** A node-size write is in flight (handles disabled until it settles). */
  private persisting = false;
  /** Responsive reflow: planner for the current source/settings/fonts, and the plan shown. */
  private planner: ReflowPlanner | null = null;
  private plannerSig = "";
  private plan: ReflowPlan | null = null;
  private layoutW = 0;
  private watcher: ColumnWatcher | null = null;
  private flipFrom: FlipSnapshot | null = null;
  /** Corner drag in progress: the size being previewed (never persisted). */
  private preview: FrameSize | null = null;
  private fillRetries = 0;
  /** Hidden accessible name (no aria-label: Obsidian turns those into hover tooltips). */
  private a11yLabel: HTMLElement;
  /** Suspended (Live Preview dropped the widget): revives when its DOM is shown again. */
  private reviveObs: ResizeObserver | null = null;
  /** pele-edit: disposer of the edit toolbar layer. */
  private disposeEdit: (() => void) | null = null;
  /** Hover chrome (node handles; edit tools when edit is off) not built yet: built on the first pointerover or focusin. */
  private chromePending = false;
  /** `$…$` labels typeset by Obsidian's MathJax (core 1.15's resolver); per frame so its cache follows this diagram. */
  private readonly diagramMath: DiagramMath = createDiagramMath({
    deps: obsidianMathDeps(),
    links: () => this.host.settings().core.security.allowLinks,
    rerender: () => this.onMathReady(),
  });

  constructor(host: FrameHost, opts: FrameOptions) {
    this.host = host;
    this.opts = opts;
    this.source = opts.source;
    this.lang = opts.lang;
    this.sourcePath = opts.sourcePath;
    this.width = opts.width;
    this.height = opts.height;
    this.zoom = normaliseZoom(opts.zoom);
    this.accTitle = extractAccTitle(opts.source);
    this.idPrefix = nextIdPrefix();

    this.root = createDiv();
    this.root.className = opts.nested ? "image-embed pele-embed pele-nested" : "image-embed pele-embed";
    this.root.tabIndex = -1;
    this.wrapper = createDiv();
    this.wrapper.className = PELE_HOST_CLASS;
    this.mountEl = createDiv();
    this.mountEl.className = "pele-mount";
    this.wrapper.appendChild(this.mountEl);
    this.root.appendChild(this.wrapper);
    this.a11yLabel = createSpan();
    this.a11yLabel.className = "pele-a11y-label";
    this.a11yLabel.id = `${this.idPrefix}-a11y`;
    this.root.appendChild(this.a11yLabel);
    this.errorEl = createEl("pre");
    this.errorEl.className = `pele-error ${HIDDEN_CLASS}`;
    this.root.appendChild(this.errorEl);
    // Repair: text button inside the error-pane slot.
    const errorActions = createDiv();
    errorActions.className = "pele-error-actions pele-repair-slot";
    this.errorRepairBtn = createEl("button");
    this.errorRepairBtn.className = "pele-repair-button";
    this.errorRepairBtn.textContent = "Repair";
    this.errorRepairBtn.addEventListener("click", () => this.host.repair(this));
    errorActions.appendChild(this.errorRepairBtn);
    this.root.appendChild(errorActions);

    if (!Platform.isMobile) {
      const corner = createDiv();
      corner.className = "image-resize-corner";
      // Sibling of the mount target (mount() replaces the target's children),
      // inside the wrapper so it tracks the diagram's bottom-right corner.
      this.wrapper.appendChild(corner);
      this.attachResize(corner);
    }

    const { bar, wrench } = buildActionBar({
      zoom: () => this.host.openLightbox(this),
      revealCode: () => this.opts.onRevealCode(this),
      source: () => this.source,
      svg: () => this.flattenedSvg(),
      repair: () => this.host.repair(this),
    });
    this.actionBar = bar;
    this.wrenchBtn = wrench;
    this.root.appendChild(bar);

    this.wrapper.addEventListener("click", this.onWrapperClick);
    this.wrapper.addEventListener("mouseover", this.onWrapperHover);
    this.root.addEventListener("contextmenu", this.onContextMenu);
    // pele-edit: toolbar + inline editor; edits go through persistSource.
    // With edit on it attaches now (an open editor is handed to the frame that
    // replaces this one, before any pointer event). Node handles, and the edit
    // tools while edit is off, only act under the pointer or keyboard focus:
    // they are built on the first pointerover or focusin, so read-only and
    // unvisited diagrams carry no observers.
    if (this.editOn()) this.attachEditNow();
    this.chromePending = true;
    this.root.addEventListener("pointerover", this.onFirstHover, true);
    this.root.addEventListener("focusin", this.onFirstHover, true);
    this.applyWidthStyle();
    this.applyA11y();
    this.setRepairVisible(false);
  }

  private editOn(): boolean {
    const f = this.host.settings().features;
    return f.toolbar.enabled || f["inline-edit"].enabled;
  }

  private attachEditNow(): void {
    if (this.disposeEdit || this.destroyed) return;
    this.disposeEdit =
      this.host.attachEdit?.(
        this,
        () => !!this.opts.onSourceChange || (!!this.opts.onApplyRepaired && !this.root.closest(".internal-embed, .mehrpele-label, .canvas-node")),
      ) ?? null;
  }

  private ensureNodeHandles(): NodeHandleLayer | null {
    if (this.nodeHandles || this.destroyed || Platform.isMobile) return this.nodeHandles;
    this.nodeHandles = new NodeHandleLayer({
      wrapper: this.wrapper,
      svg: () => this.mountEl.querySelector("svg"),
      source: () => this.source,
      enabled: () => this.host.settings().features.resize.enabled && !this.destroyed && !this.persisting,
      fontSize: () => toMountOptions(this.host.settings()).fontSize ?? 16,
      persist: (next) => void this.persistSource(next),
      applied: (next, id) => this.appliedNodeBox(next, id),
    });
    return this.nodeHandles;
  }

  private unhookChrome(): void {
    this.root.removeEventListener("pointerover", this.onFirstHover, true);
    this.root.removeEventListener("focusin", this.onFirstHover, true);
  }

  /**
   * First pointer over (or focus into) the frame: build the hover chrome.
   * Capture, so the wrapper's handlers see this pointer's next events and the
   * action buttons' tooltips carry their modifier hints before they show.
   */
  private onFirstHover = (): void => {
    this.unhookChrome();
    if (!this.chromePending || this.destroyed) return;
    this.chromePending = false;
    this.ensureNodeHandles();
    this.attachEditNow();
  };

  load(): void {
    this.host.registerFrame(this);
    if (!this.reflowOn()) {
      this.doMount();
      return;
    }
    // Re-layout from our own debounced observer; Pele's stays off (explicit maxWidth).
    this.watcher = new ColumnWatcher(this.root, () => this.relayout());
    const canvas = this.root.closest(".canvas-node-content");
    if (canvas) this.watcher.observe(canvas);
    // Not laid out yet (a Reading-view section before insertion): the first
    // width the watcher sees mounts it.
    if (this.layoutTarget() > 0) this.relayout();
  }

  /** Responsive reflow applies (setting on, block not `%% pele-reflow off %%`). */
  private reflowOn(): boolean {
    return this.host.settings().features.reflow.enabled && !parseReflowDirective(this.source).off;
  }

  /** Box width for this frame: column capped by `width=` and the max-width setting. */
  private computeLayoutW(): number {
    const width = this.preview ? this.preview.width : this.width;
    return layoutWidthFor(contentWidth(this.root), {
      ...(width !== undefined ? { width } : {}),
      ...(toMountOptions(this.host.settings()).maxWidth !== undefined ? { settingsMax: toMountOptions(this.host.settings()).maxWidth } : {}),
      ...(this.opts.nested && this.opts.maxWidth ? { nestedMax: this.opts.maxWidth } : {}),
    });
  }

  /**
   * Explicit zoom in effect: the fence's `zoom=` (or the drag preview's)
   * where it applies — reflow on, a top-level frame, no legacy magnify, not
   * a Canvas card (cards fit their box).
   */
  private zoomFactor(): number {
    if (this.frameBoxHeight() !== null) return 1;
    const z = this.preview && !this.preview.keepZoom ? undefined : this.zoom;
    if (z === undefined || !(z > 1) || this.opts.nested || !this.reflowOn()) return 1;
    if (LEGACY_MAGNIFY || this.boxHeight() !== null) return 1;
    return effectiveZoom(z, this.preview ? this.preview.width : this.width, contentWidth(this.root));
  }

  /**
   * Width Pele lays out for: the box (column-capped) over the zoom, which
   * then fills the box; the Max width setting caps the layout after that
   * division (it bounds the layout, not the zoomed display).
   */
  private layoutTarget(): number {
    // A W×H box: the box width (column-capped); planFill picks the layout.
    if (this.frameBoxHeight() !== null) {
      const width = this.preview ? this.preview.width : this.width;
      return layoutWidthFor(contentWidth(this.root), {
        ...(width !== undefined ? { width } : {}),
        ...(this.opts.nested && this.opts.maxWidth ? { nestedMax: this.opts.maxWidth } : {}),
      });
    }
    const z = this.zoomFactor();
    if (z <= 1) return this.computeLayoutW();
    const width = this.preview ? this.preview.width : this.width;
    const box = layoutWidthFor(contentWidth(this.root), width !== undefined ? { width } : {});
    if (!(box > 0)) return 0;
    const settingsMax = toMountOptions(this.host.settings()).maxWidth;
    const L = Math.floor(box / z);
    return settingsMax !== undefined && settingsMax > 0 ? Math.min(L, Math.floor(settingsMax)) : L;
  }

  /** The box height (fence `height=` or the drag preview's) where a box applies: reflow on, top level, no legacy magnify, not a Canvas card. */
  private frameBoxHeight(): number | null {
    const h = this.preview && !this.preview.keepZoom ? this.preview.height : this.height;
    if (h === undefined || !(h > 0) || !this.reflowOn()) return null;
    if (LEGACY_MAGNIFY || this.boxHeight() !== null) return null;
    return h;
  }

  /** Fit-box height when the frame lives in a Canvas card (its content box). */
  private boxHeight(): number | null {
    const card = this.root.closest<HTMLElement>(".canvas-node-content");
    if (!card) return null;
    const h = card.clientHeight - 24;
    return h > 40 ? h : null;
  }

  /** Base options for planning: what the mount renders with, fonts resolved like mount(). */
  private planBase() {
    const { onRender: _r, onError: _e, sanitize: _s, zoom: _z, maxWidth: _m, autoDirection: _a, ...base } = {
      ...this.renderOptions(this.idPrefix, false),
    } as ReturnType<DiagramFrame["renderOptions"]> & Record<string, unknown>;
    return { ...base, ...(this.mountEl.isConnected ? cssFonts(this.mountEl, (base as { fontFamily?: string }).fontFamily) : {}) };
  }

  /** The planner for the current source, settings and fonts (rebuilt when any changes). */
  private ensurePlanner(): ReflowPlanner {
    const base = this.planBase();
    const policy = reflowPolicy(this.host.settings().features.reflow);
    const sig = JSON.stringify([this.source, policy, base.fontFamily, base.fontFamilyMono, base.fontSize, base.config, base.padding]);
    if (!this.planner || sig !== this.plannerSig) {
      const planner = new ReflowPlanner(this.source, base, render, policy);
      // An in-place edit (node size) or a font change keeps the layout shown
      // while it still fits: no direction flip just because the planner is new.
      planner.seed(this.plan);
      this.planner = planner;
      this.plannerSig = sig;
    }
    return this.planner;
  }

  /**
   * Re-plan for the current width. Re-renders only when the layout changes
   * (or `force`); otherwise only the display size is updated.
   */
  private relayout(force = false): void {
    if (this.destroyed || !this.reflowOn()) return;
    const L = this.layoutTarget();
    if (!(L > 0)) return;
    this.layoutW = L;
    const prev = this.plan;
    // At its full zoom the layout is the one the user picked by dragging
    // (box / zoom is exactly its natural width): no hysteresis keeps an
    // older, narrower layout once the pane is wide again.
    if (!this.preview && this.zoom !== undefined && this.zoomFactor() >= this.zoom) this.planner?.reset();
    const next = this.planFor(L);
    this.plan = next;
    if (!this.mounted) {
      // First layout (deferred until the frame had a width): the section grows now.
      withHeightCheck(this.root, () => this.doMount(), (el) => this.host.heightChanged?.(el));
      return;
    }
    if (force || !prev || next.key !== prev.key || next.source !== prev.source) {
      if (prev && next.key !== prev.key && canAnimate(this.root, REFLOW_ANIMATE)) {
        this.flipFrom = snapshotLayout(this.ownSvg(), this.mountEl);
      }
      const mounted = this.mounted;
      withHeightCheck(
        this.root,
        () => {
          try {
            mounted.update(this.renderSource(), this.mountOptions());
          } catch (e) {
            this.showError(e);
          }
        },
        (el) => this.host.heightChanged?.(el),
      );
    } else {
      // Same layout, new display size: the nodes moved without a render (companions re-place).
      const shown = this.root.dataset.reflow;
      this.applyDisplay();
      if (this.root.dataset.reflow !== shown) this.host.frameRendered?.(this);
    }
  }

  /** User-sized nodes: their labels grow to fill the box (node-fill.ts). */
  private applyFill(r: RenderResult): void {
    const sizes = (r as RenderResult & { nodeSizes?: Record<string, unknown> }).nodeSizes;
    const svg = this.ownSvg();
    if (!sizes || !svg || this.destroyed) return;
    if (!svg.isConnected || !(svg.getBoundingClientRect().width > 0)) {
      // Not laid out yet (a Reading-view section mounted before insertion,
      // reflow off): measure the labels once it is.
      if (this.fillRetries++ < 20) window.setTimeout(() => this.ownSvg() === svg && this.applyFill(r), 100);
      return;
    }
    this.fillRetries = 0;
    const fills = fillSvgLabels(svg, Object.keys(sizes), toMountOptions(this.host.settings()).fontSize ?? 16);
    this.root.dataset.fill = [...fills].map(([id, k]) => `${id}=${k}`).join(" ");
  }

  private ownSvg(): SVGSVGElement | null {
    return this.mountEl.querySelector(":scope > svg");
  }

  /** This frame as a companion frame-handle surface; null without companion info. */
  companionSurface(): FrameSurface | null {
    if (this.surface !== undefined) return this.surface;
    const c = this.opts.companion;
    this.surface = c
      ? {
          key: c.key,
          sourcePath: this.sourcePath,
          lang: this.lang,
          fenceRest: c.fenceRest,
          locate: () => (this.destroyed ? null : (c.locate?.() ?? null)),
          root: this.root,
          host: this.wrapper,
          mount: this.mountEl,
          bar: this.actionBar,
          svg: () => this.ownSvg(),
          // Known before the first mount too: a reflowing frame mounts only once it has a width.
          diagramType: () => this.diagramType ?? sourceDiagramType(this.source),
          source: () => this.source,
          rerender: () => {
            if (!this.destroyed) this.applySettings();
          },
          settleMs: () => flipRemaining(this.mountEl),
        }
      : null;
    return this.surface;
  }

  /** Size the SVG (never magnified, floor then scroll) and play a pending FLIP. */
  private applyDisplay(): void {
    const svg = this.ownSvg();
    const plan = this.plan;
    if (!svg || !plan || !(this.diagramWidth > 0) || !this.reflowOn()) return;
    const s = this.host.settings().features.reflow;
    const magnifyTo = LEGACY_MAGNIFY && this.width !== undefined ? Math.min(this.width, contentWidth(this.root) || this.width) : undefined;
    const H = this.boxHeight();
    const floor = this.planner?.minTextScale ?? s.minTextScale;
    const fit = H !== null && this.diagramHeight > 0 ? Math.min(1, this.layoutW / this.diagramWidth, H / this.diagramHeight) : null;
    if (plan.boxHeight !== undefined) {
      const shownBox = applyBoxDisplay(svg, this.diagramWidth, this.mountEl, plan, plan.boxHeight);
      this.root.dataset.reflow = `${plan.key} L=${this.layoutW} box=${this.layoutW}x${plan.boxHeight} s=${shownBox.scale.toFixed(3)}${shownBox.scroll ? " scroll" : ""}`;
      this.root.style.setProperty("--pele-display-scale", String(Math.round(shownBox.scale * 1000) / 1000));
      const fromBox = this.flipFrom;
      this.flipFrom = null;
      if (fromBox) playFlip(fromBox, svg, this.mountEl);
      return;
    }
    clearBoxDisplay(this.mountEl);
    const zoom = this.zoomFactor();
    const shown = applyDisplaySize(svg, this.diagramWidth, this.mountEl, {
      // Canvas cards fit the box (both dimensions), down to the floor.
      layoutWidth: fit !== null ? this.diagramWidth * Math.max(fit, floor) : this.layoutW,
      floor,
      ...(magnifyTo !== undefined ? { magnifyTo } : {}),
      ...(zoom > 1 ? { zoom } : {}),
    });
    this.root.dataset.reflow = `${plan.key} L=${this.layoutW}${zoom > 1 ? ` z=${zoom}` : ""} s=${shown.scale.toFixed(3)}${shown.scroll ? " scroll" : ""}`;
    this.root.style.setProperty("--pele-display-scale", String(Math.round(shown.scale * 1000) / 1000));
    const from = this.flipFrom;
    this.flipFrom = null;
    if (from) playFlip(from, svg, this.mountEl);
  }

  /**
   * Live Preview reported the widget destroyed, but CodeMirror can put the
   * same DOM back later. Stand down (unregistered, no column watcher) and
   * revive in place when the DOM is laid out again, instead of leaving a
   * dead diagram that never re-lays out.
   */
  suspend(onResume: () => void): void {
    if (this.destroyed || this.reviveObs || typeof ResizeObserver === "undefined" || !this.host.suspendFrame) {
      this.destroy();
      return;
    }
    this.host.unregisterFrame(this);
    this.watcher?.disconnect();
    this.watcher = null;
    this.reviveObs = new ResizeObserver(() => {
      if (this.destroyed || !this.root.isConnected || !(this.root.clientWidth > 0)) return;
      this.reviveObs?.disconnect();
      this.reviveObs = null;
      this.host.registerFrame(this);
      onResume();
      // The watcher's first sighting re-plans for the width it has now.
      if (this.reflowOn()) this.watcher = new ColumnWatcher(this.root, () => this.relayout());
    });
    this.reviveObs.observe(this.root);
    // Not revived soon (CM built a new frame instead): the host destroys it.
    this.host.suspendFrame(this);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.reviveObs?.disconnect();
    this.reviveObs = null;
    this.host.unregisterFrame(this);
    try {
      this.mounted?.destroy();
    } catch {
      /* already gone */
    }
    this.mounted = null;
    this.watcher?.disconnect();
    this.watcher = null;
    // Live Preview can keep showing a destroyed widget's DOM: let its SVG fall
    // back to CSS fitting (max-width: 100%) instead of a fixed reflow width.
    const svg = this.ownSvg();
    if (svg) {
      svg.style.removeProperty("width");
      svg.style.removeProperty("max-width");
      svg.classList.remove(REFLOW_SIZED_CLASS);
    }
    this.mountEl.classList.remove("is-scrolling");
    this.nodeHandles?.destroy();
    this.nodeHandles = null;
    this.disposeEdit?.(); // pele-edit
    this.disposeEdit = null;
    this.chromePending = false;
    this.unhookChrome();
    this.wrapper.removeEventListener("click", this.onWrapperClick);
    this.wrapper.removeEventListener("mouseover", this.onWrapperHover);
    this.root.removeEventListener("contextmenu", this.onContextMenu);
  }

  refresh(): void {
    try {
      this.mounted?.refresh();
    } catch {
      /* detached */
    }
    // Fonts may have changed: the planner is rebuilt for new fonts (Pele's own
    // refresh re-renders for them); a theme change re-renders nothing.
    if (this.reflowOn() && this.mounted) this.relayout();
  }

  /** MathJax finished loading after this diagram rendered its TeX as text: re-plan and re-render. */
  private onMathReady(): void {
    if (this.destroyed) return;
    this.planner = null;
    this.applySettings();
  }

  applySettings(): void {
    // Repair turned on or off: show or hide its buttons on an error frame.
    this.setRepairVisible(!this.errorEl.classList.contains(HIDDEN_CLASS));
    // Edit just turned on: attach now (see the constructor).
    if (this.editOn()) this.attachEditNow();
    // Not mounted yet: load() or the first width the watcher sees mounts it
    // (reflow just turned off while waiting for a width: mount now).
    if (!this.mounted) {
      if (!this.reflowOn() && !this.destroyed) this.doMount();
      return;
    }
    const reflow = this.reflowOn();
    // Settings may switch reflow on or off: keep the legacy styling in step.
    this.root.classList.toggle("pele-legacy-size", !reflow);
    if (!reflow) this.mountEl.classList.remove("is-scrolling");
    if (reflow) {
      this.watcher ??= new ColumnWatcher(this.root, () => this.relayout());
      const L = this.layoutTarget();
      if (L > 0) {
        this.layoutW = L;
        this.plan = this.planFor(L);
      }
    }
    try {
      this.mounted.update(this.renderSource(), this.mountOptions());
    } catch (e) {
      this.showError(e);
    }
  }

  /** Plan for L: fit-box in a Canvas card, the width ladder elsewhere. */
  private planFor(L: number): ReflowPlan {
    const planner = this.ensurePlanner();
    const H = this.boxHeight();
    if (H !== null) return { ...planner.planBox(L, H), layoutWidth: L };
    const box = this.frameBoxHeight();
    return box !== null ? planner.planFill(L, box) : planner.plan(L);
  }

  /** Source Pele renders: the plan's direction rewrite of the block source. */
  private renderSource(): string {
    return this.reflowOn() && this.plan ? applyPlanSource(this.source, this.plan) : this.source;
  }

  /** Apply a size re-read from the fence (widget reuse path). Never persists. */
  applyFenceSize(size: FenceSize): void {
    const z = normaliseZoom(size.zoom);
    if (size.width === this.width && size.height === this.height && z === this.zoom) return;
    this.width = size.width;
    this.height = size.height;
    this.zoom = z;
    this.applyWidthStyle();
    this.applySettings();
  }

  /** Route a diagram link click (also used inside the lightbox). */
  activateLink(href: string, evt?: MouseEvent): boolean {
    const link = this.lastLinks.find((l) => l.href === href);
    const kind = routeDiagramLink(href, link?.internal ?? false, this.host.settings().core.security, {
      internal: (h) => this.host.internalLink(h, this.sourcePath, evt),
      open: (h) => window.open(h),
    });
    return kind === "internal" || kind === "obsidian" || kind === "external"; // blocked/other never navigate
  }

  /** Fresh render with its own idPrefix (copy/export: the layout the note shows). */
  freshRender(): RenderResult {
    return render(this.renderSource(), this.renderOptions(nextIdPrefix()));
  }

  /**
   * Fresh render laid out for a W×H box (the lightbox): the layout that
   * shows the diagram largest without magnifying it, and its fit scale.
   */
  boxRender(W: number, H: number): { result: RenderResult; scale: number } {
    if (!this.host.settings().features.reflow.enabled || parseReflowDirective(this.source).off) {
      const result = this.freshRender();
      return { result, scale: Math.min(1, W / (result.width || 1), H / (result.height || 1)) };
    }
    const base = this.planBase();
    const planner = new ReflowPlanner(this.source, base, render, reflowPolicy(this.host.settings().features.reflow));
    const plan = planner.planBox(W, H);
    const opts = { ...this.renderOptions(nextIdPrefix(), false), ...plan.options, ...cssFontsOrEmpty(base) };
    const result = render(plan.source, opts);
    return { result, scale: Math.min(1, W / (result.width || 1), H / (result.height || 1)) };
  }

  /** pele-edit: direction of the layout shown ("TB", "LR", "authored", …); null without reflow. */
  get planDirection(): string | null {
    return this.plan?.direction ?? null;
  }

  /** Reflow applies to this frame (lightbox fit-box layout). */
  get reflowEnabled(): boolean {
    return this.reflowOn();
  }

  /** Shrink floor in effect (setting or the block's `floor=`). */
  get reflowFloor(): number {
    return parseReflowDirective(this.source).floor ?? this.host.settings().features.reflow.minTextScale;
  }

  /** Lightbox SVG element for a W×H box (sanitised like freshSvgElement). */
  boxSvgElement(W: number, H: number): { svg: SVGElement; width: number; height: number; scale: number } | null {
    const { result, scale } = this.boxRender(W, H);
    if (!result.svg) return null;
    const strict = this.host.settings().core.security.sanitize;
    const svg = svgElementFromMarkup(result.svg, strict ? sanitizeSvg : null);
    return svg ? { svg: this.diagramMath.hydrate(svg, strict), width: result.width, height: result.height, scale } : null;
  }

  /**
   * Fresh SVG element for the lightbox. `render()` ignores MountOptions'
   * `sanitize`, so the "Sanitize SVG" setting is applied here before the
   * markup reaches the DOM.
   */
  freshSvgElement(): SVGElement | null {
    const markup = this.freshRender().svg;
    if (!markup) return null;
    const strict = this.host.settings().core.security.sanitize;
    const svg = svgElementFromMarkup(markup, strict ? sanitizeSvg : null);
    return svg ? this.diagramMath.hydrate(svg, strict) : null;
  }

  /** Live SVG with the current computed --pele-* values inlined (paste-safe). */
  flattenedSvg(): string {
    return flattenSvg(this.currentSvg ?? this.freshRender().svg, this.wrapper, PELE_THEME_VARS, this.host.settings().core.security.sanitize);
  }

  /** The box `next` renders node `id` at (SVG units), as this frame renders. */
  private appliedNodeBox(nextSource: string, id: string): { w: number; h: number } | null {
    let next = nextSource;
    try {
      // Measure in the font the mount uses (it resolves --pele-font from the
      // container when no family is configured).
      const opts: ReturnType<DiagramFrame["renderOptions"]> & { fontFamily?: string; fontFamilyMono?: string } =
        this.renderOptions(nextIdPrefix());
      // Size it in the layout the frame shows (wrap width, direction).
      if (this.reflowOn() && this.plan) next = applyPlanSource(next, this.plan);
      if (!opts.fontFamily) {
        const fonts = cssFonts(this.mountEl);
        if (fonts.fontFamily) opts.fontFamily = fonts.fontFamily;
        if (fonts.fontFamilyMono && !opts.fontFamilyMono) opts.fontFamilyMono = fonts.fontFamilyMono;
      }
      const r = render(next, opts) as RenderResult & {
        nodeSizes?: Record<string, { applied: { w: number; h: number } }>;
      };
      return r.nodeSizes?.[id]?.applied ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A node was resized (its `%% pele-size %%` entry edited). Nested frames
   * hand the edit to the enclosing label; blocks in a note are written as one
   * edit (Live Preview: undoable transaction; Reading view: one file write
   * with an Undo notice); everything else (embeds of other notes, Mehrpele
   * labels, Canvas) re-renders without saving.
   */
  async persistSource(next: string, what = "node size"): Promise<boolean> {
    if (this.destroyed || this.persisting || next === this.source) return false;
    const previous = this.source;
    if (this.opts.onSourceChange) {
      this.opts.onSourceChange(next);
      return true;
    }
    if (this.opts.onApplyRepaired && !this.root.closest(".internal-embed, .mehrpele-label, .canvas-node")) {
      // Decide before writing: a Live Preview write replaces (detaches) this widget.
      const inEditor = !!this.root.closest(".cm-editor");
      // One write at a time: handles stand down until this one settles, so a
      // second gesture never starts from a stale expected source.
      this.persisting = true;
      let ok = false;
      try {
        ok = await this.opts.onApplyRepaired(next, previous).catch(() => false);
      } finally {
        this.persisting = false;
      }
      if (!ok) {
        // Not written: keep showing what the note says.
        new Notice(`Pele: could not locate that diagram; ${what} not saved.`);
        return false;
      }
      if (!inEditor) noticeWithUndo(`Pele: ${what} saved.`, this.host.undoLatest?.(this.opts.sourcePath) ?? (() => this.opts.onApplyRepaired?.(previous, next)));
    }
    if (this.destroyed) return true;
    this.source = next;
    this.applySettings();
    return true;
  }

  /** Id of the sizable node under `target` (context menu), if any. */
  nodeIdAt(target: EventTarget | null): string | null {
    return this.ensureNodeHandles()?.nodeAt(target)?.id ?? null;
  }

  /** Apply a node-size edit (context menu resets) through persistSource. */
  editNodeSizes(edit: (source: string) => string): void {
    const next = edit(this.source);
    if (next !== this.source) void this.persistSource(next);
  }

  /** Code-reveal (same action as the code-2 button). */
  revealCode(): void {
    this.opts.onRevealCode(this);
  }

  /** A fence size (width, height or zoom) to reset. */
  get hasWidth(): boolean {
    return this.width !== undefined || this.height !== undefined || this.zoom !== undefined;
  }

  resetSize(): void {
    this.commitSize({ width: null, height: null, zoom: null });
  }

  cloneSvg(): SVGElement | null {
    const svg = this.wrapper.querySelector("svg");
    return svg ? (svg.cloneNode(true) as SVGElement) : null;
  }

  /** Reading-view code reveal: toggle an inline source panel under the diagram. */
  toggleSourcePanel(): void {
    if (this.sourcePanel) {
      this.sourcePanel.remove();
      this.sourcePanel = null;
      return;
    }
    const pre = createEl("pre");
    pre.className = "pele-source-panel";
    const code = createEl("code");
    code.className = `language-${this.lang}`;
    code.textContent = this.source;
    pre.appendChild(code);
    this.root.appendChild(pre);
    this.sourcePanel = pre;
  }

  // -- internals ----------------------------------------------------------

  private effectiveMaxWidth(): number | undefined {
    if (this.width !== undefined) return this.width;
    return toMountOptions(this.host.settings()).maxWidth;
  }

  /**
   * RenderOptions for this frame (shared by mount and fresh renders). With
   * reflow the plan supplies an explicit layout width and the direction
   * rules; without it (setting off, `%% pele-reflow off %%`) the legacy
   * rules apply: `width=` pins the authored direction.
   */
  private renderOptions(idPrefix: string, withPlan = true) {
    const s = this.host.settings();
    const base = toMountOptions(s);
    const maxWidth = this.effectiveMaxWidth();
    const reflow = this.reflowOn();
    return {
      ...base,
      zoom: zoomOption(base.zoom, this.root),
      ...(!reflow && maxWidth !== undefined ? { maxWidth } : {}),
      // Legacy: a user-chosen size keeps the authored direction (e.g. `graph LR`).
      ...(!reflow && this.width !== undefined ? { autoDirection: false } : {}),
      ...(reflow && withPlan && this.plan ? this.plan.options : {}),
      idPrefix,
      ...(s.core.iconsEnabled
        ? { icons: makeIconResolver((n) => this.host.iconSvg(n)) }
        : {}),
      math: this.diagramMath.math,
      // Always parse through here: math placeholders are hydrated after the
      // (optional) sanitizer, as core does.
      sanitize: (svg: string) => this.diagramMath.sanitize(svg, s.core.security.sanitize ? sanitizeSvg : null),
    };
  }

  private mountOptions() {
    return {
      ...this.renderOptions(this.idPrefix),
      onRender: (r: RenderResult) => {
        this.currentSvg = r.svg;
        this.lastLinks = r.links;
        this.diagramType = r.type;
        this.diagramWidth = r.width;
        this.diagramHeight = r.height;
        markExternalLinks(this.mountEl);
        this.hideError();
        this.applyA11y();
        this.applyDisplay();
        this.applyFill(r);
        this.root.classList.toggle("no-hover-actions", this.wrapper.offsetWidth > 0 && this.wrapper.offsetWidth < 80);
        this.host.frameRendered?.(this);
      },
      onError: (e: unknown) => this.showError(e),
    };
  }

  /**
   * Accessible name via a hidden element (aria-labelledby), never an
   * aria-label: Obsidian shows aria-labels as hover tooltips, which left a
   * stale "flowchart diagram" bubble over every diagram.
   */
  private applyA11y(): void {
    this.root.removeAttribute("aria-label");
    if (this.lastLinks.length > 0) {
      // Interactive content inside: don't claim the frame is a single image.
      this.root.removeAttribute("role");
      this.root.removeAttribute("aria-labelledby");
      this.a11yLabel.textContent = "";
    } else {
      this.root.setAttribute("role", "img");
      this.a11yLabel.textContent = this.accTitle ?? `${this.diagramType ?? this.lang} diagram`;
      this.root.setAttribute("aria-labelledby", this.a11yLabel.id);
    }
  }

  private doMount(): void {
    // mount() reports invalid syntax via onError/.error (no throw initially);
    // guard try/catch for re-render paths that rethrow. Never propagate.
    this.root.classList.toggle("pele-legacy-size", !this.reflowOn());
    try {
      this.mounted = mount(this.mountEl, this.renderSource(), this.mountOptions());
      if (this.mounted.error) this.showError(this.mounted.error);
      else if (this.mounted.result) {
        this.currentSvg = this.mounted.result.svg;
        this.lastLinks = this.mounted.result.links;
        this.diagramType = this.mounted.result.type;
        this.diagramWidth = this.mounted.result.width;
        this.diagramHeight = this.mounted.result.height;
        this.applyA11y();
        this.applyDisplay();
        this.applyFill(this.mounted.result);
      }
    } catch (e) {
      this.showError(e);
    }
  }

  private showError(e: unknown): void {
    this.errorEl.textContent = formatError(e, {
      showSnippet: true,
    });
    this.errorEl.classList.remove(HIDDEN_CLASS);
    this.setRepairVisible(true);
  }

  private hideError(): void {
    this.errorEl.classList.add(HIDDEN_CLASS);
    this.errorEl.textContent = "";
    this.setRepairVisible(false);
  }

  /** Repair affordances only show on error frames, and only while Repair is on. */
  private setRepairVisible(v: boolean): void {
    const hidden = !(v && this.host.settings().features.repair.enabled);
    if (this.wrenchBtn) this.wrenchBtn.classList.toggle(HIDDEN_CLASS, hidden);
    if (this.errorRepairBtn) this.errorRepairBtn.classList.toggle(HIDDEN_CLASS, hidden);
  }

  get isRepairBusy(): boolean {
    return this.repairBusy;
  }

  setRepairBusy(busy: boolean): void {
    this.repairBusy = busy;
    if (this.errorRepairBtn) {
      this.errorRepairBtn.disabled = busy;
      this.errorRepairBtn.textContent = busy ? "Repairing…" : "Repair";
      this.errorRepairBtn.classList.toggle("is-loading", busy);
    }
    if (this.wrenchBtn) this.wrenchBtn.classList.toggle("is-loading", busy);
  }

  /** Whether "Copy link to this diagram" can write a block id here. */
  get canLinkBlock(): boolean {
    return !!this.opts.onEnsureBlockId && !this.root.closest(".internal-embed, .canvas-node");
  }

  ensureBlockId(): Promise<string | null> {
    return this.canLinkBlock ? this.opts.onEnsureBlockId!(this.source) : Promise.resolve(null);
  }

  get canApplyRepair(): boolean {
    return !!this.opts.onApplyRepaired;
  }

  applyRepaired(newSource: string): Promise<boolean> {
    return this.opts.onApplyRepaired
      ? this.opts.onApplyRepaired(newSource, this.source)
      : Promise.resolve(false);
  }

  /** Apply `newSource` when the block currently contains `expectedCurrent` (undo). */
  applyRepairSwap(newSource: string, expectedCurrent: string): Promise<boolean> {
    return this.opts.onApplyRepaired
      ? this.opts.onApplyRepaired(newSource, expectedCurrent)
      : Promise.resolve(false);
  }

  private applyWidthStyle(): void {
    const width = this.preview ? this.preview.width : this.width;
    this.wrapper.style.width = width !== undefined ? `${width}px` : "";
    this.wrapper.classList.add("pele-host-capped"); // max-width: 100% (styles.css)
    this.wrapper.classList.toggle("has-width", width !== undefined);
    const h = this.frameBoxHeight();
    this.wrapper.style.height = h !== null ? `${h}px` : "";
    this.wrapper.classList.toggle("has-height", h !== null);
  }

  /**
   * The only path that persists a frame size: a genuine drag on the corner,
   * a double-click on it, or "Reset size". Unchanged values are not written.
   */
  /** An absent key keeps that token as it is; null removes it. */
  private commitSize(edit: FenceSizeEdit): void {
    const nested = !!this.opts.nested;
    const w = edit.width === undefined ? this.width : (edit.width ?? undefined);
    const h = edit.height === undefined ? this.height : (edit.height ?? undefined);
    const z = nested ? undefined : edit.zoom === undefined ? this.zoom : normaliseZoom(edit.zoom);
    if (w === this.width && h === this.height && z === this.zoom) {
      this.applyWidthStyle();
      if (this.reflowOn()) this.relayout();
      return;
    }
    this.width = w;
    this.height = h;
    this.zoom = z;
    this.applyWidthStyle();
    // The drag preview fed the planner many widths: start the committed one fresh.
    this.planner?.reset();
    if (this.reflowOn()) this.relayout();
    else this.applySettings();
    this.opts.onPersistSize?.({
      width: w ?? null,
      ...(edit.height !== undefined ? { height: h ?? null } : {}),
      ...(edit.zoom !== undefined && !nested ? { zoom: z ?? null } : {}),
    });
  }

  /**
   * The size a corner drag asks for (frame-resize.ts): the box, following
   * the pointer on each axis (a height for top-level reflow frames); null
   * when the drag changes nothing.
   */
  private resolveCorner(start: FrameStart, dx: number, dy: number): FrameSize | null {
    const column = contentWidth(this.root) || this.root.parentElement?.clientWidth || 1600;
    const boxable = !!this.mounted && this.reflowOn() && !LEGACY_MAGNIFY && this.boxHeight() === null;
    return resolveFrameDrag(start, dx, dy, {
      min: this.opts.minWidth ?? 20,
      max: this.opts.maxWidth ?? column,
      minHeight: this.opts.minHeight ?? MIN_BOX_HEIGHT,
      maxHeight: this.opts.maxHeight ?? MAX_BOX_HEIGHT,
      boxable,
    });
  }

  private attachResize(corner: HTMLElement): void {
    corner.addEventListener("dblclick", (e) => {
      if (!isGenuineHandleClick(e, corner)) return;
      e.preventDefault();
      e.stopPropagation();
      this.commitSize({ width: null, height: null, zoom: null });
    });
    corner.addEventListener("pointerdown", (e) => {
      if (!isGenuineHandlePress(e, corner)) return;
      e.preventDefault();
      e.stopPropagation();
      // Inside a scaled container (a Mehrpele node) pointer px ≠ layout px.
      const scale = resizeScale(this.wrapper);
      // Start from the frame as shown: the corner sits on the box (a
      // `width=` box can be wider than the chart), at the chart's bottom.
      const shown = this.ownSvg()?.getBoundingClientRect();
      const boxH = this.frameBoxHeight();
      const start: FrameStart = {
        width: this.wrapper.offsetWidth || 1,
        height: boxH ?? (shown && shown.height > 0 ? shown.height / scale : this.wrapper.offsetHeight || 1),
        hasHeight: boxH !== null,
        // The fence's zoom (not the effective one: a narrow column may show it at 1×).
        legacyZoom: boxH === null && this.zoom !== undefined && !this.opts.nested && this.reflowOn(),
      };
      const before = { width: this.width, height: this.height, zoom: this.zoom };
      let next: FrameSize | null = null;
      let raf = 0;
      this.root.classList.add("is-resizing");
      this.wrapper.classList.add("is-sizing-box");
      trackHandleDrag(corner, e, {
        onMove: (dx, dy) => {
          next = this.resolveCorner(start, dx / scale, dy / scale);
          if (!raf) {
            raf = window.requestAnimationFrame(() => {
              raf = 0;
              // Live preview of the box and zoom (null: back to the start size).
              this.previewSize(next);
            });
          }
        },
        onEnd: (commit) => {
          if (raf) cancelAnimationFrame(raf);
          raf = 0;
          this.root.classList.remove("is-resizing");
          this.wrapper.classList.remove("is-sizing-box");
          this.preview = null;
          // Click, jitter, cancel, or the size it already had: restore, write nothing.
          if (!commit || !next || sameFrameSize(next, before)) {
            this.applyWidthStyle();
            this.planner?.reset();
            if (this.reflowOn()) this.relayout();
          } else if (next.keepZoom) this.commitSize({ width: next.width });
          else this.commitSize({ width: next.width, height: next.height ?? null, zoom: null });
        },
      });
    });
  }

  /** During a corner drag: show the dragged box and zoom (never persisted); null shows the start size. */
  private previewSize(size: FrameSize | null): void {
    this.preview = size;
    this.applyWidthStyle();
    if (this.reflowOn() && this.mounted) this.relayout();
  }

  private onWrapperClick = (ev: MouseEvent): void => {
    const target = ev.target as Element | null;
    const anchor = target?.closest?.("a");
    if (anchor) {
      const href = anchor.getAttribute("href");
      if (!href) return;
      // Always suppress the anchor's default navigation: refused links (blocked
      // schemes, command/write obsidian:// URIs) must not fall through to it.
      ev.preventDefault();
      ev.stopPropagation();
      this.activateLink(href, ev);
      return;
    }
    if (Platform.isMobile) {
      this.host.openLightbox(this);
    }
  };

  private onWrapperHover = (ev: MouseEvent): void => {
    const target = ev.target as Element | null;
    const anchor = target?.closest?.("a") as HTMLElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    const link = this.lastLinks.find((l) => l.href === href);
    if (link?.internal) this.host.hoverLink(ev, anchor, href, this);
  };

  private onContextMenu = (ev: MouseEvent): void => {
    ev.preventDefault();
    // A nested frame's menu replaces the enclosing diagram's, not both.
    if (this.opts.nested) ev.stopPropagation();
    this.host.contextMenu(this, ev);
  };
}

/** Client px per layout px of `el` (1 unless an ancestor is CSS-scaled). */
export function resizeScale(el: HTMLElement): number {
  const w = el.offsetWidth;
  const r = el.getBoundingClientRect().width;
  return w > 0 && r > 0 ? r / w : 1;
}


/** Obsidian's MathJax API for createDiagramMath (Mehrpele shares it). */
export function obsidianMathDeps(): MathJaxDeps {
  return {
    isLoaded: () => typeof (window as { MathJax?: { tex2chtml?: unknown } }).MathJax?.tex2chtml === "function",
    loadMathJax,
    renderMath,
    finishRenderMath,
  };
}

/** Font options of a plan base (for one-off renders). */
function cssFontsOrEmpty(base: { fontFamily?: string; fontFamilyMono?: string }): { fontFamily?: string; fontFamilyMono?: string } {
  return {
    ...(base.fontFamily ? { fontFamily: base.fontFamily } : {}),
    ...(base.fontFamilyMono ? { fontFamilyMono: base.fontFamilyMono } : {}),
  };
}
