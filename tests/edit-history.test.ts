import { describe, expect, test } from "bun:test";
import { applyPatch, EditHistory, makePatch } from "../src/edit-history";

const NOTE = "# Note\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\ntext after\n";
const COLOURED = NOTE.replace("  A --> B\n", "  A --> B\n  style A fill:#f00\n");
const WIDER = COLOURED.replace("```mermaid\n", "```mermaid width=400\n");

describe("patches", () => {
  test("undo and redo round-trip", () => {
    const p = makePatch(NOTE, COLOURED)!;
    expect(applyPatch(COLOURED, p, "undo")).toBe(NOTE);
    expect(applyPatch(NOTE, p, "redo")).toBe(COLOURED);
    expect(makePatch(NOTE, NOTE)).toBeNull();
  });
  test("an edit elsewhere in the note does not block undo", () => {
    const p = makePatch(NOTE, COLOURED)!;
    const later = `Intro added above\n\n${COLOURED}more at the end\n`;
    expect(applyPatch(later, p, "undo")).toBe(`Intro added above\n\n${NOTE}more at the end\n`);
  });
  test("a change to the same place refuses", () => {
    const p = makePatch(NOTE, COLOURED)!;
    expect(applyPatch(COLOURED.replace("fill:#f00", "fill:#0f0"), p, "undo")).toBeNull();
    expect(applyPatch(NOTE, p, "undo")).toBeNull(); // already undone
  });
  test("only a copy the note's growth can explain is used", () => {
    const p = makePatch("x\n", "y\n", 0)!;
    // Grew by 6 since: the span can only have moved 0..6 characters later.
    expect(applyPatch("a y\nb y\n", { ...p, at: 4 }, "undo")).toBe("a y\nb x\n");
    expect(applyPatch("y\n__y\n", { ...p, at: 0 }, "undo")).toBe("x\n__y\n");
    // Same length: nothing moved, a copy 2 characters away is not it.
    expect(applyPatch("_y\n", { ...p, at: 0, before: 3, after: 3 } as typeof p, "undo")).toBeNull();
  });
});

describe("history", () => {
  test("push, undo, redo in order; a new action drops redo", () => {
    const h = new EditHistory();
    h.record("a.md", NOTE, COLOURED, "colour");
    h.record("a.md", COLOURED, WIDER, "width");
    let r = h.undo("a.md", WIDER);
    expect(r && "text" in r && r.text).toBe(COLOURED);
    r = h.undo("a.md", COLOURED);
    expect(r && "text" in r && r.text).toBe(NOTE);
    expect(h.undo("a.md", NOTE)).toBeNull();
    r = h.redo("a.md", NOTE);
    expect(r && "text" in r && r.entry.label).toBe("colour");
    h.record("a.md", COLOURED, COLOURED.replace("B", "C"), "text");
    expect(h.peekRedo("a.md")).toBeNull();
  });
  test("a conflict refuses and drops that entry", () => {
    const h = new EditHistory();
    h.record("a.md", NOTE, COLOURED, "colour");
    const r = h.undo("a.md", COLOURED.replace("fill:#f00", "fill:#00f"));
    expect(r && "conflict" in r).toBe(true);
    expect(h.peekUndo("a.md")).toBeNull();
  });
  test("restore puts back an entry whose write did not happen", () => {
    const h = new EditHistory();
    h.record("a.md", NOTE, COLOURED, "colour");
    const r = h.undo("a.md", COLOURED);
    if (!r || !("text" in r)) throw new Error("expected text");
    h.restore(r, "undo");
    expect(h.peekUndo("a.md")?.label).toBe("colour");
    expect(h.peekRedo("a.md")).toBeNull();
  });
  test("capped per file", () => {
    const h = new EditHistory(3);
    let t = NOTE;
    for (let i = 0; i < 5; i++) {
      const n = t.replace("text after", `text after ${i}`);
      h.record("a.md", t, n, `e${i}`);
      t = n;
    }
    const labels: string[] = [];
    for (let r = h.undo("a.md", t); r && "text" in r; r = h.undo("a.md", t)) {
      labels.push(r.entry.label);
      t = r.text;
    }
    expect(labels).toEqual(["e4", "e3", "e2"]);
  });
  test("files are separate; rename moves, forget clears", () => {
    const h = new EditHistory();
    h.record("a.md", NOTE, COLOURED, "colour");
    h.record("b.md", NOTE, WIDER, "width");
    expect(h.peekUndo("a.md")?.label).toBe("colour");
    expect(h.peekUndo("b.md")?.label).toBe("width");
    h.rename("a.md", "c.md");
    expect(h.peekUndo("a.md")).toBeNull();
    expect(h.peekUndo("c.md")?.path).toBe("c.md");
    h.forget("b.md");
    expect(h.peekUndo("b.md")).toBeNull();
  });
});

