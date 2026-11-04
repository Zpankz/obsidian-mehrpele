/**
 * View nodes through the embed-renderer seam (embeds.ts): a sole-embed label
 * naming a web page, a PDF or a `view:` becomes a viewport slot whose live
 * content is docked on the frame's view stage (stage.ts).
 */
import { Keymap, TFile, type App, type Component } from "obsidian";
import { registerEmbedRenderer, embedBoxSize, type MehrpeleEmbedContext } from "../embeds";
import type { MehrpeleEmbedTarget } from "../model";
import { setViewportBox } from "../viewport";
import { chip, mountLeafView, mountPdf, mountWeb, openInSidebar, type LiveView } from "./hosts";
import { ViewHub, type DockSource, type ViewStage } from "./stage";
import { buildViewState, isStateError, type BuiltViewState } from "./state";
import { isNodeViewTarget, parseBool, parseNodeViewTarget, viewSpecKey, type NodeViewSpec, type ViewNodeSpec } from "./syntax";
import { WEB_OFF, webBlockReason, type ViewNodeSettings } from "./settings";
import { bareFolderTarget, mountFolder, revealFolder, saveFolderBase } from "./folder";

export interface ViewNodesHost {
  app: App;
  settings(): ViewNodeSettings;
  /** Mehrpele itself is on (view nodes are Mehrpele labels). */
  notify(message: string): void;
}

export const SLOT_CLASS = "mehrpele-view-slot";

/** Resolve a written note/file linkpath against the note. */
export function resolvePath(app: App, linkpath: string, sourcePath: string): TFile | null {
  const f = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
  return f instanceof TFile ? f : null;
}

/** Built state for a `view:` spec in a note (errors as messages). */
export function stateFor(app: App, spec: ViewNodeSpec, sourcePath: string, defaultFile: string | null, settings: ViewNodeSettings): BuiltViewState | { error: string } {
  return buildViewState(spec, {
    defaultFile,
    resolveFile: (lp) => resolvePath(app, lp, sourcePath)?.path ?? null,
    defaultDepth: settings.defaultLocalGraphDepth,
  });
}

/** The dock source (what to mount, how to open the original) for a spec. */
export function dockSourceFor(
  host: ViewNodesHost,
  hub: ViewHub,
  spec: NodeViewSpec,
  key: string,
  sourcePath: string,
  defaultFile: string | null,
): DockSource | { error: string } {
  const { app } = host;
  const settings = host.settings();
  if (spec.kind === "web") {
    // Blocked or disabled pages get a chip, never a dock (no open action either).
    const blocked = webBlockReason(spec.url, settings);
    if (blocked) return { error: blocked };
    let hostName = spec.url;
    try {
      hostName = new URL(spec.url).host || spec.url;
    } catch {
      /* keep */
    }
    return {
      key,
      title: hostName,
      icon: "lucide-globe",
      originTooltip: "Open page (⌘/Ctrl: in browser)",
      mount: async (content, _owner, setTitle) =>
        mountWeb(app, spec.url, content, {
          settings: host.settings(),
          onTitle: setTitle,
          onBlocked: (u) => host.notify(`Blocked navigation to ${u.split(":")[0]}:// in a web node`),
        }),
      openOriginal: (evt) => openWeb(app, spec.url, Keymap.isModEvent(evt) !== false, host.settings()),
    };
  }
  if (spec.kind === "folder") {
    const f = spec.folder;
    const name = f.path ? f.path.split("/").pop()! : "Vault";
    return {
      key,
      title: name,
      icon: "lucide-folder-open",
      originTooltip: `Reveal ${f.path || "the vault root"} in the file explorer`,
      mount: (content, owner) => mountFolder(app, f, sourcePath, content, owner),
      openOriginal: () => revealFolder(app, f),
      actions: [{ icon: "lucide-file-plus-2", label: "Save as .base (next to this note)", run: () => void saveFolderBase(app, f, sourcePath) }],
    };
  }
    if (spec.kind === "pdf") {
    const file = resolvePath(app, spec.file, sourcePath);
    if (!file) return { error: `PDF not found: ${spec.file}` };
    return {
      key,
      title: `${file.basename}${spec.subpath}`,
      icon: "lucide-file-text",
      originTooltip: `Open ${file.name}${spec.subpath}`,
      mount: (content, owner) => mountPdf(app, file, spec.subpath, sourcePath, content, owner),
      openOriginal: (evt) => void app.workspace.openLinkText(`${file.path}${spec.subpath}`, sourcePath, Keymap.isModEvent(evt)),
    };
  }
  const built = stateFor(app, spec, sourcePath, defaultFile, settings);
  if (isStateError(built)) return built;
  const b = built;
  // The Web viewer view loads its URL like a web node: same switch, same schemes.
  if (b.type === "webviewer" && typeof b.state.url === "string") {
    const blocked = webBlockReason(b.state.url, settings);
    if (blocked) return { error: blocked };
  } else if (b.type === "webviewer" && !settings.webEnabled) return { error: WEB_OFF };
  // A note view of the note holding the diagram would nest itself.
  if (b.type === "markdown" && b.state.file === sourcePath) return { error: "A note can't show itself in its own diagram" };
  const header = parseBool(spec.params.header) ?? false;
  const controls = parseBool(spec.params.controls) ?? false;
  return {
    key,
    title: b.file ? `${b.title}: ${b.file.split("/").pop()?.replace(/\.md$/i, "")}` : b.title,
    icon: b.core?.icon ?? "lucide-layout-panel-top",
    originTooltip: "Open in sidebar",
    mount: (content): Promise<LiveView> => mountLeafView(app, b, content, { header, controls }),
    openOriginal: () => void openInSidebar(app, b),
    openInSidebar: () => void openInSidebar(app, b),
  };
}

