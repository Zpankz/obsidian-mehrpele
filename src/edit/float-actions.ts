/**
 * A frame's action bar (zoom, code, copy, open): `.embed-actions`, the frame
 * root's own child. A nested frame's bar lives inside its node's overlay item
 * (overflow-clipped, CSS-scaled), so a frame narrower than the bar, or one
 * near a clipping edge, cuts it off. On hover, a clipped bar moves (same
 * element, so its listeners stay) into a fixed body layer
 * `.pele-floating-actions` at the frame's visible top-right, kept inside the
 * viewport; it goes back when the pointer leaves both, on scroll or resize,
 * on detach, and when the frame stops being where the bar was placed for it
 * (detached, hidden, re-rendered, moved, or in another window) - things that
 * happen with no pointerleave, e.g. a tab moving to another note.
 */
import { Platform } from "obsidian";
import { floatBarBox, intersect, isClipped, isEmpty, type Rect } from "./float-geometry";

const LEAVE_MS = 150;
/** How often a floated bar re-checks its frame (only while floated). */
const WATCH_MS = 250;

const floated = new WeakMap<HTMLElement, HTMLElement>();
/** Anchor checks of the bars floated now. */
const live = new Set<() => void>();

/** Put back every floated bar whose frame is no longer where it was (workspace changes call this). */
export function sweepFloatingActions(): void {
  for (const check of [...live]) check();
}

/** The frame's action bar, wherever it is shown (in the frame or floated). */
export function actionBarOf(root: HTMLElement): HTMLElement | null {
  return floated.get(root) ?? root.querySelector<HTMLElement>(":scope > .embed-actions");
}

const rectOf = (r: DOMRect): Rect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

/** The viewport cut down by every overflow-clipping ancestor of `el`. */
function clipOf(el: HTMLElement): Rect {
  const doc = el.ownerDocument;
  const win = doc.defaultView ?? window;
  let clip: Rect = { left: 0, top: 0, right: doc.documentElement.clientWidth, bottom: doc.documentElement.clientHeight };
  for (let p = el.parentElement; p && p !== doc.body; p = p.parentElement) {
    const s = win.getComputedStyle(p);
    if (s.overflowX !== "visible" || s.overflowY !== "visible") clip = intersect(clip, rectOf(p.getBoundingClientRect()));
  }
  return clip;
}

/** Float `root`'s action bar out of clipping ancestors while hovered. Returns the detach. */
export function attachFloatingActions(root: HTMLElement): () => void {
  if (Platform.isMobile) return () => undefined;
  let layer: HTMLElement | null = null;
  let mark: Comment | null = null;
  let bar: HTMLElement | null = null;
  let win: Window | null = null;
  let timer = 0;
  let watch = 0;
  let anchor: Rect | null = null;
  let armed = false;

  const cancel = (): void => {
    if (timer) win?.clearTimeout(timer);
    timer = 0;
  };
  const restore = (): void => {
    cancel();
    if (watch) win?.clearInterval(watch);
    watch = 0;
    live.delete(check);
    if (!layer || !bar || !mark) return;
    win?.removeEventListener("scroll", onScroll, true);
    win?.removeEventListener("resize", restore);
    win?.removeEventListener("blur", restore);
    // A re-render dropped the placeholder (and built a new bar): drop the stale one.
    if (root.contains(mark)) mark.replaceWith(bar);
    else bar.remove();
    layer.remove();
    floated.delete(root);
    layer = mark = bar = null;
  };
  /** Restore unless the frame is still shown, in the layer's window, where the bar was placed. */
  const check = (): void => {
    if (!layer || !mark || !anchor) return;
    const r = root.getBoundingClientRect();
    const same = Math.abs(r.left - anchor.left) < 1 && Math.abs(r.top - anchor.top) < 1 && Math.abs(r.right - anchor.right) < 1;
    if (root.isConnected && root.ownerDocument === layer.ownerDocument && root.contains(mark) && r.width && same) return;
    restore();
    armed = !!r.width; // still shown (moved): float again on the next pointer move
  };
  const leave = (): void => {
    if (!layer || timer) return;
    timer = (win ?? window).setTimeout(() => {
      timer = 0;
      if (!root.isConnected || !(root.matches(":hover") || layer?.matches(":hover"))) restore();
    }, LEAVE_MS);
  };
  const onScroll = (): void => {
    restore();
    armed = true; // re-check on the next move: the frame may still be under the pointer
  };

  const float = (): void => {
    cancel();
    if (layer || !root.isConnected) return;
    const b = root.querySelector<HTMLElement>(":scope > .embed-actions");
    if (!b?.childElementCount) return;
    const r = b.getBoundingClientRect();
    if (!r.width) return;
    const clip = clipOf(b);
    if (!isClipped(rectOf(r), clip)) return;
    const visible = intersect(rectOf(root.getBoundingClientRect()), clip);
    if (isEmpty(visible)) return;
    // Looked up now: a frame is built before it is placed, possibly in a popout.
    const doc = root.ownerDocument;
    win = doc.defaultView ?? window;
    bar = b;
    mark = doc.createComment("pele-floating-actions");
    b.replaceWith(mark);
    layer = doc.body.createDiv({ cls: "pele-floating-actions" });
    layer.appendChild(b);
    const vp = { left: 0, top: 0, right: doc.documentElement.clientWidth, bottom: doc.documentElement.clientHeight };
    const at = floatBarBox(visible, { width: layer.offsetWidth, height: layer.offsetHeight }, vp);
    layer.style.left = `${Math.round(at.left)}px`;
    layer.style.top = `${Math.round(at.top)}px`;
    layer.addEventListener("pointerenter", cancel);
    layer.addEventListener("pointerleave", leave);
    floated.set(root, b);
    win.addEventListener("scroll", onScroll, true);
    win.addEventListener("resize", restore);
    win.addEventListener("blur", restore);
    anchor = rectOf(root.getBoundingClientRect());
    live.add(check);
    watch = win.setInterval(check, WATCH_MS);
  };
  const onEnter = (): void => {
    armed = false;
    float();
  };
  const onMove = (): void => {
    if (!armed) return;
    armed = false;
    float();
  };

  root.addEventListener("pointerenter", onEnter);
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerleave", leave);
  return () => {
    root.removeEventListener("pointerenter", onEnter);
    root.removeEventListener("pointermove", onMove);
    root.removeEventListener("pointerleave", leave);
    restore();
  };
}
