import { describe, expect, test } from "bun:test";
import { MOD_ACTIONS, modAction, modState, nextState, NO_MODS, tipWithHints, variantFor, variantId } from "../../src/edit/mod-actions";

const find = (sel: string) => MOD_ACTIONS.find((a) => a.selector.includes(sel))!;
const S = (mod: boolean, alt = false, shift = false) => ({ mod, alt, shift });

describe("modifier icons", () => {
  test("copy: image / Copy SVG while Mod is held", () => {
    expect(variantFor(find("pele-copy-action"), NO_MODS)).toBeNull();
    expect(variantFor(find("pele-copy-action"), S(true))).toEqual({ icon: "image", tip: "Copy SVG" });
  });
  test("quick-add +: sparkles / Autocomplete node", () => {
    expect(variantFor(find("pele-edit-plus"), S(true))).toEqual({ icon: "sparkles", tip: "Autocomplete node" });
  });
  test("open original: tab, split, window (Keymap.isModEvent order)", () => {
    const o = find("pele-open-original");
    expect(variantFor(o, S(true))?.tip).toBe("Open in new tab");
    expect(variantFor(o, S(true, true))).toEqual({ icon: "columns-2", tip: "Open to the right" });
    expect(variantFor(o, S(true, true, true))?.tip).toBe("Open in new window");
    expect(variantFor(o, S(false, true))).toBeNull();
  });
  test("Mod is Cmd on macOS, Ctrl elsewhere", () => {
    const e = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(modState(e, true).mod).toBe(true);
    expect(modState(e, false).mod).toBe(false);
  });
});

test("the modifier key itself sets and clears its flag", () => {
  const k = (type: string, key: string, meta = false) => ({ type, key, metaKey: meta, ctrlKey: false, altKey: false, shiftKey: false });
  expect(nextState(k("keydown", "Meta"), true).mod).toBe(true);
  expect(nextState(k("keyup", "Meta", true), true).mod).toBe(false);
  expect(nextState(k("keydown", "Control"), false).mod).toBe(true);
  expect(nextState(k("keydown", "a", true), true).mod).toBe(true);
});

describe("zoom and code variants", () => {
  const zoom = modAction(".pele-zoom-action");
  const code = modAction(".pele-code-action");
  test("zoom: new tab, split right, window — the same keys as links", () => {
    expect(variantFor(zoom, S(true))).toEqual({ icon: "maximize-2", tip: "Open diagram in new tab" });
    expect(variantFor(zoom, S(true, true))).toEqual({ icon: "columns-2", tip: "Open diagram to the right" });
    expect(variantFor(zoom, S(true, true, true))).toEqual({ icon: "picture-in-picture-2", tip: "Open diagram in new window" });
    expect([NO_MODS, S(true), S(true, true), S(true, true, true), S(false, true), S(true, false, true)].map((s) => variantId(zoom, s))).toEqual([null, "tab", "split", "window", null, null]);
  });
  test("code: canvas, source to the right, source in a window", () => {
    expect(variantFor(code, S(true))).toEqual({ icon: "layout-dashboard", tip: "Open as canvas" });
    expect(variantFor(code, S(true, true))).toEqual({ icon: "columns-2", tip: "Edit source to the right" });
    expect([S(true), S(true, true), S(true, true, true)].map((s) => variantId(code, s))).toEqual(["canvas", "split", "window"]);
  });
  test("base tooltips list the variants, simplest first, in platform key names", () => {
    expect(tipWithHints("Zoom in", zoom, true)).toBe("Zoom in (⌘: new tab, ⌘⌥: right, ⌘⌥⇧: window)");
    expect(tipWithHints("Edit block", code, false)).toBe("Edit block (Ctrl: canvas, Ctrl+Alt: right, Ctrl+Alt+Shift: window)");
    expect(tipWithHints("Copy", modAction(".pele-copy-action"), true)).toBe("Copy");
  });
});
