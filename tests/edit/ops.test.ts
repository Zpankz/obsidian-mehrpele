import { describe, expect, test } from "bun:test";
import { parse, render } from "pele-render/pele";
import { parseSizeDirective } from "pele-render/node-size";
import { analyse, applyEdit, readText, type EditContext, type EditOp, type EditTarget } from "../../src/edit/ops";
import { extractLabels } from "../../src/mehrpele/extract";

const ctx = (source: string, extra: Partial<EditContext> = {}): EditContext => ({
  source,
  type: "flowchart",
  markdownBlock: false,
  canSwitch: false,
  ...extra,
});

function edit(c: EditContext, t: EditTarget, op: EditOp): string {
  const r = applyEdit(c, t, op);
  if (!r.ok) throw new Error(r.error);
  return r.source;
}

const FC = `flowchart LR
  A[Start] --> B{Valid?}
  B -->|Yes| C(Render)
  B -- No --> D[Show error]
  C --> E[Done]
  linkStyle 2 stroke:#f00
%% pele-size A=120 %%
%% pele-reflow direction=fixed %%`;

describe("flowchart shapes", () => {
  test("rewrite in place, label kept, ids stable", () => {
    const s = edit(ctx(FC), { kind: "node", id: "A" }, { op: "shape", key: "stadium" });
    expect(s).toContain("A([Start]) --> B{Valid?}");
    expect(edit(ctx(FC), { kind: "node", id: "C" }, { op: "shape", key: "doublecircle" })).toContain("C(((Render)))");
    expect(edit(ctx(FC), { kind: "node", id: "B" }, { op: "shape", key: "trapezoid" })).toContain("B[/Valid?\\]");
    // Pele agrees.
    const n = (parse(s) as any).nodes.get("A");
    expect(n.type).toBe("stadium");
    expect(s).toContain("%% pele-size A=120 %%\n%% pele-reflow direction=fixed %%");
  });
  test("a bare node gains brackets", () => {
    const s = edit(ctx("flowchart LR\n  A --> B"), { kind: "node", id: "B" }, { op: "shape", key: "circle" });
    expect(s).toBe("flowchart LR\n  A --> B((B))");
  });
  test("labels with closers get quoted", () => {
    const s = edit(ctx("flowchart LR\n  A[a/b] --> B"), { kind: "node", id: "A" }, { op: "shape", key: "parallelogram" });
    expect(s).toBe('flowchart LR\n  A[/"a/b"/] --> B');
    expect(() => render(s)).not.toThrow();
  });
  test("data shapes rewrite shape:", () => {
    const s = edit(ctx('flowchart LR\n  A@{ shape: rect, label: "x" } --> B'), { kind: "node", id: "A" }, { op: "shape", key: "hexagon" });
    expect(s).toContain("A@{ shape: hex, label: \"x\" }");
  });
});

