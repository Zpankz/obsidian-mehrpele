/** Re-render open Markdown leaves after load, unload and settings changes. */
import { PLUGIN_ID } from "./plugin-id";
import {
  MarkdownView, type App
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import { hasDiagramFence } from "./fence-locate";
import { MERMAID_GUARD } from "./mermaid-guard";
import { LpTakeover } from "./lp-patch";

export type RefreshMode = "live" | "reading" | "reading+live" | "rebuild";

export interface RebuildQueue {
  tail: Promise<void>;
  queued: Set<RefreshMode>;
}

export const REBUILD_QUEUE = Symbol.for("pele-mermaid.rebuildQueue.v2");

export function rebuildQueue(): RebuildQueue {
  const g = window as unknown as Record<symbol, RebuildQueue | undefined>;
  return (g[REBUILD_QUEUE] ??= { tail: Promise.resolve(), queued: new Set() });
}

/** Current text of a markdown view (editor if mounted, else view data). */
export function viewText(view: MarkdownView): string {
  try {
    const cm = (view.editor as unknown as { cm?: EditorView } | undefined)?.cm;
    if (cm) return cm.state.doc.toString();
  } catch {
    /* fall through */
  }
  try {
    return view.getViewData();
  } catch {
    return "";
  }
}

/**
 * Redraw a CM editor's DOM from its current state: every view plugin and
 * widget is recreated (so the patched LP widget builds Pele), while the state
 * itself — undo history, selection, folds — is untouched. Scroll is restored.
 */
export function redrawEditor(cm: EditorView): boolean {
  try {
    const scroller = cm.scrollDOM;
    const top = scroller.scrollTop;
    const left = scroller.scrollLeft;
    cm.setState(cm.state);
    scroller.scrollTop = top;
    scroller.scrollLeft = left;
    cm.requestMeasure({
      read: () => null,
      write: () => {
        scroller.scrollTop = top;
        scroller.scrollLeft = left;
      },
    });
    return true;
  } catch (e) {
    console.warn("[pele-mermaid] in-place editor redraw failed; rebuilding the view", e);
    return false;
  }
}

export async function rebuildLeaf(leaf: { view: unknown }): Promise<void> {
  const anyLeaf = leaf as unknown as { rebuildView?: () => Promise<void> };
  try {
    if (typeof anyLeaf.rebuildView === "function") {
      await anyLeaf.rebuildView();
      return;
    }
  } catch {
    /* fall back below */
  }
  const view = leaf.view;
  if (!(view instanceof MarkdownView)) return;
  try {
    view.previewMode?.rerender(true);
  } catch {
    /* preview not present in source mode */
  }
  try {
    const cm = (view.editor as unknown as { cm?: EditorView }).cm;
    if (cm) redrawEditor(cm);
  } catch {
    /* CM not mounted */
  }
}

/** Refresh the open markdown leaves that contain one of our blocks (see refreshMarkdownLeaves). */
export function lpTakeoverOf(app: App): LpTakeover | null {
  const plugin = (app as unknown as { plugins?: { plugins?: Record<string, { lp?: LpTakeover | null }> } }).plugins
    ?.plugins?.[PLUGIN_ID];
  return plugin?.lp ?? null;
}

/** Whether Pele renders `mermaid` fences (`core.overrideMermaid`; on unless the loaded plugin says off). */
export function overrideMermaidOf(app: App): boolean {
  const plugin = (app as unknown as { plugins?: { plugins?: Record<string, { settings?: { core?: { overrideMermaid?: boolean } } }> } })
    .plugins?.plugins?.[PLUGIN_ID];
  return plugin?.settings?.core?.overrideMermaid !== false;
}

/** Rendered diagram widgets in this editor that still show non-Pele (native) DOM. */
export function hasStaleDiagramWidgets(cm: EditorView, overrideMermaid: boolean): boolean {
  const langs = overrideMermaid ? ["mermaid", "pele", "mehrpele"] : ["pele", "mehrpele"];
  const selector = langs.map((l) => `.cm-preview-code-block.cm-lang-${l}`).join(", ");
  if (Array.from(cm.dom.querySelectorAll(selector)).some((el) => !el.querySelector(".pele-embed"))) return true;
  // Embeds (`![[note]]`) rendered while Pele was off keep Obsidian's Mermaid
  // trust banner; a redraw does not re-render them, a rebuild does.
  return overrideMermaid && cm.dom.querySelector(MERMAID_GUARD) !== null;
}

/** `forceLangs`: code-block languages whose Live Preview widgets re-render from scratch (an integration toggle). */
export async function refreshLeaves(app: App, mode: RefreshMode, forceLangs: readonly string[] = []): Promise<void> {
  let touched = false;
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    // Deferred (never-shown) tabs build their view on first show anyway.
    if ((leaf as unknown as { isDeferred?: boolean }).isDeferred) continue;
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) continue;
    const text = viewText(view);
    if (!hasDiagramFence(text)) continue;
    // Only a leaf actually redrawn or rebuilt below counts toward the resize.
    if (mode === "rebuild") {
      touched = true;
      await rebuildLeaf(leaf);
      continue;
    }
    // A toggled integration language: both of the leaf's modes must drop its last render,
    // the hidden one included, or switching modes shows the old hint or output.
    const forced = forceLangs.length > 0 && hasDiagramFence(text, forceLangs);
    const cm = (view.editor as unknown as { cm?: EditorView } | undefined)?.cm;
    const lp = lpTakeoverOf(app);
    const inPreview = view.getMode() === "preview";
    if (inPreview) {
      if (mode === "live") continue; // the LP patch doesn't affect Reading view
      touched = true;
      try {
        view.previewMode.rerender(true);
      } catch {
        await rebuildLeaf(leaf);
        continue;
      }
      if (!forced) continue;
      if (cm && lp?.isPatched) {
        lp.clearStaleWidgetCaches(cm, new Set(forceLangs));
        if (redrawEditor(cm)) continue;
      }
      await rebuildLeaf(leaf);
      continue;
    }
    if (mode === "reading") continue;
    touched = true;
    // Obsidian's code-block widget caches the DOM its initDOM built, so a redraw
    // re-shows native DOM for widgets rendered before our patch. Fall back to a
    // full rebuild (new widget instances) when any such stale widget remains.
    // Integration widgets cache their last render (hint or output) too: drop the toggled ones.
    if (cm) lp?.clearStaleWidgetCaches(cm, new Set(forced ? forceLangs : []));
    if (!cm || (forced && !lp?.isPatched) || !redrawEditor(cm) || hasStaleDiagramWidgets(cm, overrideMermaidOf(app))) {
      await rebuildLeaf(leaf); // rebuilds the Reading view too
      continue;
    }
    if (!forced) continue;
    try {
      view.previewMode?.rerender(true);
    } catch {
      /* no Reading view built yet: it renders fresh on first show */
    }
  }
  if (!touched) return;
  try {
    app.workspace.trigger("resize");
  } catch {
    /* older builds */
  }
}
