/** The Mehrpele shell: a Mehrpele diagram mount with frame chrome, and its render child. */
import {
  Component, MarkdownRenderChild, Notice,
  Platform
} from "obsidian";
import { obsidianMathDeps, PELE_THEME_VARS, resizeScale } from "../diagram-frame";
import { createDiagramMath, type DiagramMath } from "../math-resolver";
import { NodeHandleLayer } from "../node-handles";
import { PELE_HOST_CLASS } from "../core-look";
import { flattenSvg } from "../svg-markup";
import { noticeWithUndo } from "../size-undo";
import { isGenuineHandleClick, isGenuineHandlePress, trackHandleDrag } from "../drag-move";
import {
  mountMehrpele, validateMehrpele, type MehrpeleHost,
  type MehrpeleMounted, type NestedOrigin
} from "./index";
import { formatError } from "../format-error";
import { normaliseZoom, type FenceSize, type FenceSizeEdit } from "../info-width";
import { effectiveZoom, MAX_BOX_HEIGHT, MIN_BOX_HEIGHT, resolveFrameDrag, sameFrameSize, type FrameSize, type FrameStart } from "../frame-resize";
import { parseReflowDirective } from "pele-render/reflow";
import { ColumnWatcher, contentWidth, flipRemaining, layoutWidthFor, LEGACY_MAGNIFY, REFLOW_ANIMATE, reflowPolicy } from "../reflow-frame";

/** Hides shell chrome (`display: none`, styles.css) until removed. */
const HIDDEN_CLASS = "pele-hidden";
import { mehrpeleOptions } from "./settings";
import type { MehrpeleReflow } from "./labels";
import {
  validateSource
} from "pele-render/repair";
import { extractAccTitle } from "../render-policy";
import {
  toMountOptions
} from "../settings";
import { buildActionBar } from "../action-bar";
import type { FrameCompanion, FrameSurface } from "../api/frame-handles";
import type PeleMermaidPlugin from "../../main";

export interface MehrpeleShellOpts {
  source: string;
  lang: string;
  sourcePath: string;
  width?: number;
  /** Fence `height=H` (the box height of a corner-dragged frame). */
  height?: number;
  onRevealCode: () => void;
  /** Fence `zoom=Z` (legacy display zoom from an earlier corner drag). */
  zoom?: number;
  /** Persist the fence size (null removes a token, an absent key keeps it); nested shells never set a zoom. */
  onPersistSize?: (edit: FenceSizeEdit) => void;
  onApplyRepaired?: (newSource: string, expected: string) => Promise<boolean>;
  onEnsureBlockId?: (source: string) => Promise<string | null>;
  /**
   * Rendered inside another diagram's node (a nested diagram): its nesting
   * level and the resize-corner bounds given by the enclosing node.
   */
  nested?: { depth: number; minWidth: number; maxWidth: number; minHeight?: number; maxHeight?: number };
  /** Processor-rendered inside a Mehrpele label: nesting level only. */
  depth?: number;
  /**
   * A nested shell edited its own source (a node resized inside it): the
   * enclosing label writes it back. Without it edits stay in memory.
   */
  onSourceChange?: (next: string) => void;
  /** Nested shells: where this diagram's source lives (inline children inherit it). */
  origin?: NestedOrigin;
  /** Nested shells from an inline fence: reveal the outermost block. */
  revealOrigin?: () => void;
  /** 0-based opening-fence line of this block in sourcePath (top-level blocks). */
  fenceLine?: number;
  /** A top-level fence: its companion frame-handle key and info-string rest (api `frames`). */
  companion?: FrameCompanion;
}

/** The subset of Obsidian's internal canvas view API used to zoom to a node. */
export interface CanvasViewApi {
  nodes?: Map<string, { id: string }>;
  selection?: Set<{ id: string }>;
  selectOnly?(node: unknown): void;
  zoomToSelection?(): void;
}

