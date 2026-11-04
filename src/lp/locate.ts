import type { EditorView } from "@codemirror/view";
import type { FenceLocation } from "../api/frame-handles";
import { isDiagramFenceLine } from "../fence-locate";
import { fenceRestOf } from "../info-width";

/**
 * The live opening-fence line (0-based) and info-string rest of the LP widget in
 * `container`, exact (editor state). Null when it can't be told: the widget is gone, the view
 * switched files, or the editor is hidden (a split in Reading mode keeps its editor's doc
 * until it shows it again), so the frame follows its handle's shown editor (HandleRegistry.resync).
 */
export function lpLocate(view: EditorView, container: HTMLElement): FenceLocation | null {
  try {
    if (!container.isConnected || container.offsetParent === null || !view.dom.contains(container)) return null;
    const doc = view.state.doc;
    const at = doc.lineAt(view.posAtDOM(container)).number;
    for (const n of [at, at - 1]) {
      if (n < 1) continue;
      const text = doc.line(n).text;
      if (isDiagramFenceLine(text)) return { line: n - 1, rest: fenceRestOf(text), exact: true };
    }
  } catch {
    /* not mapped */
  }
  return null;
}
