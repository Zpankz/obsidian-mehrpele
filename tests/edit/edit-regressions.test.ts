import { describe, expect, test } from "bun:test";
import { parse, render } from "pele-render/pele";
import { analyse, applyEdit, readText, type EditContext, type EditOp, type EditTarget } from "../../src/edit/ops";
import { withMehrpeleDirective } from "../../src/edit/label-text";

const ctx = (source: string, extra: Partial<EditContext> = {}): EditContext => ({ source, type: "flowchart", markdownBlock: false, canSwitch: false, ...extra });
function edit(c: EditContext, t: EditTarget, op: EditOp): string {
  const r = applyEdit(c, t, op);
  if (!r.ok) throw new Error(r.error);
  return r.source;
}
const svgEdgeIds = (src: string) => [...render(src).svg.matchAll(/<g class="pele-edge[^"]*" data-id="([^"]+)"/g)].map((m) => m[1]!);

describe("state transitions follow Pele's edge numbering (notes count)", () => {
  const ST = `stateDiagram-v2
  [*] --> A
  note right of A : hello
  A --> B
  note left of B
    multi --> line
  end note
  B --> C`;
  const sc = ctx(ST, { type: "state" });
  test("deleting A→B removes A→B", () => {
    const ids = svgEdgeIds(ST);
    expect(ids).toEqual(["edge0", "edge2", "edge4"]);
    const s = edit(sc, { kind: "edge", id: "edge2" }, { op: "delete" });
    expect(s).not.toContain("  A --> B");
    expect(s).toContain("B --> C");
    expect(s).toContain("multi --> line");
  });
  test("labels go on the right transition", () => {
    expect(edit(sc, { kind: "edge", id: "edge4" }, { op: "text", text: "go" })).toContain("B --> C : go");
  });
  test("state text is added next to the state, before trailing directives", () => {
    const src = "stateDiagram-v2\n  state Comp {\n    x --> y\n  }\n%% pele-size x=100 %%";
    const s = edit(ctx(src, { type: "state" }), { kind: "node", id: "y" }, { op: "text", text: "Why" });
    expect(s).toBe("stateDiagram-v2\n  state Comp {\n    x --> y\n    y : Why\n  }\n%% pele-size x=100 %%");
    expect(() => render(s)).not.toThrow();
  });
});

describe("deleting a node keeps its neighbours", () => {
  test("mirrored chains", () => {
    const s = edit(ctx("flowchart LR\n  A --> B --> C\n  C --> B --> A"), { kind: "node", id: "B" }, { op: "delete" });
    const m = parse(s) as any;
    expect([...m.nodes.keys()].sort()).toEqual(["A", "C"]);
  });
  test("identical chains", () => {
    const s = edit(ctx("flowchart LR\n  A --> B --> C\n  A --> B --> C"), { kind: "node", id: "B" }, { op: "delete" });
    expect([...(parse(s) as any).nodes.keys()].sort()).toEqual(["A", "C"]);
  });
  test("a lone A:::cls keeps its class", () => {
    const s = edit(ctx("flowchart LR\n  A:::hot --> B\n  A --> C\n  classDef hot fill:#f00"), { kind: "edge", id: "L_A_B_0" }, { op: "delete" });
    expect(s).toContain("A:::hot");
  });
});

describe("nested quoted subgraphs resolve by closing order and title", () => {
  const src = `flowchart TD
  subgraph "Outer"
    subgraph "Inner"
      A
    end
    B
  end`;
  test("editing Inner rewrites Inner", () => {
    const c = ctx(src);
    const ids = (parse(src) as any).subgraphs.map((s: any) => s.id);
    expect(ids).toEqual(["Inner", "Outer"]);
    expect(readText(c, { kind: "subgraph", id: "Inner" })).toBe("Inner");
    const s = edit(c, { kind: "subgraph", id: "Inner" }, { op: "text", text: "Core" });
    expect(s).toContain('subgraph "Outer"');
    expect(s).toContain('subgraph "Core"');
  });
  test("ungroup removes the right one", () => {
    const s = edit(ctx(src), { kind: "subgraph", id: "Inner" }, { op: "delete" });
    expect(s).toContain('subgraph "Outer"');
    expect(s).not.toContain("Inner");
  });
});

describe("frontmatter", () => {
  test("the Mehrpele directive goes after it", () => {
    const src = "---\ntitle: T\n---\nflowchart LR\n  A --> B";
    const out = withMehrpeleDirective(src);
    expect(out).toBe("---\ntitle: T\n---\n%% mehrpele %%\nflowchart LR\n  A --> B");
    expect(() => parse(out)).not.toThrow();
    expect(analyse(ctx(src), { kind: "node", id: "A" })).not.toBeNull();
  });
});
