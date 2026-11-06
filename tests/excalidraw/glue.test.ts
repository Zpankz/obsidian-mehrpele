import { describe, expect, test } from "bun:test";
import { extractBlocks, blockAtLine, diagramIndexOf, drawingPathFor, drawingPathError, nestedDiagramSources, parseIndex } from "../../src/excalidraw/extract";
import { resolvePalette, PELE_VARS } from "../../src/excalidraw/palette";
import { cliResultJson } from "../../src/excalidraw/result";
import { excalidrawState, excalidrawStatus, versionAtLeast } from "../../src/excalidraw/ea";
import { peleToExcalidraw } from "pele-render/excalidraw";

const NOTE = ["# Hi", "", "```mermaid", "flowchart TD", "  A --> B", "```", "", "text", "", "```pele", "pie title T", '  "a" : 1', "```"].join("\n");

describe("extractBlocks", () => {
  test("finds mermaid and pele fences in order", () => {
    const blocks = extractBlocks(NOTE);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.lang).toBe("mermaid");
    expect(blocks[1]?.lang).toBe("pele");
    expect(blocks[0]?.code).toContain("flowchart");
  });
  test("same fences and order as pele-mermaid / pele-render --index", () => {
    const md = ["```mermaid width=480", "flowchart LR", "  A-->B", "```", "~~~Mermaid", "pie", '  "a" : 1', "~~~",
      "```mehrpele", "flowchart LR", "  C-->D", "```", "```js", "x", "```"].join("\r\n");
    const blocks = extractBlocks(md);
    expect(blocks.map((b) => b.lang)).toEqual(["mermaid", "mermaid", "mehrpele"]);
    expect(blocks[0]?.code).toBe("flowchart LR\n  A-->B"); // CRLF stripped
    expect(blocks[1]).toMatchObject({ startLine: 4, endLine: 7 });
  });
  test("drawingPathError / parseIndex", () => {
    expect(drawingPathError("Dir/x.excalidraw.md")).toBeNull();
    expect(drawingPathError("x.excalidraw")).toBeNull();
    for (const bad of ["x.md", "/x.excalidraw", "\\x.excalidraw", "C:/x.excalidraw", "../x.excalidraw", "a/../x.excalidraw.md", " "]) expect(drawingPathError(bad), bad).not.toBeNull();
    expect(parseIndex(undefined)).toBe(0);
    expect(parseIndex("2")).toBe(2);
    expect(parseIndex("-1")).toBeNull();
    expect(parseIndex("1.5")).toBeNull();
    expect(parseIndex("x")).toBeNull();
  });
  test("blockAtLine picks enclosing then preceding block", () => {
    const blocks = extractBlocks(NOTE);
    expect(blockAtLine(blocks, 3)).toBe(blocks[0]!);
    expect(blockAtLine(blocks, 7)).toBe(blocks[0]!);
    expect(blockAtLine([], 0)).toBeNull();
  });
  test("drawingPathFor is next to note and non-colliding", () => {
    expect(drawingPathFor("Notes/A.md", 0, () => false)).toBe("Notes/A-diagram.excalidraw.md");
    expect(drawingPathFor("Notes/A.md", 1, () => false)).toBe("Notes/A-diagram-1.excalidraw.md");
    expect(drawingPathFor("A.md", 0, (p) => p === "A-diagram.excalidraw.md")).toBe("A-diagram-2.excalidraw.md");
  });
});