import { isReadOnlyFrameRoot, inMehrpeleLabel } from "../mehrpele-dom";

export { mehrpeleNesting, isReadOnlyFrameRoot, inMehrpeleLabel } from "../mehrpele-dom";

/**
 * DiagramFrame-shaped shell for Mehrpele mounts: same native image-embed
 * chrome (zoom/code/wrench, resize corner, error pane, context menu), with
 * mountMehrpele owning the diagram + HTML overlay inside .pele-host.
 */
export class MehrpeleShell {
  source: string;
  readonly lang: string;
  readonly sourcePath: string;
  width: number | undefined;
  /** Box height (fence `height=`); undefined = the chart's own height. */
  height: number | undefined;
  /** Legacy display zoom (fence `zoom=`); undefined = none. */
  zoom: number | undefined;
  readonly accTitle: string | null;
  root: HTMLElement;
  private wrapper: HTMLElement;
  private mountEl: HTMLElement;
  private errorEl: HTMLPreElement;
  private wrenchBtn!: HTMLElement;
  /** The `.embed-actions` bar (the same element when float-actions moves it to the body). */
  actionBar!: HTMLElement;
  private surface: FrameSurface | null | undefined;
  /** Diagram type of the last render (the first lands before `mounted` is set). */
  private renderedType: string | null = null;
  private errorRepairBtn!: HTMLButtonElement;
  private plugin: PeleMermaidPlugin;
  private component: Component;
  private opts: MehrpeleShellOpts;
  private mounted: MehrpeleMounted | null = null;
  private destroyed = false;
  private repairBusy = false;
  private sourcePanel: HTMLPreElement | null = null;
  /**
   * Parent of this shell's rendered label components (MarkdownRenderer
   * children). Owned by the shell so they die with it, not with the plugin.
   */
  private labels = new Component();
  /** `$…$` labels via Obsidian's MathJax; per shell so its cache follows this diagram. */
  private readonly diagramMath: DiagramMath = createDiagramMath({
    deps: obsidianMathDeps(),
    links: () => this.plugin.settings.core.security.allowLinks,
    rerender: () => {
      if (!this.destroyed) this.refresh();
    },
  });
  private columnObs: ResizeObserver | null = null;
  private watcher: ColumnWatcher | null = null;
  /** Corner drag in progress: the size being previewed (live re-layout, never persisted). */
  private preview: FrameSize | null = null;
  private nodeHandles: NodeHandleLayer | null = null;
  /** A size write is in flight (handles disabled until it settles). */
  private persisting = false;
  /** pele-edit: disposer of the edit toolbar layer. */
  private disposeEdit: (() => void) | null = null;

