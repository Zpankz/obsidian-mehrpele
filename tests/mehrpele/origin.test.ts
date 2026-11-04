import { describe, expect, test } from "bun:test";
import {
  embedOrigin,
  inlineOrigin,
  ORIGIN_IGNORE,
  ORIGIN_ROOT_CLASS,
  originGesture,
  originLinktext,
  originTooltip,
  portalNodeId,
} from "../../src/mehrpele/origin";

describe("nested diagram origins", () => {
  test("embeds keep linkpath + subpath; canvases are portals", () => {
    expect(embedOrigin({ linkpath: "Diagrams", subpath: "#Sequence" }, "Notes/A.md")).toEqual({
      kind: "embed",
      linkpath: "Diagrams",
      subpath: "#Sequence",
      sourcePath: "Notes/A.md",
    });
    expect(embedOrigin({ linkpath: "Board.canvas", subpath: "#n1" }, "A.md").kind).toBe("portal");
    expect(embedOrigin({ linkpath: "flow.mmd", subpath: "" }, "A.md").kind).toBe("embed");
  });

  test("inline fences point at the outer block, or inherit a nested parent's origin", () => {
    expect(inlineOrigin(undefined, "A.md", 18)).toEqual({ kind: "inline", sourcePath: "A.md", line: 18 });
    expect(inlineOrigin(undefined, "A.md")).toEqual({ kind: "inline", sourcePath: "A.md" });
    const parent = embedOrigin({ linkpath: "Diagrams", subpath: "#Sequence" }, "A.md");
    expect(inlineOrigin(parent, "A.md", 3)).toBe(parent);
  });

  test("link text, node ids and tooltips", () => {
    expect(originLinktext(embedOrigin({ linkpath: "Diagrams", subpath: "#^blk" }, "A.md"))).toBe("Diagrams#^blk");
    expect(originLinktext({ kind: "inline", sourcePath: "dir/A.md", line: 4 })).toBe("dir/A.md");
    expect(portalNodeId(embedOrigin({ linkpath: "B.canvas", subpath: "#far-node" }, "A.md"))).toBe("far-node");
    expect(portalNodeId(embedOrigin({ linkpath: "B.canvas", subpath: "" }, "A.md"))).toBeNull();
    expect(portalNodeId(embedOrigin({ linkpath: "Note", subpath: "#H" }, "A.md"))).toBeNull();
    expect(originTooltip(embedOrigin({ linkpath: "dir/Diagrams", subpath: "#Sequence" }, "A.md"))).toBe(
      "Open Diagrams#Sequence",
    );
    expect(originTooltip({ kind: "inline", sourcePath: "A.md" })).toBe("Reveal block in editor");
  });
});

interface FakeNode {
  classes: string[];
}

/** Minimal element: `closest` answers from a fixed ancestor chain (`<tag>` stands for a tag). */
function el(chain: (string[] | FakeNode)[]): { closest(sel: string): unknown } {
  const nodes = chain.map((c) => (Array.isArray(c) ? { classes: c } : c));
  return {
    closest(sel: string) {
      const wanted = sel.split(",").map((s) => s.trim());
      return (
        nodes.find((n) =>
          wanted.some((w) => (w.startsWith(".") ? n.classes.includes(w.slice(1)) : n.classes.includes(`<${w}>`))),
        ) ?? null
      );
    },
  };
}

describe("open-original gesture", () => {
  const rootClasses = ["pele-embed", "pele-nested", ORIGIN_ROOT_CLASS];
  const root: FakeNode = { classes: rootClasses };
  // target (svg background) → nested root → outer frame
  const bg = el([["<svg>"], root, ["pele-embed"]]);
  const click = (over: Partial<{ type: string; button: number; target: unknown; clientX: number; clientY: number }> = {}) => ({
    type: "click",
    button: 0,
    target: bg,
    clientX: 10,
    clientY: 10,
    ...over,
  });
  const ctx = (over: Partial<Parameters<typeof originGesture>[1]> = {}) => ({
    pane: false as const,
    root,
    pressedAt: { x: 10, y: 10 },
    resizing: false,
    ...over,
  });

  test("Mod-click picks the pane from Keymap.isModEvent; middle-click opens a tab", () => {
    expect(originGesture(click(), ctx({ pane: "tab" }))).toBe("tab");
    expect(originGesture(click(), ctx({ pane: "split" }))).toBe("split");
    expect(originGesture(click({ type: "auxclick", button: 1 }), ctx())).toBe("tab");
  });

  test("plain, right and double clicks never navigate", () => {
    expect(originGesture(click(), ctx())).toBeNull();
    expect(originGesture(click({ type: "auxclick", button: 2 }), ctx({ pane: "tab" }))).toBeNull();
    expect(originGesture(click({ type: "dblclick" }), ctx({ pane: "tab" }))).toBeNull();
  });

  test("drags and resizes never navigate", () => {
    expect(originGesture(click({ clientX: 60 }), ctx({ pane: "tab" }))).toBeNull();
    expect(originGesture(click({ clientX: 13 }), ctx({ pane: "tab" }))).toBe("tab");
    expect(originGesture(click(), ctx({ pane: "tab", resizing: true }))).toBeNull();
  });

  test("links, handles, our chrome and deeper nested frames keep their own clicks", () => {
    for (const sel of ORIGIN_IGNORE.split(",").map((s) => s.trim())) {
      const cls = sel.startsWith(".") ? sel.slice(1) : `<${sel}>`;
      const target = el([[cls], root, ["pele-embed"]]);
      expect(originGesture(click({ target }), ctx({ pane: "tab" }))).toBeNull();
    }
    const deeper = el([["<svg>"], ["pele-nested", ORIGIN_ROOT_CLASS], root]);
    expect(originGesture(click({ target: deeper }), ctx({ pane: "tab" }))).toBeNull();
    expect(originGesture(click({ target: null }), ctx({ pane: "tab" }))).toBeNull();
  });
});
