import { describe, expect, test } from "bun:test";
import { parse } from "pele-render/pele";
import { alignsWith, scanFlowchart, shapedVertex } from "../../src/edit/flow-scan";

const model = (src: string) => parse(src) as unknown as { edges: Array<{ start: string; end: string }> };

describe("scanFlowchart", () => {
  test("edges in Pele order, & groups expanded, link forms", () => {
    const src = `flowchart LR
  A & B --> C --> D
  A -- text --> D
  A -.-> B
  C ==> D
  A --- B
  A <--> C
  A ~~~ D
  A --x B
  A --o B
  A -->|p| B
  A ---->B`;
    const s = scanFlowchart(src);
    expect(s.unknown).toEqual([]);
    expect(alignsWith(s, model(src))).toBe(true);
    const e = s.edges;
    expect(e.map((x) => `${x.start}${x.end}`)).toEqual(["AC", "BC", "CD", "AD", "AB", "CD", "AB", "AC", "AD", "AB", "AB", "AB", "AB"]);
    expect(e[0]!.groupSize).toBe(2);
    expect(e[3]!.link.form).toBe("inline");
    expect(src.slice(e[3]!.link.label!.span.start, e[3]!.link.label!.span.end)).toBe("text");
    expect(e[4]!.link.stroke).toBe("dotted");
    expect(e[5]!.link.stroke).toBe("thick");
    expect([e[6]!.link.left, e[6]!.link.right]).toEqual(["", ""]);
    expect([e[7]!.link.left, e[7]!.link.right]).toEqual(["<", ">"]);
    expect(e[8]!.link.stroke).toBe("invisible");
    expect(e[9]!.link.right).toBe("x");
    expect(e[10]!.link.right).toBe("o");
    expect(e[11]!.link.form).toBe("pipe");
    expect(e[12]!.link.length).toBe(3);
  });

  test("shapes and quoted multi-line Mehrpele labels", () => {
    const src = `graph LR
T1 --> T2 & T3 --> T4
T2("$\\nabla_\\theta x$")
T3("| First | Last |
| --- | --- |
| Doug | E |")
T4["a \\"quoted\\" ] word"] --> T5{{hex}}
%% pele-size T3=314x240 %%`;
    const s = scanFlowchart(src);
    expect(s.unknown).toEqual([]);
    const t3 = shapedVertex(s, "T3")!;
    expect(t3.shape!.open).toBe("(");
    expect(src.slice(t3.shape!.label!.span.start, t3.shape!.label!.span.end)).toContain("| Doug | E |");
    const t4 = shapedVertex(s, "T4")!;
    expect(t4.shape!.label!.quoted).toBe(true);
    expect(shapedVertex(s, "T5")!.shape!.open).toBe("{{");
    expect(s.edges.map((x) => `${x.start}${x.end}`)).toEqual(["T1T2", "T1T3", "T2T4", "T3T4", "T4T5"]);
  });

  test("subgraphs, keywords, comments and statements", () => {
    const src = `flowchart TD
  %% comment --> X
  subgraph S1 [Title one]
    A --> B
  end
  subgraph "Quoted **md**"
    C
  end
  subgraph plain
    D:::cls
  end
  style A fill:#f00
  classDef cls fill:#0f0
  class A cls
  linkStyle 0 stroke:#f00
  click A "https://x"`;
    const s = scanFlowchart(src);
    expect(s.unknown).toEqual([]);
    expect(s.subgraphs.map((g) => [g.id, g.titleForm])).toEqual([
      ["S1", "bracket"],
      [null, "quoted"],
      ["plain", null],
    ]);
    expect(s.subgraphs.every((g) => g.endLine !== null)).toBe(true);
    expect(s.edges).toHaveLength(1);
  });

  test("data shapes and ids with dashes", () => {
    const src = `flowchart LR
  my-node@{ shape: rect, label: "Hi" } --> other-node`;
    const s = scanFlowchart(src);
    expect(s.unknown).toEqual([]);
    expect(s.edges[0]!.start).toBe("my-node");
    expect(shapedVertex(s, "my-node")!.shape!.kind).toBe("data");
  });

  test("unknown statements disable alignment", () => {
    const src = `flowchart LR
  A --> B
  A e1@--> C`;
    const s = scanFlowchart(src);
    expect(s.unknown.length).toBeGreaterThan(0);
    expect(alignsWith(s, { edges: [{ start: "A", end: "B" }, { start: "A", end: "C" }] })).toBe(false);
  });
});
