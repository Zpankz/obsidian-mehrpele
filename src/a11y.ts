/**
 * Keyboard access for the plugin's own controls and dialogs.
 *
 * - asButton: div controls that keep core's element and classes
 *   (div.embed-action, div.clickable-icon, as in Obsidian's own embeds) get
 *   role=button, a tab stop and Enter/Space activation, like a <button>.
 * - FocusTrap: a modal surface takes focus when it opens, keeps Tab inside,
 *   and gives focus back to whatever opened it when it closes.
 */

/** Enter or Space, not auto-repeated, not part of an IME composition. */
export function isActivationKey(e: Pick<KeyboardEvent, "key" | "repeat" | "isComposing">): boolean {
  return (e.key === "Enter" || e.key === " ") && !e.repeat && !e.isComposing;
}

/**
 * Make `el` operable like a <button>. By default a key press dispatches a
 * click that carries the key's modifiers, so the control's click handler and
 * any capture listener (Mod-click variants) run as they do for the mouse.
 * `activate` replaces that, for handlers that accept trusted events only.
 */
export function asButton<T extends HTMLElement>(el: T, activate?: (e: KeyboardEvent) => void): T {
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  // A mouse click leaves focus where it was (the editor, the note), as before
  // the tab stop; the click itself still fires.
  el.addEventListener("mousedown", (e: MouseEvent) => e.preventDefault());
  el.addEventListener("keydown", (e: KeyboardEvent) => {
    if (!isActivationKey(e)) return;
    // Space must not scroll, Enter must not reach an editor around the widget.
    e.preventDefault();
    e.stopPropagation();
    if (activate) {
      activate(e);
      return;
    }
    const { ctrlKey, metaKey, altKey, shiftKey } = e;
    // The element's own window, so a popout's handlers see their realm's MouseEvent.
    const View = el.ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
    el.dispatchEvent(new View("click", { bubbles: true, cancelable: true, ctrlKey, metaKey, altKey, shiftKey }));
  });
  return el;
}

/** What can take focus by Tab (the browser's list, minus disabled and tabindex=-1). */
export const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]",
  "iframe",
  "webview",
].join(", ");

/** Embedded web views (the views feature mounts these). Electron's webview reports tabIndex -1 yet takes Tab. */
const WEB_VIEW = "iframe, webview";

/** Where Tab moves inside a trap: wrap at either end, enter at the edge from outside; null = the browser's own move. */
export function trapTarget<T>(items: readonly T[], active: T | null, back: boolean): T | null {
  if (!items.length) return null;
  const i = active === null ? -1 : items.indexOf(active);
  const first = items[0];
  const last = items[items.length - 1];
  if (i < 0) return back ? last : first;
  if (back && i === 0) return last;
  if (!back && i === items.length - 1) return first;
  return null;
}

/** Text inputs keep their own keys (typing "+" or an arrow is not a lightbox shortcut). */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as (Element & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.matches !== "function") return false;
  return !!el.isContentEditable || el.matches("input, textarea, select");
}

/**
 * Who handles a key inside a modal: "own" (the target keeps it), "trap" (Tab cycles inside), "modal" (shortcuts).
 * Only editors (contenteditable) keep Tab; inputs, selects and textareas move focus with it, so the trap wraps them.
 */
export function modalKeyRoute(key: string, target: EventTarget | null): "own" | "trap" | "modal" {
  if (key === "Escape") return "modal";
  if (key === "Tab") return (target as { isContentEditable?: boolean } | null)?.isContentEditable ? "own" : "trap";
  return isEditableTarget(target) ? "own" : "modal";
}

type Focusable = Element & { focus(opts?: FocusOptions): void; tabIndex: number };

export class FocusTrap {
  private opener: Focusable | null = null;

  constructor(private readonly root: HTMLElement) {}

  /** The Tab stops inside the root, in document order (shown ones only). */
  focusables(): Focusable[] {
    return Array.from(this.root.querySelectorAll<Element>(FOCUSABLE)).filter(
      (el): el is Focusable =>
        (el.matches(WEB_VIEW) ? el.getAttribute("tabindex") !== "-1" : (el as Focusable).tabIndex >= 0) &&
        el.getClientRects().length > 0,
    );
  }

  /** Remember the opener (the focused element now) and move focus to `initial`, else the first stop, else the root. */
  activate(initial?: HTMLElement | null): void {
    const doc = this.root.ownerDocument;
    const prev = doc.activeElement as Focusable | null;
    this.opener = prev && prev !== doc.body && !this.root.contains(prev) ? prev : null;
    const target = initial ?? this.focusables()[0] ?? null;
    if (target) target.focus({ preventScroll: true });
    else this.focusRoot();
  }

  /** Keep a Tab keydown inside the root. Returns true when it moved focus itself. */
  onTab(e: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">): boolean {
    if (e.key !== "Tab") return false;
    const items = this.focusables();
    const active = this.root.ownerDocument.activeElement as Focusable | null;
    if (!items.length) {
      e.preventDefault();
      this.focusRoot();
      return true;
    }
    const next = trapTarget(items, active && this.root.contains(active) ? active : null, e.shiftKey);
    if (!next) return false;
    e.preventDefault();
    next.focus({ preventScroll: true });
    return true;
  }

  /** Give focus back to the opener, if it is still in the document. */
  release(): void {
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  private focusRoot(): void {
    if (!this.root.hasAttribute("tabindex")) this.root.tabIndex = -1;
    this.root.focus({ preventScroll: true });
  }
}
