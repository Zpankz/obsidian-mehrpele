import { describe, expect, test } from "bun:test";
import { parseLayoutDirective } from "pele-render/canvas";
import { render } from "pele-render/pele";
import { addNode, addSharedChild, applyEdit, applyEditMany, type EditContext } from "../../src/edit/ops";
import { addPin, besideBox, dropPins } from "../../src/edit/canvas-pos";

const SRC = `flowchart LR
  A[Alpha] --> B[Beta]
  A --> C[Gamma]
%% pele-layout canvas %%
%% pele-pos A=100,100,160,60 B=400,100,160,60 C=400,260 A>B=right,left A>C=bottom,left %%
%% pele-canvas {"sourceHash":"abc"} %%`;
const ctx = (source: string): EditContext => ({ source, type: "flowchart", markdownBlock: false, canSwitch: false });
const tail = (s: string) => s.slice(s.indexOf("%% pele-layout"));

describe("toolbar edits keep the canvas layout", () => {
  test("colour, shape and size leave pele-layout / pele-pos / pele-canvas byte for byte", () => {
    for (const op of [{ op: "color", value: { preset: 2 } }, { op: "shape", key: "stadium" }, { op: "size", value: "l" }] as const) {
      const r = applyEdit(ctx(SRC), { kind: "node", id: "B" }, op);
      if (!r.ok) throw new Error(r.error);
      expect(tail(r.source)).toBe(tail(SRC));
      expect(r.source.indexOf("%% pele-layout")).toBeGreaterThan(r.source.indexOf("B"));
    }
    const multi = applyEditMany(ctx(SRC), [{ kind: "node", id: "A" }, { kind: "edge", id: "L_A_B_0" }], { op: "color", value: { preset: 5 } });
    if (!multi.ok) throw new Error(multi.error);
    expect(tail(multi.source)).toBe(tail(SRC));
    expect(() => render(multi.source)).not.toThrow();
  });
  test("quick-add pins the new node on the clicked side", () => {
    const r = addNode(ctx(SRC), "B", "child", "New", "right");
    if (!r.ok) throw new Error(r.error);
    expect(parseLayoutDirective(r.source).pos.get(r.id)).toEqual({ x: 620, y: 100 });
    expect(r.source).toContain("B --> N1[New]");
    const up = addNode(ctx(SRC), "C", "sibling-before", "New", "top");
    if (!up.ok) throw new Error(up.error);
    expect(parseLayoutDirective(up.source).pos.get(up.id)).toEqual({ x: 400, y: 140 });
    expect(up.source).toContain("A --> N1[New]");
  });
  test("a shared child goes past the group on the child side", () => {
    const r = addSharedChild(ctx(SRC), ["B", "C"], "New", "right");
    if (!r.ok) throw new Error(r.error);
    expect(parseLayoutDirective(r.source).pos.get(r.id)).toEqual({ x: 620, y: 180 });
  });
  test("deleting a node drops its pin and its edges' ports, nothing else", () => {
    const r = applyEdit(ctx(SRC), { kind: "node", id: "B" }, { op: "delete" });
    if (!r.ok) throw new Error(r.error);
    expect(r.source).toContain("%% pele-pos A=100,100,160,60 C=400,260 A>C=bottom,left %%");
    expect(r.source).toContain('%% pele-canvas {"sourceHash":"abc"} %%');
  });
  test("auto layout is left alone", () => {
    const r = addNode(ctx("flowchart LR\n  A --> B"), "B", "child", "New", "right");
    if (!r.ok) throw new Error(r.error);
    expect(r.source).not.toContain("pele-pos");
  });
  test("pins: quoted ids, a first pele-pos line, empty lines removed", () => {
    expect(addPin("flowchart LR\n  A\n%% pele-layout canvas %%", "my id", { x: 1, y: 2.345 })).toBe('flowchart LR\n  A\n%% pele-layout canvas %%\n%% pele-pos "my id"=1,2.35 %%');
    expect(dropPins("x\n%% pele-pos A=1,2 %%\ny", "A")).toBe("x\ny");
    expect(besideBox({ x: 0, y: 0 }, "left")).toEqual({ x: -220, y: 0 });
  });
});
