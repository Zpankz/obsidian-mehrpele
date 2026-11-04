import { Notice } from "obsidian";

/**
 * A Notice with an Undo button, for size edits written to a file outside
 * the editor (Reading view has no undo history). `undo` swaps the previous
 * source back when the block still holds the new one.
 */
export function noticeWithUndo(message: string, undo: () => unknown, timeoutMs = 6000): void {
  const frag = createFragment();
  const text = createSpan();
  text.textContent = `${message} `;
  const button = createEl("button");
  button.className = "pele-undo-button";
  button.textContent = "Undo";
  frag.append(text, button);
  const notice = new Notice(frag, timeoutMs);
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    notice.hide();
    void Promise.resolve(undo()).catch(() => undefined);
  });
}
