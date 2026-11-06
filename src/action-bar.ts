/**
 * A frame's action bar (`div.embed-actions`, Obsidian's native embed actions): the
 * built-in actions in order (zoom, code, copy, repair), shared by DiagramFrame and the
 * Mehrpele shell. Companion actions (api `addFrameAction`) are appended after these by
 * src/api/frame-actions.ts on every render.
 *
 * Keyboard: each action is a button (Enter/Space). Mod, Mod+Alt and
 * Mod+Alt+Shift with Enter or Space open in a new tab, split or window, as a
 * modified click does; `bindActionKeys` routes those past Obsidian's hotkeys.
 */
import { type App, Scope, setIcon, setTooltip } from "obsidian";
import { asButton, clickWithKeys, isActivationKey } from "./a11y";
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

/**
 * A new `div.embed-actions` with the built-in actions; `wrench` is the repair
 * button, `keys` its Mod+Enter route (the frame releases it when it stands down).
 */
export function buildActionBar(ctx: ActionBarCtx, app: App): { bar: HTMLElement; wrench: HTMLElement; keys: ActionBarKeys } {
  const bar = createDiv();
  bar.className = "embed-actions";
  let wrench: HTMLElement | null = null;
  for (const action of BUILTIN_FRAME_ACTIONS) {
    const built = action.build(ctx);
    bar.appendChild(built.el);
    if (built.wrench) wrench = built.wrench;
  }
  if (!wrench) throw new Error("action bar: no repair action");
  return { bar, wrench, keys: bindActionKeys(bar, app) };
}

/** Modifier sets that open a link elsewhere (Keymap.isModEvent: tab, split, window). */
const MOD_KEYS = [["Mod"], ["Mod", "Alt"], ["Mod", "Alt", "Shift"]] as const;

export interface ActionBarKeys {
  /** Pop the scope if pushed (the frame stood down); focus in the bar pushes it again. */
  release(): void;
  /** Pop the scope and stop listening (the frame is gone). */
  dispose(): void;
}

/**
 * Obsidian's keymap sees keys first (capture, on the window) and runs a
 * Mod+Enter hotkey before the action's own keydown. While focus is in `bar`, a
 * scope over the app's takes Mod(+Alt(+Shift)) Enter/Space and clicks the
 * focused action with those modifiers; other keys reach the app's hotkeys.
 */
export function bindActionKeys(bar: HTMLElement, app: App): ActionBarKeys {
  let scope: Scope | null = null;
  const release = (): void => {
    if (!scope) return;
    app.keymap.popScope(scope);
    scope = null;
  };
  const onFocusIn = (): void => {
    if (scope) return;
    scope = new Scope(app.scope);
    for (const mods of MOD_KEYS) {
      for (const key of ["Enter", " "]) {
        scope.register([...mods], key, (e) => {
          // The event's own target (not instanceof: a popout has its own HTMLElement).
          const target = e.target as HTMLElement | null;
          if (!target || !bar.contains(target) || target.getAttribute("role") !== "button") return;
          if (isActivationKey(e)) clickWithKeys(target, e);
          return false;
        });
      }
    }
    app.keymap.pushScope(scope);
  };
  const onFocusOut = (e: FocusEvent): void => {
    const to = e.relatedTarget as Node | null;
    if (to && bar.contains(to)) return;
    release();
  };
  bar.addEventListener("focusin", onFocusIn);
  bar.addEventListener("focusout", onFocusOut);
  return {
    release,
    dispose: () => {
      release();
      bar.removeEventListener("focusin", onFocusIn);
      bar.removeEventListener("focusout", onFocusOut);
    },
  };
}
