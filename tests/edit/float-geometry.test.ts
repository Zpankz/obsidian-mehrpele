import { describe, expect, test } from "bun:test";
import { floatBarBox, intersect, isClipped, isEmpty } from "../../src/edit/float-geometry";

const vp = { left: 0, top: 0, right: 1000, bottom: 800 };

describe("float-actions geometry", () => {
  test("intersect / isEmpty", () => {
    expect(intersect({ left: 0, top: 0, right: 100, bottom: 100 }, { left: 50, top: 20, right: 200, bottom: 60 })).toEqual({ left: 50, top: 20, right: 100, bottom: 60 });
    expect(isEmpty(intersect({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 20, top: 0, right: 30, bottom: 10 }))).toBe(true);
  });

  test("isClipped: inside, sub-pixel, cut on the left", () => {
    const clip = { left: 623, top: 100, right: 755, bottom: 300 };
    expect(isClipped({ left: 630, top: 102, right: 750, bottom: 130 }, clip)).toBe(false);
    expect(isClipped({ left: 622.7, top: 102, right: 755.3, bottom: 130 }, clip)).toBe(false);
    expect(isClipped({ left: 600, top: 102, right: 753, bottom: 130 }, clip)).toBe(true);
    expect(isClipped({ left: 630, top: 290, right: 750, bottom: 318 }, clip)).toBe(true);
  });

  test("floatBarBox: right-aligned to the visible top-right", () => {
    expect(floatBarBox({ left: 500, top: 200, right: 700, bottom: 400 }, { width: 120, height: 28 }, vp)).toEqual({ left: 578, top: 202 });
  });

  test("floatBarBox: a frame narrower than the bar extends left, never off-screen", () => {
    expect(floatBarBox({ left: 40, top: 200, right: 80, bottom: 260 }, { width: 120, height: 28 }, vp)).toEqual({ left: 4, top: 202 });
    expect(floatBarBox({ left: 900, top: 790, right: 1100, bottom: 900 }, { width: 120, height: 28 }, vp)).toEqual({ left: 876, top: 768 });
  });
});
