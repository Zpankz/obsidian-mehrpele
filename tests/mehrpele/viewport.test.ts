import { describe, expect, test } from "bun:test";
import { clientToSvgSize } from "../../src/mehrpele/remeasure";
import { DEFAULT_MEHRPELE_SETTINGS, normalizeMehrpeleSettings } from "../../src/mehrpele/settings";
import {
  bleedViewportBox,
  embedUiScale,
  isViewportMode,
  labelScales,
  setViewportBox,
  setViewportFactor,
  viewportBoxOf,
  viewportLayoutBox,
} from "../../src/mehrpele/viewport";

/** Minimal element stand-in: viewport.ts only writes inline styles. */
const fakeEl = () => ({ style: {} as Record<string, string> }) as unknown as HTMLElement;

describe("embedUiScale (viewport scaling)", () => {
  test("never magnifies embed UI", () => {
    expect(embedUiScale(1, 0.75)).toBe(1);
    expect(embedUiScale(1.5, 0.75)).toBe(1);
    expect(embedUiScale(3, 0.75)).toBe(1);
  });
  test("scales down with the diagram between the floor and 1", () => {
    expect(embedUiScale(0.9, 0.75)).toBeCloseTo(0.9);
    expect(embedUiScale(0.75, 0.75)).toBeCloseTo(0.75);
  });
  test("stops at the floor below it", () => {
    expect(embedUiScale(0.5, 0.75)).toBe(0.75);
    expect(embedUiScale(0.1, 0.6)).toBe(0.6);
  });
  test("legacy zoom follows the diagram scale", () => {
    expect(embedUiScale(2.77, 0.75, "zoom")).toBeCloseTo(2.77);
    expect(embedUiScale(0.4, 0.75, "zoom")).toBeCloseTo(0.4);
  });
  test("degenerate inputs fall back safely", () => {
    expect(embedUiScale(Number.NaN, 0.75)).toBe(1);
    expect(embedUiScale(0, 0.75)).toBe(1);
    expect(embedUiScale(0.5, 0)).toBe(1);
    expect(embedUiScale(0.5, 2)).toBe(1);
  });
});

describe("viewportLayoutBox", () => {
  // On screen the box is always svg × s: layout (svg × s/k) × k.
  const onScreen = (svg: number, s: number, minUi = 0.75) => {
    const k = embedUiScale(s, minUi);
    return viewportLayoutBox({ width: svg }, s, k).width * k;
  };
  test("on-screen size is SVG size × diagram scale at any zoom", () => {
    for (const s of [0.3, 0.6, 0.75, 0.9, 1, 1.5, 2.77, 3]) expect(onScreen(320, s)).toBeCloseTo(320 * s);
  });
  test("a larger diagram grows the viewport, not the controls", () => {
    expect(viewportLayoutBox({ width: 320, height: 240 }, 2.77, 1)).toEqual({ width: 320 * 2.77, height: 240 * 2.77 });
  });
  test("below the floor the viewport shrinks instead", () => {
    const k = embedUiScale(0.5, 0.75);
    const box = viewportLayoutBox({ width: 320, maxHeight: 480 }, 0.5, k);
    expect(box.width).toBeCloseTo((320 * 0.5) / 0.75);
    expect(box.maxHeight).toBeCloseTo((480 * 0.5) / 0.75);
    expect(box.height).toBeUndefined();
  });
});

describe("viewport box on a label element", () => {
  test("box stays in SVG units; the factor only changes layout px", () => {
    const el = fakeEl();
    setViewportBox(el, { width: 320, height: 240 });
    expect(el.style.width).toBe("320px");
    expect(setViewportFactor(el, 2)).toBe(true);
    expect(el.style.width).toBe("640px");
    expect(el.style.height).toBe("480px");
    expect(viewportBoxOf(el)).toEqual({ width: 320, height: 240 });
    // A resize preview sets a new SVG box at the current factor.
    setViewportBox(el, { width: 400, height: 300 });
    expect(el.style.width).toBe("800px");
    expect(setViewportFactor(el, 2)).toBe(false); // unchanged: no re-layout
  });
  test("auto height uses max-height and clears a fixed height", () => {
    const el = fakeEl();
    setViewportBox(el, { width: 320, maxHeight: 480 });
    setViewportFactor(el, 1.5);
    expect(el.style.height).toBe("");
    expect(el.style.maxHeight).toBe("720px");
  });
  test("non-viewport elements are ignored", () => {
    expect(setViewportFactor(fakeEl(), 2)).toBe(false);
    expect(viewportBoxOf(fakeEl())).toBeNull();
  });
});

