import { describe, expect, test } from "bun:test";
import { parse } from "pele";
import {
  extractLabels,
  hasMehrpeleDirective,
  isMehrpeleSource,
  stripMehrpeleDirective,
} from "../../src/mehrpele/extract";
import {
  markdownToFallback,
  parseSoleEmbed,
  parseEmbedSize,
  escapeLabelMarkdown,
  unescapeLabelMarkdown,
} from "../../src/mehrpele/model";

describe("directive detection", () => {
  test("mehrpele lang always applies", () => {
    expect(isMehrpeleSource("mehrpele", "flowchart TD\n A-->B")).toBe(true);
  });
  test("mermaid needs the directive", () => {
    expect(isMehrpeleSource("mermaid", "flowchart TD\n A-->B")).toBe(false);
    expect(isMehrpeleSource("mermaid", "%% mehrpele %%\nflowchart TD\n A-->B")).toBe(true);
    expect(isMehrpeleSource("pele", "flowchart TD\n%% mehrpele %%\n A-->B")).toBe(true);
  });
  test("other languages never apply", () => {
    expect(isMehrpeleSource("base", "%% mehrpele %%")).toBe(false);
  });
  test("directive stripping", () => {
    expect(hasMehrpeleDirective("%% mehrpele %%")).toBe(true);
    expect(stripMehrpeleDirective("%% mehrpele %%\nflowchart TD")).toBe("flowchart TD");
    expect(stripMehrpeleDirective("flowchart TD\n%% mehrpele %%\n A-->B")).toBe("flowchart TD\n A-->B");
  });
});

describe("label extraction", () => {
  test("node labels in all bracket shapes", () => {
    const labels = extractLabels(`flowchart LR
      A["**bold** [[Note]]"] --> B("plain $x^2$") --> C{"[[Dec#Head|Which?]]"}
      D[["table"]]`);
    expect(labels.map((l) => [l.anchorId, l.kind])).toEqual([
      ["A", "node"],
      ["B", "node"],
      ["C", "node"],
      ["D", "node"],
    ]);
    expect(labels[0].markdown).toBe("**bold** [[Note]]");
    expect(labels[2].markdown).toBe("[[Dec#Head|Which?]]");
  });

  test("edge labels: piped and inline forms get Pele-order indices", () => {
    const labels = extractLabels(`flowchart LR
      A -->|"costs $x^2$"| B
      B -- "second **label**" --> C
      C --> D`);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatchObject({ anchorId: "A->B#0", kind: "edge", markdown: "costs $x^2$" });
    expect(labels[1]).toMatchObject({ anchorId: "B->C#1", kind: "edge", markdown: "second **label**" });
  });

  test("subgraph titles are cluster labels (Mehrmaid #4)", () => {
    const labels = extractLabels(`flowchart TD
      subgraph "My **Group**"
        A --> B
      end
      subgraph grp ["Second title"]
        C --> D
      end`);
    expect(labels.filter((l) => l.kind === "cluster").map((l) => l.anchorId)).toEqual([
      "subgraph:cluster",
      "subgraph:grp",
    ]);
    expect(labels.find((l) => l.anchorId === "subgraph:grp")?.markdown).toBe("Second title");
  });

  test("escaped quotes and [[a|\"b\"]] do not break spans (Mehrmaid regex bug)", () => {
    const labels = extractLabels(`flowchart TD
      A["say \\"hi\\" now"] --> B["[[a|\\"b\\"]]"]`);
    expect(labels).toHaveLength(2);
    expect(labels[0].markdown).toBe('say "hi" now');
    expect(labels[1].markdown).toBe('[[a|"b"]]');
  });

  test("multi-line quoted labels keep real newlines", () => {
    const src = 'flowchart TD\n  A["| A | B |\n| - | - |\n| 1 | 2 |"] --> B["x"]';
    const labels = extractLabels(src);
    expect(labels[0].markdown).toContain("\n");
    expect(labels[0].span.start).toBe(src.indexOf('"'));
  });

  test("unquoted labels are not extracted", () => {
    expect(extractLabels("flowchart TD\n  A[plain] --> B")).toHaveLength(0);
    expect(extractLabels("flowchart TD\n  A --> B")).toHaveLength(0);
  });

  test("unclosed quote is ignored, never throws", () => {
    expect(extractLabels('flowchart TD\n  A["oops --> B')).toHaveLength(0);
  });

  test("duplicate node labels preserved in order, identity is the id", () => {
    const labels = extractLabels(`flowchart TD
      A["same"] --> B["same"]
      A["changed"]`);
    expect(labels.map((l) => l.anchorId)).toEqual(["A", "B", "A"]);
    expect(labels[0].markdown).toBe("same");
  });

  test("state descriptions and sequence participants", () => {
    const st = extractLabels('stateDiagram-v2\n  s1: "First **state**"\n  s1 --> s2');
    expect(st).toContainEqual(expect.objectContaining({ anchorId: "s1", kind: "node" }));
    const sq = extractLabels('sequenceDiagram\n  participant A as "**Alice**"\n  A->>B: hi');
    expect(sq).toContainEqual(expect.objectContaining({ anchorId: "A", kind: "node" }));
  });

  test("sole embeds parse linkpath/subpath/size", () => {
    const labels = extractLabels(`flowchart TD
      P["![[Projects.base#Table]]"] --> Q["![[Board.canvas|400x300]]"] --> R["see ![[img.png]] here"]`);
    expect(labels[0].embedTarget).toEqual({ linkpath: "Projects.base", subpath: "#Table" });
    expect(labels[1].embedTarget).toEqual({ linkpath: "Board.canvas", subpath: "", aliasOrSize: "400x300" });
    expect(labels[2].embedTarget).toBeUndefined();
  });

  test("extracted sources still parse with Pele", () => {
    const src = `flowchart LR
      A["**Start** — see [[Welcome]]"] -->|"costs $x^2$"| B{"[[Decision#Criteria|Which path?]]"}`;
    const model = parse(src);
    expect(model.type).toBe("flowchart");
  });
});

describe("fallback text", () => {
  test("links collapse to display text", () => {
    expect(markdownToFallback("**Start** — see [[Welcome]]")).toBe("Start — see Welcome");
    expect(markdownToFallback("[[Dec#Head|Which?]]")).toBe("Which?");
    expect(markdownToFallback("costs $x^2$")).toBe("costs $x^2$");
    expect(markdownToFallback("![[Projects.base#Table]]")).toBe("Projects.base#Table");
  });
  test("escape round-trips", () => {
    const md = 'a "quoted" \\ path';
    expect(unescapeLabelMarkdown(escapeLabelMarkdown(md))).toBe(md);
  });
  test("sole embed + size parsing", () => {
    expect(parseSoleEmbed("![[a.base#V|400x300]]")).toEqual({
      linkpath: "a.base", subpath: "#V", aliasOrSize: "400x300",
    });
    expect(parseSoleEmbed("text ![[a]]")).toBeUndefined();
    expect(parseEmbedSize("400x300")).toEqual({ width: 400, height: 300 });
    expect(parseEmbedSize("400")).toEqual({ width: 400 });
    expect(parseEmbedSize("alias")).toEqual({});
  });
});