describe("flowchart edges", () => {
  test("line style and heads keep labels and indices", () => {
    let s = edit(ctx(FC), { kind: "edge", id: "L_B_C_0" }, { op: "stroke", value: "dotted" });
    expect(s).toContain("B -.->|Yes| C(Render)");
    s = edit(ctx(s), { kind: "edge", id: "L_B_C_0" }, { op: "heads", value: "both" });
    expect(s).toContain("B <-.->|Yes| C(Render)");
    s = edit(ctx(s), { kind: "edge", id: "L_B_C_0" }, { op: "heads", value: "none" });
    expect(s).toContain("B -.-|Yes| C(Render)");
    const m = parse(s) as any;
    expect(m.edges[1].stroke).toBe("dotted");
    expect(m.edges[1].type).toBe("arrow_open");
    expect(s).toContain("linkStyle 2 stroke:#f00");
  });
  test("circle and cross tips keep one or both ends; one / both are arrows", () => {
    const e = { kind: "edge", id: "L_B_C_0" } as const;
    let s = edit(ctx(FC), e, { op: "heads", value: "circle" });
    expect(s).toContain("B --o|Yes| C(Render)");
    expect(analyse(ctx(s), e)!.currentHeads).toBe("circle");
    s = edit(ctx(s), e, { op: "heads", value: "both" });
    expect(s).toContain("B <-->|Yes| C(Render)");
    s = edit(ctx(s), e, { op: "heads", value: "cross" });
    expect(s).toContain("B x--x|Yes| C(Render)");
    expect(analyse(ctx(s), e)!.currentHeads).toBe("cross");
    s = edit(ctx(s), e, { op: "heads", value: "one" });
    expect(s).toContain("B -->|Yes| C(Render)");
    for (const v of ["circle", "cross"] as const) {
      const m = parse(edit(ctx(FC), e, { op: "heads", value: v })) as any;
      expect(m.edges[1].type).not.toBe("arrow_open");
    }
    // Unspaced `A<-->B`: the tail is spaced off the id, or Pele would read node `Ao`.
    for (const [v, want] of [["circle", "A o--oB"], ["cross", "A x--xB"]] as const) {
      const s2 = edit(ctx("flowchart LR\n  A<-->B"), { kind: "edge", id: "L_A_B_0" }, { op: "heads", value: v });
      expect(s2).toContain(want);
      expect((parse(s2) as any).edges.map((x: any) => `${x.start}>${x.end}`)).toEqual(["A>B"]);
    }
  });
  test("inline labels become pipe labels on arrow changes", () => {
    const s = edit(ctx(FC), { kind: "edge", id: "L_B_D_0" }, { op: "stroke", value: "thick" });
    expect(s).toContain("B ==>|No| D[Show error]");
  });
  test("edge colour writes linkStyle by Pele index (invisible edges counted)", () => {
    const src = "flowchart LR\n  A ~~~ B\n  B --> C";
    const s = edit(ctx(src), { kind: "edge", id: "L_B_C_0" }, { op: "color", value: { preset: 1 } });
    expect(s).toContain("linkStyle 1 stroke:#e93147,color:#e93147");
  });
  test("edge label set, change, remove", () => {
    let s = edit(ctx(FC), { kind: "edge", id: "L_A_B_0" }, { op: "text", text: "go" });
    expect(s).toContain("A[Start] -->|go| B{Valid?}");
    s = edit(ctx(s), { kind: "edge", id: "L_B_D_0" }, { op: "text", text: "Nope" });
    expect(s).toContain("B -- Nope --> D");
    s = edit(ctx(s), { kind: "edge", id: "L_A_B_0" }, { op: "text", text: "" });
    expect(s).toContain("A[Start] --> B{Valid?}");
  });
  test("delete edge splits the chain and reindexes linkStyle", () => {
    const src = `flowchart LR
  A --> B --> C --> D
  linkStyle 2 stroke:#f00`;
    const s = edit(ctx(src), { kind: "edge", id: "L_B_C_0" }, { op: "delete" });
    expect(s).toBe(`flowchart LR
  A --> B
  C --> D
  linkStyle 1 stroke:#f00`);
    const m = parse(s) as any;
    expect(m.edges[1].style).toContain("stroke:#f00");
  });
  test("& group edges cannot be deleted alone", () => {
    const c = ctx("flowchart LR\n  A & B --> C");
    expect(analyse(c, { kind: "edge", id: "L_A_C_0" })!.delete).toBe(false);
  });
});

describe("flowchart delete node", () => {
  test("drops its edges, styles, sizes and reindexes", () => {
    const src = `flowchart LR
  A[a] --> B[b] --> C[c]
  B --> D
  D --> C
  style B fill:#f00
  classDef canvas1 fill:#e931471a,stroke:#e93147
  class B,D canvas1
  linkStyle 3 stroke:#0f0
%% pele-size B=200 D=100 %%`;
    const s = edit(ctx(src), { kind: "node", id: "B" }, { op: "delete" });
    expect(s).toBe(`flowchart LR
  A[a]
  C[c]
  D --> C
  classDef canvas1 fill:#e931471a,stroke:#e93147
  class D canvas1
  linkStyle 0 stroke:#0f0
%% pele-size D=100 %%`);
    expect(() => render(s)).not.toThrow();
  });
});

