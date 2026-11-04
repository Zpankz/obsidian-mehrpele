import { describe, expect, test } from "bun:test";
import { parse } from "pele";
import { flowchartFromGraph, type GraphNode, type GraphSpec } from "../../src/integrations/graph-to-pele";
import { datacoreToGraph } from "../../src/integrations/datacore/map";
import { normalizeIntegrationSettings } from "../../src/integrations/settings";
import {
  applyExtendedGraphStyle,
  egClassName,
  nodeColorFor,
  nodeShapeFor,
  normaliseColor,
  parseExtendedGraphSettings,
  ruleMatches,
  type NodeFacts,
} from "../../src/integrations/extended-graph/style-map";
import { generateBasesSource } from "../../src/mehrpele/bases-source";

/** Fake settings object shaped like Extended Graph 2.7.6's data.json. */
const EG_SETTINGS = {
  interactiveSettings: {
    tag: {
      colormap: "hsv",
      colors: [
        { type: "project", color: "#e05555" },
        { type: "area/health", color: "rgb(40, 160, 90)" },
        { type: "bad", color: "not-a-colour" },
      ],
      unselected: [],
      noneType: "none",
      showOnGraph: true,
      enableByDefault: true,
    },
    link: {
      colormap: "rainbow",
      colors: [{ type: "up", color: "#36f" }, { type: "same", color: "#aa8800" }],
      unselected: [],
      noneType: "none",
      showOnGraph: true,
      enableByDefault: true,
    },
    folder: {
      colormap: "winter",
      colors: [{ type: "Archive", color: "#777777", recursive: true }],
      unselected: [],
      noneType: "/",
      showOnGraph: true,
      enableByDefault: false,
    },
    status: {
      colormap: "viridis",
      colors: [{ type: "done", color: "#22aa22" }],
      unselected: [],
      noneType: "none",
      showOnGraph: true,
      enableByDefault: true,
      useForNodeColor: true,
    },
  },
  shapeQueries: {
    circle: { combinationLogic: "AND", index: 0, rules: [] },
    diamond: { combinationLogic: "AND", index: 1, rules: [{ source: "tag", property: "", value: "decision", logic: "is" }] },
    hexagon: {
      combinationLogic: "OR",
      index: 2,
      rules: [
        { source: "property", property: "type", value: "hub", logic: "is" },
        { source: "folderRec", property: "", value: "Maps", logic: "is" },
      ],
    },
    star5: { combinationLogic: "AND", index: 3, rules: [{ source: "all", property: "", value: "", logic: "" }] },
  },
  states: [],
};

const parsed = parseExtendedGraphSettings(EG_SETTINGS);
if (!parsed.ok) throw new Error(parsed.reason);
const style = parsed.style;

const FACTS: Record<string, NodeFacts> = {
  "Projects/Alpha.md": { path: "Projects/Alpha.md", tags: ["project"], properties: {} },
  "Health/Run.md": { path: "Health/Run.md", tags: ["area/health/running"], properties: {} },
  "Archive/2024/Old.md": { path: "Archive/2024/Old.md", tags: [], properties: {} },
  "Done.md": { path: "Done.md", tags: ["project"], properties: { status: ["done"] } },
  "Decide.md": { path: "Decide.md", tags: ["decision"], properties: {} },
  "Maps/World.md": { path: "Maps/World.md", tags: [], properties: { type: ["note"] } },
  "Plain.md": { path: "Plain.md", tags: [], properties: {} },
};

