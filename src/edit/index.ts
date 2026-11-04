/**
 * Diagram editing: hover/select toolbar + rendered inline label editor.
 * Frames call `attachEditing` once (DiagramFrame through FrameHost.attachEdit,
 * MehrpeleShell directly) and the returned function on destroy.
 */
import type { App } from "obsidian";
import type { SettingsV3 } from "../settings/schema";
import { editOptions } from "./settings";
import { suggestLabels, type CompletionModel } from "./autocomplete";
import { attachFrameActions } from "./frame-actions";
import { actionBarOf, attachFloatingActions } from "./float-actions";
import { retainModIcons } from "./mod-icons";
import { EditToolbarLayer } from "./toolbar";

export { DEFAULT_EDIT_SETTINGS, normalizeEditSettings, type EditSettings } from "./settings";

/** The plugin surface editing needs (PeleMermaidPlugin satisfies it). */
export interface EditPlugin {
  app: App;
  settings: SettingsV3;
  isMehrpeleBlock(lang: string, source: string): boolean;
  /** The configured autocomplete model; undefined = off or not configured. */
  nodeAutocomplete?(): CompletionModel | undefined;
  /** Open this plugin's settings tab. */
  openPluginSettings?(): void;
  /** Write a diagram to a canvas next to its note and open it (code button, Mod-click). */
  convertToCanvas?(source: string, sourcePath: string, lang: string): Promise<string | null>;
}

/** One rendered diagram (plain frame or Mehrpele shell). */
export interface EditableFrame {
  root: HTMLElement;
  wrapper: HTMLElement;
  lang: string;
  sourcePath: string;
  // Function-typed (not methods): attachEditing hands them to the toolbar layer as plain callbacks.
  svg: () => SVGSVGElement | null;
  source: () => string;
  diagramType: () => string | null;
  /** Layout direction the reflow plan shows ("TB", "LR", "authored", …). */
  direction?: () => string | null;
  /** Edits reach the note (or the enclosing label); false hides the toolbar. */
  writable: () => boolean;
  persist: (next: string, what: string) => Promise<boolean>;
}

export function attachEditing(plugin: EditPlugin, frame: EditableFrame): () => void {
  const layer = new EditToolbarLayer({
    app: plugin.app,
    root: frame.root,
    wrapper: frame.wrapper,
    svg: frame.svg,
    source: frame.source,
    diagramType: frame.diagramType,
    sourcePath: frame.sourcePath,
    settings: () => editOptions(plugin.settings),
    labelMode: () => {
      const markdownBlock = plugin.isMehrpeleBlock(frame.lang, frame.source());
      const canSwitch =
        !markdownBlock &&
        plugin.settings.features["live-view"].enabled &&
        (frame.lang === "mermaid" || frame.lang === "pele");
      return { markdownBlock, canSwitch };
    },
    writable: frame.writable,
    persist: frame.persist,
    ...(frame.direction ? { direction: frame.direction } : {}),
    suggest: (req) => {
      const model = plugin.nodeAutocomplete?.();
      return model ? suggestLabels(model, req) : null;
    },
    openSettings: () => plugin.openPluginSettings?.(),
    zoom: (nodeId) => zoomFor(frame.root, nodeId),
  });
  // Modified clicks on zoom / code, and modifier-aware icons in the window the
  // frame is in once the pointer reaches it (it is built before it is placed,
  // possibly in a popout).
  const detachActions = attachFrameActions(plugin, frame);
  // A clipped action bar (nested frames) floats above the diagram while hovered.
  const detachFloat = attachFloatingActions(frame.root);
  let modWin: Window | null = null;
  let releaseMod = (): void => undefined;
  const watchMods = (): void => {
    const win = frame.root.ownerDocument.defaultView;
    if (win === modWin) return;
    releaseMod();
    modWin = win;
    releaseMod = retainModIcons(win);
  };
  frame.root.addEventListener("pointerenter", watchMods);
  return () => {
    layer.destroy();
    detachActions();
    detachFloat();
    frame.root.removeEventListener("pointerenter", watchMods);
    releaseMod();
  };
}

/** A frame's own zoom action (its action bar's), wherever the bar is shown. */
function frameZoom(root: HTMLElement): HTMLElement | null {
  const bar = actionBarOf(root);
  return bar?.querySelector<HTMLElement>(":scope > .pele-zoom-action, :scope > .embed-action:has(> .lucide-zoom-in)") ?? null;
}

/** The zoom for a node: its nested diagram's (in this frame's overlay) when it has one, else the frame's. */
export function zoomFor(root: HTMLElement, nodeId: string | null): (() => void) | null {
  const items = nodeId ? Array.from(root.querySelectorAll<HTMLElement>(`.mehrpele-overlay-item[data-anchor="${CSS.escape(nodeId)}"]`)) : [];
  const own = items.find((i) => i.parentElement?.closest(".pele-embed") === root);
  const nested = own?.querySelector<HTMLElement>(".pele-embed");
  const btn = (nested && frameZoom(nested)) ?? frameZoom(root);
  return btn ? () => btn.click() : null;
}
