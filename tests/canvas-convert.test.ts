import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { presetThemeCss, type CanvasData } from "pele-render/canvas";
import { canvasReferences, canvasToBlock, fenceFor, insertBlock, mermaidNoteBody, mermaidNoteName } from "../src/canvas-convert";
import { normalizeSettings } from "../src/settings/v2";

const settings = { portals: "link" as const, portalDepth: 1, layout: "canvas" as const };
const markdownCanvas: CanvasData = {
  nodes: [
    { id: "a", type: "file", x: 0, y: 0, width: 320, height: 240, file: "Notes/Alpha.md", subpath: "#Plan" },
    { id: "b", type: "text", x: 400, y: 0, width: 250, height: 60, text: "Plain" },
    { id: "p", type: "file", x: 0, y: 400, width: 300, height: 200, file: "Boards/Other.canvas", portal: true },
  ],
  edges: [{ id: "e", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left" }],
};
const plainCanvas: CanvasData = { nodes: [{ id: "b", type: "text", x: 0, y: 0, width: 250, height: 60, text: "Plain" }], edges: [] };

describe("canvasToBlock", () => {
  test("view-nodes: web link cards become web-view nodes only when asked (and never in a forced mermaid block)", () => {
    const web: CanvasData = { nodes: [{ id: "w", type: "link", x: 0, y: 0, width: 440, height: 320, url: "https://example.com" }], edges: [] };
    const on = canvasToBlock(web, settings, { mehrpeleByDefault: false, webNodes: true });
    expect(on.lang).toBe("mehrpele");
    expect(on.source).toContain('"![[https://example.com|440x320]]"');
    expect(canvasToBlock(web, settings, { mehrpeleByDefault: false }).source).toContain('click example_com "https://example.com"');
    expect(canvasToBlock(web, settings, { mehrpeleByDefault: false, webNodes: true, lang: "mermaid" }).source).not.toContain("![[");
  });
  test("file cards make a mehrpele block with pinned positions", () => {
    const b = canvasToBlock(markdownCanvas, settings, { mehrpeleByDefault: false });
    expect(b.lang).toBe("mehrpele");
    expect(b.block.startsWith("```mehrpele\n")).toBe(true);
    expect(b.block.endsWith("\n```")).toBe(true);
    expect(b.source).toContain('"![[Notes/Alpha.md#Plan|320x240]]"');
    expect(b.source).toContain("%% pele-layout canvas %%");
  });
  test("plain canvases stay mermaid unless Mehrpele is on for every block; lang forces", () => {
    expect(canvasToBlock(plainCanvas, settings, { mehrpeleByDefault: false }).lang).toBe("mermaid");
    expect(canvasToBlock(plainCanvas, settings, { mehrpeleByDefault: true }).lang).toBe("mehrpele");
    const forced = canvasToBlock(markdownCanvas, settings, { mehrpeleByDefault: false, lang: "mermaid" });
    expect(forced.lang).toBe("mermaid");
    expect(canvasToBlock(markdownCanvas, settings, { mehrpeleByDefault: false, layout: "auto" }).source).not.toContain("pele-layout");
  });
  test("the fence outgrows code blocks inside text cards", () => {
    expect(fenceFor("flowchart TD")).toBe("```");
    expect(fenceFor('A["```js\nx\n```"]')).toBe("````");
    const b = canvasToBlock({ nodes: [{ id: "t", type: "text", x: 0, y: 0, width: 250, height: 60, text: "Run:\n```js\nx()\n```" }], edges: [] }, settings, { mehrpeleByDefault: false });
    expect(b.block.startsWith("````mehrpele\n")).toBe(true);
    expect(b.block.endsWith("\n````")).toBe(true);
  });
  test("canvas references for portal preloading", () => {
    expect(canvasReferences(markdownCanvas)).toEqual(["Boards/Other.canvas"]);
  });
});

describe("destinations", () => {
  test("new note beside the canvas, numbered when taken, linking back", () => {
    expect(mermaidNoteName("Boards/Plan.canvas")).toBe("Boards/Plan.md");
    expect(mermaidNoteName("Plan.canvas", 3)).toBe("Plan 3.md");
    expect(mermaidNoteBody("Boards/Plan.canvas", "```mermaid\nflowchart TD\n```")).toBe("Converted from [[Boards/Plan.canvas|Plan]].\n\n```mermaid\nflowchart TD\n```\n");
  });
  test("insert after the cursor line, blank-separated, or at the end", () => {
    const block = "```mermaid\nflowchart TD\n```";
    expect(insertBlock("# Title\nText\nMore", block, 0)).toEqual({ text: "# Title\n\n```mermaid\nflowchart TD\n```\n\nText\nMore", line: 2 });
    expect(insertBlock("# Title\n", block)).toEqual({ text: "# Title\n\n```mermaid\nflowchart TD\n```\n", line: 2 });
    expect(insertBlock("", block)).toEqual({ text: "```mermaid\nflowchart TD\n```\n", line: 0 });
    const note = "Intro\n```mehrpele\nflowchart LR\n  A --> B\n```\nAfter";
    expect(insertBlock(note, block, 2)).toEqual({ text: "Intro\n```mehrpele\nflowchart LR\n  A --> B\n```\n\n```mermaid\nflowchart TD\n```\n\nAfter", line: 6 });
    expect(insertBlock(note, block, 1).line).toBe(6);
  });
});

describe("settings and styles", () => {
  test("canvas layout defaults to canvas positions; junk is normalised", () => {
    expect(normalizeSettings(null).canvas.layout).toBe("canvas");
    expect(normalizeSettings({ canvas: { layout: "auto" } } as never).canvas.layout).toBe("auto");
    expect(normalizeSettings({ canvas: { layout: "grid" } } as never).canvas.layout).toBe("canvas");
    expect(normalizeSettings({ canvas: { portals: "inline" } } as never).canvas).toMatchObject({ portals: "inline", portalDepth: 1, layout: "canvas" });
  });
  test("styles.css carries the theme-aware preset classes", () => {
    const css = readFileSync(join(import.meta.dir, "../styles.css"), "utf8");
    expect(css).toContain(presetThemeCss());
  });
});
