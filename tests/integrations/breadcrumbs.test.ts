import { describe, expect, test } from "bun:test";
import { parse } from "pele";
import { breadcrumbsToGraph } from "../../src/integrations/breadcrumbs/map";
import { normaliseBcEdges, type BcEdgeLike } from "../../src/integrations/detect";
import { flowchartFromGraph } from "../../src/integrations/graph-to-pele";

// Fake edges shaped like GCEdgeData records (wasm breadcrumbs_graph_wasm.d.ts:
// source/target/edge_type/edge_source) as normalised plain objects.
const graph: Record<string, BcEdgeLike[]> = {
  "Home.md": [
    { source: "Home.md", target: "Projects.md", field: "down", sourceKind: "typed_link" },
    { source: "Home.md", target: "Home.md", field: "same", sourceKind: "implied", implied: true }, // self-loop
    { source: "Home.md", target: "Areas.md", field: "same", sourceKind: "implied", implied: true },
  ],
  "Projects.md": [
    { source: "Projects.md", target: "Projects/Alpha.md", field: "down", sourceKind: "typed_link" },
    { source: "Projects.md", target: "Home.md", field: "up", sourceKind: "typed_link" },
  ],
  "Projects/Alpha.md": [],
  "Areas.md": [],
};

const fetch = (p: string) => graph[p];

describe("breadcrumbsToGraph", () => {
  test("drops self-loops and implied edges by default", () => {
    const spec = breadcrumbsToGraph("Home.md", fetch, { fields: [], depth: 2, implied: false, maxNodes: 50 });
    expect(spec.nodes.map((n) => n.id)).toEqual(["Home.md", "Projects.md", "Projects/Alpha.md"]);
    expect(spec.edges.every((e) => e.from !== e.to)).toBe(true);
    expect(spec.edges.some((e) => e.implied)).toBe(false);
  });

  test("keeps implied edges dimmed when requested", () => {
    const spec = breadcrumbsToGraph("Home.md", fetch, { fields: [], depth: 1, implied: true, maxNodes: 50 });
    expect(spec.edges.some((e) => e.to === "Areas.md" && e.implied)).toBe(true);
    const { source } = flowchartFromGraph(spec);
    expect(source).toContain("linkStyle");
    expect(parse(source).type).toBe("flowchart");
  });

  test("field filter and depth limit traversal", () => {
    const spec = breadcrumbsToGraph("Home.md", fetch, { fields: ["down"], depth: 1, implied: false, maxNodes: 50 });
    expect(spec.nodes.map((n) => n.id)).toEqual(["Home.md", "Projects.md"]);
    expect(spec.edges).toHaveLength(1);
  });

  test("unknown start yields just the start node", () => {
    const spec = breadcrumbsToGraph("Missing.md", fetch, { fields: [], depth: 2, implied: false, maxNodes: 50 });
    expect(spec.nodes).toHaveLength(1);
    expect(spec.edges).toHaveLength(0);
  });
});

describe("normaliseBcEdges", () => {
  test("accepts get_edges() EdgeList fakes and plain records", () => {
    const list = { get_edges: () => [{ source: "A.md", target: "B.md", edge_type: "up", edge_source: "typed_link" }] };
    expect(normaliseBcEdges(list)).toEqual([
      { source: "A.md", target: "B.md", field: "up", sourceKind: "typed_link", implied: false },
    ]);
    expect(normaliseBcEdges(undefined)).toEqual([]);
  });
});