describe("text edits", () => {
  test("plain text in a plain block", () => {
    const s = edit(ctx(FC), { kind: "node", id: "A" }, { op: "text", text: "Begin here" });
    expect(s).toContain("A[Begin here] --> B");
    expect(readText(ctx(s), { kind: "node", id: "A" })).toBe("Begin here");
  });
  test("Markdown switches the block to Mehrpele when allowed", () => {
    const r = applyEdit(ctx(FC, { canSwitch: true }), { kind: "node", id: "E" }, { op: "text", text: "**Done** see [[Note]]" });
    expect(r.ok && r.switched).toBe(true);
    if (!r.ok) return;
    expect(r.source.startsWith("%% mehrpele %%\nflowchart LR")).toBe(true);
    expect(r.source).toContain('E["**Done** see [[Note]]"]');
  });
  test("multi-line callout round-trips into a Mehrpele label", () => {
    const src = `flowchart LR
  B{"x"} --> C["> [!note] Callouts work too"]`;
    const c = ctx(src, { markdownBlock: true });
    expect(readText(c, { kind: "node", id: "C" })).toBe("> [!note] Callouts work too");
    const text = '> [!warning]- Careful "now"\n> second line with $x^2$';
    const s = edit(c, { kind: "node", id: "C" }, { op: "text", text });
    const label = extractLabels(s).find((l) => l.anchorId === "C")!;
    expect(label.markdown).toBe(text);
    expect(readText(ctx(s, { markdownBlock: true }), { kind: "node", id: "C" })).toBe(text);
  });
  test("table label: add a row, sizes line preserved", () => {
    const src = `graph LR
T1 --> T3
T3("| First Name | Last Name |
| ---------- | --------- |
| Doug | Engelbart |")
%% pele-size T3=314x240 %%`;
    const c = ctx(src, { markdownBlock: true });
    const before = readText(c, { kind: "node", id: "T3" })!;
    const s = edit(c, { kind: "node", id: "T3" }, { op: "text", text: `${before}\n| Ada | Lovelace |` });
    expect(s).toContain('| Doug | Engelbart |\n| Ada | Lovelace |")');
    expect(parseSizeDirective(s).get("T3")).toEqual({ w: 314, h: 240 });
  });
  test("LaTeX keeps backslashes as written", () => {
    const src = 'graph LR\nT2("$\\nabla_\\theta x$")';
    const c = ctx(src, { markdownBlock: true });
    expect(readText(c, { kind: "node", id: "T2" })).toBe("$\\nabla_\\theta x$");
    const s = edit(c, { kind: "node", id: "T2" }, { op: "text", text: "$\\nabla_\\phi \\frac{a}{b}$" });
    expect(s).toBe('graph LR\nT2("$\\nabla_\\phi \\frac{a}{b}$")');
  });
  test("subgraph titles", () => {
    const src = `flowchart TD
  subgraph S1 [Old]
    A
  end
  subgraph "Group **title**"
    B
  end
  subgraph one
    C
  end`;
    const c = ctx(src, { markdownBlock: true });
    expect(edit(c, { kind: "subgraph", id: "S1" }, { op: "text", text: "New" })).toContain("subgraph S1 [New]");
    expect(edit(c, { kind: "subgraph", id: "one" }, { op: "text", text: "Uno" })).toContain("subgraph one [Uno]");
    expect(edit(c, { kind: "subgraph", id: "subGraph1" }, { op: "text", text: "Grp *x*" })).toContain('subgraph "Grp *x*"');
  });
  test("ungroup a subgraph keeps its contents", () => {
    const src = "flowchart TD\n  subgraph S1 [Old]\n    A --> B\n  end\n  style S1 fill:#f00";
    expect(edit(ctx(src), { kind: "subgraph", id: "S1" }, { op: "delete" })).toBe("flowchart TD\n    A --> B");
  });
});

describe("state, class and mindmap", () => {
  const ST = `stateDiagram-v2
  [*] --> s1
  s1: First state
  s1 --> s2: go
  s2 --> s3`;
  const sc = (src: string) => ctx(src, { type: "state" });
  test("state text and transition labels", () => {
    expect(readText(sc(ST), { kind: "node", id: "s1" })).toBe("First state");
    expect(edit(sc(ST), { kind: "node", id: "s1" }, { op: "text", text: "Begin" })).toContain("s1: Begin");
    expect(edit(sc(ST), { kind: "node", id: "s3" }, { op: "text", text: "Third" })).toContain("s3 : Third");
    expect(edit(sc(ST), { kind: "edge", id: "edge1" }, { op: "text", text: "went" })).toContain("s1 --> s2: went");
    expect(edit(sc(ST), { kind: "edge", id: "edge2" }, { op: "text", text: "next" })).toContain("s2 --> s3 : next");
    expect(edit(sc(ST), { kind: "edge", id: "edge1" }, { op: "delete" })).not.toContain("s1 --> s2");
  });
  test("state colour", () => {
    const s = edit(sc(ST), { kind: "node", id: "s2" }, { op: "color", value: { preset: 4 } });
    expect(render(s).svg).toContain("canvas4");
    expect(analyse(sc(ST), { kind: "node", id: "root_start" })).toBeNull();
  });
  test("no text size for Mehrpele Markdown labels (HTML overlays)", () => {
    const c = ctx('flowchart LR\n  A["**md**"] --> B[plain]', { markdownBlock: true });
    expect(analyse(c, { kind: "node", id: "A" })!.textSize).toBe(false);
    expect(analyse(c, { kind: "node", id: "B" })!.textSize).toBe(true);
  });
  test("class diagram: colour only", () => {
    const c = ctx("classDiagram\n  class Animal", { type: "class" });
    const caps = analyse(c, { kind: "node", id: "Animal" })!;
    expect([caps.color, caps.editText, caps.shapes]).toEqual([true, false, null]);
  });
  test("mindmap shapes, text, delete subtree", () => {
    const mm = `mindmap
  root((Root))
    A[Square]
      a2
    B(Rounded)`;
    const c = ctx(mm, { type: "mindmap" });
    expect(edit(c, { kind: "node", id: "A" }, { op: "shape", key: "hexagon" })).toContain("A{{Square}}");
    expect(edit(c, { kind: "node", id: "B" }, { op: "shape", key: "default" })).toContain("    Rounded");
    expect(edit(c, { kind: "node", id: "a2" }, { op: "shape", key: "circle" })).toContain("a2((a2))");
    expect(edit(c, { kind: "node", id: "A" }, { op: "text", text: "Squared" })).toContain("A[Squared]");
    expect(edit(c, { kind: "node", id: "A" }, { op: "delete" })).toBe("mindmap\n  root((Root))\n    B(Rounded)");
    expect(analyse(c, { kind: "node", id: "A" })!.color).toBe(false);
  });
});
