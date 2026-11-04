import { describe, expect, test } from "bun:test";
import { parseLayoutDirective } from "pele-render/canvas";
import { parse } from "pele-render/pele";
import { addPort, pinAtDrop } from "../../src/edit/canvas-pos";
import { addConnectedNode, connectNodes, type EditContext } from "../../src/edit/ops";

const ctx = (source: string): EditContext => ({ source, type: "flowchart", markdownBlock: false, canSwitch: false });

const FC = `flowchart LR
  A[Start] --> B{Valid?}
  B -->|Yes| C(Render)
  C --> E[Done]
  linkStyle 2 stroke:#f00`;

const edges = (src: string) => (parse(src) as { edges: Array<{ start: string; end: string }> }).edges.map((e) => `${e.start}>${e.end}`);

describe("drag a + onto a node: one edge", () => {
  test("adds from --> to and keeps every edge's linkStyle", () => {
    const r = connectNodes(ctx(FC), "A", "E");
    if (!r.ok) throw new Error(r.error);
    expect(r.source).toContain("  A --> E\n");
    expect(edges(r.source)).toContain("A>E");
    expect(r.edgeId).toBe("L_A_E_0");
    // C --> E was edge 2 and kept its style wherever the new line landed.
    const i = edges(r.source).indexOf("C>E");
    expect(r.source).toContain(`linkStyle ${i} stroke:#f00`);
  });
  test("an existing edge is not duplicated (the UI flashes it)", () => {
    const r = connectNodes(ctx(FC), "A", "B");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.duplicate).toBe("L_A_B_0");
  });
  test("the reverse direction is a new edge", () => {
    expect(connectNodes(ctx(FC), "B", "A").ok).toBe(true);
  });
  test("a drop on the node itself does nothing", () => {
    const r = connectNodes(ctx(FC), "A", "A");
    expect(!r.ok && r.noop).toBe(true);
  });
  test("unknown targets are refused", () => {
    expect(connectNodes(ctx(FC), "A", "Z").ok).toBe(false);
    expect(connectNodes({ ...ctx("sequenceDiagram\n  A->>B: hi"), type: "sequence" }, "A", "B").ok).toBe(false);
  });
  test("a subgraph is a valid target; nodes stay out of subgraphs they are not in", () => {
    const src = `flowchart LR
  A --> B
  subgraph S [Group]
    C --> D
  end`;
    const r = connectNodes(ctx(src), "A", "S");
    if (!r.ok) throw new Error(r.error);
    expect(r.source.endsWith("end\n  A --> S")).toBe(true);
    // C is inside S: an edge from C to B outside goes at top level, after the subgraph.
    const r2 = connectNodes(ctx(r.source), "C", "B");
    if (!r2.ok) throw new Error(r2.error);
    const m = parse(r2.source) as { subgraphs: Array<{ id: string; nodes: string[] }> };
    expect(m.subgraphs.find((s) => s.id === "S")!.nodes).not.toContain("B");
  });
  test("inside one subgraph the edge goes into it", () => {
    const src = `flowchart LR
  subgraph S [Group]
    C --> D
    F
  end`;
    const r = connectNodes(ctx(src), "D", "F");
    if (!r.ok) throw new Error(r.error);
    expect(r.source).toMatch(/F\n {4}D --> F\n {2}end/);
  });
});

const CANVAS = `flowchart LR
  A[Start] --> B[Next]
%% pele-layout canvas %%
%% pele-pos A=100,100,160,60 B=400,100,160,60 %%`;

describe("canvas layout", () => {
  test("the edge leaves on the + side (a port)", () => {
    const r = connectNodes(ctx(CANVAS), "B", "A", "bottom");
    if (!r.ok) throw new Error(r.error);
    expect(parseLayoutDirective(r.source).ports.get("B>A")).toEqual({ from: "bottom" });
  });
  test("a node dropped on empty space is pinned where it was dropped", () => {
    const at = pinAtDrop(CANVAS, "A", { x: 30, y: 40 }, { x: 330, y: 400 });
    // A is drawn at 30,40 but pinned at 100,100: the drop carries the same offset, centred.
    expect(at).toEqual({ x: 330 - 80 + 70, y: 400 - 30 + 60 });
    // Centred with the new node's own size when it is known.
    expect(pinAtDrop(CANVAS, "A", { x: 30, y: 40 }, { x: 330, y: 400 }, { w: 60, h: 40 })).toEqual({ x: 330 - 30 + 70, y: 400 - 20 + 60 });
    const r = addConnectedNode(ctx(CANVAS), "A", "right", at);
    if (!r.ok) throw new Error(r.error);
    expect(r.source).toContain(`A --> ${r.id}[New]`);
    const layout = parseLayoutDirective(r.source);
    expect(layout.pos.get(r.id)).toEqual({ x: 320, y: 430 });
    expect(layout.ports.get(`A>${r.id}`)).toEqual({ from: "right" });
  });
  test("without a drop point it goes beside the anchor; outside canvas layout nothing is pinned", () => {
    const r = addConnectedNode(ctx(CANVAS), "B", "bottom");
    if (!r.ok) throw new Error(r.error);
    expect(parseLayoutDirective(r.source).pos.get(r.id)).toEqual({ x: 400, y: 220 });
    const plain = addConnectedNode(ctx(FC), "C", "right", { x: 1, y: 2 });
    if (!plain.ok) throw new Error(plain.error);
    expect(plain.source).not.toContain("pele-pos");
    expect(addPort(FC, "A", "B", "left")).toBe(FC);
    expect(pinAtDrop(FC, "A", { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });
});
