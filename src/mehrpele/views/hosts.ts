/**
 * Live view hosts: the content a view node shows, mounted into a container
 * the stage owns (stage.ts). Each mirrors what Obsidian itself does:
 *
 * - web: Canvas link cards — desktop `<webview>` in the vault's browser
 *   partition (`app.getWebviewPartition()`) when the core Web viewer has set
 *   up that partition, no popups, no Node integration; otherwise (mobile too) a
 *   sandboxed `<iframe>` with Canvas's sandbox flags. Navigation is held to
 *   the allowed schemes (obsidian:// and file:// never load).
 * - pdf: Canvas file cards — the embed registry's PDF embed (the native
 *   viewer: toolbar, pages, zoom, text selection) at `#page=N`.
 * - view: any registered workspace view, in a WorkspaceLeaf of a detached
 *   WorkspaceSplit (Excalidraw's embeddable technique, minus its getRoot
 *   patch): the split has no parent, so `workspace.isAttached(leaf)` is
 *   false — the leaf never becomes active, never steals focus, and
 *   `getLayout()` (workspace.json) never sees it. File views are pinned so
 *   they keep their note instead of following the active file. The global
 *   graph's option saver is shadowed: a filtered graph in a node never
 *   writes graph.json.
 */
import { Component, MarkdownRenderer, Platform, TFile, setIcon, type App, type View, type WorkspaceLeaf } from "obsidian";
import * as obsidian from "obsidian";
import type { BuiltViewState } from "./state";
import { isAppOrigin, isGuardedScheme, webUrlAllowed, type ViewNodeSettings } from "./settings";

export interface LiveView {
  /** The view's root inside the dock content. */
  el: HTMLElement;
  /** Title for chrome (page title, view name). */
  title(): string;
  destroy(): void;
  /** Re-fit after a size change the view's own observers may miss. */
  resize?(): void;
  reload?(): void;
  /** The hosted workspace view (diagnostics). */
  view?: View;
}

export class HostError extends Error {
  constructor(
    message: string,
    /** The real view can still be opened in a sidebar. */
    readonly canOpenInSidebar = false,
  ) {
    super(message);
  }
}

// -- web -------------------------------------------------------------------

interface WebviewLike extends HTMLElement {
  src: string;
  partition: string;
  allowpopups: boolean;
  stop(): void;
  reload(): void;
  getTitle(): string;
  getURL(): string;
  loadURL(url: string): Promise<void>;
  isLoading(): boolean;
}

export interface WebHostOptions {
  settings: ViewNodeSettings;
  onTitle?(title: string): void;
  onBlocked?(url: string): void;
  onFirstPaint?(): void;
}

/**
 * The vault's webview partition, only once Obsidian has configured it
 * (permission allowlist, UA string, request filters). The core Web viewer does
 * that when it is enabled on desktop. A partition nobody configured would get
 * Electron's defaults, which grant every permission request, so without the
 * Web viewer pages load in the sandboxed iframe instead.
 */
function configuredWebviewPartition(app: App): string | null {
  if (!Platform.isDesktopApp || !isInternalPluginEnabled(app, "webviewer")) return null;
  const getPartition = (app as unknown as { getWebviewPartition?: () => string }).getWebviewPartition;
  return getPartition ? getPartition.call(app) || null : null;
}

