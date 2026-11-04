import { describe, expect, test } from "bun:test";
import { parse, render } from "pele";
import {
  generateBasesSource,
  sanitiseNodeId,
  type BaseEntryLike,
} from "../../src/mehrpele/bases-source";
import { parseMehrpele } from "../../src/mehrpele/extract";
import { normalizeMehrpeleSettings, mehrpeleApplies } from "../../src/mehrpele/settings";
import { DEFAULT_MEHRPELE_SETTINGS } from "../../src/mehrpele/settings";

const ENTRIES: BaseEntryLike[] = [
  { path: "Proj/Alpha.md", basename: "Alpha", label: "**Alpha** plan", links: ["Proj/Beta.md"], group: "Active" },
  { path: "Proj/Beta.md", basename: "Beta", links: ["Proj/Gamma.md"], group: "Active" },
  { path: "Proj/Gamma.md", basename: "Gamma", links: [], group: null },
  { path: "9 Lives.md", basename: "9 Lives", links: ["Proj/Alpha.md"], group: "Later" },
];

describe("Bases → source generation", () => {
  test("flowchart: deterministic order, subgraphs from groups, sanitised ids", () => {
    const r = generateBasesSource(ENTRIES);
    expect(r.nodeCount).toBe(4);
    expect(r.edgeCount).toBe(3);
    expect(r.truncated).toBe(false);
    const lines = r.source.split("\n");
    expect(lines[0]).toBe("flowchart TD");
    expect(r.source).toContain('subgraph "Active"');
    expect(r.source).toContain('subgraph "Later"');
    // Leading-digit path gets the n_ prefix; spaces become underscores.
    expect([...r.idByPath.values()]).toContain("n_9_Lives");
    // Same input → same output.
    expect(generateBasesSource(ENTRIES).source).toBe(r.source);
  });

  test("generated source parses and renders with Pele, labels round-trip", () => {
    const r = generateBasesSource(ENTRIES);
    const model = parse(r.source);
    expect(model.type).toBe("flowchart");
    expect(() => render(r.source)).not.toThrow();
    const labels = parseMehrpele(r.source);
    expect(labels.labels.some((l) => l.markdown === "**Alpha** plan")).toBe(true);
  });

  test("maxNodes truncates with a flag and a hard cap of 500", () => {
    const many: BaseEntryLike[] = Array.from({ length: 600 }, (_, i) => ({
      path: `N${i}.md`, basename: `N${i}`, links: [],
    }));
    const r = generateBasesSource(many, { kind: "flowchart", direction: "LR", groupIntoSubgraphs: false, maxNodes: 100 });
    expect(r.truncated).toBe(true);
    expect(r.nodeCount).toBe(100);
    const capped = generateBasesSource(many, { kind: "flowchart", direction: "LR", groupIntoSubgraphs: false, maxNodes: 9999 });
    expect(capped.nodeCount).toBe(500);
  });

  test("mindmap: parent links form a tree under a synthetic root", () => {
    const r = generateBasesSource(ENTRIES, {
      kind: "mindmap", direction: "TD", groupIntoSubgraphs: true, maxNodes: 100,
    });
    expect(r.source.startsWith("mindmap")).toBe(true);
    expect(() => parse(r.source)).not.toThrow();
    // Link property points at the parent: Alpha→Beta→Gamma, so Alpha is deepest.
    const gammaDepth = r.source.split("\n").find((l) => l.includes("Gamma"))?.search(/\S/);
    const alphaDepth = r.source.split("\n").find((l) => l.includes("Alpha"))?.search(/\S/);
    expect(alphaDepth).toBeGreaterThan(gammaDepth ?? 0);
  });

  test("id sanitisation is deterministic and collision-safe", () => {
    const taken = new Set<string>();
    expect(sanitiseNodeId("a/b-c.md", taken)).toBe("a_b_c");
    expect(sanitiseNodeId("a/b_c.md", taken)).toBe("a_b_c_2");
    expect(sanitiseNodeId("9x.md", taken)).toBe("n_9x");
  });

  test("linkpaths without .md resolve by basename/suffix", () => {
    const r = generateBasesSource([
      { path: "A.md", basename: "A", links: ["B"], group: null },
      { path: "dir/B.md", basename: "B", links: [], group: null },
    ]);
    expect(r.edgeCount).toBe(1);
  });
});

describe("settings normalisation + applicability", () => {
  test("defaults survive junk input", () => {
    const s = normalizeMehrpeleSettings({ maxLabels: -3, mermaidLabelMode: "bogus" as never });
    expect(s.maxLabels).toBe(DEFAULT_MEHRPELE_SETTINGS.maxLabels);
    expect(s.mermaidLabelMode).toBe("directive");
    expect(normalizeMehrpeleSettings(null)).toEqual(DEFAULT_MEHRPELE_SETTINGS);
  });
  test("applicability matrix", () => {
    const s = normalizeMehrpeleSettings(null);
    expect(mehrpeleApplies("mehrpele", "flowchart TD", s, false)).toBe(true);
    expect(mehrpeleApplies("mermaid", "flowchart TD", s, false)).toBe(false);
    expect(mehrpeleApplies("mermaid", "flowchart TD", s, true)).toBe(true);
    const always = normalizeMehrpeleSettings({ mermaidLabelMode: "always" });
    expect(mehrpeleApplies("pele", "flowchart TD", always, false)).toBe(true);
    const off = normalizeMehrpeleSettings({ mermaidLabelMode: "off" });
    expect(mehrpeleApplies("mermaid", "flowchart TD", off, true)).toBe(false);
  });
});

describe("Bases labels cannot inject diagram statements", () => {
  const evil = (label: string): BaseEntryLike[] => [
    { path: "A.md", basename: "A", label, links: [] },
    { path: "B.md", basename: "B", links: [] },
  ];
  for (const nl of ["\n", "\r\n", "\r", " "]) {
    test(`newline ${JSON.stringify(nl)} in a label stays inside the quotes`, () => {
      const { source } = generateBasesSource(evil(`x${nl}click B "https://evil.example"${nl}style B fill:red`));
      const lines = source.split(/\r\n|[\r\n]/);
      expect(lines.some((l) => /^\s*click\b/.test(l))).toBe(false);
      expect(lines.some((l) => /^\s*style\b/.test(l))).toBe(false);
      expect(source).not.toContain("\r");
      // The whole payload stays one quoted (Mehrpele-escaped) label on node A.
      const nodeLine = lines.find((l) => /^\s*A\[/.test(l))!;
      expect(nodeLine).toContain('click B \\"https://evil.example\\" style B fill:red"]');
    });
  }

  test("mindmap labels handle lone CR", () => {
    const { source } = generateBasesSource(evil("first\rsecond"), {
      ...{ kind: "mindmap", direction: "TD", groupIntoSubgraphs: false, maxNodes: 10 },
    } as never);
    expect(source).not.toContain("\r");
    expect(source).toContain("first");
    expect(source).not.toContain("second");
  });
});
