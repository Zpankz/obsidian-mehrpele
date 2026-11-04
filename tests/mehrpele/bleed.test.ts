import { describe, expect, test } from "bun:test";
import { bleedArea, bleedBox, shapeBounds, bleedPad, bleedPlaceholder, bleedReservation, isAspectMode, isBleedLabel, isSoleCodeBlock, reservesBox, withBleedEntries } from "../../src/mehrpele/bleed";
import { noteCardTitle } from "../../src/mehrpele/note-card-title";
import { render } from "pele-render/pele";
import { nodeBoxMap, nodeSizeCaps, parseSizeDirective, withSizeDirective } from "pele-render/node-size";
import { extractLabels } from "../../src/mehrpele/extract";
import { buildPlaceholder, makeReservationMeasurer, placeholderSource } from "../../src/mehrpele/placeholder";

const FREE = { w: true, h: true, lock: "free" as const };
const node = (markdown: string, mode?: string) => ({ label: { kind: "node" as const, markdown, anchorId: "A" }, mode });

describe("full-bleed nodes", () => {
  test("one-element labels bleed in every sizable shape; text and edges do not", () => {
    for (const mode of ["embed", "embed-auto", "lazy", "image", "diagram"]) expect(isBleedLabel(node("x", mode), FREE)).toBe(true);
    expect(isBleedLabel(node("```js\nx()\n```", "markdown"), FREE)).toBe(true);
    expect(isBleedLabel(node("**bold**", "markdown"), FREE)).toBe(false);
    expect(isBleedLabel(node("x", "chip"), FREE)).toBe(false);
    expect(isBleedLabel({ label: { kind: "edge", markdown: "x", anchorId: "e" }, mode: "embed" }, FREE)).toBe(false);
    expect(isBleedLabel(node("x", "embed"), { w: true, h: false, lock: "square" })).toBe(true);
    expect(isBleedLabel(node("x", "embed"), { w: true, h: true, lock: "coupled" })).toBe(true);
    expect(isBleedLabel(node("x", "embed"), undefined)).toBe(false);
    // Only freely sizable shapes reserve the element's box; circles and diamonds keep theirs.
    expect(reservesBox(FREE)).toBe(true);
    expect(reservesBox({ w: true, h: false, lock: "square" })).toBe(false);
    expect(reservesBox({ w: true, h: true, lock: "coupled" })).toBe(false);
  });

  test("code nodes: one fence, not a nested diagram", () => {
    expect(isSoleCodeBlock("```js\nconst a = 1;\n```")).toBe(true);
    expect(isSoleCodeBlock("~~~\nplain\n~~~")).toBe(true);
    expect(isSoleCodeBlock("~~~mermaid\nflowchart LR\n~~~")).toBe(false);
    expect(isSoleCodeBlock("text\n```js\nx\n```")).toBe(false);
    expect(isSoleCodeBlock("```js\nx\n````")).toBe(false);
  });

  test("reservation leaves room for the exact box; heights snap to whole lines", () => {
    expect(bleedReservation({ width: 360, height: 240 })).toEqual({ width: 324, height: 1 });
    expect(bleedReservation({ width: 20, height: 20 })).toEqual({ width: 1, height: 1 });
    expect(bleedBox({ width: 360, height: 240 })).toEqual({ w: 360, h: 240 });
    expect(bleedBox({ width: 420, height: 260 })).toEqual({ w: 420, h: 264 });
    // Fixed aspect: next whole-line height, width keeps the aspect.
    expect(bleedBox({ width: 280, height: 305 }, { aspect: true })).toEqual({ w: 286, h: 312 });
    expect(bleedBox({ width: 160, height: 64 }, { aspect: true, lineHeight: 24 })).toEqual({ w: 180, h: 72 });
    expect(bleedBox({ width: 30, height: 10 })).toEqual({ w: 48, h: 48 });
    expect(isAspectMode("image") && isAspectMode("diagram") && !isAspectMode("embed")).toBe(true);
  });

  test("entries: in-render only, the user's own entry wins, partial entries completed", () => {
    const user = new Map([["U", { w: 500, h: 400 }], ["P", { w: 200 }]]);
    const out = withBleedEntries(user, new Map([["U", { width: 100, height: 100 }], ["P", { width: 300, height: 120 }], ["N", { width: 300, height: 200 }]]))!;
    expect(out.get("U")).toEqual({ w: 500, h: 400 });
    expect(out.get("P")).toEqual({ w: 200, h: 120 });
    expect(out.get("N")).toEqual({ w: 300, h: 216 });
    expect(user.get("P")).toEqual({ w: 200 });
    expect(withBleedEntries(new Map([["U", { w: 1, h: 1 }]]), new Map([["U", { width: 5, height: 5 }]]))).toBeNull();
  });

  test("a user's box entry narrower than the element is honoured (note card |320x240, pele-size 140x96)", () => {
    // Same pipeline as mount.ts prepare(): minimal reservation + in-render entry.
    const source = 'flowchart LR\n  N["![[note-cards/Field Guide|320x240]]"] --> M[Plain]\n%% pele-size N=140x96 %%';
    const content = { width: 320, height: 240 };
    const user = parseSizeDirective(source);
    const label = extractLabels(source).find((l) => l.anchorId === "N")!;
    const reserved = [buildPlaceholder(label, bleedReservation(content, user.get("N")), 16, 0)];
    const entries = withBleedEntries(user, new Map([["N", content]])) ?? user;
    const src = withSizeDirective(placeholderSource(source, reserved, 16), entries);
    const box = nodeBoxMap(render(src, { measurer: makeReservationMeasurer(reserved) }).svg).get("N")!;
    expect(Math.abs(box.w - 140)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.h - 96)).toBeLessThanOrEqual(12); // height moves on Pele's line grid
    // Without an entry, a larger one or a height-only one: the element's reservation, as before.
    expect(bleedReservation(content)).toEqual({ width: 284, height: 1 });
    expect(bleedReservation(content, { w: 500, h: 400 })).toEqual({ width: 284, height: 1 });
    expect(bleedReservation(content, { h: 96 })).toEqual({ width: 284, height: 1 });
  });

  // Render one bleed node the way mount.prepare does and return its box.
  const bleedRender = (decl: string, entry: { w?: number; h?: number } | null, content = { width: 320, height: 240 }) => {
    const source = `flowchart LR\n  ${decl} --> M[Plain]${entry ? `\n%% pele-size N=${entry.w ?? ""}${entry.h ? `x${entry.h}` : ""} %%` : ""}`;
    const caps = nodeSizeCaps(source)!.get("N");
    const user = parseSizeDirective(source);
    const label = extractLabels(source).find((l) => l.anchorId === "N")!;
    const plan = bleedPlaceholder(content, caps, user.get("N"));
    const reserved = [buildPlaceholder(label, plan.size, 16, 0)];
    const entries = plan.box ? withBleedEntries(user, new Map([["N", content]])) ?? user : user;
    const src = withSizeDirective(placeholderSource(source, reserved, 16), entries);
    return nodeBoxMap(render(src, { measurer: makeReservationMeasurer(reserved) }).svg).get("N")!;
  };

  test("free shapes: the box is the entry whatever Pele's padding for the shape", () => {
    for (const decl of ['N["![[c|320x240]]"]', 'N("![[c|320x240]]")', 'N[["![[c|320x240]]"]]', 'N[("![[c|320x240]]")]']) {
      const small = bleedRender(decl, { w: 140, h: 96 });
      expect([decl, Math.abs(small.w - 140) <= 2]).toEqual([decl, true]);
      // No entry: the element's own box.
      const own = bleedRender(decl, null);
      expect([decl, Math.abs(own.w - 320) <= 2]).toEqual([decl, true]);
    }
    // The pad follows the shape; unknown shapes take the widest known pad.
    expect(bleedPad({ w: true, h: true, lock: "free", shape: "square" })).toBe(36);
    expect(bleedPad({ w: true, h: true, lock: "free", shape: "subroutine" })).toBe(52);
    expect(bleedPad({ w: true, h: true, lock: "free" })).toBe(52);
  });

  test("diamonds, circles and pills shrink below their content when the user sizes them", () => {
    // Without an entry they keep Pele's box around the element (unchanged).
    expect(bleedRender('N{"![[c|320x240]]"}', null).w).toBeGreaterThan(500);
    const d = bleedRender('N{"![[c|320x240]]"}', { w: 150, h: 80 });
    expect(d.w).toBeLessThanOrEqual(152);
    expect(d.h).toBeLessThanOrEqual(100);
    const c = bleedRender('N(("![[c|320x240]]"))', { w: 120 });
    expect(c.w).toBeLessThanOrEqual(122);
    const p = bleedRender('N(["![[c|320x240]]"])', { w: 160, h: 72 });
    expect(p.w).toBeLessThanOrEqual(162);
    // A partial entry on a coupled shape can't size it: Pele's box as before.
    expect(bleedPlaceholder({ width: 320, height: 240 }, { w: true, h: true, lock: "coupled" }, { w: 150 })).toEqual({ size: { width: 320, height: 240 }, box: false, held: false });
    expect(bleedPlaceholder({ width: 320, height: 240 }, { w: true, h: false, lock: "square" }, { w: 150 })).toEqual({ size: { width: 1, height: 1 }, box: false, held: true });
  });

  test("bleed area: inside the stroke, rounded like the shape, inscribed in pills, circles and polygons", () => {
    const rect = bleedArea({ kind: "rect", x: -180, y: -120, w: 360, h: 240, rx: 4, stroke: 1 }, 1.5);
    expect(rect).toEqual({ x: -179.5, y: -119.5, w: 359, h: 239, r: 3.5 });
    // Subroutine: between its inner bars, square corners.
    expect(bleedArea({ kind: "rect", x: -128, y: -84, w: 256, h: 168, rx: 0, stroke: 1, bars: 8 }, 1.5)).toMatchObject({ x: -119.5, w: 239, r: 0 });
    // Stadium: a pill is inscribed, not clipped.
    const pill = bleedArea({ kind: "rect", x: -182, y: -96, w: 364, h: 192, rx: 96, stroke: 1 }, 1.5);
    expect(pill.inscribed).toBe(true);
    expect(pill.w / pill.h).toBeCloseTo(1.5, 2);
    const corner = (x: number, y: number) => {
      const dx = x - (181.5 - 95.5), dy = y - (95.5 - 95.5);
      return dx <= 0 || dy <= 0 || dx * dx + dy * dy <= 95.5 * 95.5 + 1e-6;
    };
    expect(corner(pill.w / 2, pill.h / 2)).toBe(true);
    // Circle: the rect's diagonal is the inner diameter.
    const c = bleedArea({ kind: "circle", cx: 0, cy: 0, r: 177.71, stroke: 1 }, 1);
    expect(Math.hypot(c.w, c.h)).toBeCloseTo(2 * 177.21, 1);
    expect(c.x).toBeCloseTo(-c.w / 2, 6);
    // Diamond: corners on the edges (w/W + h/H = 1), centred.
    const d = bleedArea({ kind: "polygon", points: [[0, -168], [268.8, 0], [0, 168], [-268.8, 0]], stroke: 0 }, 1.5);
    expect(d.w / 537.6 + d.h / 336).toBeCloseTo(1, 2);
    expect(d.x + d.w / 2).toBeCloseTo(0, 1);
    expect(d.y + d.h / 2).toBeCloseTo(0, 1);
    // Hexagon: taller than the diamond rule allows, still inside.
    const h = bleedArea({ kind: "polygon", points: [[-138, -96], [138, -96], [186, 0], [138, 96], [-138, 96], [-186, 0]], stroke: 1 }, 1.5);
    expect(h.h).toBeGreaterThan(160);
    expect(h.w / 2).toBeLessThanOrEqual(186 - 48 * (h.h / 2 / 96) + 1e-6);
    // Cylinder: under the rim, base ellipse at the bottom.
    expect(bleedArea({ kind: "cylinder", x: -120, y: -96, w: 240, h: 192, ry: 12, stroke: 1 }, 1.5)).toEqual({ x: -119.5, y: -71.5, w: 239, h: 167, r: 0, bottomRy: 11.5 });
  });

  test("note card label: file name, then heading or block", () => {
    expect(noteCardTitle("Field Guide", "")).toBe("Field Guide");
    expect(noteCardTitle("Field Guide", "#Details")).toBe("Field Guide › Details");
    expect(noteCardTitle("Field Guide", "#Details#Sub")).toBe("Field Guide › Details › Sub");
    expect(noteCardTitle("Field Guide", "#^summary")).toBe("Field Guide › ^summary");
  });
});

