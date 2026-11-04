import { describe, expect, test } from "bun:test";
import { render } from "pele-render/pele";
import {
  appendLines,
  currentColor,
  currentTextSize,
  editLinkStyle,
  reindexLinkStyles,
  setColor,
  setEdgeColor,
  setTextSize,
} from "../../src/edit/style-lines";

const FC = `flowchart LR
  A --> B --> C
%% pele-size A=120 %%`;

describe("node colours and sizes", () => {
  test("preset: one classDef, merged class line, before trailing directives", () => {
    let s = setColor(FC, "flowchart", "A", { preset: 3 });
    s = setColor(s, "flowchart", "B", { preset: 3 });
    expect(s).toBe(`flowchart LR
  A --> B --> C
  classDef canvas3 fill:#e0ac001a,stroke:#e0ac00
  class A,B canvas3
%% pele-size A=120 %%`);
    expect(currentColor(s, "flowchart", "B")).toEqual({ preset: 3 });
    expect(() => render(s)).not.toThrow();
  });

  test("switching preset moves the node; unused classDef is pruned", () => {
    let s = setColor(FC, "flowchart", "A", { preset: 1 });
    s = setColor(s, "flowchart", "A", { preset: 4 });
    expect(s).not.toContain("canvas1");
    expect(s).toContain("classDef canvas4 fill:#08b94e1a,stroke:#08b94e");
    expect(s).toContain("class A canvas4");
  });

  test("custom colour uses the node's style line and drops the preset", () => {
    let s = setColor(FC, "flowchart", "A", { preset: 2 });
    s = setColor(s, "flowchart", "A", { custom: "#123ABC" });
    expect(s).not.toContain("canvas2");
    expect(s).toContain("style A fill:#123abc1a,stroke:#123abc");
    expect(currentColor(s, "flowchart", "A")).toEqual({ custom: "#123abc" });
  });

  test("reset removes only our properties", () => {
    const src = `flowchart LR
  A --> B
  style A fill:#f00,stroke-width:4px,stroke:#0f0`;
    const s = setColor(src, "flowchart", "A", null);
    expect(s).toContain("style A stroke-width:4px");
    const t = setColor(`flowchart LR\n  A --> B\n  style A fill:#f00`, "flowchart", "A", null);
    expect(t).toBe(`flowchart LR\n  A --> B`);
  });

  test("a shared class line keeps the other ids", () => {
    const src = `flowchart LR
  A --> B
  classDef canvas5 fill:#00bfbc1a,stroke:#00bfbc
  class A,B canvas5`;
    const s = setColor(src, "flowchart", "A", null);
    expect(s).toContain("class B canvas5");
    expect(s).toContain("classDef canvas5");
  });

  test("text size combines with colour classes", () => {
    let s = setColor(FC, "flowchart", "A", { preset: 1 });
    s = setTextSize(s, "flowchart", "A", "xl");
    expect(s).toContain("classDef pele_text_xl font-size:26px");
    expect(currentTextSize(s, "flowchart", "A")).toBe("xl");
    const svg = render(s).svg;
    expect(svg).toMatch(/canvas1 pele_text_xl|pele_text_xl canvas1/);
    s = setTextSize(s, "flowchart", "A", null);
    expect(s).not.toContain("pele_text_xl");
  });

  test("class diagrams assign with cssClass; state with class", () => {
    const cls = setColor(`classDiagram\n  class Animal\n  class Dog`, "class", "Dog", { preset: 6 });
    expect(cls).toContain(`cssClass "Dog" canvas6`);
    expect(render(cls).svg).toContain("canvas6");
    const st = setColor(`stateDiagram-v2\n  a --> b`, "state", "a", { preset: 2 });
    expect(st).toContain("class a canvas2");
    expect(render(st).svg).toContain("canvas2");
  });

  test("indentation skips a leading %% mehrpele %% directive", () => {
    const src = "%% mehrpele %%\nflowchart TD\n  A --> B";
    expect(setColor(src, "flowchart", "B", { preset: 3 })).toBe(
      "%% mehrpele %%\nflowchart TD\n  A --> B\n  classDef canvas3 fill:#e0ac001a,stroke:#e0ac00\n  class B canvas3",
    );
  });

  test("appendLines keeps indentation and trailing blank lines", () => {
    expect(appendLines("graph TD\n    A\n\n", ["style A fill:#fff"])).toBe("graph TD\n    A\n    style A fill:#fff\n\n");
  });
});

describe("linkStyle", () => {
  test("set, merge, split shared lines", () => {
    let s = setEdgeColor(FC, 1, "#e93147");
    expect(s).toContain("linkStyle 1 stroke:#e93147,color:#e93147");
    s = editLinkStyle(s, 1, { "stroke-width": "3px" });
    expect(s).toContain("linkStyle 1 stroke:#e93147,color:#e93147,stroke-width:3px");
    const shared = `flowchart LR\n  A --> B --> C\n  linkStyle 0,1 stroke:#000`;
    const t = setEdgeColor(shared, 0, "#fff");
    expect(t).toContain("linkStyle 1 stroke:#000");
    expect(t).toContain("linkStyle 0 stroke:#ffffff,color:#ffffff");
    expect(setEdgeColor(t, 0, null)).not.toContain("linkStyle 0");
  });

  test("reindex after deleting an edge", () => {
    const src = `flowchart LR
  A --> B --> C --> D
  linkStyle 0 stroke:#a00
  linkStyle 1,2 stroke:#0a0
  linkStyle 2 stroke-width:4px
  linkStyle default stroke:#999`;
    expect(reindexLinkStyles(src, 1)).toBe(`flowchart LR
  A --> B --> C --> D
  linkStyle 0 stroke:#a00
  linkStyle 1 stroke:#0a0
  linkStyle 1 stroke-width:4px
  linkStyle default stroke:#999`);
    expect(reindexLinkStyles(src, 0)).not.toContain("stroke:#a00");
  });
});

describe("one palette family with Canvas (canvas1…6); pele_cN still read", () => {
  test("legacy pele_cN is recognised and replaced on the next colour change", () => {
    const src = "flowchart LR\n  A --> B\n  classDef pele_c2 fill:#ec750033,stroke:#ec7500\n  class A,B pele_c2";
    expect(currentColor(src, "flowchart", "A")).toEqual({ preset: 2 });
    const s = setColor(src, "flowchart", "A", { preset: 4 });
    expect(s).toContain("class B pele_c2");
    expect(s).toContain("classDef canvas4 fill:#08b94e1a,stroke:#08b94e");
    expect(s).toContain("class A canvas4");
    expect(setColor(s, "flowchart", "B", null)).not.toContain("pele_c2");
  });
  test("a toolbar colour survives Mermaid → Canvas → Mermaid", async () => {
    const { mermaidToCanvas, canvasToMermaid } = await import("pele-render/canvas");
    const src = setColor("flowchart LR\n  A[Alpha] --> B[Beta]", "flowchart", "A", { preset: 3 });
    const canvas = mermaidToCanvas(src).canvas;
    const card = canvas.nodes.find((n: any) => n.text === "Alpha" || n.label === "Alpha") as any;
    expect(card?.color).toBe("3");
    expect(canvasToMermaid(canvas).source).toContain("canvas3");
  });
});
