/**
 * The insert-embed button beside the inline editor, for a node just made
 * with "+": a pick fills the editor (embeds commit at once; templates stay
 * open to be filled in). It follows the editor while it is open.
 */
import { setIcon, setTooltip, type App } from "obsidian";
import type { InlineEditorHandle } from "../inline-editor";
import { openEmbedInsert } from "./index";
import type { PopoverHandle } from "./popover";

/** Class shared with the inline editor's outside-click rule (clicks here keep it open). */
export const EMBED_INSERT_CLASS = "pele-embed-insert";

export function attachEmbedAccessory(o: { app: App; doc: Document; handle: InlineEditorHandle; sourcePath: string; nodeId: string; graphDepth?: number }): () => void {
  const btn = o.doc.body.createEl("button", { cls: `clickable-icon ${EMBED_INSERT_CLASS}-accessory ${EMBED_INSERT_CLASS}` });
  setIcon(btn, "package-plus");
  btn.setAttribute("aria-label", "Insert embed");
  setTooltip(btn, "Insert embed", { placement: "top" });
  let pop: PopoverHandle | null = null;
  let raf = 0;
  const follow = (): void => {
    const r = o.handle.el.getBoundingClientRect();
    btn.style.left = `${Math.round(r.right + 6)}px`;
    btn.style.top = `${Math.round(r.top)}px`;
    btn.toggle(r.width > 0);
    raf = window.requestAnimationFrame(follow);
  };
  follow();
  btn.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the editor's focus
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.isTrusted) return;
    if (pop) {
      pop.close();
      return;
    }
    pop = openEmbedInsert({
      app: o.app,
      doc: o.doc,
      anchor: btn,
      parent: o.doc.body,
      avoid: () => {
        const r = o.handle.el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      },
      sourcePath: o.sourcePath,
      current: () => o.handle.value(),
      nodeId: o.nodeId,
      graphDepth: o.graphDepth ?? 1,
      onClose: () => {
        pop = null;
        o.handle.focus?.();
      },
      onInsert: (r) => {
        o.handle.setValue?.(r.text);
        if (!r.edit) o.handle.commit();
      },
    });
  });
  return () => {
    cancelAnimationFrame(raf);
    pop?.close();
    btn.remove();
  };
}
