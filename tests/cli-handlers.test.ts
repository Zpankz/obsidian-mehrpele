import { describe, expect, test } from "bun:test";
import {
  applyRepairsToText,
  buildRepairSummary,
  fromCanvasLang,
  repairResultEntry,
  buildCheckSummary,
  buildCheckSummaryAsync,
  canvasFileName,
  chooseCanvasTarget,
  cliFlag,
  isWholeFileDiagram,
  mergeUserCanvasContent,
  validateOutPath,
  DIAGRAM_TYPES,
  diagramsOf,
  formatCheckText,
  guardOutput,
  inVaultFolder,
  parseIndexParam,
} from "../src/cli-handlers";

const NOTE = [
  "# T",
  "```mermaid",
  "graph TD",
  " A-->B",
  "```",
  "```mermaid",
  "graph TD",
  " A-->",
  "```",
].join("\n");

describe("cli handler cores", () => {
  test("check summary matches the pele-render schema shape", () => {
    const s = buildCheckSummary([{ file: "T.md", content: NOTE }]);
    expect(s.diagrams).toBe(2);
    expect(s.invalid).toBe(1);
    expect(s.results[0]).toEqual({ file: "T.md", index: 0, line: 3, type: "flowchart", ok: true });
    expect(s.errors[0]?.file).toBe("T.md");
    expect(s.errors[0]?.code).toBe("syntax");
    expect(formatCheckText(s)).toContain("1/2 valid");
  });

  test("index param validation throws Errors the CLI host prints as before", () => {
    expect(parseIndexParam(undefined, 1, "T.md")).toBe(0);
    expect(parseIndexParam("1", 2, "T.md")).toBe(1);
    expect(() => parseIndexParam(undefined, 2, "T.md")).toThrow("pass index=");
    expect(() => parseIndexParam("5", 2, "T.md")).toThrow("out of range");
    // Obsidian's CLI host renders a rejection as `typeof e == "string" ? "Error: " + e : String(e)`
    // (Electron re-creates a thrown Error as a plain Error with the same message), so the
    // printed line is byte-identical to the former thrown string: pin name and message exactly.
    let thrown: unknown;
    try {
      parseIndexParam(undefined, 2, "T.md");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("pele: T.md has 2 diagrams; pass index=<n> or out=<folder>");
    expect(String(thrown)).toBe("Error: pele: T.md has 2 diagrams; pass index=<n> or out=<folder>");
    expect(() => validateOutPath("Note.md", [".svg"])).toThrow(new Error("pele: out=Note.md must end with .svg"));
  });

  test("whole-file diagrams, output guard, canvas naming, types", () => {
    expect(diagramsOf({ file: "x.mmd", content: "graph TD\n A-->B", wholeFile: true })).toHaveLength(1);
    expect(guardOutput("x".repeat(600_000))).toContain("output-too-large");
    expect(canvasFileName("a/b/Note.md", "abcdef0123456789", "")).toBe("Note - diagram abcdef.canvas");
    expect(canvasFileName("Note.md", "abcdef0123456789", "out/", 2)).toBe("out/Note - diagram abcdef 2.canvas");
    // A note at the vault root: its folder path is "/".
    expect(canvasFileName("Note.md", "abcdef0123456789", "/")).toBe("Note - diagram abcdef.canvas");
    expect(DIAGRAM_TYPES).toHaveLength(33);
  });
});

describe("inVaultFolder", () => {
  test("root spellings mean the whole vault", () => {
    for (const root of ["", ".", "/", "./"]) expect(inVaultFolder("a/b.md", root)).toBe(true);
  });
  test("prefix match respects path segments", () => {
    expect(inVaultFolder("notes/a.md", "notes")).toBe(true);
    expect(inVaultFolder("notes/a.md", "/notes/")).toBe(true);
    expect(inVaultFolder("notes2/a.md", "notes")).toBe(false);
  });
});

describe("validateOutPath (CLI out=/folder=)", () => {
  test("accepts vault-relative paths with the expected extension", () => {
    expect(validateOutPath("exports/a.svg", [".svg"])).toBe("exports/a.svg");
    expect(validateOutPath("./x//y.PNG", [".png"])).toBe("x/y.PNG");
    expect(validateOutPath("out/", undefined)).toBe("out");
  });
  test("rejects absolute, home, drive and traversal paths", () => {
    for (const bad of ["/etc/passwd.svg", "~/a.svg", "C:/a.svg", "\\\\srv\\a.svg", "a/../../b.svg", "..", "file:///a.svg"]) {
      expect(() => validateOutPath(bad, [".svg"])).toThrow();
    }
  });
  test("rejects a wrong or missing extension (can't overwrite notes)", () => {
    expect(() => validateOutPath("Note.md", [".svg"])).toThrow("must end with .svg");
    expect(() => validateOutPath("Diagram.canvas.md", [".canvas"])).toThrow();
    expect(() => validateOutPath(".svg", [".svg"])).toThrow();
    expect(() => validateOutPath("", [".svg"])).toThrow();
  });
  test("flags", () => {
    expect(cliFlag("true")).toBe(true);
    expect(cliFlag("")).toBe(true);
    expect(cliFlag(undefined)).toBe(false);
    expect(cliFlag("false")).toBe(false);
  });
});

describe("applyRepairsToText (pele:repair write)", () => {
  const doc = [
    "```mermaid", "graph TD", "  A-->", "```", "",
    "```mehrpele", "graph TD", "  \"**x**\"-->", "```", "",
    "```pele", "graph TD", "  B-->", "```",
  ].join("\n");

  test("a Mehrpele block is written back and doesn't abort the others", () => {
    const r = applyRepairsToText(doc, false, [
      { line: 2, old: "graph TD\n  A-->", next: "graph TD\n  A-->A2" },
      { line: 7, old: "graph TD\n  \"**x**\"-->", next: "graph TD\n  \"**x**\"-->Y" },
      { line: 12, old: "graph TD\n  B-->", next: "graph TD\n  B-->B2" },
    ]);
    expect(r).toMatchObject({ applied: 3, skipped: 0 });
    expect(r.text).toContain("A-->A2");
    expect(r.text).toContain('"**x**"-->Y');
    expect(r.text).toContain("B-->B2");
  });

  test("a block that changed is skipped, the rest still apply", () => {
    const r = applyRepairsToText(doc, false, [
      { line: 2, old: "graph TD\n  A-->", next: "graph TD\n  A-->A2" },
      { line: 12, old: "graph TD\n  Z-->", next: "graph TD\n  Z-->Z2" },
    ]);
    expect(r).toMatchObject({ applied: 1, skipped: 1 });
  });

  test(".mmd/.mermaid files are repaired as a whole-file body", () => {
    expect(isWholeFileDiagram("mmd")).toBe(true);
    expect(isWholeFileDiagram("MERMAID")).toBe(true);
    expect(isWholeFileDiagram("md")).toBe(false);
    const r = applyRepairsToText("graph TD\n  A-->\n", true, [{ line: 1, old: "graph TD\n  A-->\n", next: "graph TD\n  A-->B" }]);
    expect(r).toEqual({ text: "graph TD\n  A-->B\n", applied: 1, skipped: 0 });
    // File changed meanwhile: untouched.
    expect(applyRepairsToText("graph LR\n", true, [{ line: 1, old: "graph TD", next: "x" }]).applied).toBe(0);
  });
});

describe("canvas target identity", () => {
  const canvasWith = (hash: string, extra: object = {}) =>
    JSON.stringify({ metadata: { pele: { sourceHash: hash } }, nodes: [], edges: [], ...extra });

  test("creates a fresh file when the name is free", async () => {
    const t = await chooseCanvasTarget((n) => `N - diagram aaaaaa${n > 1 ? ` ${n}` : ""}.canvas`, "aaaaaa11", () => null);
    expect(t).toEqual({ path: "N - diagram aaaaaa.canvas", kind: "create" });
  });

  test("merges only into a canvas made from the same source", async () => {
    const files: Record<string, string> = { "N - diagram aaaaaa.canvas": canvasWith("aaaaaa11") };
    const t = await chooseCanvasTarget((n) => `N - diagram aaaaaa${n > 1 ? ` ${n}` : ""}.canvas`, "aaaaaa11", (p) => files[p] ?? null);
    expect(t.kind).toBe("merge");
  });

  test("never overwrites another diagram's / a user's canvas", async () => {
    const files: Record<string, string> = {
      "N - diagram aaaaaa.canvas": canvasWith("aaaaaa99"), // hash6 collision, other diagram
      "N - diagram aaaaaa 2.canvas": "{ not json",
    };
    const t = await chooseCanvasTarget((n) => `N - diagram aaaaaa${n > 1 ? ` ${n}` : ""}.canvas`, "aaaaaa11", (p) => files[p] ?? null);
    expect(t).toEqual({ path: "N - diagram aaaaaa 3.canvas", kind: "create" });
  });

  test("merging keeps user cards and user edges, drops stale generator edges", () => {
    const generated = {
      metadata: { pele: { sourceHash: "h" } },
      nodes: [{ id: "n_A", peleId: "A" }, { id: "n_B", peleId: "B" }],
      edges: [{ id: "e_A_B_0", fromNode: "n_A", toNode: "n_B" }],
    };
    const previous = {
      nodes: [
        { id: "n_A", peleId: "A", x: 5 },
        { id: "n_B", peleId: "B" },
        { id: "n_C", peleId: "C" }, // removed from the diagram
        { id: "f00dcafe", type: "text", text: "my note" }, // user card
      ],
      edges: [
        { id: "e_A_B_0", fromNode: "n_A", toNode: "n_B" },
        { id: "e_B_C_0", fromNode: "n_B", toNode: "n_C" }, // stale generator edge
        { id: "u1", fromNode: "n_A", toNode: "f00dcafe" }, // user edge to a user card
        { id: "u2", fromNode: "n_C", toNode: "f00dcafe" }, // endpoint gone
      ],
    };
    const merged = mergeUserCanvasContent(generated, previous);
    expect(merged.nodes!.map((n) => n.id)).toEqual(["n_A", "n_B", "f00dcafe"]);
    expect(merged.edges!.map((e) => e.id)).toEqual(["e_A_B_0", "u1"]);
    expect(merged.metadata).toEqual(generated.metadata);
  });
});

describe("buildCheckSummaryAsync", () => {
  test("yields to the event loop every N notes and matches the sync summary", async () => {
    const notes = Array.from({ length: 25 }, (_, i) => ({ file: `n${i}.md`, content: "```mermaid\ngraph TD\n A-->B\n```" }));
    let yields = 0;
    const summary = await buildCheckSummaryAsync(notes, { yieldEvery: 10, yieldFn: async () => void yields++ });
    expect(yields).toBe(2);
    expect(summary).toEqual(buildCheckSummary(notes));
    async function* gen() {
      yield { file: "x.md", content: "```pele\ngraph TD\n A-->\n```" };
    }
    expect((await buildCheckSummaryAsync(gen())).invalid).toBe(1);
  });
});

describe("pele-render bridge interop", () => {
  test("(a) pele:repair format=json matches `pele-render repair --format json`", () => {
    const valid = repairResultEntry({ file: "N.md", index: 0, line: 2 }, { ok: true, fixes: [], attempts: [], unchanged: true });
    const fixed = repairResultEntry(
      { file: "N.md", index: 1, line: 8 },
      { ok: true, tier: "linter", fixes: ["close bracket"], attempts: [{ tier: "linter" }], lossy: true, dropped: ["x"] },
    );
    const broken = repairResultEntry({ file: "N.md", index: 2, line: 14 }, { ok: false, fixes: [], attempts: [], dropped: [] });
    const summary = buildRepairSummary([valid, fixed, broken]);
    expect(summary).toEqual({
      diagrams: 3,
      repaired: 1,
      failed: 1,
      results: [
        { file: "N.md", index: 0, line: 2, ok: true, tier: undefined, fixes: [], attempts: [], unchanged: true, lossy: false },
        { file: "N.md", index: 1, line: 8, ok: true, tier: "linter", fixes: ["close bracket"], attempts: [{ tier: "linter" }], unchanged: undefined, lossy: true, dropped: ["x"] },
        { file: "N.md", index: 2, line: 14, ok: false, tier: undefined, fixes: [], attempts: [], unchanged: undefined, lossy: false },
      ],
    });
    // The bridge's acceptance check (classifyBridge "repair").
    const j = JSON.parse(JSON.stringify(summary));
    expect(Array.isArray(j.results) && typeof j.repaired === "number" && typeof j.failed === "number").toBe(true);
  });

  test("(b) pele:from-canvas accepts lang= (bridge) and the mehrpele flag", () => {
    expect(fromCanvasLang({ lang: "mehrpele" }, false)).toBe("mehrpele");
    expect(fromCanvasLang({ lang: "MERMAID" }, true)).toBe("mermaid"); // explicit beats the setting
    expect(fromCanvasLang({ mehrpele: "true" }, false)).toBe("mehrpele");
    expect(fromCanvasLang({}, true)).toBe("mehrpele");
    expect(fromCanvasLang({}, false)).toBe("mermaid");
    expect(() => fromCanvasLang({ lang: "js" }, false)).toThrow();
  });

  test("(c) index = 0-based document order over mermaid|pele|mehrpele, case-insensitive", () => {
    const md = [
      "```js", "x", "```",
      "```Mermaid", "graph TD", "```",
      "````md", "```pele", "nested, not counted", "```", "````",
      "~~~PELE width=300", "graph LR", "~~~",
      "```pele-tasks", "view: kanban", "```",
      "```MehrPele", "graph TD", "```",
    ].join("\n");
    const ds = diagramsOf({ file: "N.md", content: md });
    expect(ds.map((d) => [d.index, d.lang, d.line])).toEqual([
      [0, "mermaid", 5],
      [1, "pele", 13],
      [2, "mehrpele", 19],
    ]);
  });

  test("(c) CRLF notes count the same blocks", () => {
    const md = "```mermaid\r\ngraph TD\r\n A-->B\r\n```\r\n\r\n```pele\r\ngraph LR\r\n```\r\n";
    const ds = diagramsOf({ file: "N.md", content: md });
    expect(ds.map((d) => d.code)).toEqual(["graph TD\n A-->B", "graph LR"]);
  });

  test("(c) .mmd/.mermaid are one whole-file diagram at index 0", () => {
    for (const ext of ["mmd", "mermaid", "MMD"]) {
      const note = { file: `d.${ext}`, content: "graph TD\n A-->B\n", wholeFile: isWholeFileDiagram(ext) };
      const ds = diagramsOf(note);
      expect(ds).toHaveLength(1);
      expect(ds[0]!.index).toBe(0);
      expect(parseIndexParam("0", ds.length, note.file)).toBe(0);
    }
  });

  test("CRLF files are repaired and keep CRLF", () => {
    const text = "```mermaid\r\ngraph TD\r\n  A-->\r\n```\r\n";
    const r = applyRepairsToText(text, false, [{ line: 2, old: "graph TD\n  A-->", next: "graph TD\n  A-->B" }]);
    expect(r.applied).toBe(1);
    expect(r.text).toBe("```mermaid\r\ngraph TD\r\n  A-->B\r\n```\r\n");
  });

  test("case-insensitive fences can be written back", () => {
    const r = applyRepairsToText("```Mermaid\ngraph TD\n  A-->\n```", false, [{ line: 2, old: "graph TD\n  A-->", next: "graph TD\n  A-->B" }]);
    expect(r.applied).toBe(1);
  });
});

describe("check warnings for pele-size", () => {
  test("warnings mirror pele-render: located at the directive line, never errors", async () => {
    const { buildCheckSummary } = await import("../src/cli-handlers");
    const s = buildCheckSummary([
      { file: "n.md", content: "# t\n\n```mermaid\nblock-beta\n  a b\n%% pele-size a=100 %%\n```\n\n```mermaid\nflowchart LR\n  A --> B\n%% pele-size Z=10 %%\n```\n" },
    ]);
    expect(s.invalid).toBe(0);
    expect(s.warnings?.map((w) => [w.line, w.code])).toEqual([[6, "unsupported-type"], [12, "unknown-node"]]);
    expect(buildCheckSummary([{ file: "x.mmd", content: "flowchart LR\n  A" }]).warnings).toBeUndefined();
  });

  test("a warning points at the outer directive, not one inside a nested label", async () => {
    const { buildCheckSummary } = await import("../src/cli-handlers");
    const content = '# t\n\n```mehrpele\nflowchart LR\n  A --> N["~~~mermaid\nflowchart TD\n  X --> Y\n%% pele-size X=50 %%\n~~~"]\n%% pele-size Z=10 %%\n```\n';
    const s = buildCheckSummary([{ file: "n.md", content }]);
    expect(s.warnings?.map((w) => [w.line, w.code])).toEqual([[10, "unknown-node"]]);
  });
});
