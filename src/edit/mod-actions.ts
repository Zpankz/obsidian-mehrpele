/**
 * Which frame buttons do something else with a modifier held, and what they
 * show then (pure). Obsidian's Mod is Cmd on macOS, Ctrl elsewhere. Buttons
 * that open something follow Keymap.isModEvent, as links do (Mod: new tab,
 * Mod+Alt: split right, Mod+Alt+Shift: new window); the code button's Mod
 * opens the diagram as a canvas, itself a new tab.
 */

export interface ModState {
  mod: boolean;
  alt: boolean;
  shift: boolean;
}

export const NO_MODS: ModState = { mod: false, alt: false, shift: false };

export interface Variant {
  icon: string;
  /** Tooltip while it applies; null keeps the button's own. */
  tip: string | null;
}

export interface ModAction {
  /** CSS selector of the buttons. */
  selector: string;
  /** Icon without modifiers. */
  base: string;
  /** Most specific first; `hint` names the variant in the button's base tooltip. */
  variants: Array<{ when: (s: ModState) => boolean; icon: string; tip: string; id?: string; hint?: string; keys?: ModState }>;
}

const MOD: ModState = { mod: true, alt: false, shift: false };
const MOD_ALT: ModState = { mod: true, alt: true, shift: false };
const MOD_ALT_SHIFT: ModState = { mod: true, alt: true, shift: true };
const exactly = (k: ModState) => (s: ModState) => s.mod === k.mod && s.alt === k.alt && s.shift === k.shift;
const mod = exactly(MOD);
const modAlt = exactly(MOD_ALT);
const modAltShift = exactly(MOD_ALT_SHIFT);

export const MOD_ACTIONS: readonly ModAction[] = [
  { selector: ".pele-copy-action", base: "copy", variants: [{ when: (s) => s.mod, icon: "image", tip: "Copy SVG" }] },
  { selector: ".pele-edit-plus", base: "plus", variants: [{ when: (s) => s.mod, icon: "sparkles", tip: "Autocomplete node" }] },
  {
    selector: '.pele-edit-menu button[data-pele-mod="shared-child"]',
    base: "arrow-right",
    variants: [{ when: (s) => s.mod, icon: "sparkles", tip: "Autocomplete a shared child" }],
  },
  {
    selector: ".pele-open-original",
    base: "arrow-up-right",
    variants: [
      { when: modAltShift, icon: "app-window", tip: "Open in new window" },
      { when: modAlt, icon: "columns-2", tip: "Open to the right" },
      { when: mod, icon: "square-arrow-out-up-right", tip: "Open in new tab" },
    ],
  },
  {
    selector: ".pele-zoom-action",
    base: "zoom-in",
    variants: [
      { when: modAltShift, id: "window", keys: MOD_ALT_SHIFT, icon: "picture-in-picture-2", tip: "Open diagram in new window", hint: "window" },
      { when: modAlt, id: "split", keys: MOD_ALT, icon: "columns-2", tip: "Open diagram to the right", hint: "right" },
      { when: mod, id: "tab", keys: MOD, icon: "maximize-2", tip: "Open diagram in new tab", hint: "new tab" },
    ],
  },
  {
    selector: ".pele-code-action",
    base: "code-2",
    variants: [
      { when: modAltShift, id: "window", keys: MOD_ALT_SHIFT, icon: "app-window", tip: "Edit source in new window", hint: "window" },
      { when: modAlt, id: "split", keys: MOD_ALT, icon: "columns-2", tip: "Edit source to the right", hint: "right" },
      { when: mod, id: "canvas", keys: MOD, icon: "layout-dashboard", tip: "Open as canvas", hint: "canvas" },
    ],
  },
];

/** The ModAction for `selector` (it exists: the selectors above are constants). */
export function modAction(selector: string): ModAction {
  return MOD_ACTIONS.find((a) => a.selector === selector)!;
}

/** Keys as shown in tooltips: ⌘⌥⇧ on macOS, Ctrl+Alt+Shift elsewhere. */
export function keyLabel(k: ModState, isMac: boolean): string {
  if (isMac) return (k.mod ? "⌘" : "") + (k.alt ? "⌥" : "") + (k.shift ? "⇧" : "");
  return [k.mod && "Ctrl", k.alt && "Alt", k.shift && "Shift"].filter(Boolean).join("+");
}

/** "Zoom in (⌘: new tab, ⌘⌥: right, ⌘⌥⇧: window)": the base tooltip with its variants, simplest first. */
export function tipWithHints(base: string, action: ModAction, isMac: boolean): string {
  const hints = action.variants.filter((v) => v.hint && v.keys).reverse().map((v) => `${keyLabel(v.keys!, isMac)}: ${v.hint}`);
  return hints.length ? `${base} (${hints.join(", ")})` : base;
}

/** The variant `action` shows in `state`, or null for its normal look. */
export function variantFor(action: ModAction, state: ModState): Variant | null {
  const v = action.variants.find((x) => x.when(state));
  return v ? { icon: v.icon, tip: v.tip } : null;
}

/** Which variant a click with `state` runs (its id), or null for the plain action. */
export function variantId(action: ModAction, state: ModState): string | null {
  return action.variants.find((x) => x.when(state))?.id ?? null;
}

/** Modifier state from a keyboard/pointer event (Mod = Meta on macOS, Ctrl elsewhere). */
export function modState(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, isMac: boolean): ModState {
  return { mod: isMac ? e.metaKey : e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
}

/**
 * The state after a keyboard event: the event's modifier flags, corrected by
 * the key itself (pressing Meta sets Mod even if a synthetic event forgot
 * the flag; releasing it clears it).
 */
export function nextState(e: { type: string; key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, isMac: boolean): ModState {
  const s = modState(e, isMac);
  const down = e.type === "keydown";
  if (e.key === (isMac ? "Meta" : "Control")) s.mod = down;
  else if (e.key === "Alt") s.alt = down;
  else if (e.key === "Shift") s.shift = down;
  return s;
}

export function sameState(a: ModState, b: ModState): boolean {
  return a.mod === b.mod && a.alt === b.alt && a.shift === b.shift;
}