describe("viewport labels", () => {
  test("embeds, auto-height note embeds and lazy placeholders are viewports", () => {
    expect(isViewportMode("embed")).toBe(true);
    expect(isViewportMode("embed-auto")).toBe(true);
    expect(isViewportMode("lazy")).toBe(true);
  });
  test("text, images, nested diagrams and chips scale with the diagram", () => {
    for (const m of ["markdown", "image", "diagram", "chip", undefined] as const) expect(isViewportMode(m)).toBe(false);
  });
  test("re-measure: SVG size is the on-screen size over the on-screen scale", () => {
    expect(clientToSvgSize({ width: 480, height: 300 }, 1.5)).toEqual({ width: 320, height: 200 });
  });
});

describe("embed scaling settings", () => {
  test("defaults: viewport scaling, 75 % UI floor", () => {
    expect(DEFAULT_MEHRPELE_SETTINGS.embedScaling).toBe("viewport");
    expect(DEFAULT_MEHRPELE_SETTINGS.minEmbedUiScale).toBe(0.75);
    expect(normalizeMehrpeleSettings(null).embedScaling).toBe("viewport");
  });
  test("normalisation keeps valid values and repairs bad ones", () => {
    expect(normalizeMehrpeleSettings({ embedScaling: "zoom" }).embedScaling).toBe("zoom");
    expect(normalizeMehrpeleSettings({ embedScaling: "huge" as never }).embedScaling).toBe("viewport");
    expect(normalizeMehrpeleSettings({ minEmbedUiScale: 0.5 }).minEmbedUiScale).toBe(0.5);
    expect(normalizeMehrpeleSettings({ minEmbedUiScale: 0.01 }).minEmbedUiScale).toBe(0.25);
    expect(normalizeMehrpeleSettings({ minEmbedUiScale: 4 }).minEmbedUiScale).toBe(1);
    expect(normalizeMehrpeleSettings({ minEmbedUiScale: Number.NaN }).minEmbedUiScale).toBe(0.75);
  });
});

describe("labelScales (overlay)", () => {
  test("diagram content scales with s; handles counter-scale to native size", () => {
    expect(labelScales(2, 1, false, 0.75)).toEqual({ local: 2, factor: 1, counter: 0.5 });
    // Inside a parent node shown at 1.5x: on screen 3x, so the counter is 1/3.
    expect(labelScales(2, 1.5, false, 0.75).counter).toBeCloseTo(1 / 3);
  });
  test("embeds: native-size UI, the viewport takes the rest", () => {
    const r = labelScales(2.77, 1, true, 0.75);
    expect(r.local).toBe(1);
    expect(r.factor).toBeCloseTo(2.77);
    expect(r.counter).toBe(1);
  });
  test("the embed clamp is decided on screen (zoomed lightbox, scaled parent)", () => {
    // s = 1 in the overlay, but an ancestor zooms 4x: UI stays native on screen.
    const r = labelScales(1, 4, true, 0.75);
    expect(r.local * 4).toBeCloseTo(1);
    expect(r.factor).toBeCloseTo(4);
    // A parent shrunk to 0.5 with s = 1 here: on screen 0.5 < floor → UI at 0.75 on screen.
    expect(labelScales(1, 0.5, true, 0.75).local * 0.5).toBeCloseTo(0.75);
  });
  test("legacy zoom keeps embeds scaling with the diagram", () => {
    expect(labelScales(2.77, 1, true, 0.75, "zoom")).toEqual({ local: 2.77, factor: 1, counter: 1 / 2.77 });
  });
  test("a bad ancestor scale is treated as untransformed", () => {
    expect(labelScales(2, Number.NaN, false, 0.75)).toEqual({ local: 2, factor: 1, counter: 0.5 });
  });
});

describe("bleedViewportBox", () => {
  const area = { w: 140, h: 70 };
  test("an auto-height note keeps its own height, up to its cap", () => {
    expect(bleedViewportBox("embed-auto", false, area, { width: 300, maxHeight: 400 })).toEqual({ width: 140, maxHeight: 400 });
    expect(bleedViewportBox("embed-auto", false, area, null)).toEqual({ width: 140 });
  });
  test("an auto-height note whose height the user set keeps to the node", () => {
    expect(bleedViewportBox("embed-auto", true, area, { width: 300, maxHeight: 400 })).toEqual({ width: 140, height: 70 });
  });
  test("a fixed view fills the node box", () => {
    expect(bleedViewportBox("embed", false, area, { width: 300, height: 200 })).toEqual({ width: 140, height: 70 });
  });
});