describe("nestedDiagramSources / diagramIndexOf", () => {
  test("top-level fences give the same sources as extractBlocks", () => {
    const md = ["```mermaid width=480", "flowchart LR", "  A-->B", "```", "~~~Mermaid", "pie", '  "a" : 1', "~~~",
      "```mehrpele", "flowchart LR", "  C-->D", "```", "```js", "x", "```"].join("\r\n");
    expect(nestedDiagramSources(md)).toEqual(extractBlocks(md).map((b) => b.code));
    expect(nestedDiagramSources(NOTE)).toEqual(extractBlocks(NOTE).map((b) => b.code));
  });
  test("tab-indented fences and thematic breaks keep parity with extractBlocks", () => {
    const tabbed = ["\t```mermaid", "x", "\t```", "```mermaid", "z", "```"].join("\n");
    expect(nestedDiagramSources(tabbed).map((s) => s.trim())).toEqual(extractBlocks(tabbed).map((b) => b.code.trim()));
    expect(diagramIndexOf(tabbed, "z")).toBe(1);
    // `* * *` is a thematic break, not a list item, so the 4-space fence after it is indented code.
    const hr = ["```mermaid", "pie", "```", "* * *", "", "    ```mermaid", "    flowchart", "    ```", "```mermaid", "z", "```"].join("\n");
    expect(nestedDiagramSources(hr)).toEqual(extractBlocks(hr).map((b) => b.code));
    expect(diagramIndexOf(hr, "z")).toBe(1);
  });
  test("an unclosed fence in a list item ends with the item", () => {
    const md = ["```mermaid", "pie", "```", "- ```js", "  example", "", "```mermaid", "z", "```"].join("\n");
    expect(diagramIndexOf(md, "z")).toBe(1);
    const below = ["- item", "  ```mermaid", "  flowchart", "", "```mermaid", "z", "```"].join("\n");
    expect(nestedDiagramSources(below).map((s) => s.trim())).toEqual(["flowchart", "z"]);
  });
  test("in a list item, a fence 4+ spaces past the item's content is indented code", () => {
    const md = ["- item", "", "      ```mermaid", "      pie", "      ```", "", "```mermaid", "z", "```"].join("\n");
    expect(diagramIndexOf(md, "z")).toBe(0);
    // Nested items: the content column is the innermost item's, and drops back when a line dedents.
    const nested = ["- a", "  - b", "", "    ```mermaid", "    one", "    ```", "", "  text", "",
      "      ```mermaid", "      code", "      ```", "", "```mermaid", "z", "```"].join("\n");
    expect(nestedDiagramSources(nested).map((s) => s.trim())).toEqual(["one", "z"]);
    // Up to 4 spaces after the marker set the content column; more means 1.
    const wide = ["-    item", "", "     ```mermaid", "     wide", "     ```"].join("\n");
    expect(nestedDiagramSources(wide).map((s) => s.trim())).toEqual(["wide"]);
  });
  test("a closing fence is indented at most 3 spaces from its container, not from the opener", () => {
    // The 4-space ``` line is content of the js block, so the ~~~mermaid inside it is not a diagram.
    const md = ["   ```js", "    ```", "~~~mermaid", "x", "~~~", "   ```", "```mermaid", "z", "```"].join("\n");
    expect(nestedDiagramSources(md)).toEqual(extractBlocks(md).map((b) => b.code));
    expect(diagramIndexOf(md, "z")).toBe(0);
    // In a list item, the fence ends where the item does, measured from the item's content, not the opener.
    const list = ["```mermaid", "pie", "```", "- item", "    ```mermaid", "  flowchart", "  ```"].join("\n");
    expect(nestedDiagramSources(list).map((s) => s.trim())).toEqual(["pie", "flowchart"]);
    expect(diagramIndexOf(list, "flowchart")).toBe(1);
  });
  test("a list marker 4+ spaces past its container is indented code, not a list item", () => {
    const md = ["    - ~~~mermaid", "      pie", "      ~~~", "", "```mermaid", "z", "```"].join("\n");
    expect(nestedDiagramSources(md)).toEqual(extractBlocks(md).map((b) => b.code));
    expect(diagramIndexOf(md, "z")).toBe(0);
    // A nested marker up to 3 spaces past its parent's content still opens an item.
    const nested = ["- a", "     - ```mermaid", "       x", "       ```"].join("\n");
    expect(nestedDiagramSources(nested).map((s) => s.trim())).toEqual(["x"]);
  });
  test("a top-level diagram keeps extractBlocks' index even where the scanner misreads a list", () => {
    // `2) two` can't interrupt a paragraph, so this is prose and the 6-space fence is not a diagram;
    // the scanner reads a list item. A top-level diagram's index must not depend on that.
    const md = ["text", "2) two", "      ```mermaid", "      d2", "      ```", "```mermaid", "z", "```"].join("\n");
    expect(diagramIndexOf(md, "z")).toBe(extractBlocks(md).findIndex((b) => b.code.trim() === "z"));
    expect(diagramIndexOf(md, "z")).toBe(0);
  });
  test("a fence ends with its quote; the next line is still scanned", () => {
    const md = ["> ```mermaid", "> flowchart LR", ">   A-->B", "```mermaid", "pie", '  "a" : 1', "```"].join("\n");
    expect(nestedDiagramSources(md)).toEqual(["flowchart LR\n  A-->B", 'pie\n  "a" : 1']);
  });
  test("fences shown inside another fence or as indented code are not diagrams", () => {
    const md = ["````md", "```mermaid", "flowchart LR", "```", "````", "", "    ```mermaid", "    pie", "    ```", "", "```mermaid", "pie", "```"].join("\n");
    expect(nestedDiagramSources(md)).toEqual(["pie"]);
  });
  test("a fence on the list marker line strips the marker's width", () => {
    const md = ["1. ```mermaid", "   flowchart LR", "     A-->B", "   ```"].join("\n");
    expect(nestedDiagramSources(md)).toEqual(["flowchart LR\n  A-->B"]);
  });
  test("diagramIndexOf falls back to ignoring per-line indent, and is -1 without a match", () => {
    const spaced = ["- item", "  ```mermaid", "  flowchart LR", "     A-->B", "  ```"].join("\n");
    expect(diagramIndexOf(spaced, "flowchart LR\nA-->B")).toBe(0);
    expect(diagramIndexOf(spaced, "pie")).toBe(-1);
  });
});

