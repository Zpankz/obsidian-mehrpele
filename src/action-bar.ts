/**
 * A frame's action bar (`div.embed-actions`, Obsidian's native embed actions): the
 * built-in actions in order (zoom, code, copy, repair), shared by DiagramFrame and the
 * Mehrpele shell. Companion actions (api `addFrameAction`) are appended after these by
 * src/api/frame-actions.ts on every render.
 */
import { setIcon, setTooltip } from "obsidian";
import { asButton } from "./a11y";
import { copyAction } from "./copy-action";

/** What the built-in actions do for one frame. */
export interface ActionBarCtx {
  zoom(): void;
  revealCode(): void;
  source(): string;
  svg(): string;
  repair(): void;
}

export type BuiltinFrameActionId = "zoom" | "code" | "copy" | "repair";

export interface BuiltinFrameAction {
  id: BuiltinFrameActionId;
  /** The element appended to the bar; `wrench` is the repair button inside its slot. */
  build(ctx: ActionBarCtx): { el: HTMLElement; wrench?: HTMLElement };
}

function button(cls: string, icon: string, tip: string, run: () => void): HTMLElement {
  // Keyboard: role=button, a tab stop, Enter/Space (a11y.ts).
  const btn = asButton(createDiv());
  btn.className = cls;
  setIcon(btn, icon);
  setTooltip(btn, tip);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    run();
  });
  return btn;
}

/** The built-in actions, in bar order. */
export const BUILTIN_FRAME_ACTIONS: readonly BuiltinFrameAction[] = [
  // Same element/classes as Obsidian's native embed actions (div.embed-action).
  { id: "zoom", build: (c) => ({ el: button("embed-action", "zoom-in", "Zoom in", () => c.zoom()) }) },
  { id: "code", build: (c) => ({ el: button("embed-action edit-block-button", "code-2", "Edit block", () => c.revealCode()) }) },
  // pele-edit: copy
  { id: "copy", build: (c) => ({ el: copyAction(() => c.source(), () => c.svg()) }) },
  {
    // Repair: wrench action in the embed-actions slot, beside zoom/code.
    id: "repair",
    build: (c) => {
      const slot = createDiv();
      slot.className = "pele-repair-slot";
      const wrench = button("embed-action", "wrench", "Repair diagram", () => c.repair());
      slot.appendChild(wrench);
      return { el: slot, wrench };
    },
  },
];

/** A new `div.embed-actions` with the built-in actions; `wrench` is the repair button. */
export function buildActionBar(ctx: ActionBarCtx): { bar: HTMLElement; wrench: HTMLElement } {
  const bar = createDiv();
  bar.className = "embed-actions";
  let wrench: HTMLElement | null = null;
  for (const action of BUILTIN_FRAME_ACTIONS) {
    const built = action.build(ctx);
    bar.appendChild(built.el);
    if (built.wrench) wrench = built.wrench;
  }
  if (!wrench) throw new Error("action bar: no repair action");
  return { bar, wrench };
}
