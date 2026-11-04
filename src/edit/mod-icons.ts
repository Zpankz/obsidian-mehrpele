/**
 * Live modifier icons: while Cmd/Ctrl (± Alt, Shift) is held, frame buttons
 * whose modified click does something else show that (copy → image "Copy
 * SVG", + → sparkles "Autocomplete node", open original → new tab / split /
 * window), and switch back on release. One listener set per window
 * (popouts included), shared by every frame there and removed with the last
 * one; window blur and tab hiding reset it so nothing sticks. Desktop only.
 */
import { Platform, setIcon, setTooltip } from "obsidian";
import { MOD_ACTIONS, modState, nextState, NO_MODS, sameState, variantFor, type ModState } from "./mod-actions";

const SWAP = "pele-mod-swap";

class Watcher {
  state: ModState = NO_MODS;
  refs = 0;
  constructor(private win: Window) {}

  private set(next: ModState): void {
    if (sameState(next, this.state)) return;
    this.state = next;
    apply(this.win.document, next);
  }

  private onKey = (e: KeyboardEvent): void => this.set(nextState(e, Platform.isMacOS));
  /** Pointer events carry the modifiers too: resync if a keyup was missed. */
  private onPointer = (e: PointerEvent): void => this.set(modState(e, Platform.isMacOS));
  private reset = (): void => this.set(NO_MODS);
  private onVisibility = (): void => {
    if (this.win.document.visibilityState !== "visible") this.reset();
  };

  start(): void {
    this.win.addEventListener("keydown", this.onKey, true);
    this.win.addEventListener("keyup", this.onKey, true);
    this.win.addEventListener("pointerover", this.onPointer, true);
    this.win.addEventListener("blur", this.reset);
    this.win.document.addEventListener("visibilitychange", this.onVisibility);
  }

  stop(): void {
    this.win.removeEventListener("keydown", this.onKey, true);
    this.win.removeEventListener("keyup", this.onKey, true);
    this.win.removeEventListener("pointerover", this.onPointer, true);
    this.win.removeEventListener("blur", this.reset);
    this.win.document.removeEventListener("visibilitychange", this.onVisibility);
    if (!sameState(this.state, NO_MODS)) apply(this.win.document, NO_MODS);
  }
}

const watchers = new Map<Window, Watcher>();

/** Keep modifier icons live in `win` while the returned release is not called. */
export function retainModIcons(win: Window | null | undefined): () => void {
  if (!win || Platform.isMobile) return () => undefined;
  let w = watchers.get(win);
  if (!w) {
    w = new Watcher(win);
    watchers.set(win, w);
    w.start();
  }
  w.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--w.refs === 0) {
      w.stop();
      watchers.delete(win);
    }
  };
}

/** Bring newly created buttons (the + buttons) in line with the keys held now. */
export function syncModIcons(root: ParentNode, doc: Document): void {
  const w = doc.defaultView ? watchers.get(doc.defaultView) : undefined;
  if (w && !sameState(w.state, NO_MODS)) apply(root, w.state);
}

function apply(root: ParentNode, state: ModState): void {
  for (const action of MOD_ACTIONS) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(action.selector))) {
      // Only what can be seen (offsetParent covers display:none ancestors).
      if (!el.isConnected || (el.offsetParent === null && getComputedStyle(el).position !== "fixed")) continue;
      el.dataset.peleBaseTip ??= el.getAttribute("aria-label") ?? "";
      const v = variantFor(action, state);
      const icon = v?.icon ?? action.base;
      if (el.dataset.peleIcon === icon || (!el.dataset.peleIcon && icon === action.base)) continue;
      el.dataset.peleIcon = icon;
      setIcon(el, icon);
      // Crossfade the new glyph (CSS; none with reduced motion). Same box: no layout shift.
      el.removeClass(SWAP);
      void el.offsetWidth;
      el.addClass(SWAP);
      const tip = v?.tip ?? el.dataset.peleBaseTip ?? "";
      setTooltip(el, tip);
      // A tooltip showing for this button follows at once.
      if (el.matches(":hover")) {
        const shown = el.doc.querySelector<HTMLElement>(".tooltip");
        const text = shown ? Array.from(shown.childNodes).find((n) => n.nodeType === Node.TEXT_NODE) : null;
        if (text) text.textContent = tip;
      }
    }
  }
}
