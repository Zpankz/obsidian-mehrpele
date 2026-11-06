import {
  Component, ItemView,
  Keymap, MarkdownRenderChild, MarkdownView, Notice, Plugin, requireApiVersion, setIcon,
  setTooltip, TFile, type MarkdownPostProcessorContext,
  type WorkspaceLeaf
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import { forgetTextWidths, mount, render } from "pele-render/pele";
import { asButton } from "./src/a11y";
import { closeContextMenu } from "./src/context-menu";
import { DiagramFrame, obsidianMathDeps } from "./src/diagram-frame";
import { createDiagramMath, type DiagramMath } from "./src/math-resolver";
import { LiveRegistry } from "./src/live-registry";
import { sharedChild } from "./src/shared-child";
import { hasCorePele } from "./src/core-pele";
import { pruneNoteSizes } from "./src/node-size";
import { DiagramUndo } from "./src/diagram-undo";
import { isolateHistory } from "@codemirror/commands";
import { makeIconResolver } from "./src/icons";
import { nextIdPrefix } from "./src/id-prefix";
import type { IntegrationHost } from "./src/integrations/host";
import type {
  MehrpeleBasesDeps,
  MehrpeleDiagramView,
  MehrpeleMounted,
  NestedDiagramHandle,
  NestedDiagramSpec,
  NestedOrigin,
  OriginPane,
} from "./src/mehrpele/index";
import { sanitizedSvgMarkup, sanitizeSvg } from "./src/sanitize-svg";
import { locateBlockForPersist } from "./src/fence-locate";
import { unwrapMermaidGuard } from "./src/mermaid-guard";
import { fenceLineAt, fenceRestOf, parseFenceSize, serializeFenceSize, type FenceSize, type FenceSizeEdit } from "./src/info-width";
import { PeleLightbox } from "./src/lightbox";
import { reflowPolicy } from "./src/reflow-frame";
import {
  validateSource, type LlmProvider
} from "pele-render/repair";
import { replaceBlockBody } from "./src/replace-block";
import { createDocumentGuard, guardAnchorClick } from "./src/link-guard";
import { isSvgAnchor, routeDiagramLink } from "./src/link-classify";
import { LpTakeover } from "./src/lp-patch";
import { toMountOptions } from "./src/settings";
import { defaultSettingsV3, type SettingsV3 } from "./src/settings/schema";
import { mehrpeleOptions } from "./src/mehrpele/settings";
import { integrationOptions } from "./src/integrations/settings";
import { repairOptions } from "./src/repair-settings";
import type { EditableFrame } from "./src/edit"; // pele-edit
import { DIAGRAM_VIEW, DiagramView } from "./src/diagram-view"; // pele-edit: zoom Mod-click
import { registerBeforeCore } from "./src/processor-order";
import { showMehrpeleMenu, showFrameMenu } from "./src/frame-menus";
import { buildLpWidgetDOM, applyLpFenceWidths, handleLpWidgetReuse, refreshLpFenceModes, ensureChildBlockId, copyDiagramLink } from "./src/lp/widget";
import { focusDiagramActions } from "./src/lp/focus-actions";
import { dispatchBlockReplace, frameHostOf } from "./src/frame-host";
import type { CanvasViewApi, MehrpeleShell } from "./src/mehrpele/shell";
import { mehrpeleNesting } from "./src/mehrpele-dom";
import { hasMehrpeleDirective, isMehrpeleSource } from "./src/mehrpele-source";
import type { CanvasData } from "pele-render/canvas";
import type { ExcalidrawApi } from "./src/excalidraw/converter";
import { IntegrationFrameChild, PeleDiagramChild } from "./src/diagram-child";
// region features
import { FeatureRegistry } from "./src/features/registry";
import { registerIntegrationBlocks } from "./src/features/integration-blocks";
import { isEnabled } from "./src/features/enabled";
import * as lazy from "./src/features/lazy";
import { LazySettingTab } from "./src/features/settings-tab";
import { AddonHints } from "./src/api/hints";
import { detectFlows, FLOWS, type FlowStatus, type PluginManagerLike } from "./src/features/companions";
// endregion features
import { type RefreshMode, rebuildQueue, refreshLeaves } from "./src/refresh-leaves";
import { RefreshCoalescer, SuspendedFrames } from "./src/frame-lifecycle";
import { PLUGIN_ID, setPluginId } from "./src/plugin-id";
import { loadSettings } from "./src/settings/load";
import { HandleRegistry, type FenceLocation, type FrameCompanion } from "./src/api/frame-handles";
import { CompanionActions } from "./src/api/frame-actions";
import { CompanionMenus } from "./src/api/menu-items";
import { createHostApi, type CanvasConverters, type HostApi } from "./src/api/host-api";
import { mountPeleSource } from "./src/api/pele-source";
import type { FrameProvenance, MehrpeleApiV1 } from "mehrpele-api";

export default class PeleMermaidPlugin extends Plugin {
  settings: SettingsV3 = defaultSettingsV3();
  /** Mod+Z / Mod+Shift+Z for diagram edits; Reading-view edits are recorded here. */
  readonly diagramUndo = new DiagramUndo(this, this.app);
  /** Model names fetched from a local Ollama instance (settings UI). */
  ollamaModels: string[] = [];
  frames = new LiveRegistry<DiagramFrame>();
  /** Frames keyed by their widget container DOM (CM may destroy a different widget instance than it created). */
  framesByDom = new WeakMap<HTMLElement, DiagramFrame>();
  mehrShells = new LiveRegistry<MehrpeleShell>();
  /** Open Mehrpele Bases views: the Bases toggle refreshes them. */
  private basesViews = new LiveRegistry<MehrpeleDiagramView>();
  mehrByDom = new WeakMap<HTMLElement, MehrpeleShell>();
  /** Live Preview canvas embeds by widget container DOM, with the body and rest they were built from. */
  canvasEmbedsByDom = new WeakMap<HTMLElement, { code: string; rest: string; destroy(): void }>();
  /** Live Preview frames whose widget left the document: destroyed unless revived within a second. */
  readonly suspended = new SuspendedFrames<DiagramFrame>();
  /** css-change bursts: one refresh per shown frame per frame tick; hidden frames refresh when shown. */
  private readonly cssRefresh = new RefreshCoalescer<DiagramFrame | MehrpeleShell>({
    targets: () => [...this.frames, ...this.mehrShells],
  });
  /** Feature modules loaded for the toggles that are on. */
  features: FeatureRegistry | null = null;
  // region companion api
  /** Companion action-bar buttons (api `addFrameAction`). */
  readonly companionActions: CompanionActions = new CompanionActions(() => this.frameHandles.refreshAllActions());
  /** Companion frame handles, one per top-level fence (api `frames`). */
  readonly frameHandles: HandleRegistry = new HandleRegistry({
    actions: this.companionActions,
    provenance: (src) => canvasProvenance(src),
    nextFrame: (cb) => window.requestAnimationFrame(() => cb()),
  });
  /** Companion context-menu callbacks (api `addMenuItems`). */
  readonly companionMenus = new CompanionMenus();
  /** The companion API (MehrpeleApiV1), set in onload once features exist. */
  api: MehrpeleApiV1 | null = null;
  private companionHost: HostApi | null = null;
  private addonHints: AddonHints | null = null;
  private addonTab: LazySettingTab | null = null;
  // endregion companion api
  private lp: LpTakeover | null = null;
  /** Whether the `mermaid` override was registered at load (registration is load-time only). */
  private overrideActive = false;

  async onload(): Promise<void> {
    // Enabled after startup (not restored with the app): open views rendered
    // without us and need a redraw once the layout is ready.
    const afterStart = this.app.workspace.layoutReady;
    setPluginId(this.manifest.id);
    // v3 on disk and in memory; migrates and saves once (src/settings/load.ts).
    this.settings = (await loadSettings(this, (m) => new Notice(m))).settings;

    this.addonTab = new LazySettingTab(this);
    this.addSettingTab(this.addonTab);
    this.diagramUndo.load();

    // Block command/write obsidian:// links in diagrams before anything else sees the click.
    const guardDocument = createDocumentGuard<Document>((doc) => {
      for (const type of ["click", "auxclick"] as const) {
        this.registerDomEvent(
          doc,
          type,
          (evt) => guardAnchorClick(evt, this.settings.core.security, (m) => new Notice(m, 10_000)),
          { capture: true },
        );
      }
    });
    guardDocument(document);

    // Popouts that are already open (plugin enabled while Obsidian is running, or restored
    // before onload) never fire window-open for us: guard them now and again
    // once the layout is ready; dedupe by Document.
    const guardOpenWindows = () => {
      try {
        this.app.workspace.iterateAllLeaves((leaf) => {
          guardDocument(leaf.view?.containerEl?.ownerDocument);
          guardDocument((leaf as unknown as { getContainer?: () => { doc?: Document } }).getContainer?.()?.doc);
        });
      } catch {
        /* workspace not ready */
      }
    };
    guardOpenWindows();
    this.app.workspace.onLayoutReady(guardOpenWindows);
    this.registerEvent(this.app.workspace.on("window-open", (win) => guardDocument(win.doc)));
    try {
      this.registerHoverLinkSource(PLUGIN_ID, { display: "Mehrpele", defaultMod: true });
    } catch {
      /* page-preview core plugin unavailable */
    }

    const makeHandler =
      (lang: string) =>
      (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        let lineStart: number | undefined;
        let size: FenceSize = {};
        let fenceRest = "";
        try {
          const info = ctx.getSectionInfo(el);
          if (info) {
            lineStart = info.lineStart;
            const fence = fenceLineAt(info.text, info.lineStart);
            size = parseFenceSize(fence);
            fenceRest = fenceRestOf(fence);
          }
        } catch {
          /* section info unavailable (e.g. some embed contexts) */
        }
        // Untrusted vault: Obsidian wrapped this mermaid fence in its trust
        // banner first. Pele runs no mermaid.js: the frame takes its place.
        unwrapMermaidGuard(el);
        // Rendered inside a Mehrpele label (mixed Markdown, embedded notes):
        // a nested diagram — never persisted to the file (the processor's
        // section info describes the label text, not the note), and bounded
        // by the nesting depth so self-embedding notes cannot recurse.
        const nested = mehrpeleNesting(el);
        if (nested.inLabel) {
          lineStart = undefined;
          size = {};
        }
        // Top-level fences get a companion frame handle (api `frames`).
        const companion: FrameCompanion | undefined =
          lineStart !== undefined
            ? { key: `${ctx.sourcePath}#${lineStart}`, fenceRest, locate: () => readingLocate(ctx, el) }
            : undefined;
        // A `cannoli` fence whose body is `%% pele-source: [[X.canvas]] %%`: the canvas.
        const embed = companion && this.canvasEmbed(source, el, ctx.sourcePath, companion);
        if (embed) {
          const child = new MarkdownRenderChild(el);
          child.register(() => embed.destroy());
          ctx.addChild(child);
          return;
        }
        if (this.appliesMehrpele(lang, source)) {
          if (nested.depth > this.settings.features.nested.maxDepth) {
            // Too deep: the plain diagram, labels as fallback text.
            ctx.addChild(
              new PeleDiagramChild(el, this, lazy.mehrpele().mehrpeleRenderSource(source), ctx.sourcePath, lang, undefined, {}, true),
            );
          } else {
            ctx.addChild(
              new (lazy.mehrpeleShell().MehrpeleChild)(el, this, source, ctx.sourcePath, lang, lineStart, size, nested.depth, companion),
            );
          }
        } else {
          ctx.addChild(
            new PeleDiagramChild(el, this, source, ctx.sourcePath, lang, lineStart, size, nested.inLabel, companion),
          );
          if (lang === "mehrpele" && !this.settings.features["live-view"].enabled) {
            el.createDiv({
              cls: "pele-mehrpele-hint",
              text: "Enable Mehrpele in settings to render Markdown labels",
            });
          }
        }
      };

    // A diagram block in its own tab / split / window (zoom button, Mod-click).
    this.registerView(DIAGRAM_VIEW, (leaf) => new DiagramView(leaf, this));
    this.registerMarkdownCodeBlockProcessor("pele", makeHandler("pele"));
    this.registerMarkdownCodeBlockProcessor("mehrpele", makeHandler("mehrpele"));
    registerIntegrationBlocks(this);
    this.overrideActive = false;
    if (this.settings.core.overrideMermaid) {
      try {
        registerBeforeCore(this, "mermaid", makeHandler("mermaid"));
        this.overrideActive = true;
      } catch (e) {
        console.error("[pele-mermaid] could not register mermaid processor", e);
      }
    }

    // Live Preview takeover: patch Obsidian's private fenced-code widget
    // (a registered `mermaid` processor can never win there). Discovery is
    // structural and failure leaves native rendering intact.
    this.lp = new LpTakeover({
      isOverrideOn: () => this.settings.core.overrideMermaid,
      buildWidgetDOM: (widget, view) => buildLpWidgetDOM(this, widget, view),
      onWidgetDestroy: (widget, dom) => {
        const el = dom ?? widget.containerEl;
        if (!el) return;
        // CM can report a widget destroyed while its DOM stays (or is put back)
        // in the editor; tearing the frame down then left a dead, static
        // diagram on screen. Decide after the update: only DOM that really
        // left the document is torn down.
        window.setTimeout(() => {
          if (el.isConnected) return;
          const frame = this.framesByDom.get(el);
          if (frame) {
            this.framesByDom.delete(el);
            // CM may re-attach this very DOM later: the frame revives in place.
            frame.suspend(() => {
              if (!this.framesByDom.has(el)) this.framesByDom.set(el, frame);
            });
          }
          const shell = this.mehrByDom.get(el);
          if (shell) {
            shell.destroy();
            this.mehrByDom.delete(el);
          }
          const embed = this.canvasEmbedsByDom.get(el);
          if (embed) {
            embed.destroy();
            this.canvasEmbedsByDom.delete(el);
          }
          // CM destroys widgets that scroll out of its viewport, but Obsidian's
          // widget keeps `containerEl` and its toDOM returns that cache without
          // re-running initDOM: scrolled back, the block would show the dead
          // frame (empty, never re-mounted). Drop the cache so it rebuilds.
          if ((frame || shell || embed) && widget.containerEl === el) widget.containerEl = undefined;
        }, 0);
      },
      onWidgetReuse: (widget, dom, view) => handleLpWidgetReuse(this, widget, dom, view),
      onFenceWidthChanges: (view, changes) => applyLpFenceWidths(this, view, changes),
      onFenceLayoutChange: (view) => {
        this.frameHandles.resyncSoon();
        window.requestAnimationFrame(() => refreshLpFenceModes(this, view));
      },
      onFirstPatch: () => {
        // Redraw already-open LP editors that show one of our blocks so they
        // switch to Pele without being reopened (undo history and cursor are
        // kept). Deferred: we are inside a CM update.
        window.setTimeout(() => void this.refreshMarkdownLeaves("live"), 0);
      },
      onUnavailable: (reason) => {
        // Native rendering stays (fallback); on core-Pele builds that means
        // core's read-only diagram, so say why editing tools are missing.
        console.warn(`[pele-mermaid] Live Preview takeover unavailable: ${reason}`);
        if (hasCorePele({ apiVersionAtLeast: requireApiVersion })) {
          new Notice("Live preview editing unavailable on this Obsidian build");
        }
      },
    });
    try {
      this.registerEditorExtension(this.lp.extension());
    } catch (e) {
      console.error("[pele-mermaid] could not register LP discovery extension", e);
    }

    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        forgetTextWidths();
        this.cssRefresh.request();
      }),
    );

    this.addCommand({
      id: "copy-diagram-svg",
      name: "Copy current diagram as SVG",
      editorCallback: (editor, view) => {
        void lazy.editorCommands().copyDiagramSvg(this, editor, view.file?.path ?? "");
      },
    });
    this.addCommand({
      id: "export-diagram-svg",
      name: "Export current diagram as SVG file",
      editorCallback: (editor, view) => {
        void lazy.editorCommands().exportDiagramSvg(this, editor, view.file ?? null);
      },
    });
    this.addCommand({
      id: "prune-node-sizes",
      name: "Remove stale node sizes in this note",
      editorCallback: (editor) => {
        const cm = (editor as unknown as { cm?: EditorView }).cm;
        const plan = pruneNoteSizes(editor.getValue());
        if (!cm || plan.length === 0) {
          new Notice("Pele: no stale node sizes in this note.");
          return;
        }
        // One transaction: a single undo step for the whole note.
        const doc = cm.state.doc;
        cm.dispatch({
          changes: plan.map((p) => ({ from: doc.line(p.firstLine + 1).from, to: doc.line(p.lastLine + 1).to, insert: p.body })),
          scrollIntoView: false,
        });
        new Notice(`Pele: removed stale node sizes in ${plan.length} diagram${plan.length === 1 ? "" : "s"}.`);
      },
    });
    this.addCommand({
      id: "focus-diagram-actions",
      name: "Focus diagram actions",
      editorCheckCallback: (checking, editor) => focusDiagramActions((editor as unknown as { cm?: EditorView }).cm, checking),
    });
    this.addCommand({
      id: "validate-mermaid-blocks",
      name: "Validate all Mermaid blocks in note",
      editorCallback: (editor) => {
        lazy.editorCommands().validateNote(this, editor);
      },
    });
    // region features
    // Feature code loads only for toggles that are on (src/features/registry.ts).
    this.features = new FeatureRegistry(this, (id) => isEnabled(this.settings, id));
    this.addChild(this.features);
    await this.features.sync();
    // endregion features

    // region companion api
    const features = this.features;
    this.companionHost = createHostApi({
      hostVersion: this.manifest.version,
      pele: Object.freeze({ render, mount }),
      workspace: this.app.workspace,
      adopt: (def) => features.adopt(def),
      handles: this.frameHandles,
      actions: this.companionActions,
      menus: this.companionMenus,
      // pele-render's canvas node union is structurally wider than obsidian/canvas's tagged one.
      canvas: () => lazy.canvas() as unknown as CanvasConverters,
      read: (file) => this.app.vault.read(file),
      mountDiagram: (el, owner, source, path, lang, companion) =>
        this.mountDiagram(el, owner, source, path, lang, undefined, companion),
      onModify: (file, cb) => {
        // A child of the plugin, so plugin unload also drops the listener.
        const watch = this.addChild(new Component());
        watch.registerEvent(this.app.vault.on("modify", (f) => f.path === file.path && cb(f)));
        return () => this.removeChild(watch);
      },
      schedule: (cb, ms) => {
        const t = window.setTimeout(cb, ms);
        return () => window.clearTimeout(t);
      },
    });
    this.api = this.companionHost.api;
    this.addonHints = new AddonHints({
      handles: this.frameHandles,
      enabled: () => this.settings.core.showAddonHints,
      ready: () => this.flowStatus().kind === "ready",
      openFlows: () => this.addonTab?.openFlows(),
    });
    this.register(this.companionHost.onFeaturesChanged(() => {
      this.refreshAddonHints();
      this.addonTab?.refreshAddons();
    }));
    this.app.workspace.onLayoutReady(() => {
      this.companionHost?.ready();
      this.refreshAddonHints();
      this.addonTab?.refreshAddons();
    });
    // endregion companion api

    // Take effect in already-open notes without reopening them: Reading views
    // need the new processors here; LP editors are redrawn once, by
    // onFirstPatch, so layout-ready doesn't rebuild them a second time. At app
    // start the layout restores after onload, so restored views already
    // render with our processors: no redraw then.
    if (afterStart) this.app.workspace.onLayoutReady(() => void this.refreshMarkdownLeaves("reading"));
    // Startup self-check: open LP editors showing code blocks must have
    // yielded the widget class by now (reports once if not).
    this.app.workspace.onLayoutReady(() => this.lp?.selfCheck(this.liveEditorViews()));
  }

  /** CodeMirror views of open Markdown editors (source mode has no widgets, so it never counts). */
  private liveEditorViews(): EditorView[] {
    const views: EditorView[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const mv = leaf.view;
      if (!(mv instanceof MarkdownView)) continue;
      const cm = (mv.editor as unknown as { cm?: EditorView } | undefined)?.cm;
      if (cm) views.push(cm);
    }
    return views;
  }

  /**
   * Companion api first: `isLive()` turns false and `mehrpele:api-unload`
   * fires while every frame is still up, then companion state goes. Obsidian unloads
   * children last-added-first before onunload, so this cannot be a child or onunload.
   */
  override unload(): void {
    this.addonHints?.dispose();
    this.addonHints = null;
    this.companionHost?.unload();
    super.unload();
  }

  onunload(): void {
    PeleLightbox.closeCurrent();
    closeContextMenu();
    this.cssRefresh.dispose();
    this.suspended.destroyAll();
    for (const frame of [...this.frames]) frame.destroy();
    this.frames.clear();
    for (const shell of [...this.mehrShells]) shell.destroy();
    this.mehrShells.clear();
    // Restore the LP widget prototype, then rebuild so native mermaid returns.
    try {
      this.lp?.restore();
    } catch {
      /* best effort */
    }
    this.lp = null;
    void this.refreshMarkdownLeaves("rebuild");
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // region features
  /**
   * Every settings write loads or unloads features whose toggle changed,
   * including settings sections that call saveData directly.
   */
  override async saveData(data: unknown): Promise<void> {
    await super.saveData(data);
    await this.features?.sync();
    this.refreshAddonHints();
  }
  flowStatus(): FlowStatus {
    const pm = (this.app as unknown as { plugins?: PluginManagerLike }).plugins;
    return detectFlows(pm, this.api?.apiMinor ?? 0, this.companionHost?.feature(FLOWS.id));
  }
  refreshAddonHints(): void { this.addonHints?.refresh(); }
  // endregion features

  // -- FrameHost (adapted via frameHostOf) -----------------------------------

  registerFrame(frame: DiagramFrame): void {
    this.suspended.delete(frame);
    this.frames.add(frame);
    const s = frame.companionSurface();
    if (s) this.frameHandles.bind(s);
  }
  unregisterFrame(frame: DiagramFrame): void {
    this.suspended.delete(frame);
    this.cssRefresh.forget(frame);
    this.frames.delete(frame);
    const s = frame.companionSurface();
    if (s) this.frameHandles.unbind(s);
  }
  frameRendered(frame: DiagramFrame): void {
    const s = frame.companionSurface();
    if (s) this.frameHandles.rendered(s);
  }
  suspendFrame(frame: DiagramFrame): void {
    this.suspended.add(frame);
    // Its handle lives on (hidden) until revival or the TTL's destroy.
    const s = frame.companionSurface();
    if (s) this.frameHandles.suspend(s);
  }

  /**
   * A diagram re-laid out after Obsidian measured its Reading-view section
   * (reflow is debounced; Obsidian re-measures on width changes): update
   * the cached section height so the virtualised view's spacer doesn't jump
   * the reading position when sections above are unloaded. Private renderer
   * API, feature-detected; a no-op anywhere else.
   */
  remeasureSection(el: HTMLElement): void {
    try {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        type Section = { el?: HTMLElement };
        const renderer = (leaf.view as unknown as {
          previewMode?: { renderer?: { previewEl?: HTMLElement; sections?: Section[]; measureSection?(s: Section): void } };
        }).previewMode?.renderer;
        if (!renderer?.previewEl?.contains(el) || typeof renderer.measureSection !== "function") continue;
        const section = renderer.sections?.find((s) => s.el?.contains(el));
        if (section) renderer.measureSection(section);
        return;
      }
    } catch {
      /* renderer internals changed: scroll anchoring still applies */
    }
  }

  /** Mehrpele applies only when the master toggle is on (default off). */
  appliesMehrpele(lang: string, source: string): boolean {
    return (
      this.settings.features["live-view"].enabled &&
      lazy.mehrpele().mehrpeleApplies(lang, source, mehrpeleOptions(this.settings), hasMehrpeleDirective(source))
    );
  }

  /**
   * A block whose quoted labels are Markdown: rendering applies (see
   * appliesMehrpele), or it is written as Mehrpele (`mehrpele` / directive)
   * even while the renderer is off — validation and repair must never
   * treat its label Markdown as diagram syntax.
   */
  isMehrpeleBlock(lang: string, source: string): boolean {
    return isMehrpeleSource(lang, source) || this.appliesMehrpele(lang, source);
  }

  /** validateSource, Mehrpele-aware (labels neutralised, line numbers kept). */
  validateDiagram(lang: string, source: string): ReturnType<typeof validateSource> {
    return this.isMehrpeleBlock(lang, source)
      ? lazy.mehrpele().validateMehrpele(source, (s) => validateSource(s))
      : validateSource(source);
  }

  /**
   * A sole-diagram Mehrpele label (inline fence or diagram embed) rendered as
   * a real frame inside the node: a nested MehrpeleShell for Mehrpele
   * sources, a DiagramFrame otherwise — both with zoom, code reveal and a
   * bounded resize corner whose width goes back to the label (spec.onResize).
   */
  renderNestedDiagram(el: HTMLElement, spec: NestedDiagramSpec, component: Component): NestedDiagramHandle | null {
    // Callbacks passed on as functions, so the spec's methods are never called unbound.
    const revealOrigin = spec.revealOrigin ? (): void => spec.revealOrigin?.() : undefined;
    try {
      if (this.isMehrpeleBlock(spec.lang, spec.code) && this.settings.features["live-view"].enabled) {
        const shell: MehrpeleShell = new (lazy.mehrpeleShell().MehrpeleShell)(this, component, {
          source: spec.code,
          lang: spec.lang,
          sourcePath: spec.sourcePath,
          width: spec.width,
          ...(spec.height !== undefined ? { height: spec.height } : {}),
          nested: {
            depth: spec.depth,
            minWidth: spec.minWidth,
            maxWidth: spec.maxWidth,
            ...(spec.minHeight !== undefined ? { minHeight: spec.minHeight } : {}),
            ...(spec.maxHeight !== undefined ? { maxHeight: spec.maxHeight } : {}),
          },
          onRevealCode: () => shell.toggleSourcePanel(),
          onPersistSize: (edit) => spec.onResize(edit.width ?? null, edit.height),
          ...(spec.onSourceChange ? { onSourceChange: (next: string) => spec.onSourceChange?.(next) } : {}),
          origin: spec.origin,
          ...(revealOrigin ? { revealOrigin } : {}),
        });
        el.appendChild(shell.root);
        shell.load();
        const detach = this.attachOpenOriginal(shell.root, spec.origin, { reveal: revealOrigin });
        return {
          destroy: () => {
            detach();
            shell.destroy();
          },
        };
      }
      const frame = new DiagramFrame(frameHostOf(this), {
        source: spec.code,
        lang: spec.lang,
        sourcePath: spec.sourcePath,
        width: spec.width,
        ...(spec.height !== undefined ? { height: spec.height } : {}),
        nested: true,
        minWidth: spec.minWidth,
        maxWidth: spec.maxWidth,
        ...(spec.minHeight !== undefined ? { minHeight: spec.minHeight } : {}),
        ...(spec.maxHeight !== undefined ? { maxHeight: spec.maxHeight } : {}),
        onRevealCode: (f) => f.toggleSourcePanel(),
        onPersistSize: (edit) => spec.onResize(edit.width ?? null, edit.height),
        ...(spec.onSourceChange ? { onSourceChange: (next: string) => spec.onSourceChange?.(next) } : {}),
      });
      el.appendChild(frame.root);
      frame.load();
      const detach = this.attachOpenOriginal(frame.root, spec.origin, { reveal: revealOrigin });
      return {
        destroy: () => {
          detach();
          frame.destroy();
        },
      };
    } catch (e) {
      console.warn("[pele-mermaid] nested diagram failed", e);
      return null;
    }
  }

  /** What the Mehrpele Bases view needs from the plugin (feature "bases"). */
  mehrBasesDeps(): MehrpeleBasesDeps {
    return {
      settings: () => mehrpeleOptions(this.settings),
      renderOptions: () => this.mehrRenderOptions(),
      liveMount: (m, live) => (live ? this.sharedMathMounts.add(m) : this.sharedMathMounts.delete(m)),
      liveView: (v, live) => (live ? this.basesViews.add(v) : this.basesViews.delete(v)),
      renderNestedDiagram: (el, spec, component) => this.renderNestedDiagram(el, spec, component),
      nodeStyle: () => {
        if (!this.settings.features.integrations["extended-graph"].enabled) return null;
        const eg = lazy.extendedGraph();
        return eg.basesNodeStyleFromExtendedGraph(this.app, eg.readExtendedGraphStyle(this.app));
      },
    };
  }

  // -- Integrations -----------------------------------------------------------

  private integrationFrames = new WeakMap<HTMLElement, IntegrationFrameChild>();

  integrationHost(): IntegrationHost {
    return {
      app: this.app,
      component: this,
      settings: () => integrationOptions(this.settings),
      renderSource: (source, el, ctx) => {
        // One live frame per mount target: a refresh destroys the previous
        // frame and reuses the target's single lifecycle child.
        let child = this.integrationFrames.get(el);
        child?.release();
        el.replaceChildren();
        const frame = new DiagramFrame(frameHostOf(this), {
          source,
          lang: "pele",
          sourcePath: ctx.sourcePath,
          onRevealCode: (f) => f.toggleSourcePanel(),
        });
        el.appendChild(frame.root);
        frame.load();
        if (!child) {
          child = new IntegrationFrameChild(el, () => this.integrationFrames.delete(el));
          this.integrationFrames.set(el, child);
          ctx.addChild(child);
        }
        child.frame = frame;
      },
      releaseSource: (el) => {
        this.integrationFrames.get(el)?.release();
      },
      renderPele: (source, opts) => {
        const r = render(source, {
          ...toMountOptions(this.settings),
          ...(opts?.maxWidth ? { maxWidth: opts.maxWidth } : {}),
        });
        return { svg: sanitizedSvgMarkup(r.svg, this.settings.core.security.sanitize), type: r.type, width: r.width, height: r.height };
      },
      mountPele: (el, source, opts) => {
        let frame: DiagramFrame | null = null;
        const spawn = (src: string): DiagramFrame => {
          const f = new DiagramFrame(frameHostOf(this), {
            source: src,
            lang: "pele",
            sourcePath: "",
            ...(opts?.maxWidth ? { width: opts.maxWidth } : {}),
            onRevealCode: (fr) => fr.toggleSourcePanel(),
          });
          el.appendChild(f.root);
          f.load();
          return f;
        };
        frame = spawn(source);
        return {
          destroy: () => frame?.destroy(),
          update: (src: string) => {
            frame?.destroy();
            frame = spawn(src);
          },
          refresh: () => frame?.refresh(),
        };
      },
    };
  }

  // -- Mehrpele ---------------------------------------------------------------

  registerMehr(shell: MehrpeleShell): void {
    this.mehrShells.add(shell);
    const s = shell.companionSurface();
    if (s) this.frameHandles.bind(s);
  }
  unregisterMehr(shell: MehrpeleShell): void {
    this.cssRefresh.forget(shell);
    this.mehrShells.delete(shell);
    const s = shell.companionSurface();
    if (s) this.frameHandles.unbind(s);
  }
  mehrRendered(shell: MehrpeleShell): void {
    const s = shell.companionSurface();
    if (s) this.frameHandles.rendered(s);
  }

  refreshMehrpele(): void {
    for (const shell of [...this.mehrShells]) shell.refresh();
  }

  /** Bases toggle: open views go inert (off) or build their diagram (on). */
  refreshBasesViews(): void {
    for (const view of [...this.basesViews]) view.refresh();
  }

  /**
   * RenderOptions for Mehrpele mounts (no in-place Pele zoom; lightbox zooms).
   * `fixedWidth`: a user-chosen width keeps the authored direction (Pele's
   * auto-direction would flip `graph LR` to top-down at narrow widths).
   */
  mehrRenderOptions(maxWidth?: number, fixedWidth = false, dm: DiagramMath = this.sharedMehrMath()) {
    const s = this.settings;
    const base = toMountOptions(s);
    return {
      ...base,
      zoom: false as const,
      ...(maxWidth !== undefined ? { maxWidth } : {}),
      ...(fixedWidth ? { autoDirection: false } : {}),
      idPrefix: nextIdPrefix(),
      ...(s.core.iconsEnabled ? { icons: makeIconResolver((n) => frameHostOf(this).iconSvg(n)) } : {}),
      math: dm.math,
      sanitize: (svg: string) => dm.sanitize(svg, s.core.security.sanitize ? sanitizeSvg : null),
    };
  }

  private mehrMath: DiagramMath | null = null;
  /** Live mounts rendering with sharedMehrMath (inline shells have their own resolver). */
  private sharedMathMounts = new LiveRegistry<MehrpeleMounted>();
  /** Math resolver for Mehrpele mounts without their own (lightbox, Bases view). */
  private sharedMehrMath(): DiagramMath {
    return (this.mehrMath ??= createDiagramMath({
      deps: obsidianMathDeps(),
      links: () => this.settings.core.security.allowLinks,
      rerender: () => {
        for (const m of [...this.sharedMathMounts]) m.refresh();
      },
    }));
  }

  openMehrpeleLightbox(shell: MehrpeleShell): void {
    // Read per use (the getter below has the options object as `this`).
    const currentSettings = () => mehrpeleOptions(this.settings);
    PeleLightbox.openCustom(shell.accTitle ?? shell.lang, (wrapper) => {
      let mounted: MehrpeleMounted | null = null;
      let dead = false;
      // Label components live only as long as the lightbox.
      const labels = new Component();
      labels.load();
      wrapper.addEventListener(
        "click",
        (ev) => this.routeMehrSvgLink(ev, shell.sourcePath, mounted?.result()?.links ?? shell.result()?.links, wrapper),
        true,
      );
      // Mount into a shrink-wrapped host: the overlay is positioned against
      // the mount container, which must start at the SVG's corner (the
      // full-screen media wrapper centres the SVG, misplacing every label).
      const host = wrapper.createDiv({ cls: "pele-mehrpele-lightbox-host" });
      void lazy.mehrpele().mountMehrpele(host, shell.source, {
        app: this.app,
        component: labels,
        sourcePath: shell.sourcePath,
        // Read per use: a settings change applies to the open lightbox.
        get settings() {
          return currentSettings();
        },
        // Explicit layout width (the host shrink-wraps; see MehrpeleShell.layoutWidth).
        renderOptions: () => this.mehrRenderOptions(Math.floor(window.innerWidth * 0.92), !shell.reflowOn && shell.width !== undefined),
        // Reflow: the layout that shows largest in the lightbox, never magnified (zoom magnifies).
        reflow: () =>
          shell.reflowOn
            ? {
                layoutWidth: Math.floor(window.innerWidth * 0.92),
                box: { width: Math.floor(window.innerWidth * 0.92), height: Math.floor(window.innerHeight * 0.85) },
                policy: reflowPolicy(this.settings.features.reflow),
                animate: false,
              }
            : null,
        onLink: (href, evt) => this.internalLink(href, shell.sourcePath, evt),
        // Same nesting as the shell; resizes inside the lightbox stay in memory.
        depth: shell.depth,
        renderNestedDiagram: (el, spec, component) => this.renderNestedDiagram(el, spec, component),
        ...shell.originHost(),
      }).then((m) => {
        if (dead) {
          m.destroy();
          return;
        }
        mounted = m;
        this.sharedMathMounts.add(m);
        // Reflow lays it out for the lightbox at ≤ 1×; the lightbox zoom magnifies.
        if (shell.reflowOn) return;
        // Legacy: scale the diagram (and its overlay, which follows the SVG's
        // CSS scale) up to the viewport, at most 3×.
        const r = m.result();
        if (r && r.width > 0 && r.height > 0) {
          const scale = Math.min((window.innerWidth * 0.92) / r.width, (window.innerHeight * 0.85) / r.height, 3);
          if (scale > 1) {
            host.style.width = `${Math.floor(r.width * scale)}px`;
            host.classList.add("is-scaled");
          }
        }
      });
      return () => {
        dead = true;
        if (mounted) this.sharedMathMounts.delete(mounted);
        mounted?.destroy();
        labels.unload();
      };
    });
  }

  /**
   * Links Pele itself draws inside a Mehrpele diagram (SVG `<a>`, not the
   * HTML overlay labels): same routing as DiagramFrame.activateLink, and the
   * default navigation is always suppressed (refused links must not fall
   * through to it).
   */
  routeMehrSvgLink(
    ev: MouseEvent,
    sourcePath: string,
    links?: readonly { href: string; internal?: boolean }[],
    scope?: HTMLElement,
  ): void {
    const anchor = (ev.target as Element | null)?.closest?.("a");
    if (!anchor || !isSvgAnchor(anchor)) return;
    // Anchors drawn by a nested diagram (inside a node) are routed by that
    // diagram's own handler, with its own link list.
    const nested = anchor.closest(".pele-nested");
    if (scope && nested && nested !== scope && scope.contains(nested)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const href = anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href");
    if (!href) return;
    const internal = links?.find((l) => l.href === href)?.internal ?? false;
    routeDiagramLink(href, internal, this.settings.core.security, {
      internal: (h) => this.internalLink(h, sourcePath, ev),
      open: (h) => window.open(h),
    });
  }

  /** Hover preview for internal links inside Mehrpele overlays. */
  hoverMehrLink(evt: MouseEvent, anchor: HTMLElement, href: string, shell: MehrpeleShell): void {
    let hoverParent: unknown = shell.root;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const mv = leaf.view;
      if (mv instanceof MarkdownView && mv.containerEl.contains(shell.root)) {
        hoverParent = mv;
        break;
      }
    }
    try {
      this.app.workspace.trigger("hover-link", {
        event: evt,
        source: PLUGIN_ID,
        hoverParent,
        targetEl: anchor,
        linktext: href,
        sourcePath: shell.sourcePath,
      });
    } catch {
      /* page preview unavailable */
    }
  }

  /** pele-edit: hover toolbar + inline label editor on one rendered diagram. */
  attachEdit(frame: EditableFrame): () => void {
    const edit = lazy.edit();
    const releaseSweep = this.floatSweep();
    const detach = edit.attachEditing(this, frame);
    return () => {
      detach();
      releaseSweep();
    };
  }
  /**
   * A floated action bar must not outlive its frame's place (tab moved to another note, popouts):
   * swept on these workspace events while any frame has editing attached, and not after.
   */
  private readonly floatSweep = sharedChild(this, (c) => {
    const { sweepFloatingActions } = lazy.floatActions();
    for (const name of ["active-leaf-change", "layout-change", "file-open", "window-close"] as const) {
      c.registerEvent(this.app.workspace.on(name as "layout-change", sweepFloatingActions));
    }
  });

  /**
   * Mount one block as the Markdown processor would (the diagram view); `fenceLine`
   * undefined = never written back; `companion` gives it a companion frame handle.
   */
  mountDiagram(
    el: HTMLElement,
    owner: Component,
    source: string,
    sourcePath: string,
    lang: string,
    fenceLine: number | undefined,
    companion?: FrameCompanion,
  ): void {
    owner.addChild(
      this.appliesMehrpele(lang, source)
        ? new (lazy.mehrpeleShell().MehrpeleChild)(el, this, source, sourcePath, lang, fenceLine, {}, 0, companion)
        : new PeleDiagramChild(el, this, source, sourcePath, lang, fenceLine, {}, false, companion),
    );
  }

  /**
   * A canvas embed (`cannoli` fence, `%% pele-source: [[X.canvas]] %%` body) mounted into `el`
   * through the api's mountCanvas, keyed by the fence; null when the fence is a normal diagram.
   */
  canvasEmbed(source: string, el: HTMLElement, sourcePath: string, companion: FrameCompanion): { destroy(): void } | null {
    const host = this.companionHost;
    if (!host) return null;
    const deps = {
      resolve: (link: string, from: string) => this.app.metadataCache.getFirstLinkpathDest(link, from),
      mountCanvas: host.mountCanvas,
    };
    return mountPeleSource(deps, source, el, sourcePath, companion.fenceRest, companion.key, companion.locate ?? (() => null));
  }

  /** pele-edit: node label autocomplete through the Repair LLM provider (undefined = off / unconfigured). */
  nodeAutocomplete(): LlmProvider | undefined {
    const a = this.settings.features.autocomplete;
    if (!a.enabled) return undefined;
    const r = repairOptions(this.settings);
    // A hosted OpenAI-compatible service needs a key; local (Ollama, LM Studio) does not.
    if (r.llmProvider === "openai" && !lazy.repairHost().secret(this, r.openaiKeySecretId) && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(r.llmBaseUrl || "https://api.openai.com")) return undefined;
    return lazy.repairHost().buildLlmProvider(this, { ...r, tierLlm: true, ...(a.model ? { llmModel: a.model } : {}) });
  }

  /** pele-edit: open this plugin's settings tab. */
  openPluginSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  /**
   * "Open original" for a nested diagram or a portal embed: an embed-action
   * button, Mod-click / middle-click on its background (Keymap.isModEvent
   * picks the pane) and a Mod-hover page preview. Plain clicks, double-clicks
   * and drags keep their behaviour. Returns the detach.
   */
  attachOpenOriginal(root: HTMLElement, origin: NestedOrigin, opts: { reveal?: () => void } = {}): () => void {
    root.classList.add(lazy.mehrpele().ORIGIN_ROOT_CLASS);
    let actions = root.querySelector<HTMLElement>(":scope > .embed-actions");
    if (!actions) {
      // Portal embeds have no frame chrome: give them the native slot.
      actions = root.createDiv({ cls: "embed-actions pele-origin-actions" });
    }
    const btn = asButton(createDiv({ cls: "embed-action pele-open-original" }));
    setIcon(btn, "arrow-up-right");
    setTooltip(btn, lazy.mehrpele().originTooltip(origin));
    // Before the repair slot (zoom, code, open, repair).
    actions.insertBefore(btn, actions.querySelector(":scope > .pele-repair-slot"));
    const onButton = (e: MouseEvent): void => {
      if (e.type === "auxclick" && e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      this.openOrigin(origin, e.type === "auxclick" ? "tab" : Keymap.isModEvent(e), { reveal: opts.reveal, from: root });
    };
    btn.addEventListener("click", onButton);
    btn.addEventListener("auxclick", onButton);

    let pressedAt: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent): void => {
      pressedAt = { x: e.clientX, y: e.clientY };
    };
    const onClick = (e: MouseEvent): void => {
      const pane = lazy.mehrpele().originGesture(e, {
        pane: Keymap.isModEvent(e),
        root,
        pressedAt,
        resizing: !!root.closest(`.is-resizing, .${lazy.mehrpele().RESIZING_CLASS}`) || !!root.querySelector(`.is-resizing, .${lazy.mehrpele().RESIZING_CLASS}`),
      });
      pressedAt = null;
      if (pane === null) return;
      e.preventDefault();
      e.stopPropagation();
      this.openOrigin(origin, pane, { reveal: opts.reveal, from: root });
    };
    // Mod-hover preview of the original (page-preview applies the Mod rule
    // for our registered source); re-armed after leaving or a link hover.
    let armed = true;
    const onOver = (e: MouseEvent): void => {
      const t = e.target as Element | null;
      const background = !t?.closest?.("a, .embed-actions") && t?.closest?.(`.${lazy.mehrpele().ORIGIN_ROOT_CLASS}`) === root;
      if (!background) {
        armed = true;
        return;
      }
      if (!armed || origin.kind === "inline") return;
      armed = false;
      this.hoverOrigin(e, root, origin);
    };
    const onLeave = (): void => {
      armed = true;
    };
    root.addEventListener("pointerdown", onDown, true);
    root.addEventListener("click", onClick);
    root.addEventListener("auxclick", onClick);
    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseleave", onLeave);
    return () => {
      root.removeEventListener("pointerdown", onDown, true);
      root.removeEventListener("click", onClick);
      root.removeEventListener("auxclick", onClick);
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseleave", onLeave);
      btn.remove();
      root.classList.remove(lazy.mehrpele().ORIGIN_ROOT_CLASS);
    };
  }

  /**
   * Open where a nested diagram comes from: the embedded note / section /
   * block / diagram file (headings and blocks scroll into view), the portal's
   * `.canvas` (zoomed to `#node-id`), or for inline fences the outer block
   * (revealed in place; Mod/middle opens the note at that line in a new pane).
   */
  openOrigin(origin: NestedOrigin, pane: OriginPane, opts: { reveal?: () => void; from?: HTMLElement } = {}): void {
    // Leaving a lightbox: close it so the opened note is not hidden behind it.
    opts.from?.closest(".lightbox")?.querySelector<HTMLElement>(":scope > .modal-close-button")?.click();
    if (origin.kind === "inline") {
      if (!pane && opts.reveal) {
        opts.reveal();
        return;
      }
      void this.app.workspace.openLinkText(
        origin.sourcePath,
        "",
        pane,
        origin.line !== undefined ? { eState: { line: origin.line } } : undefined,
      );
      return;
    }
    const opened = this.app.workspace.openLinkText(lazy.mehrpele().originLinktext(origin), origin.sourcePath, pane);
    const nodeId = lazy.mehrpele().portalNodeId(origin);
    if (nodeId) void opened.then(() => this.zoomToCanvasNode(origin, nodeId));
    else if (origin.subpath) void opened.then(() => this.settleSubpath(origin));
  }

  /**
   * Live Preview scrolls to the heading/block before the diagrams above it
   * have their final height, which leaves the target off-screen in notes
   * full of diagrams. Scroll to it once more after they settle.
   */
  private settleSubpath(origin: NestedOrigin): void {
    if (origin.kind === "inline") return;
    const file = this.app.metadataCache.getFirstLinkpathDest(origin.linkpath, origin.sourcePath);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!file || view?.file?.path !== file.path) return;
    window.setTimeout(() => {
      if (view.file?.path === file.path && view.leaf.view === view) view.setEphemeralState({ subpath: origin.subpath });
    }, 700);
  }

  /**
   * Opening `x.canvas#node-id` already selects and centres the node (Advanced
   * Canvas); fall back to the canvas view's own API when it did not.
   */
  private zoomToCanvasNode(origin: NestedOrigin, nodeId: string): void {
    if (origin.kind !== "portal") return;
    const file = this.app.metadataCache.getFirstLinkpathDest(origin.linkpath, origin.sourcePath);
    const view: (ItemView & { file?: TFile | null; canvas?: CanvasViewApi }) | null =
      this.app.workspace.getActiveViewOfType(ItemView);
    const canvas = view?.getViewType() === "canvas" && view.file?.path === file?.path ? view.canvas : undefined;
    const node = canvas?.nodes?.get(nodeId);
    if (!canvas || !node) return;
    if ([...(canvas.selection ?? [])].some((n) => n.id === nodeId)) return;
    try {
      canvas.selectOnly?.(node);
      canvas.zoomToSelection?.();
    } catch {
      /* canvas internals changed: the canvas is open, unzoomed */
    }
  }

  /** Page preview of a nested diagram's original (Mod-hover). */
  private hoverOrigin(evt: MouseEvent, root: HTMLElement, origin: NestedOrigin): void {
    let hoverParent: unknown = root;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const mv = leaf.view;
      if (mv instanceof MarkdownView && mv.containerEl.contains(root)) {
        hoverParent = mv;
        break;
      }
    }
    try {
      this.app.workspace.trigger("hover-link", {
        event: evt,
        source: PLUGIN_ID,
        hoverParent,
        targetEl: root,
        linktext: lazy.mehrpele().originLinktext(origin),
        sourcePath: origin.sourcePath,
      });
    } catch {
      /* page preview unavailable */
    }
  }

  showMehrpeleMenu(shell: MehrpeleShell, evt: MouseEvent): void {
    return showMehrpeleMenu(this, shell, evt);
  }

  repairShell(shell: MehrpeleShell): Promise<void> {
    return lazy.repairHost().repairShell(this, shell);
  }

  openLightbox(frame: DiagramFrame): void {
    const sameNote = [...this.frames].filter((f) => f.sourcePath === frame.sourcePath);
    const list = sameNote.length > 0 ? sameNote : [frame];
    PeleLightbox.open(list, Math.max(0, list.indexOf(frame)));
  }

  internalLink(href: string, sourcePath: string, evt?: MouseEvent): void {
    void this.app.workspace.openLinkText(
      href,
      sourcePath,
      evt ? Keymap.isModEvent(evt) : false,
    );
  }

  /** Hover preview for internal diagram links (page-preview core plugin). */
  hoverLink(evt: MouseEvent, anchor: HTMLElement, href: string, frame: DiagramFrame): void {
    let hoverParent: unknown = frame.root;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const mv = leaf.view;
      if (mv instanceof MarkdownView && mv.containerEl.contains(frame.root)) {
        hoverParent = mv;
        break;
      }
    }
    try {
      this.app.workspace.trigger("hover-link", {
        event: evt,
        source: PLUGIN_ID,
        hoverParent,
        targetEl: anchor,
        linktext: href,
        sourcePath: frame.sourcePath,
      });
    } catch {
      /* page preview unavailable */
    }
  }

  showFrameMenu(frame: DiagramFrame, evt: MouseEvent): void {
    return showFrameMenu(this, frame, evt);
  }

  /** Re-apply current settings to every live diagram (zoom/size/font changes). */
  refreshLiveMounts(): void {
    for (const frame of [...this.frames]) frame.applySettings();
    for (const shell of [...this.mehrShells]) shell.syncEdit();
  }

  ensureChildBlockId(sourcePath: string, fenceLine: number, source: string, frameRoot: HTMLElement): Promise<string | null> {
    return ensureChildBlockId(this, sourcePath, fenceLine, source, frameRoot);
  }

  copyDiagramLink(target: { sourcePath: string; ensureBlockId(): Promise<string | null> }, kind: "uri" | "wikilink"): Promise<void> {
    return copyDiagramLink(this, target, kind);
  }

  // -- width persistence / code reveal for processor-rendered diagrams -------

  /** Markdown leaves, the one showing `el` first: with the note open twice, its editor gets the edit (and the undo step). */
  private markdownLeavesFrom(el: HTMLElement | undefined): WorkspaceLeaf[] {
    const all = this.app.workspace.getLeavesOfType("markdown");
    const own = el ? all.find((l) => l.view.containerEl.contains(el)) : undefined;
    return own ? [own, ...all.filter((l) => l !== own)] : all;
  }

  persistSizeInFile(sourcePath: string, fenceLine: number, edit: FenceSizeEdit, source: string, frameRoot?: HTMLElement): void {
    // In Live Preview write through the editor: one undoable change, and no
    // vault.process racing the editor's own pending save.
    if (frameRoot?.closest(".cm-preview-code-block")) {
      for (const leaf of this.markdownLeavesFrom(frameRoot)) {
        const mv = leaf.view;
        if (!(mv instanceof MarkdownView) || mv.file?.path !== sourcePath) continue;
        const cm = (mv.editor as unknown as { cm?: EditorView }).cm;
        if (!cm) break;
        const hit = locateBlockForPersist(cm.state.doc.toString(), fenceLine, source);
        if (hit.kind !== "found") {
          new Notice("Pele: could not locate that diagram; width not saved.");
          return;
        }
        const line = cm.state.doc.line(hit.line + 1);
        const next = serializeFenceSize(line.text, edit);
        if (next !== line.text) {
          cm.dispatch({ changes: { from: line.from, to: line.to, insert: next }, annotations: isolateHistory.of("full"), scrollIntoView: false });
        }
        return;
      }
    }
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;
    let located = false;
    let written: [before: string, after: string] | null = null;
    void this.app.vault
      .process(file, (data) => {
        // Re-locate the block in the current text: the processor-time line
        // is only trusted when the fence and following source still match.
        const hit = locateBlockForPersist(data, fenceLine, source);
        if (hit.kind !== "found") return data;
        located = true;
        const lines = data.split("\n");
        const next = serializeFenceSize(lines[hit.line], edit);
        if (next === lines[hit.line]) return data; // unchanged: no write
        lines[hit.line] = next;
        const out = lines.join("\n");
        written = [data, out];
        return out;
      })
      .then(() => {
        // Recorded once written: a failed write leaves nothing to undo.
        if (written) this.diagramUndo.record(sourcePath, written[0], written[1], "diagram size");
        if (!located) new Notice("Pele: could not locate that diagram; width not saved.");
      });
  }

  /** Move the editor cursor into a fenced block in the leaf showing sourcePath. */
  revealInEditor(sourcePath: string, fenceLine: number): boolean {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file?.path !== sourcePath) continue;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (!cm) continue;
      try {
        const anchor = cm.state.doc.line(fenceLine + 2).from;
        cm.dispatch({ selection: { anchor }, scrollIntoView: true });
        cm.focus();
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  // -- view rebuilding ---------------------------------------------------------

  /**
   * Refresh open markdown leaves that contain one of our blocks (others are
   * never touched). `live` redraws LP editors in place (CM `setState` with the
   * same state: undo history, selection and folds are kept); `reading`
   * re-renders Reading views; `rebuild` uses `leaf.rebuildView()` (unload,
   * fallback). Requests are serialised on a queue shared across plugin
   * instances so a disable→enable cycle can't overlap two rebuilds.
   */
  refreshMarkdownLeaves(mode: RefreshMode, forceLangs: readonly string[] = []): Promise<void> {
    // rebuildView() is async (open(null), then setViewState(saved)); two
    // overlapping calls make the second capture the transient empty view and
    // close the note. Coalesce identical pending requests, run one at a time.
    // A forced request (integration toggle) is never coalesced away.
    const q = rebuildQueue();
    const forced = forceLangs.length > 0;
    if (!forced) {
      if (q.queued.has(mode)) return q.tail;
      q.queued.add(mode);
    }
    const app = this.app;
    q.tail = q.tail
      .then(async () => {
        if (!forced) q.queued.delete(mode);
        await refreshLeaves(app, mode, forceLangs);
      })
      .catch((e) => console.warn("[pele-mermaid] rebuild failed", e));
    return q.tail;
  }

  /** Settings changes / "Re-render open notes": in-place where possible. `forceLangs`: see refreshLeaves. */
  rerenderAllMarkdownViews(forceLangs?: readonly string[]): void {
    void this.refreshMarkdownLeaves("reading+live", forceLangs);
  }

  handleInternalLink(href: string, sourcePath: string): void {
    this.internalLink(href, sourcePath);
  }

  // -- repair ---------------------------------------------------------------

  /** Apply a repair for a processor-rendered frame (LP editor or Reading vault). */
  applyChildRepair(
    sourcePath: string,
    fenceLine: number,
    expected: string,
    newSource: string,
    frameRoot: HTMLElement,
  ): Promise<boolean> {
    const inLp = !!frameRoot.closest(".cm-preview-code-block");
    if (inLp) {
      for (const leaf of this.markdownLeavesFrom(frameRoot)) {
        const mv = leaf.view;
        if (!(mv instanceof MarkdownView) || mv.file?.path !== sourcePath) continue;
        const cm = (mv.editor as unknown as { cm?: EditorView }).cm;
        if (!cm) break;
        return Promise.resolve(dispatchBlockReplace(cm, fenceLine, expected, newSource));
      }
      return Promise.resolve(false);
    }
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return Promise.resolve(false);
    let written: [before: string, after: string] | null = null;
    return this.app.vault
      .process(file, (data) => {
        const r = replaceBlockBody(data, fenceLine, expected, newSource);
        if (!r.ok) return data;
        written = [data, r.text];
        return r.text;
      })
      .then(() => {
        if (!written) return false;
        // Reading view has no editor history: Mod+Z / the Undo notice use this one.
        this.diagramUndo.record(sourcePath, written[0], written[1], "diagram edit");
        return true;
      })
      .catch(() => false);
  }

  repairFrame(frame: DiagramFrame): Promise<void> {
    return lazy.repairHost().repairFrame(this, frame);
  }

  testJevConnection(): Promise<void> {
    return lazy.repairHost().testJevConnection(this);
  }

  testLlmConnection(): Promise<void> {
    return lazy.repairHost().testLlmConnection(this);
  }

  fetchOllamaModels(): Promise<void> {
    return lazy.repairHost().fetchOllamaModels(this);
  }

  // -- canvas conversion ------------------------------------------------------

  advancedCanvasInstalled(): boolean {
    return !!(this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins
      ?.plugins?.["advanced-canvas"];
  }

  /** Text of a vault file, or null when nothing (or a folder) is at `path`. */
  async readVaultText(path: string): Promise<string | null> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f) return null;
    if (!(f instanceof TFile)) return ""; // a folder: never reuse, never overwrite
    try {
      return await this.app.vault.read(f);
    } catch {
      return "";
    }
  }

  /**
   * Convert a diagram to a canvas named by its source hash. An existing canvas
   * is only regenerated when it was made from this exact diagram
   * (`metadata.pele.sourceHash`), keeping its layout and any cards/edges the
   * user added; anything else at that name gets a new numbered file.
   */
  async convertToCanvas(source: string, sourcePath: string, lang: string): Promise<string | null> {
    const file = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : null;
    const parent = file instanceof TFile && file.parent?.path ? file.parent.path : "";
    const folder = this.settings.features.canvas.outputFolder || parent;
    const baseOpts = {
      advancedCanvas: this.advancedCanvasInstalled(),
      mehrpele: lang === "mehrpele" || this.appliesMehrpele(lang, source),
      sourcePath,
    };
    const { mermaidToCanvas, sourceHash: canvasSourceHashOf, stringifyCanvas } = lazy.canvas();
    const { canvasFileName, canvasSourceHash, chooseCanvasTarget, mergeUserCanvasContent } = lazy.canvasFiles();
    const fresh = mermaidToCanvas(source, baseOpts);
    const hash = canvasSourceHash(fresh.canvas) ?? canvasSourceHashOf(source);
    const target = await chooseCanvasTarget<CanvasData>(
      (n) => canvasFileName(sourcePath || "diagram.md", hash, folder, n),
      hash,
      (p) => this.readVaultText(p),
    );
    let { canvas, dropped } = fresh;
    if (target.kind === "merge") {
      ({ canvas, dropped } = mermaidToCanvas(source, { ...baseOpts, previous: target.previous }));
      canvas = mergeUserCanvasContent(canvas, target.previous);
    }
    const text = stringifyCanvas(canvas);
    const existing = this.app.vault.getAbstractFileByPath(target.path);
    if (target.kind === "merge" && existing instanceof TFile) await this.app.vault.modify(existing, text);
    else await this.app.vault.create(target.path, text);
    const created = this.app.vault.getAbstractFileByPath(target.path);
    if (created instanceof TFile) {
      await this.app.workspace.getLeaf(true).openFile(created);
    }
    new Notice(
      `Pele: ${target.kind === "merge" ? "updated" : "wrote"} ${target.path}${dropped.length ? ` (${dropped.length} dropped: ${dropped[0]})` : ""}`,
      8000,
    );
    return target.path;
  }

  // -- Excalidraw conversion ----------------------------------------------------

  /** The built-in converter while feature "excalidraw" runs (set by src/features/register-excalidraw). */
  excalidraw: ExcalidrawApi | null = null;

  /**
   * The retired pele-excalidraw plugin is enabled: it keeps its own commands and
   * pele:excalidraw handler, so the built-in ones stand down.
   */
  excalidrawStandsDown(): boolean {
    // enabledPlugins comes from community-plugins.json, which can list a plugin that is no longer installed.
    const plugins = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string>; manifests?: Record<string, unknown> } })
      .plugins;
    return plugins?.enabledPlugins?.has("pele-excalidraw") === true && !!plugins.manifests?.["pele-excalidraw"];
  }

  /** What "Convert to Excalidraw" in the diagram menu calls: the retired plugin while it stands in, else the built-in converter. */
  excalidrawApi(): Pick<ExcalidrawApi, "createDrawing"> | null {
    if (this.excalidrawStandsDown()) {
      const plugins = (this.app as unknown as { plugins: { plugins: Record<string, { api?: never } | undefined> } }).plugins.plugins;
      return (plugins["pele-excalidraw"]?.api as never) ?? null;
    }
    return this.excalidraw;
  }
}

/** `%% pele-canvas %%` provenance of a source, as companions see it (node id → canvas id). */
function canvasProvenance(source: string): FrameProvenance | null {
  if (!source.includes("pele-canvas")) return null; // no marker: skip loading the canvas module
  const p = lazy.canvas().parseProvenance(source);
  if (!p) return null;
  const nodes: FrameProvenance["nodes"] = {};
  for (const [id, box] of p.nodes) nodes[id] = { canvasId: box.canvasId };
  return { nodes };
}

/**
 * A Reading-view fence's live line and info-string rest, from its section info. Not exact:
 * it updates after the editor, and a hidden Reading view's stays stale until shown (null
 * then). Its frame follows the handle's editor surface when there is one (HandleRegistry.resync).
 */
function readingLocate(ctx: MarkdownPostProcessorContext, el: HTMLElement): FenceLocation | null {
  if (!el.isConnected || el.offsetParent === null) return null;
  try {
    const info = ctx.getSectionInfo(el);
    if (!info) return null;
    return { line: info.lineStart, rest: fenceRestOf(fenceLineAt(info.text, info.lineStart)) };
  } catch {
    return null;
  }
}
