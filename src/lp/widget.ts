/** Live Preview widget construction, block ids and size write-back. */
import {
  MarkdownView, Notice, TFile
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import { DiagramFrame } from "../diagram-frame";
import type { MehrpeleShell } from "../mehrpele/shell";
import { isolateHistory } from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import { findOpeningFenceLine } from "../fence-locate";
import { fenceRestOf, parseFenceSize, serializeFenceSize, type FenceSize, type FenceSizeEdit } from "../info-width";
import { advancedUri, openUri, planFenceBlockId, wikilinkToBlock, type BlockIdPlan } from "../diagram-link";
import { type LpWidgetLike } from "../lp-patch";
import { escapeToEditor } from "./focus-actions";
import { lpLocate } from "./locate";
import { isCannoliFence, parsePeleSource } from "../api/pele-source";
import type PeleMermaidPlugin from "../../main";
import { dispatchBlockReplace, frameHostOf } from "../frame-host";
import { generatorContext, mehrpeleShell } from "../features/lazy";

// -- Live Preview widget construction --------------------------------------

export function buildLpWidgetDOM(plugin: PeleMermaidPlugin, widget: LpWidgetLike, view: EditorView): HTMLElement | null {
  const s = createDiv();
  s.className = `cm-preview-code-block cm-embed-block markdown-rendered cm-lang-${widget.lang}`;
  s.tabIndex = -1;
  widget.containerEl = s;
  escapeToEditor(s, view);
  buildLpFrame(plugin, widget, view, s);
  try {
    widget.resizeWidget?.(view, s);
  } catch {
    /* base helper unavailable */
  }
  return s;
}

/**
 * Hand-edited fence width in LP: the widget instance is reused unchanged,
 * so locate its frame by mapping the fence line to the widget container
 * DOM and apply the new width (undefined = back to natural).
 */
export function applyLpFenceWidths(
  plugin: PeleMermaidPlugin,
  view: EditorView,
  changes: { line: number; width: number | undefined; height: number | undefined; zoom: number | undefined }[],
): void {
  for (const change of changes) {
    let frame: DiagramFrame | undefined;
    try {
      const containers = view.dom.querySelectorAll(".cm-preview-code-block");
      containers.forEach((el) => {
        if (frame) return;
        try {
          const pos = view.posAtDOM(el);
          const line = view.state.doc.lineAt(pos).number - 1;
          if (line === change.line || line === change.line + 1) {
            frame = plugin.framesByDom.get(el as HTMLElement);
          }
        } catch {
          /* not mapped */
        }
      });
      if (!frame) {
        const from = view.state.doc.line(change.line + 1).from;
        const node = view.domAtPos(from).node;
        const el =
          node.instanceOf(Element) ? node.closest(".cm-preview-code-block") : null;
        if (el) frame = plugin.framesByDom.get(el as HTMLElement);
      }
    } catch {
      /* view not laid out */
    }
    const changed: FenceSize = {
      ...(change.width !== undefined ? { width: change.width } : {}),
      ...(change.height !== undefined ? { height: change.height } : {}),
      ...(change.zoom !== undefined ? { zoom: change.zoom } : {}),
    };
    if (frame) frame.applyFenceSize(changed);
    else {
      // Mehrpele shell for this fence, if any.
      try {
        const containers = view.dom.querySelectorAll(".cm-preview-code-block");
        containers.forEach((el) => {
          const sh = plugin.mehrByDom.get(el as HTMLElement);
          if (!sh) return;
          try {
            const pos = view.posAtDOM(el);
            const line = view.state.doc.lineAt(pos).number - 1;
            if (line === change.line || line === change.line + 1) sh.applyFenceSize(changed);
          } catch {
            /* not mapped */
          }
        });
      } catch {
        /* view not laid out */
      }
    }
  }
}

/** Info-only edits may bypass widget reuse callbacks; revisit the visible fence modes. */
export function refreshLpFenceModes(plugin: PeleMermaidPlugin, view: EditorView): void {
  view.dom.querySelectorAll<HTMLElement>(".cm-preview-code-block").forEach((dom) => {
    const tile = dom as HTMLElement & { cmView?: { widget?: LpWidgetLike }; cmTile?: { widget?: LpWidgetLike } };
    const widget = tile.cmTile?.widget ?? tile.cmView?.widget;
    const location = lpLocate(view, dom);
    if (widget && location) handleLpWidgetReuse(plugin, { ...widget, lineStart: location.line }, dom, view);
  });
}

/** CM reused a widget DOM (eq match): re-read the fence; rebuild if needed. */
export function handleLpWidgetReuse(plugin: PeleMermaidPlugin, widget: LpWidgetLike, dom: HTMLElement, view: EditorView): boolean {
  // The fence may sit on another line, or its info string changed: companion keys follow.
  plugin.frameHandles.resyncSoon();
  const embed = plugin.canvasEmbedsByDom.get(dom);
  if (embed) {
    // Same body and info string: the mount stays (it re-renders on canvas modify itself).
    if (embed.code === widget.code && embed.rest === lpFenceRest(view, widget)) return true;
    embed.destroy();
    plugin.canvasEmbedsByDom.delete(dom);
    dom.replaceChildren();
    buildLpFrame(plugin, widget, view, dom);
    return true;
  }
  const shell = plugin.mehrByDom.get(dom);
  if (shell) {
    // A body edited into a pele-source line on a cannoli fence becomes a canvas embed, never a shell over the comment.
    if (parsePeleSource(widget.code) !== null && isCannoliFence(lpFenceRest(view, widget))) {
      shell.destroy();
      plugin.mehrByDom.delete(dom);
      dom.replaceChildren();
      buildLpFrame(plugin, widget, view, dom);
      return true;
    }
    if (widget.code !== shell.source) shell.update(widget.code);
    try {
      const line = view.state.doc.line(widget.lineStart + 1);
      shell.applyFenceSize(parseFenceSize(line.text));
    } catch {
      /* keep current width */
    }
    return true;
  }
  const frame = plugin.framesByDom.get(dom);
  if (!frame) return false;
  if (widget.code !== frame.source || widget.lang !== frame.lang || (isCannoliFence(lpFenceRest(view, widget)) && parsePeleSource(widget.code) !== null)) {
    frame.destroy();
    plugin.framesByDom.delete(dom);
    dom.replaceChildren();
    buildLpFrame(plugin, widget, view, dom);
    return true;
  }
  try {
    const line = view.state.doc.line(widget.lineStart + 1);
    frame.applyFenceSize(parseFenceSize(line.text));
  } catch {
    /* keep current width */
  }
  return true;
}

export function buildLpFrame(plugin: PeleMermaidPlugin, widget: LpWidgetLike, view: EditorView, container: HTMLElement): DiagramFrame | MehrpeleShell | null {
  let size: FenceSize = {};
  let fenceRest = "";
  try {
    const text = view.state.doc.line(widget.lineStart + 1).text;
    size = parseFenceSize(text);
    fenceRest = fenceRestOf(text);
  } catch {
    /* line unavailable */
  }
  const sourcePath = sourcePathForView(plugin, view, widget);
  const companion = {
    key: `${sourcePath}#${widget.lineStart}`,
    fenceRest,
    // A reused widget keeps its lineStart when lines are added above: read the live doc.
    locate: () => lpLocate(view, container),
  };

  // A canvas embed: the canvas through mountCanvas, never a write-back frame over the comment body.
  const embed = plugin.canvasEmbed(widget.code, container, sourcePath, companion);
  if (embed) {
    plugin.canvasEmbedsByDom.set(container, { code: widget.code, rest: fenceRest, destroy: () => embed.destroy() });
    return null;
  }

  if (plugin.appliesMehrpele(widget.lang, widget.code)) {
    const shell: MehrpeleShell = new (mehrpeleShell().MehrpeleShell)(plugin, plugin, {
      source: widget.code,
      lang: widget.lang,
      sourcePath,
      ...size,
      fenceLine: widget.lineStart,
      companion,
      onRevealCode: () => {
        try {
          const anchor =
            widget.start >= 0
              ? widget.start
              : view.state.doc.line(widget.lineStart + 2).from;
          view.dispatch({ selection: { anchor }, scrollIntoView: true });
          view.focus();
        } catch {
          /* view gone */
        }
      },
      onPersistSize: (edit) => persistLpSize(plugin, shell, view, edit),
      onApplyRepaired: (newSource, expected) => applyLpRepair(plugin, shell, view, expected, newSource),
      onEnsureBlockId: (src) => ensureLpBlockId(plugin, shell, view, src),
    });
    container.appendChild(shell.root);
    shell.load();
    plugin.mehrByDom.set(container, shell);
    return shell;
  }

  const frame: DiagramFrame = new DiagramFrame(frameHostOf(plugin), {
    source: widget.code,
    lang: widget.lang,
    sourcePath,
    ...size,
    companion,
    onRevealCode: () => {
      try {
        const anchor =
          widget.start >= 0
            ? widget.start
            : view.state.doc.line(widget.lineStart + 2).from;
        view.dispatch({ selection: { anchor }, scrollIntoView: true });
        view.focus();
      } catch {
        /* view gone */
      }
    },
    onPersistSize: (edit) => persistLpSize(plugin, frame, view, edit),
    onApplyRepaired: (newSource, expected) => applyLpRepair(plugin, frame, view, expected, newSource),
    onEnsureBlockId: (src) => ensureLpBlockId(plugin, frame, view, src),
  });
  container.appendChild(frame.root);
  frame.load();
  plugin.framesByDom.set(container, frame);
  return frame;
}

/** The info-string rest of the widget's fence line ("" when the line can't be read). */
function lpFenceRest(view: EditorView, widget: LpWidgetLike): string {
  try {
    return fenceRestOf(view.state.doc.line(widget.lineStart + 1).text);
  } catch {
    return "";
  }
}

/** Resolve the file for a CM view: leaf whose editor.cm is this view first. */
export function sourcePathForView(plugin: PeleMermaidPlugin, view: EditorView, widget: LpWidgetLike): string {
  for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
    const mv = leaf.view;
    if (mv instanceof MarkdownView && (mv.editor as unknown as { cm?: EditorView }).cm === view) {
      return mv.file?.path ?? "";
    }
  }
  return (
    (widget as unknown as { editor?: { path?: string } }).editor?.path ??
    plugin.app.workspace.getActiveFile()?.path ??
    ""
  );
}

