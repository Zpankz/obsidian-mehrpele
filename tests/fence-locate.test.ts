import { describe, expect, test } from "bun:test";
import {
  findOpeningFenceLine,
  isDiagramFenceLine,
  locateBlockForPersist,
} from "../src/fence-locate";

describe("findOpeningFenceLine", () => {
  const text = [
    "# Note", // 0
    "```mermaid", // 1
    "graph TD", // 2
    "  A-->B", // 3
    "```", // 4
    "prose", // 5
  ];
  test("finds the fence at or above the position", () => {
    expect(findOpeningFenceLine(text, 1)).toBe(1);
    expect(findOpeningFenceLine(text, 3)).toBe(1);
  });
  test("does not cross a previous block's closing fence or prose above any fence", () => {
    expect(findOpeningFenceLine(text, 5)).toBeNull();
    expect(findOpeningFenceLine(["just prose"], 0)).toBeNull();
  });
  test("isDiagramFenceLine validates lang", () => {
    expect(isDiagramFenceLine("```mermaid width=3")).toBe(true);
    expect(isDiagramFenceLine("~~~pele")).toBe(true);
    expect(isDiagramFenceLine("```js")).toBe(false);
    expect(isDiagramFenceLine(undefined)).toBe(false);
  });
});

describe("locateBlockForPersist", () => {
  const doc = [
    "intro", // 0
    "```mermaid", // 1
    "graph TD", // 2
    "  A-->B", // 3
    "```", // 4
  ].join("\n");
  const source = "graph TD\n  A-->B";

  test("trusts the expected line when fence + source match", () => {
    expect(locateBlockForPersist(doc, 1, source)).toEqual({ kind: "found", line: 1 });
  });

  test("relocates when lines shifted", () => {
    const shifted = ["new", "lines", ...doc.split("\n")].join("\n");
    expect(locateBlockForPersist(shifted, 1, source)).toEqual({ kind: "found", line: 3 });
  });

  test("aborts when the expected line is prose and no match exists", () => {
    expect(locateBlockForPersist(doc, 0, "graph LR\n X-->Y")).toEqual({ kind: "missing" });
  });

  test("reports ambiguity for duplicate blocks", () => {
    const dup = `${doc}\n\n${doc.split("\n").slice(1).join("\n")}`;
    expect(locateBlockForPersist(dup, 0, source)).toEqual({ kind: "ambiguous" });
  });
});

describe("block identity requires the closing fence (no partial overwrite)", () => {
  const longer = ["# t", "```mermaid", "graph TD", "  A-->B", "  B-->C", "```", ""].join("\n");

  test("a source that is only the head of a longer block does not match", () => {
    expect(locateBlockForPersist(longer, 1, "graph TD\n  A-->B")).toEqual({ kind: "missing" });
  });

  test("the full body matches", () => {
    expect(locateBlockForPersist(longer, 1, "graph TD\n  A-->B\n  B-->C")).toEqual({ kind: "found", line: 1 });
  });

  test("closing fence must use the same marker and be at least as long", () => {
    const tilde = ["~~~~mermaid", "graph TD", "~~~", "x", "~~~~"].join("\n");
    expect(locateBlockForPersist(tilde, 0, "graph TD")).toEqual({ kind: "missing" });
    expect(locateBlockForPersist(tilde, 0, "graph TD\n~~~\nx")).toEqual({ kind: "found", line: 0 });
  });

  test("an unclosed block at end of document still matches its whole body", () => {
    expect(locateBlockForPersist("```pele\ngraph TD\n  A", 0, "graph TD\n  A")).toEqual({ kind: "found", line: 0 });
  });

  test("relocation skips a same-head block and finds the exact one", () => {
    const two = ["```mermaid", "graph TD", "  A-->B", "  B-->C", "```", "", "```mermaid", "graph TD", "  A-->B", "```"].join("\n");
    expect(locateBlockForPersist(two, 0, "graph TD\n  A-->B")).toEqual({ kind: "found", line: 6 });
  });
});

describe("diagram fence langs", () => {
  test("mehrpele is a diagram fence (write-back works)", () => {
    expect(isDiagramFenceLine("```mehrpele width=300")).toBe(true);
    expect(locateBlockForPersist("```mehrpele\ngraph TD\n```", 0, "graph TD")).toEqual({ kind: "found", line: 0 });
  });

  test("integration query blocks are not diagram fences", () => {
    expect(isDiagramFenceLine("```pele-tasks")).toBe(false);
    expect(isDiagramFenceLine("```pele-datacore")).toBe(false);
    expect(isDiagramFenceLine("```pele-breadcrumbs")).toBe(false);
    expect(isDiagramFenceLine("```mermaidx")).toBe(false);
  });
});

import { hasDiagramFence } from "../src/fence-locate";

describe("hasDiagramFence (scoped refresh)", () => {
  test("detects our fences, including Mehrpele and integration blocks", () => {
    expect(hasDiagramFence("# a\n\n```mermaid\ngraph TD\n```")).toBe(true);
    expect(hasDiagramFence("~~~pele width=3\n~~~")).toBe(true);
    expect(hasDiagramFence("  ```mehrpele")).toBe(true);
    expect(hasDiagramFence("```pele-tasks\nview: kanban\n```")).toBe(true);
  });
  test("ignores notes without them", () => {
    expect(hasDiagramFence("")).toBe(false);
    expect(hasDiagramFence("```js\nmermaid\n```\nprose mentioning ```mermaid inline")).toBe(false);
    expect(hasDiagramFence("```mermaidx\n```")).toBe(false);
    expect(hasDiagramFence("```pele-tasks", ["mermaid", "pele"])).toBe(false);
  });
});
