import { describe, expect, test } from "bun:test";
import { parse } from "pele-render/pele";
import { lintReflowDirective, parseReflowDirective } from "pele-render/reflow";
import { parseSizeDirective } from "pele-render/node-size";
import { mehrpeleRenderSource } from "../../src/mehrpele/validate";
import { extractLabels } from "../../src/mehrpele/extract";
import { rewriteBlock, withMehrpeleDirective } from "../../src/materialise/rewrite";

const fc = (src: string, map: Record<string, string>, addDirective = false) => rewriteBlock(src, "flowchart", new Map(Object.entries(map)), { addDirective });

describe("flowchart rewrite", () => {
  test("every shape keeps its brackets", () => {
    const src = `flowchart TD
  A[rect] --> B(round) --> C([stadium]) --> D[[sub]] --> E[(db)]
  F((circle)) --> G(((dbl))) --> H{rhombus} --> I{{hex}} --> J>odd]
  K[/lean/] --> L[\\alt\\] --> M[/trap\\] --> N[\\inv/]`;
    const ids = "ABCDEFGHIJKLMN".split("");
    const out = fc(src, Object.fromEntries(ids.map((i) => [i, `F/${i}`])));
    for (const [id, open, close] of [
      ["A", "[", "]"], ["B", "(", ")"], ["C", "([", "])"], ["D", "[[", "]]"], ["E", "[(", ")]"], ["F", "((", "))"],
      ["G", "(((", ")))"], ["H", "{", "}"], ["I", "{{", "}}"], ["J", ">", "]"], ["K", "[/", "/]"], ["L", "[\\", "\\]"],
      ["M", "[/", "\\]"], ["N", "[\\", "/]"],
    ] as const) expect(out).toContain(`${id}${open}"![[F/${id}]]"${close}`);
    // Still a valid diagram with the same structure.
    const m = parse(mehrpeleRenderSource(out)) as any;
    expect([...m.nodes.keys()].sort()).toEqual(ids);
    expect(m.edges.length).toBe(11);
  });

  test("quoted labels with escapes and markdown strings are replaced whole", () => {
    const out = fc('flowchart LR\n  A["say \\"hi\\" [x]"] --> B["`**md** str`"]', { A: "a", B: "b" });
    expect(out).toBe('flowchart LR\n  A["![[a]]"] --> B["![[b]]"]');
  });

  test("bare ids get a label at their first mention only", () => {
    const out = fc("flowchart LR\n  A --> B\n  B --> C\n  C --> A", { A: "x/A", B: "x/B" });
    expect(out).toBe('flowchart LR\n  A["![[x/A]]"] --> B["![[x/B]]"]\n  B --> C\n  C --> A');
  });

  test("a node labelled later is not also given a bare label", () => {
    const out = fc("flowchart LR\n  A --> B\n  B[Bee]", { B: "b" });
    expect(out).toBe('flowchart LR\n  A --> B\n  B["![[b]]"]');
  });

  test("repeated definitions are all rewritten", () => {
    expect(fc("flowchart LR\n  A[one] --> B\n  A[two]", { A: "a" })).toBe('flowchart LR\n  A["![[a]]"] --> B\n  A["![[a]]"]');
  });

  test("comments, classDef/class/style/click/linkStyle, subgraph headers and edge labels are untouched", () => {
    const src = `%%{init: {"theme": "dark"}}%%
flowchart LR
  %% A[comment]
  subgraph A2["A sub"]
    A[x]:::hot --> |"A[y]"| B
    B -- A text --> C
  end
  classDef hot fill:#f00
  class A,B hot
  style A fill:#0f0
  click A "https://example.com/A[1]"
  linkStyle 0 stroke:#f00
  A -->|A| C %% trailing A[z]`;
    const out = fc(src, { A: "n/A", B: "n/B", C: "n/C" });
    expect(out).toBe(`%%{init: {"theme": "dark"}}%%
flowchart LR
  %% A[comment]
  subgraph A2["A sub"]
    A["![[n/A]]"]:::hot --> |"A[y]"| B["![[n/B]]"]
    B -- A text --> C["![[n/C]]"]
  end
  classDef hot fill:#f00
  class A,B hot
  style A fill:#0f0
  click A "https://example.com/A[1]"
  linkStyle 0 stroke:#f00
  A -->|A| C %% trailing A[z]`);
  });

  test("ids inside another node's unquoted label never match", () => {
    expect(fc("flowchart LR\n  X[see A here] --> A", { A: "a" })).toBe('flowchart LR\n  X[see A here] --> A["![[a]]"]');
  });

  test("ids are whole tokens (A vs AB vs A_1) and & chains work", () => {
    expect(fc("flowchart LR\n  AB --> A_1 & A --> A", { A: "a" })).toBe('flowchart LR\n  AB --> A_1 & A["![[a]]"] --> A');
  });

  test("dense arrows without spaces", () => {
    expect(fc("graph TD\n  A-->B\n  B==>C", { A: "a", B: "b", C: "c" })).toBe('graph TD\n  A["![[a]]"]-->B["![[b]]"]\n  B==>C["![[c]]"]');
  });

  test("@{ } metadata: label replaced or inserted", () => {
    expect(fc('flowchart LR\n  A@{ shape: rect, label: "Old" }\n  B@{ shape: circle }', { A: "a", B: "b" })).toBe(
      'flowchart LR\n  A@{ shape: rect, label: "![[a]]" }\n  B@{ label: "![[b]]", shape: circle }',
    );
  });

  test("frontmatter is skipped and the directive goes after it", () => {
    const out = fc("---\ntitle: A[x]\n---\nflowchart LR\n  A[x]", { A: "a" }, true);
    expect(out).toBe('---\ntitle: A[x]\n---\n%% mehrpele %%\nflowchart LR\n  A["![[a]]"]');
  });

  test("link text with quotes or backslashes is escaped; Mehrpele reads it back", () => {
    const out = fc("flowchart LR\n  A", { A: 'odd "name"\\x' }, true);
    const labels = extractLabels(out);
    expect(labels[0]!.markdown).toBe('![[odd "name"\\x]]');
    expect(labels[0]!.anchorId).toBe("A");
  });

  test("no targets or nothing to change → identical source, no directive", () => {
    expect(fc("flowchart LR\n  A --> B", {}, true)).toBe("flowchart LR\n  A --> B");
    expect(withMehrpeleDirective("%% mehrpele %%\nflowchart LR")).toBe("%% mehrpele %%\nflowchart LR");
  });

  test("Mehrpele scanner sees every rewritten node label", () => {
    const out = fc('flowchart LR\n  A[a] --> B((b))\n  B --> C{c}', { A: "x/A", B: "x/B", C: "x/C" }, true);
    expect(extractLabels(out).map((l) => [l.anchorId, l.kind, l.embedTarget?.linkpath])).toEqual([
      ["A", "node", "x/A"],
      ["B", "node", "x/B"],
      ["C", "node", "x/C"],
    ]);
  });
});