  constructor(plugin: PeleMermaidPlugin, component: Component, opts: MehrpeleShellOpts) {
    this.plugin = plugin;
    this.component = component;
    this.opts = opts;
    this.source = opts.source;
    this.lang = opts.lang;
    this.sourcePath = opts.sourcePath;
    this.width = opts.width;
    this.height = opts.height;
    this.zoom = opts.nested ? undefined : normaliseZoom(opts.zoom);
    this.accTitle = extractAccTitle(opts.source);

    this.root = createDiv();
    this.root.className = opts.nested ? "image-embed pele-embed pele-nested" : "image-embed pele-embed";
    this.root.tabIndex = -1;
    this.wrapper = createDiv();
    this.wrapper.className = PELE_HOST_CLASS;
    this.mountEl = createDiv();
    this.mountEl.className = "pele-mount";
    this.wrapper.appendChild(this.mountEl);
    this.root.appendChild(this.wrapper);
    this.errorEl = createEl("pre");
    this.errorEl.className = `pele-error ${HIDDEN_CLASS}`;
    this.root.appendChild(this.errorEl);
    const errorActions = createDiv();
    errorActions.className = "pele-error-actions pele-repair-slot";
    this.errorRepairBtn = createEl("button");
    this.errorRepairBtn.className = `pele-repair-button ${HIDDEN_CLASS}`;
    this.errorRepairBtn.textContent = "Repair";
    this.errorRepairBtn.addEventListener("click", () => void this.plugin.repairShell(this));
    errorActions.appendChild(this.errorRepairBtn);
    this.root.appendChild(errorActions);

    if (!Platform.isMobile) {
      const corner = createDiv();
      corner.className = "image-resize-corner";
      this.wrapper.appendChild(corner);
      this.attachResize(corner);
      this.nodeHandles = new NodeHandleLayer({
        wrapper: this.wrapper,
        svg: () => this.mounted?.svg() ?? null,
        source: () => this.source,
        enabled: () => this.plugin.settings.features.resize.enabled && !this.destroyed && !this.persisting,
        fontSize: () => toMountOptions(this.plugin.settings).fontSize ?? 16,
        persist: (next) => void this.persistSource(next),
      });
    }
    const { bar, wrench } = buildActionBar({
      zoom: () => this.plugin.openMehrpeleLightbox(this),
      revealCode: () => this.revealCode(),
      source: () => this.source,
      svg: () => this.flattenedSvg(),
      repair: () => void this.plugin.repairShell(this),
    });
    wrench.classList.add(HIDDEN_CLASS);
    this.wrenchBtn = wrench;
    this.actionBar = bar;
    this.root.appendChild(bar);
    this.root.addEventListener("contextmenu", this.onContextMenu);
    this.mountEl.addEventListener("mouseover", this.onOverlayHover);
    // Capture: Pele's SVG anchors are handled before the overlay's listener.
    this.mountEl.addEventListener("click", this.onSvgLinkClick, true);
    // pele-edit: toolbar + inline editor; edits go through persistSource.
    this.disposeEdit = this.plugin.attachEdit({
      root: this.root,
      wrapper: this.wrapper,
      lang: this.lang,
      sourcePath: this.sourcePath,
      svg: () => this.mounted?.svg() ?? null,
      source: () => this.source,
      diagramType: () => this.result()?.type ?? null,
      direction: () => this.mounted?.plan()?.direction ?? null,
      writable: () =>
        !!this.opts.onSourceChange || (!!this.opts.onApplyRepaired && !isReadOnlyFrameRoot(this.root) && !this.root.closest(".canvas-node")),
      persist: (next, what) => this.persistSource(next, what),
    });
    this.applyWidthStyle();
  }

  private onSvgLinkClick = (ev: MouseEvent): void => {
    this.plugin.routeMehrSvgLink(ev, this.sourcePath, this.result()?.links, this.root);
  };

  load(): void {
    this.plugin.registerMehr(this);
    this.component.addChild(this.labels);
    void mountMehrpele(this.mountEl, this.source, this.mehrHost())
      .then((m) => {
        if (this.destroyed) {
          m.destroy();
          return;
        }
        this.mounted = m;
        this.checkError();
        this.watchColumn();
        // Laid out after the first render (a section inserted later): re-plan once.
        if (this.reflowOn && this.columnWidth() > 0) m.relayout();
      })
      .catch(() => this.checkError());
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.columnObs?.disconnect();
    this.columnObs = null;
    this.watcher?.disconnect();
    this.watcher = null;
    this.nodeHandles?.destroy();
    this.nodeHandles = null;
    this.disposeEdit?.(); // pele-edit
    this.disposeEdit = null;
    this.plugin.unregisterMehr(this);
    try {
      this.mounted?.destroy();
    } catch {
      /* already gone */
    }
    this.mounted = null;
    try {
      this.component.removeChild(this.labels);
    } catch {
      this.labels.unload();
    }
    this.root.removeEventListener("contextmenu", this.onContextMenu);
    this.mountEl.removeEventListener("mouseover", this.onOverlayHover);
    this.mountEl.removeEventListener("click", this.onSvgLinkClick, true);
  }

