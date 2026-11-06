/** The FrameHost adapter DiagramFrame uses to reach the plugin. */
import { getIcon } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { type FrameHost } from "./diagram-frame";
import { isolateHistory } from "@codemirror/commands";
import { replaceBlockBody } from "./replace-block";
import type PeleMermaidPlugin from "../main";

/**
 * Replace one diagram block's body in a CM editor with a single undoable
 * change. The block is located by fence + exact body + closing fence (see
 * replaceBlockBody); false when it can't be located uniquely.
 */
export function dispatchBlockReplace(cm: EditorView, fenceLine: number, oldSource: string, newSource: string): boolean {
  try {
    const doc = cm.state.doc;
    const located = replaceBlockBody(doc.toString(), fenceLine, oldSource, newSource);
    if (!located.ok) return false;
    const oldCount = oldSource.replace(/\n$/, "").split("\n").length;
    const from = doc.line(located.fenceLine + 2).from;
    const to = doc.line(located.fenceLine + 1 + oldCount).to;
    // Its own undo step, never merged with typing just before or after.
    cm.dispatch({ changes: { from, to, insert: newSource.replace(/\n$/, "") }, annotations: isolateHistory.of("full"), scrollIntoView: false });
    return true;
  } catch {
    return false;
  }
}

/** Adapt the plugin to DiagramFrame's FrameHost (settings() as a method). */
export function frameHostOf(plugin: PeleMermaidPlugin): FrameHost {
  return {
    app: plugin.app,
    settings: () => plugin.settings,
    undoLatest: (path) => plugin.diagramUndo.undoLatest(path),
    repair: (f) => void plugin.repairFrame(f),
    openLightbox: (f) => plugin.openLightbox(f),
    internalLink: (href, path, evt) => plugin.internalLink(href, path, evt),
    hoverLink: (evt, anchor, href, frame) => plugin.hoverLink(evt, anchor, href, frame),
    contextMenu: (frame, evt) => plugin.showFrameMenu(frame, evt),
    iconSvg: (name) => {
      try {
        const el = getIcon(name);
        return el ? el.outerHTML : undefined;
      } catch {
        return undefined;
      }
    },
    registerFrame: (f) => plugin.registerFrame(f),
    unregisterFrame: (f) => plugin.unregisterFrame(f),
    suspendFrame: (f) => plugin.suspendFrame(f),
    frameRendered: (f) => plugin.frameRendered(f),
    heightChanged: (el) => plugin.remeasureSection(el),
    // pele-edit
    attachEdit: (f, writable) =>
      plugin.attachEdit({
        root: f.root,
        wrapper: f.wrapper,
        lang: f.lang,
        sourcePath: f.sourcePath,
        svg: () => f.wrapper.querySelector<SVGSVGElement>(":scope > .pele-mount > svg"),
        source: () => f.source,
        diagramType: () => f.diagramType,
        direction: () => f.planDirection,
        writable,
        persist: (next, what) => f.persistSource(next, what),
      }),
  };
}