/** A web page like a Canvas link card. Throws HostError when it may not load. */
export function mountWeb(app: App, url: string, parent: HTMLElement, o: WebHostOptions): LiveView {
  if (!o.settings.webEnabled) throw new HostError("Web pages in nodes are off (Settings › Mehrpele › View nodes)");
  if (!webUrlAllowed(url, o.settings)) throw new HostError(`Blocked URL scheme: ${url.split(":")[0]}:`);
  // Mobile iframes keep allow-same-origin (pages need their own storage): a
  // page from the app's own origin (Android: http://localhost) would then
  // run with the app's privileges.
  if (isAppOrigin(url, window.location.origin)) throw new HostError("Blocked: the app's own address");
  let title = url;
  const partition = configuredWebviewPartition(app);
  if (partition) {
    // `<webview>` is an Electron tag, not in HTMLElementTagNameMap, so Obsidian's
    // typed `createEl` can't name it. createElementNS in the XHTML namespace is
    // the same DOM "create an element" step as createElement on an HTML document.
    const wv = parent.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "webview") as WebviewLike;
    wv.partition = partition;
    wv.allowpopups = false;
    wv.addClass("mehrpele-view-webview");
    const guard = (target: string): boolean => {
      if (!target || target === "about:blank" || webUrlAllowed(target, o.settings)) return true;
      try {
        wv.stop();
      } catch {
        /* not attached yet */
      }
      o.onBlocked?.(target);
      return false;
    };
    // Main frame: only allowed schemes (redirects included). Sub-frames may
    // use about:/data:/blob:, but never obsidian:, file: or other app schemes.
    const onNav = (e: Event): void => {
      const ev = e as unknown as { url: string; isMainFrame?: boolean };
      if (ev.isMainFrame === false) {
        if (isGuardedScheme(ev.url)) guard(ev.url);
      } else guard(ev.url);
    };
    wv.addEventListener("will-navigate", onNav);
    wv.addEventListener("will-frame-navigate", onNav);
    wv.addEventListener("did-start-navigation", onNav);
    wv.addEventListener("did-redirect-navigation", onNav);
    wv.addEventListener("page-title-updated", () => {
      try {
        title = wv.getTitle() || title;
        o.onTitle?.(title);
      } catch {
        /* detached */
      }
    });
    wv.addEventListener("dom-ready", () => o.onFirstPaint?.(), { once: true });
    wv.src = url;
    parent.appendChild(wv);
    return {
      el: wv,
      title: () => title,
      destroy: () => wv.remove(),
      reload: () => {
        try {
          wv.reload();
        } catch {
          /* not ready */
        }
      },
    };
  }
  // Mobile, or desktop without the Web viewer: Canvas's iframe fallback.
  const frame = parent.createEl("iframe", { cls: "mehrpele-view-iframe" });
  frame.setAttr("sandbox", "allow-forms allow-presentation allow-same-origin allow-scripts allow-modals");
  frame.setAttr("allow", "fullscreen");
  frame.setAttr("referrerpolicy", "no-referrer");
  frame.addEventListener("load", () => o.onFirstPaint?.(), { once: true });
  frame.src = url;
  return {
    el: frame,
    title: () => title,
    destroy: () => frame.remove(),
    reload: () => {
      frame.src = url;
    },
  };
}

// -- pdf -------------------------------------------------------------------

interface EmbedChild extends Component {
  loadFile?(): Promise<void> | void;
}

type EmbedCreator = (
  ctx: { app: App; containerEl: HTMLElement; linktext: string; sourcePath: string; depth: number; showInline?: boolean },
  file: TFile,
  subpath: string,
) => EmbedChild | null;

/** A PDF in Obsidian's native viewer (the same embed Canvas file cards use). */
export async function mountPdf(
  app: App,
  file: TFile,
  subpath: string,
  sourcePath: string,
  parent: HTMLElement,
  owner: Component,
): Promise<LiveView> {
  const component = new Component();
  owner.addChild(component);
  const el = parent.createDiv({ cls: "mehrpele-view-pdf" });
  const creator = (app as unknown as { embedRegistry?: { embedByExtension?: Record<string, EmbedCreator> } }).embedRegistry
    ?.embedByExtension?.pdf;
  let ok = false;
  if (typeof creator === "function") {
    try {
      const embed = creator({ app, containerEl: el, linktext: file.path + subpath, sourcePath, depth: 0 }, file, subpath);
      if (embed) {
        component.addChild(embed);
        await embed.loadFile?.();
        el.addClass("pdf-embed", "is-loaded");
        ok = true;
      }
    } catch (e) {
      console.warn("[mehrpele] pdf embed failed, falling back to Markdown", e);
      el.empty();
    }
  }
  if (!ok) {
    await MarkdownRenderer.render(app, `![[${file.path}${subpath}]]`, el, sourcePath, component);
  }
  return {
    el,
    title: () => `${file.basename}${subpath}`,
    destroy: () => {
      try {
        owner.removeChild(component);
      } catch {
        component.unload();
      }
      el.remove();
    },
  };
}

// -- workspace views -------------------------------------------------------

interface ViewRegistryLike {
  getViewCreatorByType?(type: string): ((leaf: WorkspaceLeaf) => View) | undefined;
  viewByType?: Record<string, (leaf: WorkspaceLeaf) => View>;
}

interface GraphViewLike extends View {
  onOptionsChange?: () => void;
  dataEngine?: {
    getOptions?(): Record<string, unknown>;
    setOptions?(o: Record<string, unknown>): void;
    requestUpdateSearch?: { run?(): void };
  };
  update?(): void;
  onResize(): void;
}

export function viewCreator(app: App, type: string): ((leaf: WorkspaceLeaf) => View) | null {
  const reg = (app as unknown as { viewRegistry?: ViewRegistryLike }).viewRegistry;
  return reg?.getViewCreatorByType?.(type) ?? reg?.viewByType?.[type] ?? null;
}

export function isInternalPluginEnabled(app: App, id: string): boolean {
  const ip = (app as unknown as { internalPlugins?: { getEnabledPluginById?(id: string): unknown } }).internalPlugins;
  return !!ip?.getEnabledPluginById?.(id);
}

let quiet: { app: App; ws: unknown } | null = null;