test("a card label sits on the node's outline, not on the label's reserved box", () => {
  // A user-sized diamond is smaller than its content: the label goes above the diamond.
  expect(shapeBounds({ kind: "polygon", points: [[100, 40], [160, 80], [100, 120], [40, 80]], stroke: 1 })).toEqual({ x: 40, y: 40, width: 120, height: 80 });
  expect(shapeBounds({ kind: "circle", cx: 50, cy: 60, r: 30, stroke: 1 })).toEqual({ x: 20, y: 30, width: 60, height: 60 });
  expect(shapeBounds({ kind: "rect", x: -10, y: -5, w: 20, h: 10, rx: 0, stroke: 1 })).toEqual({ x: -10, y: -5, width: 20, height: 10 });
  expect(shapeBounds({ kind: "cylinder", x: 0, y: 0, w: 40, h: 60, ry: 6, stroke: 1 })).toEqual({ x: 0, y: 0, width: 40, height: 60 });
});

test("a card whose height the user set holds it: the note scrolls inside instead of growing the node", () => {
  const rect = nodeSizeCaps("flowchart LR\n  A[x]")?.get("A");
  const diamond = nodeSizeCaps("flowchart LR\n  D{x}")?.get("D");
  const circle = nodeSizeCaps("flowchart LR\n  C((x))")?.get("C");
  const size = { width: 320, height: 240 };
  expect(bleedPlaceholder(size, rect).held).toBe(false);
  expect(bleedPlaceholder(size, rect, { w: 140 }).held).toBe(false);
  expect(bleedPlaceholder(size, rect, { w: 140, h: 70 }).held).toBe(true);
  expect(bleedPlaceholder(size, rect, { h: 70 }).held).toBe(true);
  expect(bleedPlaceholder(size, diamond, { w: 150, h: 80 }).held).toBe(true);
  // A circle's single size is its height too.
  expect(bleedPlaceholder(size, circle, { w: 120 }).held).toBe(true);
});