describe("regressions: context and edges", () => {
  test("a block id added just after the fence (copy link) does not block undo of an edit near the block's end", () => {
    const p = makePatch(NOTE, COLOURED)!;
    const linked = COLOURED.replace("```\n\ntext after", "```\n^pele-ab12\n\ntext after");
    expect(applyPatch(linked, p, "undo")).toBe(NOTE.replace("```\n\ntext after", "```\n^pele-ab12\n\ntext after"));
  });
  test("typing just below the block does not block undo", () => {
    const p = makePatch(NOTE, COLOURED)!;
    expect(applyPatch(COLOURED.replace("text after", "text after, edited"), p, "undo")).toBe(NOTE.replace("text after", "text after, edited"));
  });
  test("a change on the edited lines themselves still refuses", () => {
    const p = makePatch(NOTE, COLOURED)!;
    expect(applyPatch(COLOURED.replace("  A --> B\n  style", "  A --> C\n  style"), p, "undo")).toBeNull();
  });
  test("edits at the very start and end of a file, and CRLF text", () => {
    const start = makePatch("abc\n", "Xabc\n")!;
    expect(applyPatch("Xabc\n", start, "undo")).toBe("abc\n");
    const end = makePatch("abc\n", "abc\nZ")!;
    expect(applyPatch("abc\nZ", end, "undo")).toBe("abc\n");
    const crlf = makePatch("a\r\nb\r\n", "a\r\nB\r\n")!;
    expect(applyPatch("a\r\nB\r\n", crlf, "undo")).toBe("a\r\nb\r\n");
  });
  test("the redo stack is capped too", () => {
    const h = new EditHistory(2);
    let text = "0";
    for (let i = 1; i <= 4; i++) {
      h.record("n.md", text, String(i), "x");
      text = String(i);
    }
    let undone = 0;
    for (let r = h.undo("n.md", text); r && "text" in r; r = h.undo("n.md", text)) {
      text = r.text;
      undone++;
    }
    expect(undone).toBe(2);
    expect(h.peekRedo("n.md")).not.toBeNull();
  });
});

describe("regressions: never another diagram's text", () => {
  const pad = "Intro paragraph text that is long enough to exceed sixty-four characters of context.\n\n";
  const d = (extra: string) => "```mermaid\nflowchart TD\n    A --> B\n    B --> C\n" + extra + "```\n";
  const before = pad + d("") + "\nSome text between the diagrams, long enough to push context away from one another.\n\n" + d("    style C fill:#f00\n");
  const after = before.replace("    B --> C\n```", "    B --> C\n    style C fill:#f00\n```");
  test("the edited place changed: refuses instead of undoing the same line in another diagram", () => {
    const p = makePatch(before, after)!;
    const edited = after.replace("    B --> C\n    style C fill:#f00\n```", "    B --> D\n    style C fill:#f00\n```");
    expect(applyPatch(edited, p, "undo")).toBeNull();
  });
  test("still found after text added above it", () => {
    const p = makePatch(before, after)!;
    expect(applyPatch("New first line\n" + after, p, "undo")).toBe("New first line\n" + before);
  });
});
