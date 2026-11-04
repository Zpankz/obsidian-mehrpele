import { describe, expect, test } from "bun:test";
import { parse } from "pele-render/pele";
import { freshId } from "../../src/edit/concept-edit";
import { parseSuggestions } from "../../src/edit/autocomplete";
import { addNode, addSharedChild, applyEditMany, groupIntoSubgraph, type EditContext } from "../../src/edit/ops";

const ctx = (source: string, extra: Partial<EditContext> = {}): EditContext => ({ source, type: "flowchart", markdownBlock: false, canSwitch: false, ...extra });
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error((r as any).error);
  return r as any;
};
const styled = (src: string) =>
  (parse(src) as any).edges.flatMap((e: any) => ((e.style ?? []).some((x: string) => x.includes("#f00")) ? [`${e.start}>${e.end}`] : []));

describe("fresh ids see ids glued to arrows", () => {
  test("N1-->B", () => {
    expect(freshId("flowchart TD\n N1-->B[Bee]")).toBe("N2");
    const r = ok(addNode(ctx("flowchart TD\n N1-->B[Bee]"), "B", "child"));
    expect(r.id).toBe("N2");
    expect(r.source).toContain("B --> N2[New]");
  });
  test("G1-->A does not collide with a new group", () => {
    const r = ok(groupIntoSubgraph(ctx("flowchart TD\n G1-->A\n A --> B"), ["A", "B"]));
    expect(r.id).toBe("G2");
  });
});

describe("adding nodes keeps linkStyle on the same edges", () => {
  test("child inserted mid-block", () => {
    const src = "flowchart TD\n  P --> A\n  P --> B\n  linkStyle 1 stroke:#f00";
    expect(styled(ok(addNode(ctx(src), "A", "child")).source)).toEqual(["P>B"]);
  });
  test("sibling before the parent edges", () => {
    const src = "flowchart TD\n  P --> A\n  linkStyle 0 stroke:#f00";
    const r = ok(addNode(ctx(src), "A", "sibling-before"));
    expect(styled(r.source)).toEqual(["P>A"]);
  });
  test("parent and sibling-after", () => {
    const src = "flowchart TD\n  X --> P\n  P --> A\n  P --> B\n  linkStyle 0,2 stroke:#f00";
    expect(styled(ok(addNode(ctx(src), "A", "parent")).source).sort()).toEqual(["P>B", "X>P"]);
    expect(styled(ok(addNode(ctx(src), "A", "sibling-after")).source).sort()).toEqual(["P>B", "X>P"]);
  });
  test("shared child", () => {
    const src = "flowchart TD\n  A --> B\n  subgraph S\n    C --> D\n  end\n  linkStyle 1 stroke:#f00";
    expect(styled(ok(addSharedChild(ctx(src), ["A", "B"])).source)).toEqual(["C>D"]);
  });
});

describe("shared child stays in the common scope", () => {
  test("a top-level node is not pulled into a subgraph", () => {
    const src = "flowchart TD\n  A\n  subgraph S\n    B\n  end";
    const r = ok(addSharedChild(ctx(src), ["A", "B"]));
    const s = (parse(r.source) as any).subgraphs.find((x: any) => x.id === "S");
    expect(s.nodes).not.toContain("A");
    expect(s.nodes).not.toContain("N1");
    expect(r.source).toBe("flowchart TD\n  A\n  subgraph S\n    B\n  end\n  A & B --> N1[New]");
  });
});

describe("several state transitions", () => {
  test("deletes exactly the selected ones", () => {
    const src = "stateDiagram-v2\n  [*] --> A\n  A --> B\n  B --> C\n  C --> D\n  D --> [*]";
    const r = applyEditMany(ctx(src, { type: "state" }), [{ kind: "edge", id: "edge1" }, { kind: "edge", id: "edge3" }], { op: "delete" });
    if (!r.ok) throw new Error(r.error);
    expect(r.source).toBe("stateDiagram-v2\n  [*] --> A\n  B --> C\n  D --> [*]");
  });
});

describe("mindmap parent + child delete", () => {
  test("the child going with its parent is not an error", () => {
    const mm = "mindmap\n  root((Root))\n    A[Square]\n      a2\n    B(Rounded)";
    const r = applyEditMany(ctx(mm, { type: "mindmap" }), [{ kind: "node", id: "A" }, { kind: "node", id: "a2" }], { op: "delete" });
    if (!r.ok) throw new Error(r.error);
    expect(r.source).toBe("mindmap\n  root((Root))\n    B(Rounded)");
  });
});

test("prose around a list is not a suggestion", () => {
  expect(parseSuggestions("Here are some labels:\n- Alpha\n- Beta")).toEqual(["Alpha", "Beta"]);
});
