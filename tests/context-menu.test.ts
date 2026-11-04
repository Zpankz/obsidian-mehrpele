import { describe, expect, test } from "bun:test";
import { contextItems, placeContextMenu, type ContextCaps } from "../src/context-menu-spec";

const none: ContextCaps = { link: false, excalidraw: false, width: false, nodeSize: false, allSizes: false };
const ids = (c: ContextCaps) => contextItems(c).map((s) => s.items.map((i) => i.id));

describe("diagram context menu spec (U3: icon-first)", () => {
  test("base sections: copy, export, open; no size section without sizes", () => {
    expect(contextItems(none).map((s) => s.id)).toEqual(["copy", "export", "open"]);
    expect(ids(none)).toEqual([["svg", "png"], ["export-svg", "export-png"], ["source", "playground", "canvas"]]);
  });
  test("optional items appear where they belong", () => {
    const all = { link: true, excalidraw: true, width: true, nodeSize: true, allSizes: true };
    expect(ids(all)).toEqual([
      ["svg", "png", "link", "wikilink"],
      ["export-svg", "export-png"],
      ["source", "playground", "canvas", "excalidraw"],
      ["reset-size", "reset-node-size", "reset-all-sizes"],
    ]);
  });
  test("every item has an icon and a short label; icons are unique (no pencil: that is edit)", () => {
    const items = contextItems({ link: true, excalidraw: true, width: true, nodeSize: true, allSizes: true }).flatMap((s) => s.items);
    for (const i of items) {
      expect(i.icon.length, i.id).toBeGreaterThan(0);
      expect(i.label.split(" ").length, i.id).toBeLessThanOrEqual(4);
    }
    expect(new Set(items.map((i) => i.icon)).size).toBe(items.length);
    expect(items.some((i) => i.icon === "pencil")).toBe(false);
  });
});

describe("context menu placement", () => {
  const vp = { width: 1000, height: 800 };
  const size = { width: 160, height: 120 };
  test("at the pointer, down-right", () => {
    expect(placeContextMenu({ x: 100, y: 200 }, size, vp)).toEqual({ left: 100, top: 200 });
  });
  test("flips left/up at the edges and stays inside", () => {
    expect(placeContextMenu({ x: 950, y: 780 }, size, vp)).toEqual({ left: 950 - 160, top: 780 - 120 });
    const p = placeContextMenu({ x: 10, y: 10 }, { width: 2000, height: 2000 }, vp);
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.top).toBeGreaterThanOrEqual(0);
  });
});
