/**
 * "Copy" embed action (beside zoom and code): a click copies the block's
 * source, Cmd/Ctrl-click copies the diagram as SVG (the frame's flattened,
 * theme-inlined export, so it pastes correctly elsewhere).
 */
import { Notice, Platform, setIcon, setTooltip } from "obsidian";
import { asButton } from "./a11y";

export function copyAction(source: () => string, svg: () => string): HTMLElement {
  // Enter copies the source, Mod+Enter the SVG (the key's modifiers reach the click).
  const btn = asButton(createDiv());
  btn.className = "embed-action pele-copy-action";
  setIcon(btn, "copy");
  const mod = Platform.isMacOS ? "Cmd" : "Ctrl";
  setTooltip(btn, `Copy source (${mod}-click: copy SVG)`);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const asSvg = e.metaKey || e.ctrlKey;
    const text = asSvg ? svg() : source();
    if (!text) {
      new Notice("Pele: nothing to copy yet.");
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => new Notice(asSvg ? "Pele: SVG copied." : "Pele: diagram source copied.", 2000),
      () => new Notice("Pele: clipboard write failed."),
    );
  });
  return btn;
}