/** Opening fence line (0-based) for an LP frame, resolved from the live doc. */
export function lpFenceLine(plugin: PeleMermaidPlugin, frame: { root: HTMLElement }, view: EditorView): number | null {
  try {
    const pos = view.posAtDOM(frame.root);
    const approxLine = view.state.doc.lineAt(pos).number - 1;
    return findOpeningFenceLine(view.state.doc.toString().split("\n"), approxLine);
  } catch {
    return null;
  }
}

/** LP: ensure `^pele-…` after the closing fence with one undoable dispatch. */
export function ensureLpBlockId(plugin: PeleMermaidPlugin, frame: { root: HTMLElement }, view: EditorView, source: string): Promise<string | null> {
  try {
    const fence = lpFenceLine(plugin, frame, view);
    if (fence === null) return Promise.resolve(null);
    const plan = planFenceBlockId(view.state.doc.toString(), fence, source);
    return Promise.resolve(dispatchBlockIdPlan(plugin, view, plan));
  } catch {
    return Promise.resolve(null);
  }
}

export function dispatchBlockIdPlan(plugin: PeleMermaidPlugin, view: EditorView, plan: BlockIdPlan): string | null {
  if (plan.kind === "exists") return plan.id;
  if (plan.kind !== "insert") return null;
  // Not an undo step of its own: Mod+Z skips it to the last diagram edit.
  view.dispatch({ changes: { from: plan.offset, insert: plan.insert }, annotations: Transaction.addToHistory.of(false), scrollIntoView: false });
  return plan.id;
}