  private onOverlayHover = (ev: MouseEvent): void => {
    const anchor = (ev.target as Element | null)?.closest?.("a") as HTMLElement | null;
    if (!anchor || !anchor.classList.contains("internal-link")) return;
    // A nested diagram's own shell/frame handles its links.
    const nested = anchor.closest(".pele-nested");
    if (nested && nested !== this.root && this.root.contains(nested)) return;
    const href = anchor.getAttribute("href");
    if (href) this.plugin.hoverMehrLink(ev, anchor, href, this);
  };

  update(source: string): void {
    this.source = source;
    void this.mounted?.update(source).then(() => this.checkError());
    this.checkError();
  }

  refresh(): void {
    // Settings may have switched reflow on or off: swap the column watcher.
    this.applyWidthStyle();
    if (this.mounted && !this.opts.nested && this.reflowOn !== !!this.watcher) {
      this.columnObs?.disconnect();
      this.columnObs = null;
      this.watcher?.disconnect();
      this.watcher = null;
      this.watchColumn();
    }
    this.mounted?.refresh();
  }

  result() {
    return this.mounted?.result() ?? null;
  }

  /** This shell as a companion frame-handle surface; null without companion info. */
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
          // The first render lands before mountMehrpele resolves: read the DOM.
          svg: () => this.mounted?.svg() ?? this.mountEl.querySelector("svg"),
          diagramType: () => this.result()?.type ?? this.renderedType,
          source: () => this.source,
          rerender: () => {
            if (!this.destroyed) this.mounted?.refresh();
          },
          // The mount plays its FLIP on this element.
          settleMs: () => flipRemaining(this.mountEl),
        }
      : null;
    return this.surface;
  }

  /** Export markup: math as TeX text, theme vars inlined (see flattenSvg). */
  flattenedSvg(): string {
    return flattenSvg(this.result()?.svg ?? "", this.wrapper, PELE_THEME_VARS, this.plugin.settings.core.security.sanitize);
  }

  revealCode(): void {
    this.opts.onRevealCode();
  }

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

  /** A fence size (width, height or zoom) to reset. */
  get hasWidth(): boolean {
    return this.width !== undefined || this.height !== undefined || this.zoom !== undefined;
  }

  resetSize(): void {
    this.commitSize({ width: null, height: null, zoom: null });
  }

  /** Apply a size re-read from the fence (widget reuse, fence edits). Never persists. */
  applyFenceSize(size: FenceSize): void {
    const z = this.opts.nested ? undefined : normaliseZoom(size.zoom);
    const h = size.height;
    if (size.width === this.width && h === this.height && z === this.zoom) {
      if (this.reflowOn) this.mounted?.relayout();
      else this.mounted?.refresh();
      return;
    }
    this.width = size.width;
    this.height = h;
    this.zoom = z;
    this.applyWidthStyle();
    if (this.reflowOn) this.mounted?.relayout();
    else this.mounted?.refresh();
  }

  /** Responsive reflow applies (setting on, block not `%% pele-reflow off %%`). */
  get reflowOn(): boolean {
    return this.plugin.settings.features.reflow.enabled && !parseReflowDirective(this.source).off;
  }

  /** Reflow for this shell's mount: layout width, policy, legacy magnify. */
  private reflowInfo(): MehrpeleReflow | null {
    if (!this.reflowOn) return null;
    const s = this.plugin.settings.features.reflow;
    const L = this.layoutWidth() ?? 0;
    const magnify = LEGACY_MAGNIFY && this.width !== undefined && !this.opts.nested;
    const zoom = this.zoomFactor();
    const boxH = this.frameBoxHeight();
    return {
      layoutWidth: L,
      ...(boxH !== null && L > 0 ? { frameBox: { width: L, height: boxH } } : {}),
      policy: reflowPolicy(s),
      animate: REFLOW_ANIMATE,
      ...(magnify ? { magnifyTo: Math.min(this.width!, this.columnWidth() || this.width!) } : {}),
      ...(zoom > 1 ? { zoom } : {}),
      ...(zoom > 1 && !this.preview && this.zoom !== undefined && zoom >= this.zoom ? { fresh: true } : {}),
    };
  }

  /** The box height (fence `height=` or the drag preview's) where a box applies: reflow on, top level, no legacy magnify. */
  private frameBoxHeight(): number | null {
    const h = this.preview && !this.preview.keepZoom ? this.preview.height : this.height;
    if (h === undefined || !(h > 0) || !this.reflowOn || LEGACY_MAGNIFY) return null;
    return h;
  }

  /** Legacy zoom in effect (fence `zoom=`): reflow on, top level, no legacy magnify, no box height. */
  private zoomFactor(): number {
    if (this.frameBoxHeight() !== null) return 1;
    const z = this.preview && !this.preview.keepZoom ? undefined : this.zoom;
    if (z === undefined || !(z > 1) || this.opts.nested || !this.reflowOn || LEGACY_MAGNIFY) return 1;
    return effectiveZoom(z, this.preview ? this.preview.width : this.width, this.columnWidth());
  }

  get isRepairBusy(): boolean {
    return this.repairBusy;
  }
  setRepairBusy(busy: boolean): void {
    this.repairBusy = busy;
    this.errorRepairBtn.disabled = busy;
    this.errorRepairBtn.textContent = busy ? "Repairing…" : "Repair";
  }
  get canApplyRepair(): boolean {
    return !!this.opts.onApplyRepaired;
  }
  applyRepaired(newSource: string): Promise<boolean> {
    return this.opts.onApplyRepaired
      ? this.opts.onApplyRepaired(newSource, this.source).then((ok) => {
          if (ok) this.update(newSource);
          return ok;
        })
      : Promise.resolve(false);
  }
  /** Whether "Copy link to this diagram" can write a block id here. */
  get canLinkBlock(): boolean {
    return !!this.opts.onEnsureBlockId && !this.root.closest(".internal-embed, .canvas-node");
  }
  ensureBlockId(): Promise<string | null> {
    return this.canLinkBlock ? this.opts.onEnsureBlockId!(this.source) : Promise.resolve(null);
  }

  /**
   * Width Pele lays the diagram out for. Always explicit: without it Pele's
   * mount uses its container's width, and the container here is the
   * shrink-wrapped wrapper — as wide as the previous render, so a label that
   * grows in place (an image loading, a nested diagram resized, a code
   * panel) would squeeze the layout and flip `LR` to top-down for good.
   * Fence width, else the node's bound (nested), else the note column.
   */
  private layoutWidth(): number | undefined {
    if (this.reflowOn) {
      const width = this.preview ? this.preview.width : this.width;
      if (this.frameBoxHeight() !== null) {
        // A W×H box: the box width (column-capped); planFill picks the layout.
        const box = layoutWidthFor(this.columnWidth(), {
          ...(width !== undefined ? { width } : {}),
          ...(this.opts.nested ? { nestedMax: this.opts.nested.maxWidth } : {}),
        });
        return box > 0 ? box : undefined;
      }
      const settingsMax = toMountOptions(this.plugin.settings).maxWidth;
      const z = this.zoomFactor();
      if (z > 1) {
        // A zoomed diagram lays out for box / zoom (the zoom then fills the
        // box); Max width caps the layout after that division.
        const box = layoutWidthFor(this.columnWidth(), width !== undefined ? { width } : {});
        if (!(box > 0)) return undefined;
        const Lz = Math.floor(box / z);
        return settingsMax !== undefined && settingsMax > 0 ? Math.min(Lz, Math.floor(settingsMax)) : Lz;
      }
      const L = layoutWidthFor(this.columnWidth(), {
        ...(width !== undefined ? { width } : {}),
        ...(settingsMax !== undefined ? { settingsMax } : {}),
        ...(this.opts.nested ? { nestedMax: this.opts.nested.maxWidth } : {}),
      });
      return L > 0 ? L : undefined;
    }
    if (this.width !== undefined) return this.width;
    if (this.opts.nested) return this.opts.nested.maxWidth;
    const settingsMax = toMountOptions(this.plugin.settings).maxWidth;
    const column = this.columnWidth();
    if (column > 0) return settingsMax !== undefined ? Math.min(settingsMax, column) : column;
    return settingsMax;
  }

  /** Content width of the frame (the note column); 0 when not laid out. */
  private columnWidth(): number {
    return contentWidth(this.root);
  }

  /** Re-layout when the note column changes width (layoutWidth is explicit). */
  private watchColumn(): void {
    if (this.opts.nested || typeof ResizeObserver === "undefined") return;
    if (this.reflowOn) {
      // Same labels and reservations: a relayout never re-renders Markdown.
      this.watcher = new ColumnWatcher(this.root, () => {
        if (!this.destroyed) this.mounted?.relayout();
      });
      return;
    }
    let last = this.columnWidth();
    let timer: number | null = null;
    this.columnObs = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const now = this.columnWidth();
        if (this.destroyed || this.width !== undefined || now <= 0 || Math.abs(now - last) < 8) return;
        last = now;
        this.mounted?.refresh();
      }, 250);
    });
    this.columnObs.observe(this.root);
  }

  /** Diagram nesting level (0 = a block in a note). */
  get depth(): number {
    return this.opts.nested?.depth ?? this.opts.depth ?? 0;
  }

  private mehrHost(): MehrpeleHost {
    const plugin = this.plugin;
    return {
      app: this.plugin.app,
      component: this.labels,
      sourcePath: this.sourcePath,
      // Read per use: a settings change applies without a remount.
      get settings() {
        return mehrpeleOptions(plugin.settings);
      },
      renderOptions: () => this.plugin.mehrRenderOptions(this.layoutWidth(), !this.reflowOn && this.width !== undefined, this.diagramMath),
      reflow: () => this.reflowInfo(),
      heightChanged: (el) => this.plugin.remeasureSection(el),
      onLink: (href: string, evt: MouseEvent) =>
        this.plugin.internalLink(href, this.sourcePath, evt),
      depth: this.depth,
      renderNestedDiagram: (el, spec, component) => this.plugin.renderNestedDiagram(el, spec, component),
      persistSource: (next) => this.persistSource(next),
      onRender: (type) => {
        this.renderedType = type;
        this.plugin.mehrRendered(this);
      },
      onLayout: () => this.plugin.mehrRendered(this),
      ...this.originHost(),
    };
  }

  /** Origin plumbing for nested children (shared with the lightbox mount). */
  originHost(): Pick<MehrpeleHost, "origin" | "revealBlock" | "blockLine" | "attachOrigin"> {
    return {
      ...(this.opts.origin ? { origin: this.opts.origin } : {}),
      revealBlock: this.opts.revealOrigin ?? (() => this.revealCode()),
      ...(this.opts.fenceLine !== undefined ? { blockLine: this.opts.fenceLine } : {}),
      attachOrigin: (el, origin, component) => {
        component.register(this.plugin.attachOpenOriginal(el, origin));
      },
    };
  }

  /**
   * A node inside this diagram was resized (its label source rewritten).
   * Nested shells hand the edit to the enclosing label; top-level blocks
   * write it into the note (one undoable edit) when they can; everything
   * else (embeds of other notes, Canvas, labels) re-renders without saving.
   */
  private async persistSource(next: string, what = "size"): Promise<boolean> {
    if (this.destroyed || this.persisting || next === this.source) return false;
    if (this.opts.onSourceChange) {
      this.opts.onSourceChange(next);
      return true;
    }
    const previous = this.source;
    // Canvas cards hold their source in JSON: sizes stay in memory there.
    if (this.opts.onApplyRepaired && !isReadOnlyFrameRoot(this.root) && !this.root.closest(".canvas-node")) {
      // Decide before writing: a Live Preview write replaces (detaches) this widget.
      const inEditor = !!this.root.closest(".cm-editor");
      // One write at a time (see DiagramFrame.persistSource).
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
      // Reading view writes the file directly: offer the undo the editor would (the same stack as Mod+Z).
      if (!inEditor) noticeWithUndo(`Pele: ${what} saved.`, this.plugin.diagramUndo.undoLatest(this.sourcePath) ?? (() => this.opts.onApplyRepaired?.(previous, next)));
    }
    if (this.destroyed) return true;
    this.update(next);
    return true;
  }

  /** Id of the sizable node under `target` (context menu), if any. */
  nodeIdAt(target: EventTarget | null): string | null {
    return this.nodeHandles?.nodeAt(target)?.id ?? null;
  }

  /** Box-handle edits from the context menu (reset one / all node sizes). */
  editNodeSizes(edit: (source: string) => string): void {
    const next = edit(this.source);
    if (next !== this.source) void this.persistSource(next);
  }

  private checkError(): void {
    // Validate what Pele renders: label Markdown (nested fences, `\"`) is
    // never diagram syntax.
    const check = validateMehrpele(this.source, (s) => validateSource(s));
    if (!check.ok) {
      this.errorEl.textContent = formatError(check.error, {
        showSnippet: true,
      });
    }
    this.errorEl.classList.toggle(HIDDEN_CLASS, check.ok);
    this.wrenchBtn.classList.toggle(HIDDEN_CLASS, check.ok);
    this.errorRepairBtn.classList.toggle(HIDDEN_CLASS, check.ok);
  }

  private applyWidthStyle(): void {
    const width = this.preview ? this.preview.width : this.width;
    this.wrapper.style.width = width !== undefined ? `${width}px` : "";
    this.wrapper.classList.add("pele-host-capped"); // max-width: 100% (styles.css)
    this.wrapper.classList.toggle("has-width", width !== undefined);
    const h = this.frameBoxHeight();
    this.wrapper.style.height = h !== null ? `${h}px` : "";
    this.wrapper.classList.toggle("has-height", h !== null);
    this.root.classList.toggle("pele-legacy-size", !this.reflowOn);
  }

  /**
   * The only path that persists a shell size: a genuine drag on the corner,
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
      if (this.reflowOn) this.mounted?.relayout();
      return;
    }
    this.width = w;
    this.height = h;
    this.zoom = z;
    this.applyWidthStyle();
    if (this.reflowOn) this.mounted?.relayout();
    else this.mounted?.refresh();
    this.opts.onPersistSize?.({
      width: w ?? null,
      ...(edit.height !== undefined ? { height: h ?? null } : {}),
      ...(edit.zoom !== undefined && !nested ? { zoom: z ?? null } : {}),
    });
  }

  /** The size a corner drag asks for: the box, following the pointer on each axis (see frame-resize.ts). */
  private resolveCorner(start: FrameStart, dx: number, dy: number): FrameSize | null {
    const column = this.columnWidth() || this.root.parentElement?.clientWidth || 1600;
    const boxable = !!this.mounted && this.reflowOn && !LEGACY_MAGNIFY;
    return resolveFrameDrag(start, dx, dy, {
      min: this.opts.nested?.minWidth ?? 20,
      max: this.opts.nested?.maxWidth ?? column,
      minHeight: this.opts.nested?.minHeight ?? MIN_BOX_HEIGHT,
      maxHeight: this.opts.nested?.maxHeight ?? MAX_BOX_HEIGHT,
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
      // A nested shell's drag must not also start the enclosing node's.
      e.stopPropagation();
      // Inside a scaled container (a Mehrpele node) pointer px ≠ layout px.
      const scale = resizeScale(this.wrapper);
      // The corner sits on the box (a `width=` box can be wider than the chart), at the chart's bottom.
      const shown = this.mounted?.svg()?.getBoundingClientRect();
      const boxH = this.frameBoxHeight();
      const start: FrameStart = {
        width: this.wrapper.offsetWidth || 1,
        height: boxH ?? (shown && shown.height > 0 ? shown.height / scale : this.wrapper.offsetHeight || 1),
        hasHeight: boxH !== null,
        // The fence's zoom (not the effective one: a narrow column may show it at 1×).
        legacyZoom: boxH === null && this.zoom !== undefined && !this.opts.nested && this.reflowOn,
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
              // Live re-layout for the dragged size (never persisted; reservations
              // reused); null: back to the start size.
              this.preview = next;
              this.applyWidthStyle();
              if (this.reflowOn) this.mounted?.relayout();
            });
          }
        },
        onEnd: (commit) => {
          if (raf) cancelAnimationFrame(raf);
          raf = 0;
          this.preview = null;
          this.root.classList.remove("is-resizing");
          this.wrapper.classList.remove("is-sizing-box");
          // The drag fed the planner many widths and probes: start fresh.
          this.mounted?.endDrag();
          // Click, jitter, cancel, or the size it already had: restore, write nothing.
          if (!commit || !next || sameFrameSize(next, before)) {
            this.applyWidthStyle();
            if (this.reflowOn) this.mounted?.relayout();
          } else if (next.keepZoom) this.commitSize({ width: next.width });
          else this.commitSize({ width: next.width, height: next.height ?? null, zoom: null });
        },
      });
    });
  }

  private onContextMenu = (ev: MouseEvent): void => {
    ev.preventDefault();
    // A nested shell's menu replaces the enclosing diagram's, not both.
    if (this.opts.nested) ev.stopPropagation();
    this.plugin.showMehrpeleMenu(this, ev);
  };
}