function openWeb(app: App, url: string, external: boolean, settings: ViewNodeSettings): void {
  if (webBlockReason(url, settings)) return;
  const ip = (app as unknown as { internalPlugins?: { getEnabledPluginById?(id: string): unknown } }).internalPlugins;
  if (!external && ip?.getEnabledPluginById?.("webviewer")) {
    void app.workspace.getLeaf("tab").setViewState({ type: "webviewer", state: { url, navigate: true }, active: true });
    return;
  }
  window.open(url, "_blank");
}

/**
 * Register the view-node embed renderer. Returns the hub (owned by the
 * plugin; destroy it on unload).
 */
export function registerViewNodeRenderer(host: ViewNodesHost): { hub: ViewHub; unregister: () => void } {
  const hub = new ViewHub(host.app, () => host.settings().maxLiveViews);
  const unregister = registerEmbedRenderer(
    // Folders by name (`![[Projects]]`) are only known with the vault at hand.
    (t: MehrpeleEmbedTarget) => host.settings().enabled && (isNodeViewTarget(t) || !!bareFolderTarget(host.app, t, "")),
    (target, el, ctx) => renderViewSlot(host, hub, target, el, ctx),
  );
  return { hub, unregister };
}

function renderViewSlot(host: ViewNodesHost, hub: ViewHub, target: MehrpeleEmbedTarget, el: HTMLElement, ctx: MehrpeleEmbedContext): boolean {
  const bare = bareFolderTarget(host.app, target, ctx.sourcePath);
  const spec: NodeViewSpec | { error: string } | null = bare ? { kind: "folder", folder: bare } : parseNodeViewTarget(target);
  if (!spec) return false;
  // A fixed viewport box (notes grow with their content; views fill a box).
  el.removeClass("mehrpele-embed-auto");
  el.addClass(SLOT_CLASS);
  setViewportBox(el, embedBoxSize(target, ctx.settings));
  if ("error" in spec) {
    chip(el, "alert-triangle", spec.error);
    return true;
  }
  const anchor = el.dataset.anchorId ?? "";
  if (!el.closest(".mehrpele-frame")) {
    chip(el, "alert-triangle", "View nodes need a Mehrpele diagram");
    return true;
  }
  // Identity: the note, the node and the view (another note's node A never adopts this one).
  const src = dockSourceFor(host, hub, spec, `${anchor}\u0000${viewSpecKey(spec)}\u0000${ctx.sourcePath}`, ctx.sourcePath, ctx.sourcePath);
  if ("error" in src) {
    chip(el, "alert-triangle", src.error);
    return true;
  }
  el.dataset.viewKind = (spec).kind === "view" ? (spec).type : (spec).kind;
  const component = (ctx as MehrpeleEmbedContext & { component?: Component }).component;
  let released = false;
  let stage: ViewStage | null = null;
  component?.register(() => {
    released = true;
    stage?.release(el);
  });
  // Attach once the slot is placed in the overlay: labels render detached
  // (Reading view inserts the section after) and in the measure host first,
  // and only placed slots may claim a dock — so twins and overlapping render
  // cycles can't take each other's (a superseded slot is never placed).
  let tries = 0;
  const attach = (): void => {
    if (released) return;
    stage = el.closest(".mehrpele-overlay") ? hub.stageFor(el) : null;
    if (stage) stage.attach(el, src);
    else if (tries++ < 1800) window.requestAnimationFrame(attach);
  };
  attach();
  return true;
}
