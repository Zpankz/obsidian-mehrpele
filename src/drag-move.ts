/**
 * Resize-handle intent. Sizes are written into the user's note, so only a
 * genuine user gesture may commit one: a trusted primary-button drag that
 * started on the handle element itself, with the button held throughout and
 * real movement. Everything else — synthetic events (embedded views dispatch
 * their own pointer events), clicks with a few px of jitter, cancelled or
 * lost-capture gestures, moves after the button was released elsewhere —
 * restores the previous size without writing.
 */

/** Pointer travel (client px) before a press on a handle counts as a drag. */
export const DRAG_THRESHOLD_PX = 4;

/** The PointerEvent fields the intent checks read (plain objects in tests). */
export interface PointerLike {
  isTrusted: boolean;
  isPrimary: boolean;
  button: number;
  buttons: number;
  pointerId: number;
  clientX: number;
  clientY: number;
  target: unknown;
}

/** Pure decision: did a resize drag actually move enough to commit? */
export function dragMoved(deltaPx: number, thresholdPx = DRAG_THRESHOLD_PX): boolean {
  return Math.abs(deltaPx) >= thresholdPx;
}

/** A press that may start a resize: trusted, primary, left button, on the handle itself. */
export function isGenuineHandlePress(e: PointerLike, handle: unknown): boolean {
  return e.isTrusted && e.isPrimary && e.button === 0 && e.target === handle;
}

/** A double-click that may reset a size: trusted and on the handle itself. */
export function isGenuineHandleClick(e: { isTrusted: boolean; target: unknown }, handle: unknown): boolean {
  return e.isTrusted && e.target === handle;
}

/** What a pointer event means for a drag in progress. */
export type DragStep =
  | { kind: "move"; dx: number; dy: number }
  /** Not part of this drag (synthetic, another pointer): ignore it. */
  | { kind: "ignore" }
  /** The button is no longer held (released outside us): abandon, no commit. */
  | { kind: "abandon" };

/**
 * One resize drag, from a genuine press on a handle. Pointer deltas are in
 * client px; callers convert them to their own units.
 */
export class ResizeDrag {
  readonly startX: number;
  readonly startY: number;
  readonly pointerId: number;
  private travelled = false;
  private done = false;

  /** null when `press` is not a genuine press on `handle`. */
  static begin(press: PointerLike, handle: unknown, threshold = DRAG_THRESHOLD_PX): ResizeDrag | null {
    return isGenuineHandlePress(press, handle) ? new ResizeDrag(press, threshold) : null;
  }

  private constructor(press: PointerLike, private threshold: number) {
    this.startX = press.clientX;
    this.startY = press.clientY;
    this.pointerId = press.pointerId;
  }

  /** Whether the pointer has travelled past the threshold at some point. */
  get moved(): boolean {
    return this.travelled;
  }

  get ended(): boolean {
    return this.done;
  }

  move(ev: PointerLike): DragStep {
    if (this.done || !ev.isTrusted || ev.pointerId !== this.pointerId) return { kind: "ignore" };
    if ((ev.buttons & 1) === 0) return { kind: "abandon" };
    const dx = ev.clientX - this.startX;
    const dy = ev.clientY - this.startY;
    if (Math.hypot(dx, dy) >= this.threshold) this.travelled = true;
    return { kind: "move", dx, dy };
  }

  /**
   * End of the gesture. Commits only on a trusted pointerup of this pointer
   * after real movement; pointercancel / lostpointercapture / abandon never
   * commit. Idempotent: the first call decides.
   */
  end(ev: PointerLike | null, kind: "up" | "cancel"): boolean {
    if (this.done) return false;
    this.done = true;
    return kind === "up" && !!ev && ev.isTrusted && ev.pointerId === this.pointerId && this.travelled;
  }
}

/** Shared listener wiring for a handle drag (frames, shells, node corners). */
export interface HandleDragCallbacks {
  /** Pointer delta (client px) while dragging. */
  onMove(dx: number, dy: number, ev: PointerEvent): void;
  /** Gesture over: `commit` is the intent decision (false = restore). */
  onEnd(commit: boolean): void;
}

/**
 * Track a drag from a genuine press on `handle` until it ends. Returns false
 * (and does nothing) when the press is not genuine.
 */
export function trackHandleDrag(handle: HTMLElement, press: PointerEvent, cb: HandleDragCallbacks): boolean {
  const drag = ResizeDrag.begin(press, handle);
  if (!drag) return false;
  try {
    handle.setPointerCapture(press.pointerId);
  } catch {
    /* pointer already gone */
  }
  const finish = (ev: PointerEvent | null, kind: "up" | "cancel"): void => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onCancel);
    handle.removeEventListener("lostpointercapture", onCancel);
    cb.onEnd(drag.end(ev, kind));
  };
  const onMove = (ev: PointerEvent): void => {
    const step = drag.move(ev);
    if (step.kind === "move") cb.onMove(step.dx, step.dy, ev);
    else if (step.kind === "abandon") finish(null, "cancel");
  };
  const onUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== drag.pointerId) return;
    finish(ev, "up");
  };
  const onCancel = (ev: PointerEvent): void => {
    if (ev.pointerId !== drag.pointerId || drag.ended) return;
    finish(ev, "cancel");
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onCancel);
  handle.addEventListener("lostpointercapture", onCancel);
  return true;
}