export class MehrpeleChild extends MarkdownRenderChild {
  private shell: MehrpeleShell;

  constructor(
    containerEl: HTMLElement,
    plugin: PeleMermaidPlugin,
    source: string,
    sourcePath: string,
    lang: string,
    fenceLine: number | undefined,
    size: FenceSize,
    depth = 0,
    companion?: FrameCompanion,
  ) {
    super(containerEl);
    this.shell = new MehrpeleShell(plugin, this, {
      source,
      lang,
      sourcePath,
      ...size,
      depth,
      ...(fenceLine !== undefined ? { fenceLine } : {}),
      ...(companion ? { companion } : {}),
      onRevealCode: () => {
        const inLp = !!this.shell.root.closest(".cm-preview-code-block");
        if (inLp && fenceLine !== undefined && plugin.revealInEditor(sourcePath, fenceLine)) return;
        this.shell.toggleSourcePanel();
      },
      onPersistSize:
        fenceLine === undefined
          ? undefined
          : (edit) => {
              if (isReadOnlyFrameRoot(this.shell.root)) return; // live-only in embeds/labels
              plugin.persistSizeInFile(sourcePath, fenceLine, edit, source, this.shell.root);
            },
      onApplyRepaired:
        fenceLine === undefined
          ? undefined
          : (newSource, expected) =>
              inMehrpeleLabel(this.shell.root)
                ? Promise.resolve(false)
                : plugin.applyChildRepair(sourcePath, fenceLine, expected, newSource, this.shell.root),
      onEnsureBlockId:
        fenceLine === undefined
          ? undefined
          : (src) =>
              inMehrpeleLabel(this.shell.root)
                ? Promise.resolve(null)
                : plugin.ensureChildBlockId(sourcePath, fenceLine, src, this.shell.root),
    });
    containerEl.appendChild(this.shell.root);
  }

  onload(): void {
    this.shell.load();
  }

  onunload(): void {
    this.shell.destroy();
  }
}
