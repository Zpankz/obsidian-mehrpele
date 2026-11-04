import { describe, expect, test } from "bun:test";
import { extractLabels } from "../../src/mehrpele/extract";

describe("pipe edge labels", () => {
  test('extracts -->|"..."| with the true start node (not an id inside the previous label)', () => {
    const src = `flowchart LR
  A["**Start** — see [[Mehrpele]]"] -->|"costs $x^2$"| B
  B{"x"} --> C`;
    const edge = extractLabels(src).find((l) => l.kind === "edge");
    expect(edge?.anchorId).toBe("A->B#0");
    expect(edge?.markdown).toBe("costs $x^2$");
  });

  test("inline -- \"...\" --> still works", () => {
    const labels = extractLabels(`flowchart TD\n A -- "edge $label$" --> B`);
    expect(labels.find((l) => l.kind === "edge")?.anchorId).toBe("A->B#0");
  });
});