describe("palette + cli json", () => {
  test("resolvePalette keeps only non-empty vars", () => {
    const pal = resolvePalette((n) => (n === "--pele-surface" ? " #abc " : ""));
    expect(pal).toEqual({ "--pele-surface": "#abc" });
    expect(PELE_VARS).toContain("--pele-border");
  });
  test("cliResultJson shape", () => {
    expect(JSON.parse(cliResultJson({ ok: true, out: "x.excalidraw.md", fidelity: "native", elements: 3, dropped: [] })))
      .toEqual({ ok: true, out: "x.excalidraw.md", fidelity: "native", elements: 3, dropped: [] });
  });
});

describe("excalidraw state", () => {
  test("versionAtLeast compares dotted versions", () => {
    expect(versionAtLeast("2.29.0", "2.29.0")).toBe(true);
    expect(versionAtLeast("2.30.1", "2.29.0")).toBe(true);
    expect(versionAtLeast("2.10.0", "2.9.9")).toBe(true);
    expect(versionAtLeast("2.28.9", "2.29.0")).toBe(false);
    expect(versionAtLeast("2.29.0-beta.1", "2.29.0")).toBe(true);
  });
  test("excalidrawStatus names the required plugin and its state", () => {
    const id = "obsidian-excalidraw-plugin";
    expect(excalidrawStatus({ plugins: { manifests: {}, plugins: {} } })).toEqual({ ready: false, detail: "Excalidraw is not installed (needs 2.29.0 or later)." });
    expect(excalidrawStatus({ plugins: { manifests: { [id]: { version: "2.20.0" } }, plugins: { [id]: {} } } }).detail).toBe("Excalidraw 2.20.0 is too old (needs 2.29.0 or later).");
    expect(excalidrawStatus({ plugins: { manifests: { [id]: { version: "2.29.1" } }, plugins: {} } }).detail).toBe("Excalidraw 2.29.1 is installed but not enabled.");
    expect(excalidrawStatus({ plugins: { manifests: { [id]: { version: "2.29.1" } }, plugins: { [id]: {} } } })).toEqual({ ready: true, detail: "Excalidraw 2.29.1 detected." });
  });
  test("excalidrawState distinguishes installed vs enabled", () => {
    const app = { plugins: { manifests: { "obsidian-excalidraw-plugin": {} }, plugins: {} } };
    expect(excalidrawState(app)).toEqual({ installed: true, enabled: false });
    const app2 = { plugins: { manifests: {}, plugins: { "obsidian-excalidraw-plugin": {} } } };
    expect(excalidrawState(app2)).toEqual({ installed: false, enabled: true });
  });
});

describe("bundled converter smoke", () => {
  test("flowchart converts natively through the bundled import", () => {
    const r = peleToExcalidraw("flowchart LR\n A --> B");
    expect(r.fidelity).toBe("native");
    expect(r.elements.some((e) => e.type === "arrow")).toBe(true);
  });
});
