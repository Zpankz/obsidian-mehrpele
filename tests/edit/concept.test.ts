import { describe, expect, test } from "bun:test";
import { parse } from "pele-render/pele";
import { effectiveDirection, freshId, headerDirection, relationFor } from "../../src/edit/concept-edit";
import { addNode, addSharedChild, applyEditMany, groupIntoSubgraph, type EditContext } from "../../src/edit/ops";

const ctx = (source: string, extra: Partial<EditContext> = {}): EditContext => ({ source, type: "flowchart", markdownBlock: false, canSwitch: false, ...extra });
const edges = (src: string) => (parse(src) as any).edges.map((e: any) => `${e.start}>${e.end}`);
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error((r as any).error);
  return r as Extract<T, { ok: true }>;
};

describe("direction → relation", () => {
  test("TB / LR / BT / RL", () => {
    expect([relationFor("TB", "bottom"), relationFor("TB", "top"), relationFor("TB", "left"), relationFor("TB", "right")]).toEqual(["child", "parent", "sibling-before", "sibling-after"]);
    expect([relationFor("LR", "right"), relationFor("LR", "left"), relationFor("LR", "top"), relationFor("LR", "bottom")]).toEqual(["child", "parent", "sibling-before", "sibling-after"]);
    expect(relationFor("BT", "top")).toBe("child");
    expect(relationFor("RL", "left")).toBe("child");
  });
  test("header and reflow direction", () => {
    expect(headerDirection("flowchart TD\n A")).toBe("TB");
    expect(headerDirection("graph LR\n A")).toBe("LR");
    expect(effectiveDirection("flowchart LR\n A", "TB")).toBe("TB");
    expect(effectiveDirection("flowchart LR\n A", "authored")).toBe("LR");
    expect(effectiveDirection("flowchart LR\n A", "TB*")).toBe("TB");
  });
  test("fresh ids avoid every word in the block", () => {
    expect(freshId("flowchart LR\n  N1 --> N2\n  A[N3 label]")).toBe("N4");
  });
});

const TD = `flowchart TD
  P[Parent] --> A[Alpha]
  P --> B[Beta]
  linkStyle 1 stroke:#f00
%% pele-size A=120 %%`;

describe("add related node (one edit, edge in the right direction)", () => {
  test("child below in TD", () => {
    const r = ok(addNode(ctx(TD), "A", relationFor("TB", "bottom")));
    expect(r.id).toBe("N1");
    expect(r.source).toContain("  P[Parent] --> A[Alpha]\n  A --> N1[New]\n");
    expect(edges(r.source)).toContain("A>N1");
  });
  test("parent above in TD", () => {
    const r = ok(addNode(ctx(TD), "A", relationFor("TB", "top")));
    expect(edges(r.source)).toContain("N1>A");
  });
  test("sibling shares the parent edges; leading side goes first", () => {
    const after = ok(addNode(ctx(TD), "A", "sibling-after"));
    expect(edges(after.source)).toContain("P>N1");
    const before = ok(addNode(ctx(TD), "A", "sibling-before"));
    expect(before.source.indexOf("P --> N1[New]")).toBeLessThan(before.source.indexOf("P[Parent] --> A"));
  });
  test("a sibling of a parentless node stands alone", () => {
    const r = ok(addNode(ctx(TD), "P", "sibling-after"));
    expect(r.source).toContain("\n  N1[New]");
    expect(edges(r.source)).not.toContain("P>N1");
  });
  test("child in LR, inside a subgraph", () => {
    const src = "flowchart LR\n  subgraph S\n    X --> Y\n  end";
    const r = ok(addNode(ctx(src), "Y", relationFor("LR", "right")));
    expect(r.source).toBe("flowchart LR\n  subgraph S\n    X --> Y\n    Y --> N1[New]\n  end");
    expect((parse(r.source) as any).subgraphs[0].nodes).toContain("N1");
  });
  test("edge indices stay stable (new edges come after the anchor's)", () => {
    const r = ok(addNode(ctx(TD), "B", "child"));
    // linkStyle 1 still styles P→B.
    const m = parse(r.source) as any;
    expect(`${m.edges[1].start}>${m.edges[1].end}`).toBe("P>B");
    expect(m.edges[1].style).toContain("stroke:#f00");
    expect(r.source).toContain("%% pele-size A=120 %%");
  });
});

describe("several nodes", () => {
  test("shared child: one statement, edges from all", () => {
    const r = ok(addSharedChild(ctx(TD), ["A", "B"]));
    expect(r.source).toContain("A & B --> N1[New]");
    expect(edges(r.source)).toEqual(expect.arrayContaining(["A>N1", "B>N1"]));
  });
  test("group top-level nodes", () => {
    const r = ok(groupIntoSubgraph(ctx(TD), ["A", "B"], "Pair"));
    expect(r.id).toBe("G1");
    expect(r.source).toContain("  subgraph G1 [Pair]\n    A\n    B\n  end");
    const g = (parse(r.source) as any).subgraphs.find((s: any) => s.id === "G1");
    expect(g.nodes.sort()).toEqual(["A", "B"]);
    expect(r.source.trimEnd().endsWith("%% pele-size A=120 %%")).toBe(true);
  });
  test("group inside the common subgraph", () => {
    const src = "flowchart TD\n  subgraph S [Outer]\n    A --> B\n    C\n  end\n  D --> A";
    const r = ok(groupIntoSubgraph(ctx(src), ["B", "C"]));
    expect(r.source).toBe("flowchart TD\n  subgraph S [Outer]\n    A --> B\n    C\n    subgraph G1 [Group]\n      B\n      C\n    end\n  end\n  D --> A");
    const m = parse(r.source) as any;
    expect(m.subgraphs.find((s: any) => s.id === "S").nodes).toContain("G1");
  });
  test("refused when another subgraph owns a node", () => {
    const src = "flowchart TD\n  subgraph S1\n    A --> B\n  end\n  C";
    const r = groupIntoSubgraph(ctx(src), ["A", "C"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("A (in S1)");
  });
  test("style changes to several items are one edit", () => {
    const src = "flowchart LR\n  A --> B --> C\n  A --> C";
    const r = applyEditMany(ctx(src), [{ kind: "node", id: "A" }, { kind: "node", id: "C" }, { kind: "edge", id: "L_B_C_0" }], { op: "color", value: { preset: 2 } });
    if (!r.ok) throw new Error(r.error);
    expect(r.source).toContain("class A,C canvas2");
    expect(r.source).toContain("linkStyle 1 stroke:#ec7500");
  });
  test("deleting several edges keeps the other indices right", () => {
    const src = "flowchart LR\n  A --> B --> C --> D\n  D --> E\n  linkStyle 3 stroke:#0f0";
    const r = applyEditMany(ctx(src), [{ kind: "edge", id: "L_A_B_0" }, { kind: "edge", id: "L_C_D_0" }], { op: "delete" });
    if (!r.ok) throw new Error(r.error);
    expect(edges(r.source)).toEqual(["B>C", "D>E"]);
    const m = parse(r.source) as any;
    expect(m.edges[1].style).toContain("stroke:#0f0");
  });
});