describe("state rewrite", () => {
  test("alias, descriptions (first kept, rest dropped) and inserted descriptions", () => {
    const src = `stateDiagram-v2
  state "Long name" as S1
  S1 : first
  S1 : second
  [*] --> S1
  state Comp {
    [*] --> S2
  }
  S1 --> S3 : go`;
    const out = rewriteBlock(src, "state", new Map([["S1", "n/S1"], ["S2", "n/S2"], ["S3", "n/S3"]]), { addDirective: true });
    expect(out).toBe(`%% mehrpele %%
stateDiagram-v2
  state S1
  S1 : "![[n/S1]]"
  [*] --> S1
  state Comp {
    [*] --> S2
    S2 : "![[n/S2]]"
  }
  S1 --> S3 : go
  S3 : "![[n/S3]]"`);
    expect(extractLabels(out).map((l) => l.anchorId)).toEqual(["S1", "S2", "S3"]);
    const m = parse(mehrpeleRenderSource(out)) as any;
    expect(m.type).toBe("state");
  });
});

describe("directive lines are kept verbatim", () => {
  const SIZE = '%% pele-size A=220x96 B=180 "Make tea"=160x48 %%';
  // The real directive syntax (pele-render/src/reflow/directive.ts); the closing %% is optional.
  const REFLOW = "%% pele-reflow direction=auto floor=0.6 %%";
  const REFLOW_OFF = "%% pele-reflow off";
  test("flowchart: %% pele-size %% and %% pele-reflow %% survive the rewrite unchanged", () => {
    const src = `${REFLOW}\nflowchart LR\n  A[x] --> B(y)\n  %% pele-reflow direction=fixed %%\n${REFLOW_OFF}\n${SIZE}`;
    expect(lintReflowDirective(src).malformed).toEqual([]);
    const out = fc(src, { A: "n/A", B: "n/B" }, true);
    expect(out).toBe(
      `%% mehrpele %%\n${REFLOW}\nflowchart LR\n  A["![[n/A]]"] --> B("![[n/B]]")\n  %% pele-reflow direction=fixed %%\n${REFLOW_OFF}\n${SIZE}`,
    );
    // pele-render reads the same options and sizes from the rewritten block.
    expect(parseReflowDirective(out)).toEqual(parseReflowDirective(src));
    expect(parseSizeDirective(out)).toEqual(parseSizeDirective(src));
  });
  test("state: directive lines survive too", () => {
    const src = `stateDiagram-v2\n  [*] --> A\n  A : desc\n${SIZE}\n${REFLOW}`;
    const out = rewriteBlock(src, "state", new Map([["A", "n/A"]]), { addDirective: false });
    expect(out).toBe(`stateDiagram-v2\n  [*] --> A\n  A : "![[n/A]]"\n${SIZE}\n${REFLOW}`);
  });
});
