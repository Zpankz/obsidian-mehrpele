import { describe, expect, test } from "bun:test";
import {
  GROUPS,
  ITEMS,
  groupsFor,
  baseSubs,
  baseViewOf,
  calloutOf,
  combineLabel,
  editsAfter,
  embedOf,
  filteredGraphOf,
  folderEmbedOf,
  isPlaceholder,
  localGraphOf,
  placementOf,
  tableOf,
  viewOf,
  webEmbedOf,
  wikilinkOf,
  MERMAID_STUB,
} from "../../src/edit/embed-insert/catalog";
import { placePopover } from "../../src/edit/embed-insert/place";
import { applyEdit, type EditContext } from "../../src/edit/ops";
import { parseNodeViewTarget } from "../../src/mehrpele/views/syntax";
import { parseSoleEmbed } from "../../src/mehrpele/model";
import { parseSoleDiagramFence } from "../../src/mehrpele/nested";

describe("insert-embed catalogue", () => {
  test("three groups in layout order; every item has an icon and a label", () => {
    expect(GROUPS.map((g) => g.id)).toEqual(["views", "content", "media"]);
    expect(ITEMS.map((i) => i.id)).toEqual(["graph", "canvas", "base", "folder", "callout", "table", "latex", "mermaid", "webpage", "pdf", "image", "wikilink"]);
    for (const i of ITEMS) expect(i.icon && i.label).toBeTruthy();
  });

  test("base subtypes follow the installed Bases view types", () => {
    const subs = baseSubs([{ type: "table", name: "Table" }, { type: "cards", name: "Cards" }, { type: "base-graph", name: "Graph" }, { type: "tasknotesKanban", name: "TaskNotes Kanban" }]);
    expect(subs.map((s) => s.id)).toEqual(["any", "table", "cards", "base-graph"]);
    expect(baseSubs([{ type: "kanban", name: "Kanban" }]).map((s) => s.id)).toEqual(["any", "kanban"]);
  });

  test("builders produce syntax the renderers read back", () => {
    expect(embedOf("Boards/Plan.canvas")).toBe("![[Boards/Plan.canvas]]");
    expect(wikilinkOf("Projects/Hub")).toBe("[[Projects/Hub]]");
    expect(webEmbedOf("example.com/docs")).toBe("![[https://example.com/docs]]");
    expect(webEmbedOf("http://e.org/a|b")).toBe("![](<http://e.org/a|b>)");
    expect(webEmbedOf("https://x.com/a>b|c")).toBe("![](<https://x.com/a%3Eb|c>)");
    expect(webEmbedOf("https://x.com/a b")).toBe("![[https://x.com/a%20b]]");
    expect(webEmbedOf("obsidian://open?x")).toBeNull();
    expect(webEmbedOf("javascript:alert(1)")).toBeNull();
    expect(webEmbedOf("")).toBeNull();
    expect(localGraphOf(9)).toBe("![[view:localgraph?depth=5]]");
    const g = filteredGraphOf("path:Projects tag:#x & y");
    expect(g).toBe("![[view:graph?search=path:Projects tag:#x %26 y]]");
    const spec = parseNodeViewTarget(parseSoleEmbed(g)!);
    expect(spec).toMatchObject({ kind: "view", type: "graph", params: { search: "path:Projects tag:#x & y" } });
    expect(viewOf("kanban", { file: "Board.md" })).toBe("![[view:kanban?file=Board.md]]");
    expect(baseViewOf("Tasks.base", "Kanban")).toBe("![[Tasks.base#Kanban]]");
    expect(parseNodeViewTarget(parseSoleEmbed(folderEmbedOf("Projects", true))!)).toEqual({ kind: "folder", folder: { path: "Projects", recursive: true, view: "table" } });
    expect(calloutOf("warning")).toBe("> [!warning] Warning\n> Text");
    expect(tableOf(3, 2).split("\n")).toEqual(["| Column 1 | Column 2 | Column 3 |", "| --- | --- | --- |", "|   |   |   |", "|   |   |   |"]);
    expect(parseSoleDiagramFence(MERMAID_STUB)?.lang).toBe("mermaid");
  });

  test("embeds replace the label; content joins it (placeholders are replaced)", () => {
    expect(placementOf("pdf")).toBe("replace");
    expect(placementOf("callout")).toBe("block");
    expect(placementOf("latex")).toBe("inline");
    expect(combineLabel("Reading list", "![[x.pdf]]", "replace")).toBe("![[x.pdf]]");
    expect(combineLabel("Reading list", "> [!note] Note\n> Text", "block")).toBe("Reading list\n\n> [!note] Note\n> Text");
    expect(combineLabel("Energy", "$x^2$", "inline")).toBe("Energy $x^2$");
    expect(combineLabel("New", "$x^2$", "inline")).toBe("$x^2$");
    expect(combineLabel("N1", "[[Hub]]", "inline", "N1")).toBe("[[Hub]]");
    expect(isPlaceholder("  ")).toBe(true);
    expect(editsAfter("table")).toBe(true);
    expect(editsAfter("canvas")).toBe(false);
  });

  test("one edit, switching the block to Mehrpele when it needs Markdown", () => {
    const ctx: EditContext = { source: "flowchart LR\n  A[Reading list] --> B", type: "flowchart", markdownBlock: false, canSwitch: true };
    const r = applyEdit(ctx, { kind: "node", id: "A" }, { op: "text", text: combineLabel("Reading list", "![[paper.pdf#page=3]]", "replace") });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.switched).toBe(true);
      expect(r.source).toContain('A["![[paper.pdf#page=3]]"]');
    }
    const t = applyEdit({ ...ctx, markdownBlock: true }, { kind: "node", id: "A" }, { op: "text", text: combineLabel("Reading list", tableOf(), "block") });
    expect(t.ok && t.source).toContain('A["Reading list\n\n| Column 1 | Column 2 |');
  });

  test("popover placement: never over the node, inside the window", () => {
    const node = { left: 400, top: 300, width: 200, height: 120 };
    const menuAbove = { left: 470, top: 250, width: 36, height: 30 };
    const p = placePopover(menuAbove, { width: 260, height: 200 }, node, 1400, 900);
    expect(p.top + 200).toBeLessThanOrEqual(250);
    // No room above: beside the node, not over it.
    const cramped = placePopover({ left: 470, top: 20, width: 36, height: 30 }, { width: 260, height: 400 }, { left: 400, top: 60, width: 200, height: 500 }, 1400, 900);
    const box = { ...cramped, width: 260, height: 400 };
    const overlaps = box.left < 600 && box.left + 260 > 400 && box.top < 560 && box.top + 400 > 60;
    expect(overlaps).toBe(false);
  });
});

describe("insert groups (U1: one toolbar button per group)", () => {
  test("each group has its own button icon and tooltip", () => {
    expect(GROUPS.map((g) => [g.id, g.icon, g.button])).toEqual([
      ["views", "app-window", "Insert view"],
      ["content", "pilcrow", "Insert content"],
      ["media", "paperclip", "Insert media or link"],
    ]);
  });
  test("a group's flyout holds only that group's items, in catalogue order", () => {
    const one = groupsFor("content");
    expect(one.map((g) => g.id)).toEqual(["content"]);
    expect(one[0]!.items.map((i) => i.id)).toEqual(["callout", "table", "latex", "mermaid"]);
    expect(groupsFor("views")[0]!.items.map((i) => i.id)).toEqual(["graph", "canvas", "base", "folder"]);
    expect(groupsFor("media")[0]!.items.map((i) => i.id)).toEqual(["webpage", "pdf", "image", "wikilink"]);
  });
  test("no group: every group, every item once", () => {
    const all = groupsFor();
    expect(all.map((g) => g.id)).toEqual(["views", "content", "media"]);
    expect(all.flatMap((g) => g.items).length).toBe(ITEMS.length);
  });
});
