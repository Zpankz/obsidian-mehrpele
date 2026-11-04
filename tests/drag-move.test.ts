import { describe, expect, test } from "bun:test";
import {
  DRAG_THRESHOLD_PX,
  dragMoved,
  isGenuineHandleClick,
  isGenuineHandlePress,
  ResizeDrag,
  type PointerLike,
} from "../src/drag-move";

const handle = { id: "corner" };
const press = (o: Partial<PointerLike> = {}): PointerLike => ({
  isTrusted: true,
  isPrimary: true,
  button: 0,
  buttons: 1,
  pointerId: 1,
  clientX: 100,
  clientY: 100,
  target: handle,
  ...o,
});
const at = (x: number, y: number, o: Partial<PointerLike> = {}): PointerLike => press({ clientX: x, clientY: y, ...o });

describe("dragMoved", () => {
  test("only counts movement of at least the threshold", () => {
    expect(DRAG_THRESHOLD_PX).toBe(4);
    expect(dragMoved(0)).toBe(false);
    expect(dragMoved(3)).toBe(false);
    expect(dragMoved(-3)).toBe(false);
    expect(dragMoved(4)).toBe(true);
    expect(dragMoved(-9)).toBe(true);
  });
});

describe("isGenuineHandlePress", () => {
  test("accepts a trusted primary left press on the handle itself", () => {
    expect(isGenuineHandlePress(press(), handle)).toBe(true);
  });
  test("rejects synthetic, secondary, non-left and bubbled presses", () => {
    expect(isGenuineHandlePress(press({ isTrusted: false }), handle)).toBe(false);
    expect(isGenuineHandlePress(press({ isPrimary: false }), handle)).toBe(false);
    expect(isGenuineHandlePress(press({ button: 2 }), handle)).toBe(false);
    // An embedded view's canvas/toolbar under or inside the node.
    expect(isGenuineHandlePress(press({ target: { id: "canvas" } }), handle)).toBe(false);
  });
  test("double-click resets only when trusted and on the handle", () => {
    expect(isGenuineHandleClick({ isTrusted: true, target: handle }, handle)).toBe(true);
    expect(isGenuineHandleClick({ isTrusted: false, target: handle }, handle)).toBe(false);
    expect(isGenuineHandleClick({ isTrusted: true, target: {} }, handle)).toBe(false);
  });
});

describe("ResizeDrag", () => {
  test("a non-genuine press never starts a drag", () => {
    expect(ResizeDrag.begin(press({ isTrusted: false }), handle)).toBeNull();
    expect(ResizeDrag.begin(press({ target: null }), handle)).toBeNull();
  });

  test("a real drag commits once, with client-px deltas", () => {
    const d = ResizeDrag.begin(press(), handle)!;
    expect(d.move(at(110, 104))).toEqual({ kind: "move", dx: 10, dy: 4 });
    expect(d.moved).toBe(true);
    expect(d.end(at(110, 104, { buttons: 0 }), "up")).toBe(true);
    // Idempotent: a trailing lostpointercapture / second up never re-commits.
    expect(d.end(at(110, 104), "cancel")).toBe(false);
    expect(d.end(at(110, 104), "up")).toBe(false);
  });

  test("a click with jitter below the threshold does not commit", () => {
    const d = ResizeDrag.begin(press(), handle)!;
    d.move(at(102, 101));
    d.move(at(103, 102)); // hypot ≈ 3.6 < 4
    expect(d.moved).toBe(false);
    expect(d.end(at(103, 102, { buttons: 0 }), "up")).toBe(false);
  });

  test("moving out and back still counts as moved (caller skips unchanged values)", () => {
    const d = ResizeDrag.begin(press(), handle)!;
    d.move(at(140, 100));
    d.move(at(100, 100));
    expect(d.end(at(100, 100, { buttons: 0 }), "up")).toBe(true);
  });

  test("synthetic or foreign-pointer moves are ignored and never mark movement", () => {
    const d = ResizeDrag.begin(press(), handle)!;
    expect(d.move(at(400, 400, { isTrusted: false }))).toEqual({ kind: "ignore" });
    expect(d.move(at(400, 400, { pointerId: 7 }))).toEqual({ kind: "ignore" });
    expect(d.moved).toBe(false);
    expect(d.end(at(400, 400, { buttons: 0 }), "up")).toBe(false);
  });

  test("a move without the button held abandons the drag (stale gesture)", () => {
    const d = ResizeDrag.begin(press(), handle)!;
    d.move(at(150, 150));
    expect(d.move(at(160, 160, { buttons: 0 }))).toEqual({ kind: "abandon" });
    expect(d.end(null, "cancel")).toBe(false);
  });

  test("pointercancel / lost capture never commit, even after movement", () => {
    const d = ResizeDrag.begin(press(), handle)!;
    d.move(at(200, 100));
    expect(d.end(at(200, 100), "cancel")).toBe(false);
  });

  test("a synthetic or foreign pointerup does not commit", () => {
    const a = ResizeDrag.begin(press(), handle)!;
    a.move(at(200, 100));
    expect(a.end(at(200, 100, { isTrusted: false }), "up")).toBe(false);
    const b = ResizeDrag.begin(press(), handle)!;
    b.move(at(200, 100));
    expect(b.end(at(200, 100, { pointerId: 9 }), "up")).toBe(false);
  });
});