describe("parseExtendedGraphSettings", () => {
  test("reads explicit colours, drops invalid entries, keeps node-colour keys", () => {
    expect(style.colors.get("tag")?.map((c) => c.color)).toEqual(["#e05555", "#28a05a"]);
    expect(style.colors.get("link")?.map((c) => c.color)).toEqual(["#3366ff", "#aa8800"]);
    expect(style.nodeColorKeys).toEqual(["status"]);
    // Empty-rule shape queries are ignored; order follows `index`.
    expect(style.shapes.map((s) => s.shape)).toEqual(["diamond", "hexagon", "star5"]);
  });

  test("unrecognised shapes fail (caller logs once and skips)", () => {
    expect(parseExtendedGraphSettings(undefined).ok).toBe(false);
    expect(parseExtendedGraphSettings({}).ok).toBe(false);
    expect(parseExtendedGraphSettings({ interactiveSettings: [] }).ok).toBe(false);
    expect(parseExtendedGraphSettings({ interactiveSettings: {}, shapeQueries: [] }).ok).toBe(false);
  });

  test("real default data.json shape (no explicit colours) parses to an empty map", () => {
    const r = parseExtendedGraphSettings({
      interactiveSettings: { tag: { colormap: "hsv", colors: [] }, link: { colormap: "rainbow", colors: [] } },
      shapeQueries: { circle: { combinationLogic: "AND", index: 0, rules: [] } },
    });
    expect(r.ok && r.style.colors.size === 0 && r.style.shapes.length === 0).toBe(true);
  });

  test("colour normalisation", () => {
    expect(normaliseColor("#ABC")).toBe("#aabbcc");
    expect(normaliseColor("#11223344")).toBe("#112233");
    expect(normaliseColor("rgba(1, 2, 300, 0.5)")).toBe("#0102ff");
    expect(normaliseColor("red")).toBeNull();
    expect(normaliseColor("#123;fill:red")).toBeNull();
  });
});

describe("matching", () => {
  test("node colour priority: useForNodeColor key, tag (exact, then parent), property, folder (recursive)", () => {
    expect(nodeColorFor(style, FACTS["Done.md"]!)).toMatchObject({ key: "status", color: "#22aa22" });
    expect(nodeColorFor(style, FACTS["Projects/Alpha.md"]!)).toMatchObject({ key: "tag", type: "project" });
    expect(nodeColorFor(style, FACTS["Health/Run.md"]!)).toMatchObject({ key: "tag", type: "area/health" });
    expect(nodeColorFor(style, FACTS["Archive/2024/Old.md"]!)).toMatchObject({ key: "folder", color: "#777777" });
    expect(nodeColorFor(style, FACTS["Plain.md"]!)).toBeNull();
  });

  test("shape queries: first match by index; stars have no Pele analogue", () => {
    expect(nodeShapeFor(style, FACTS["Decide.md"]!)).toBe("diamond");
    expect(nodeShapeFor(style, FACTS["Maps/World.md"]!)).toBe("hexagon");
    expect(nodeShapeFor(style, FACTS["Plain.md"]!)).toBeUndefined();
  });

  test("rule logic", () => {
    const f: NodeFacts = { path: "A/B/Note.md", tags: ["x/y"], properties: { kind: ["Alpha", "Beta"] } };
    const r = (source: string, logic: string, value: string, property = "") => ruleMatches({ source, property, value, logic }, f);
    expect(r("tag", "contains", "x/")).toBe(true);
    expect(r("property", "isNot", "gamma", "kind")).toBe(true);
    expect(r("property", "matchesRegex", "al.*", "kind")).toBe(true);
    expect(r("file", "is", "note")).toBe(true);
    expect(r("folder", "is", "A/B")).toBe(true);
    expect(r("folderRec", "is", "A")).toBe(true);
    expect(r("property", "isEmpty", "", "missing")).toBe(true);
    expect(r("property", "containsRegex", "(", "kind")).toBe(false);
    expect(r("link", "is", "x")).toBe(false);
  });
});

