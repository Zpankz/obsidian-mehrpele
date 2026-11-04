/**
 * Whether an Obsidian popup (menu or editor suggest) owns the current key.
 *
 * Core's highlight swatch menu and the editor context menu close on Escape
 * from Obsidian's window-capture keymap, before the key reaches CodeMirror,
 * and the event is not marked handled. By the time the inline editor's
 * Escape binding runs, the menu is already gone, so a plain "is a menu open"
 * check reads false and the edit would be cancelled.
 *
 * The guard watches `body` for a removed `.menu` / `.suggestion-container`.
 * MutationObserver callbacks run as microtasks between event listeners, so a
 * removal caused by this keypress is seen before CodeMirror's handler. The
 * mark lasts until the next task.
 */
export const POPUP_SELECTOR = ".menu, .suggestion-container";
/** Core mounts menus and suggests directly on body; other `.menu` markup doesn't count. */
const OPEN_SELECTOR = "body > .menu, body > .suggestion-container";

export interface PopupGuard {
  /** A popup is open, or one closed during the current event. */
  owns(): boolean;
  dispose(): void;
}

export interface PopupGuardDeps {
  MutationObserver?: typeof MutationObserver;
  defer?: (fn: () => void) => void;
}

interface NodeLike {
  nodeType?: number;
  matches?: (sel: string) => boolean;
  querySelector?: (sel: string) => unknown;
}

const isPopup = (n: unknown): boolean => {
  const e = n as NodeLike;
  if (e?.nodeType !== 1) return false;
  return !!e.matches?.(POPUP_SELECTOR) || !!e.querySelector?.(POPUP_SELECTOR);
};

export function createPopupGuard(doc: Document, deps: PopupGuardDeps = {}): PopupGuard {
  const MO = "MutationObserver" in deps ? deps.MutationObserver : doc.defaultView?.MutationObserver ?? window.MutationObserver;
  const defer = deps.defer ?? ((fn: () => void) => void window.setTimeout(fn, 0));
  let justClosed = false;
  const obs = MO
    ? new MO((records) => {
        if (justClosed) return;
        for (const r of records) {
          if (Array.from(r.removedNodes as ArrayLike<unknown>).some(isPopup)) {
            justClosed = true;
            defer(() => (justClosed = false));
            return;
          }
        }
      })
    : null;
  if (doc.body) obs?.observe(doc.body, { childList: true });
  return {
    owns: () => justClosed || !!doc.querySelector(OPEN_SELECTOR),
    dispose: () => obs?.disconnect(),
  };
}

/**
 * Whether Obsidian's current editor suggest is showing. Core keeps a suggest
 * dismissed with Esc as `currentSuggest` (with `isOpen` false), so a bare
 * truthiness check would swallow the next Esc.
 */
export function suggestShowing(current: unknown): boolean {
  if (!current) return false;
  return (current as { isOpen?: boolean }).isOpen !== false;
}
