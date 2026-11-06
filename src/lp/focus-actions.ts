/**
 * Keyboard route between a Live Preview editor and its diagrams' action bars.
 * CodeMirror keeps Tab (it indents), so the way in is a command: "Focus
 * diagram actions" focuses the first action of the diagram nearest the cursor.
 * Inside the bar Tab and Shift+Tab move between actions; Escape goes back to
 * the editor with the cursor where it was.
 */
import type { EditorView } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { actionBarOf } from "../action-bar-location";

/** A diagram widget's first action, under a top-level frame or shell root (not a nested frame's). */
const FIRST_ACTION = ":scope > [role=button]:not(.pele-hidden)";
const escapeRoutes = new WeakMap<HTMLElement, EditorView>();

/** A rendered diagram widget: its block's first and last lines (1-based) and its first action. */
interface LpDiagram {
  from: number;
  to: number;
  action: HTMLElement;
}

/**
 * The diagram nearest the cursor line, from diagrams in document order: the
 * one whose block holds the line, else the next one below, else the closest above.
 */
export function nearestDiagram<T extends { from: number; to: number }>(diagrams: readonly T[], line: number): T | null {
  return diagrams.find((d) => d.from <= line && line <= d.to) ?? diagrams.find((d) => d.from > line) ?? diagrams.at(-1) ?? null;
}

/** The editor's rendered diagram widgets (CodeMirror draws only those near the viewport), in document order. */
function lpDiagrams(view: EditorView): LpDiagram[] {
  const doc = view.state.doc;
  const out: LpDiagram[] = [];
  for (const el of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-preview-code-block"))) {
    const root = el.querySelector<HTMLElement>(":scope > .pele-embed");
    const action = root ? actionBarOf(root)?.querySelector<HTMLElement>(FIRST_ACTION) : null;
    if (!action) continue;
    try {
      // The widget replaces its whole block, so its line block spans the fences.
      const block = view.lineBlockAt(view.posAtDOM(el));
      out.push({ from: doc.lineAt(block.from).number, to: doc.lineAt(block.to).number, action });
    } catch {
      /* not mapped */
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/** "Focus diagram actions": false (unavailable) outside Live Preview or with no rendered diagram. */
export function focusDiagramActions(view: EditorView | undefined, checking: boolean): boolean {
  if (!view?.state.field(editorLivePreviewField, false)) return false;
  const state = view.state;
  const target = nearestDiagram(lpDiagrams(view), state.doc.lineAt(state.selection.main.head).number);
  if (!target) return false;
  if (!checking) {
    const bar = target.action.parentElement;
    if (bar) escapeToEditor(bar, view);
    target.action.focus();
  }
  return true;
}

/** Escape on a focused action in `container` (a Live Preview widget) focuses its editor; the selection is untouched. */
export function escapeToEditor(container: HTMLElement, view: EditorView): void {
  const registered = escapeRoutes.has(container);
  escapeRoutes.set(container, view);
  if (registered) return;
  container.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.isComposing) return;
    const target = e.target as HTMLElement | null;
    if (!target?.closest(".embed-actions")) return;
    e.preventDefault();
    e.stopPropagation();
    escapeRoutes.get(container)?.focus();
  });
}