describe("applyExtendedGraphStyle → GraphSpec classDefs", () => {
  const spec: GraphSpec = {
    direction: "LR",
    nodes: ["Projects/Alpha.md", "Done.md", "Decide.md", "Plain.md"].map(
      (p): GraphNode => ({ id: p, label: p.replace(/\.md$/, ""), href: p }),
    ),
    edges: [
      { from: "Projects/Alpha.md", to: "Done.md", kind: "up", label: "up" },
      { from: "Done.md", to: "Decide.md", kind: "next" },
    ],
  };

  test("theme-safe classDefs, classes, shapes and link colours", () => {
    const styled = applyExtendedGraphStyle(spec, style, (n) => FACTS[n.id]);
    const out = flowchartFromGraph(styled.spec, styled.options);
    const tagClass = `pele-${egClassName("tag", "project")}`;
    expect(out.source).toContain(`classDef ${tagClass} fill:#e0555533,stroke:#e05555,stroke-width:2px`);
    expect(out.source).toContain("classDef pele-eg-status-done fill:#22aa2233,stroke:#22aa22,stroke-width:2px");
    expect(out.source).toContain(`class Projects_Alpha ${tagClass}`);
    expect(out.source).toContain('Decide{"Decide"}');
    expect(out.source).toContain("linkStyle 0 stroke:#3366ff");
    expect(out.source).not.toContain("linkStyle 1");
    // No raw fills: every EG colour is translucent (readable in light + dark).
    expect(out.source).not.toMatch(/fill:#[0-9a-f]{6}(?![0-9a-f])/);
    expect(() => parse(out.source)).not.toThrow();
  });

  test("no style → generator output unchanged", () => {
    const styled = applyExtendedGraphStyle(spec, { colors: new Map(), nodeColorKeys: [], shapes: [] }, (n) => FACTS[n.id]);
    expect(flowchartFromGraph(styled.spec, styled.options).source).toBe(flowchartFromGraph(spec).source);
  });

  test("explicit generator shapes are never overridden", () => {
    const s: GraphSpec = { nodes: [{ id: "Decide.md", label: "D", shape: "stadium" }], edges: [] };
    expect(applyExtendedGraphStyle(s, style, (n) => FACTS[n.id]).spec.nodes[0]!.shape).toBe("stadium");
  });
});

describe("Bases-generated diagrams", () => {
  test("style hook emits classDef + class lines (flowchart)", () => {
    const out = generateBasesSource(
      [
        { path: "Projects/Alpha.md", basename: "Alpha", links: ["Done.md"] },
        { path: "Done.md", basename: "Done", links: [] },
      ],
      {
        kind: "flowchart",
        direction: "LR",
        groupIntoSubgraphs: false,
        maxNodes: 50,
        style: {
          classDefs: { "pele-eg-tag-project": "fill:#e0555533,stroke:#e05555,stroke-width:2px" },
          classesFor: (e) => (e.path === "Projects/Alpha.md" ? ["pele-eg-tag-project", "bad class"] : []),
        },
      },
    );
    expect(out.source).toContain("classDef pele-eg-tag-project fill:#e0555533,stroke:#e05555,stroke-width:2px");
    expect(out.source).toContain("class Projects_Alpha pele-eg-tag-project");
    expect(out.source).not.toContain("bad class");
    expect(() => parse(out.source)).not.toThrow();
  });
});

describe("settings + Datacore deep links", () => {
  test("Use Extended Graph colours defaults off", () => {
    expect(normalizeIntegrationSettings(null).extendedGraph.useColors).toBe(false);
    expect(normalizeIntegrationSettings({ extendedGraph: { useColors: true } } as never).extendedGraph.useColors).toBe(true);
  });

  test("Datacore sections/blocks become heading/block deep links", () => {
    const spec = datacoreToGraph([
      { $type: "page", $path: "Notes/A.md" },
      { $type: "section", $file: "Notes/A.md", $id: "Notes/A.md#Plan", $title: "Plan" },
      { $type: "block", $file: "Notes/B.md", $id: "Notes/B.md#^b1", $blockId: "b1" },
    ]);
    expect(spec.nodes.map((n) => [n.id, n.href, n.heading, n.block])).toEqual([
      ["Notes/A.md", "Notes/A.md", undefined, undefined],
      ["Notes/A.md#Plan", "Notes/A.md", "Plan", undefined],
      ["Notes/B.md#^b1", "Notes/B.md", undefined, "b1"],
    ]);
    const out = flowchartFromGraph(spec, { advancedUriVault: "V" });
    expect(out.source).toContain("heading=Plan");
    expect(out.source).toContain("block=b1");
  });
});