/** Processor-rendered frame: LP editor dispatch, else one vault.process edit (Reading). */
export function ensureChildBlockId(
  plugin: PeleMermaidPlugin,
  sourcePath: string,
  fenceLine: number,
  source: string,
  frameRoot: HTMLElement,
): Promise<string | null> {
  if (!sourcePath.toLowerCase().endsWith(".md")) return Promise.resolve(null);
  if (frameRoot.closest(".cm-preview-code-block")) {
    for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
      const mv = leaf.view;
      if (!(mv instanceof MarkdownView) || mv.file?.path !== sourcePath) continue;
      const cm = (mv.editor as unknown as { cm?: EditorView }).cm;
      if (!cm) break;
      return Promise.resolve(dispatchBlockIdPlan(plugin, cm, planFenceBlockId(cm.state.doc.toString(), fenceLine, source)));
    }
    return Promise.resolve(null);
  }
  const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) return Promise.resolve(null);
  let id: string | null = null;
  return plugin.app.vault
    .process(file, (data) => {
      const plan = planFenceBlockId(data, fenceLine, source);
      if (plan.kind === "exists") {
        id = plan.id;
        return data;
      }
      if (plan.kind !== "insert") return data;
      id = plan.id;
      return plan.text;
    })
    .then(() => id)
    .catch(() => null);
}

