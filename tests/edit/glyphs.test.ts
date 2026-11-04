import { describe, expect, test } from "bun:test";
import { FLOW_SHAPES } from "../../src/edit/flow-edit";
import { groupShapes, shapeGlyph, shapeGrid, SHAPE_GROUPS } from "../../src/edit/glyphs";
import { MIND_SHAPES } from "../../src/edit/other-edit";

describe("shape glyphs are Pele's own outlines", () => {
  test("every flowchart and mindmap shape draws, without its label", () => {
    for (const s of FLOW_SHAPES) {
      const g = shapeGlyph(s.key, false);
      expect(g, s.key).toMatch(/^<(rect|path|circle|polygon|ellipse)\b/);
      expect(g).not.toContain("<text");
      expect(g).not.toContain("<g");
    }
    for (const s of MIND_SHAPES) expect(shapeGlyph(s.key, true), s.key).toMatch(/^<(rect|path|circle|polygon|ellipse)\b/);
  });
  test("the drawing matches the shape", () => {
    expect(shapeGlyph("diamond", false)).toStartWith("<polygon points=\"0,-");
    expect(shapeGlyph("doublecircle", false)!.match(/<circle/g)).toHaveLength(2);
    expect(shapeGlyph("subroutine", false)).toContain("<path"); // the inner bars
    expect(shapeGlyph("nope", false)).toBeNull();
  });
});

describe("shape rows", () => {
  const opt = (key: string) => ({ key });
  test("flowchart: boxes, round, angular, special", () => {
    const rows = groupShapes(FLOW_SHAPES.map((s) => opt(s.key)));
    expect(rows.map((r) => r.map((o) => o.key))).toEqual([
      ["rect", "rounded", "stadium", "subroutine"],
      ["circle", "doublecircle"],
      ["diamond", "hexagon", "parallelogram", "parallelogram-alt", "trapezoid", "trapezoid-alt"],
      ["cylinder", "asymmetric"],
    ]);
  });
  test("mindmap: only its own shapes; nothing is lost", () => {
    const rows = groupShapes(MIND_SHAPES.map((s) => opt(s.key)));
    expect(rows.flat().map((o) => o.key).sort()).toEqual(MIND_SHAPES.map((s) => s.key).sort());
    expect(rows.map((r) => r.map((o) => o.key))).toEqual([["default", "rect", "rounded"], ["circle", "cloud"], ["hexagon", "bang"]]);
    expect(groupShapes([opt("rect"), opt("rounded"), opt("future")]).map((r) => r.map((o) => o.key))).toEqual([["rect", "rounded"], ["future"]]);
  });
  test("every known shape has a group", () => {
    const grouped = new Set(SHAPE_GROUPS.flatMap((g) => g.keys));
    for (const k of [...FLOW_SHAPES, ...MIND_SHAPES].map((s) => s.key)) expect(grouped.has(k), k).toBe(true);
  });
});

describe("shape grid (B4: one column count, aligned cells, groups by spacing)", () => {
  const opt = (key: string) => ({ key });
  const keys = (g: ReturnType<typeof shapeGrid<{ key: string }>>) => g.groups.map((rows) => rows.map((r) => r.map((o) => o.key)));
  test("flowchart: four columns in every group; a long group wraps in order", () => {
    const g = shapeGrid(groupShapes(FLOW_SHAPES.map((s) => opt(s.key))));
    expect(g.cols).toBe(4);
    expect(keys(g)).toEqual([
      [["rect", "rounded", "stadium", "subroutine"]],
      [["circle", "doublecircle"]],
      [["diamond", "hexagon", "parallelogram", "parallelogram-alt"], ["trapezoid", "trapezoid-alt"]],
      [["cylinder", "asymmetric"]],
    ]);
    expect(g.rows.every((r) => r.length <= g.cols)).toBe(true);
  });
  test("fewer columns when no group is that wide; nothing lost", () => {
    const g = shapeGrid(groupShapes(MIND_SHAPES.map((s) => opt(s.key))));
    expect(g.cols).toBe(3);
    expect(g.rows.flat().map((o) => o.key).sort()).toEqual(MIND_SHAPES.map((s) => s.key).sort());
  });
  test("rows are the groups' rows in order; groupStart marks each group's first row", () => {
    const g = shapeGrid([[opt("a"), opt("b"), opt("c"), opt("d"), opt("e")], [opt("f")]], 4);
    expect(g.rows.map((r) => r.map((o) => o.key))).toEqual([["a", "b", "c", "d"], ["e"], ["f"]]);
    expect(g.groupStart).toEqual([true, false, true]);
    expect(shapeGrid([]).rows).toEqual([]);
  });
});