/** The workspace, minus layout-change bookkeeping (for detached splits only). */
function quietWorkspace(app: App): unknown {
  if (quiet?.app !== app) {
    const ws: unknown = Object.create(app.workspace, {
      onLayoutChange: { value: () => undefined },
      requestResize: { value: () => undefined },
      requestSaveLayout: { value: () => undefined },
    });
    quiet = { app, ws };
  }
  return quiet.ws;
}

/** Mount a workspace view of `built.type` into `parent`. Throws HostError. */
export async function mountLeafView(app: App, built: BuiltViewState, parent: HTMLElement, o: { header: boolean; controls: boolean }): Promise<LiveView> {
  if (built.core?.desktopOnly && !Platform.isDesktopApp) throw new HostError(`${built.title} is desktop-only`, false);
  if (built.core && !isInternalPluginEnabled(app, built.core.plugin)) {
    throw new HostError(`${built.title}: enable the core plugin in Settings › Core plugins`);
  }
  const creator = viewCreator(app, built.type);
  if (!creator) throw new HostError(`Unknown view “${built.type}” — is its plugin installed and enabled?`);
  const Split = (obsidian as unknown as { WorkspaceSplit: new (ws: unknown, dir: string) => { containerEl: HTMLElement } }).WorkspaceSplit;
  // Inserting/removing children calls `this.workspace.onLayoutChange()`,
  // which schedules a layout save, a resize of every leaf (Reading views
  // then re-apply a stale scroll position: the note jumps) and
  // layout-change events. The detached split talks to a quiet delegate.
  const split = new Split(quietWorkspace(app), "vertical");
  split.containerEl.addClass("mehrpele-view-split");
  parent.appendChild(split.containerEl);
  const leaf = app.workspace.createLeafInParent(split as unknown as obsidian.WorkspaceSplit, 0);
  // Bound to its note (linked views follow the active file otherwise).
  if (built.file) (leaf as unknown as { pinned: boolean }).pinned = true;
  let view: View;
  try {
    view = creator(leaf);
    const gv = view as GraphViewLike;
    // The global graph saves its options to graph.json on every change
    // (and on zoom, polled every 2 s): a node's filter must never leak there.
    if (built.type === "graph") gv.onOptionsChange = () => undefined;
    await leaf.open(view);
    await view.setState(built.state, { history: false });
    if (built.graphOptions && built.type === "graph" && gv.dataEngine?.setOptions) {
      const base = gv.dataEngine.getOptions?.() ?? {};
      gv.dataEngine.setOptions({ ...base, ...built.graphOptions });
      gv.dataEngine.requestUpdateSearch?.run?.();
      gv.update?.();
    }
  } catch (e) {
    try {
      leaf.detach();
    } catch {
      /* half-open */
    }
    split.containerEl.remove();
    throw new HostError(`${built.title} could not be shown here: ${(e as Error)?.message ?? e}`, true);
  }
  split.containerEl.toggleClass("mehrpele-view-has-header", o.header);
  // Graph views open with their control panel closed (controls=1 keeps it).
  if (!o.controls) view.containerEl.querySelectorAll(".graph-controls").forEach((c) => c.addClass("is-close"));
  return {
    el: split.containerEl,
    view,
    title: () => {
      try {
        return view.getDisplayText() || built.title;
      } catch {
        return built.title;
      }
    },
    resize: () => {
      try {
        (view as GraphViewLike).onResize?.();
      } catch {
        /* closed */
      }
    },
    destroy: () => {
      try {
        leaf.detach();
      } catch {
        /* already closed */
      }
      split.containerEl.remove();
    },
  };
}

/** Open the real view in the right sidebar (the "Open in sidebar" fallback). */
export async function openInSidebar(app: App, built: BuiltViewState): Promise<void> {
  const leaf = app.workspace.getRightLeaf(false);
  if (!leaf) return;
  const state = built.type === "graph" ? {} : built.state;
  // Pin first: linked views replace `file` with the active note unless pinned.
  if (built.file) leaf.setPinned(true);
  await leaf.setViewState({ type: built.type, state, active: true });
  await app.workspace.revealLeaf(leaf);
}

/** Small "icon + text + actions" chip (errors, unavailable views, paused). */
export function chip(parent: HTMLElement, icon: string, text: string, actions: { label: string; icon: string; run: (e: MouseEvent) => void }[] = []): HTMLElement {
  const el = parent.createDiv({ cls: "mehrpele-view-chip" });
  setIcon(el.createSpan({ cls: "mehrpele-view-chip-icon" }), icon);
  el.createSpan({ cls: "mehrpele-view-chip-text", text });
  for (const a of actions) {
    const b = el.createEl("button", { cls: "mehrpele-view-chip-action" });
    setIcon(b.createSpan(), a.icon);
    b.createSpan({ text: a.label });
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      a.run(e);
    });
  }
  return el;
}