/** "Copy link / wikilink to this diagram" (context menu). */
export async function copyDiagramLink(
  plugin: PeleMermaidPlugin,
  target: { sourcePath: string; ensureBlockId(): Promise<string | null> },
  kind: "uri" | "wikilink",
): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(target.sourcePath);
  if (!(file instanceof TFile)) {
    new Notice("Pele: diagram is not in a saved note.");
    return;
  }
  const id = await target.ensureBlockId();
  if (!id) {
    new Notice("Pele: could not locate this diagram in the note (duplicate or edited block); no link copied.");
    return;
  }
  let text: string;
  if (kind === "wikilink") {
    text = wikilinkToBlock(plugin.app.metadataCache.fileToLinktext(file, ""), id);
  } else if (generatorContext().advancedUriEnabled(plugin.app)) {
    text = advancedUri({ vault: plugin.app.vault.getName(), filepath: file.path, block: id });
  } else {
    text = openUri(plugin.app.vault.getName(), file.path);
  }
  try {
    await navigator.clipboard.writeText(text);
    new Notice(
      kind === "uri" && !generatorContext().advancedUriEnabled(plugin.app)
        ? "Pele: note link copied (install Advanced URI for a link to the diagram block)."
        : "Pele: link to diagram copied.",
    );
  } catch {
    new Notice("Pele: clipboard write failed.");
  }
}

/** Apply a repaired LP source: one undoable dispatch replacing just the block body. */
export function applyLpRepair(
  plugin: PeleMermaidPlugin,
  frame: { root: HTMLElement },
  view: EditorView,
  oldSource: string,
  newSource: string,
): Promise<boolean> {
  try {
    const fence = lpFenceLine(plugin, frame, view);
    if (fence === null) return Promise.resolve(false);
    return Promise.resolve(dispatchBlockReplace(view, fence, oldSource, newSource));
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * Persist an LP resize: resolve the opening fence from the live doc at
 * commit time (never trust a captured lineStart), validate it is a
 * mermaid/pele fence, then write with a single undoable change.
 */
export function persistLpSize(plugin: PeleMermaidPlugin, frame: { root: HTMLElement }, view: EditorView, edit: FenceSizeEdit): void {
  try {
    const pos = view.posAtDOM(frame.root);
    const doc = view.state.doc;
    const approxLine = doc.lineAt(pos).number - 1;
    const lines = doc.toString().split("\n");
    const fenceIdx = findOpeningFenceLine(lines, approxLine);
    if (fenceIdx === null) return; // not a diagram fence anymore: abort
    const line = doc.line(fenceIdx + 1);
    const next = serializeFenceSize(line.text, edit);
    if (next !== line.text) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: next },
        annotations: isolateHistory.of("full"),
        scrollIntoView: false,
      });
    }
  } catch {
    /* doc/view changed underneath us */
  }
}
