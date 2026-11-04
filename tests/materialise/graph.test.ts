import { describe, expect, test } from "bun:test";
import { diagramGraph } from "../../src/materialise/graph";
import { normalizeMaterialiseSettings, DEFAULT_MATERIALISE_SETTINGS } from "../../src/materialise/settings";
import { normalizeSettings } from "../../src/settings/v2";

describe("diagramGraph", () => {
  test("flowchart: membership from the parse model, edges with labels, group refs", () => {
    const g = diagramGraph(
      `flowchart LR
  subgraph O["Outer"]
    A -->|x| B
    subgraph I
      C
    end
  end
  B --> C
  A --> I`,
      { mehrpele: false },
    );
    if (!g.ok) throw new Error(g.reason);
    expect(g.graph.groups).toEqual([
      { id: "O", title: "Outer" },
      { id: "I", title: "I", parentId: "O" },
    ]);
    expect(g.graph.nodes).toEqual([
      { id: "A", label: "A", groupId: "O" },
      { id: "B", label: "B", groupId: "O" },
      { id: "C", label: "C", groupId: "I" },
    ]);
    expect(g.graph.edges).toEqual([
      { from: "A", to: "B", label: "x" },
      { from: "B", to: "C", label: "" },
      { from: "A", to: "I", label: "", toGroup: true },
    ]);
  });

  test("Mehrpele: node Markdown from labels, cluster titles as plain text, nested fences parse", () => {
    const g = diagramGraph('flowchart LR\n  subgraph S["**Bold** group"]\n    A["~~~mermaid\nflowchart LR\n  x --> y\n~~~"]\n  end\n  A -->|"uses **it**"| B["![[Note]]"]', { mehrpele: true });
    if (!g.ok) throw new Error(g.reason);
    expect(g.graph.groups[0]!.title).toBe("Bold group");
    expect(g.graph.nodes.find((n) => n.id === "B")!.label).toBe("![[Note]]");
    expect(g.graph.nodes.find((n) => n.id === "A")!.label).toContain("~~~mermaid");
    expect(g.graph.edges[0]!.label).toBe("uses it");
  });

  test("plain mermaid file embeds come back as their link", () => {
    const g = diagramGraph('flowchart LR\n  A["![[Note#Head]]"] --> B["[[Other]]"]', { mehrpele: false });
    if (!g.ok) throw new Error(g.reason);
    expect(g.graph.nodes.map((n) => n.label)).toEqual(["![[Note#Head]]", "[[Other]]"]);
  });

  test("state: pseudo-states counted and left out", () => {
    const g = diagramGraph("stateDiagram-v2\n  state c <<choice>>\n  [*] --> A\n  A --> c\n  c --> B : yes\n  B --> [*]", { mehrpele: false });
    if (!g.ok) throw new Error(g.reason);
    expect(g.graph.nodes.map((n) => n.id)).toEqual(["A", "B"]);
    expect(g.graph.edges).toEqual([]);
    expect(g.graph.skippedPseudo).toBe(3);
  });
});

describe("settings", () => {
  test("defaults and normalisation", () => {
    expect(normalizeMaterialiseSettings(null)).toEqual(DEFAULT_MATERIALISE_SETTINGS);
    expect(normalizeMaterialiseSettings({ keyStyle: "verbatim", onExisting: "suffix", rewriteBlock: false, defaultKey: " rel ", rootFolder: "X/{{note}}" })).toEqual({
      keyStyle: "verbatim",
      onExisting: "suffix",
      rewriteBlock: false,
      defaultKey: "rel",
      rootFolder: "X/{{note}}",
    });
    expect(normalizeMaterialiseSettings({ keyStyle: "nope" as never, onExisting: "overwrite" as never, defaultKey: "" })).toEqual(DEFAULT_MATERIALISE_SETTINGS);
    expect(normalizeSettings(null).materialise).toEqual(DEFAULT_MATERIALISE_SETTINGS);
    expect(normalizeSettings({ materialise: { defaultKey: "x" } as never }).materialise.defaultKey).toBe("x");
  });
});
