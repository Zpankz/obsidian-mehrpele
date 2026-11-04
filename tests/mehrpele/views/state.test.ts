import { describe, expect, test } from "bun:test";
import { buildViewState, graphOptionsFrom, isStateError, type StateContext } from "../../../src/mehrpele/views/state";
import { parseViewText, type ViewNodeSpec } from "../../../src/mehrpele/views/syntax";

const files: Record<string, string> = { Note: "Notes/Note.md", "Some Note": "Some Note.md", "Board.md": "Board.md" };
const ctx = (over: Partial<StateContext> = {}): StateContext => ({
  defaultFile: "This.md",
  resolveFile: (lp) => files[lp] ?? null,
  defaultDepth: 1,
  ...over,
});
const spec = (t: string) => parseViewText(t) as ViewNodeSpec;
const ok = (t: string, c = ctx()) => {
  const r = buildViewState(spec(t), c);
  if (isStateError(r)) throw new Error(r.error);
  return r;
};

describe("view state per type", () => {
  test("local graph: depth, link directions, closed controls, default note", () => {
    const r = ok("view:localgraph?depth=3&incoming=0&neighbors=1&tags");
    expect(r.file).toBe("This.md");
    expect(r.state.file).toBe("This.md");
    expect(r.state.options).toEqual({
      showTags: true,
      "collapse-filter": true,
      localJumps: 3,
      localBacklinks: false,
      localInterlinks: true,
    });
    expect(ok("view:localgraph?depth=99").graphOptions!.localJumps).toBe(5);
    expect(ok("view:localgraph", ctx({ defaultDepth: 2 })).graphOptions!.localJumps).toBe(2);
  });

  test("local graph of a named note; missing note is an error", () => {
    expect(ok("view:localgraph?file=Note").file).toBe("Notes/Note.md");
    expect(ok("view:localgraph?file=[[Some Note]]").file).toBe("Some Note.md");
    expect(buildViewState(spec("view:localgraph?file=Nope"), ctx())).toEqual({ error: "Note not found: Nope" });
    expect(buildViewState(spec("view:backlink"), ctx({ defaultFile: null }))).toEqual({ error: "Backlinks needs a note (file=…)" });
  });

  test("global graph: options for the engine, never in view state; no note", () => {
    const r = ok("view:graph?search=path:Projects tag:#x&orphans=0&unresolved=1&controls");
    expect(r.file).toBeNull();
    expect(r.state).toEqual({});
    expect(r.graphOptions).toEqual({ search: "path:Projects tag:#x", showOrphans: false, hideUnresolved: false, "collapse-filter": false });
    expect(ok('view:graph?state={"options":{"textFadeMultiplier":1}}').graphOptions!.textFadeMultiplier).toBe(1);
  });

  test("backlinks, outline, search, tags, explorer, bookmarks, properties, web viewer", () => {
    expect(ok("view:backlink?file=Note&unlinked&context=1&search=foo").state).toEqual({
      file: "Notes/Note.md",
      unlinkedCollapsed: false,
      extraContext: true,
      showSearch: true,
      searchQuery: "foo",
    });
    expect(ok("view:outline").state).toEqual({ file: "This.md" });
    expect(ok("view:search?query=tag:#task&case=1").state).toEqual({ query: "tag:#task", matchingCase: true });
    expect(ok("view:search?q=x").state).toEqual({ query: "x" });
    expect(ok("view:tags?hierarchy=0&sort=alphabetical").state).toEqual({ useHierarchy: false, sortOrder: "alphabetical" });
    expect(ok("view:files").type).toBe("file-explorer");
    expect(ok("view:bookmarks?search=x").state).toEqual({ showSearch: true, searchQuery: "x" });
    expect(ok("view:properties").state).toEqual({ file: "This.md" });
    expect(ok("view:web?url=https://e.org").state).toEqual({ url: "https://e.org", navigate: true });
    expect(ok("view:web").core!.desktopOnly).toBe(true);
  });

  test("community views: file= becomes state.file, state= passes through and wins", () => {
    const r = ok('view:kanban?file=Board.md&state={"view":"list"}');
    expect(r.core).toBeNull();
    expect(r.title).toBe("kanban");
    expect(r.state).toEqual({ file: "Board.md", view: "list" });
    expect(ok("view:bc-tree-view").state).toEqual({});
    expect(ok("view:bc-tree-view").file).toBeNull();
  });

  test("state= is checked before it reaches setState", () => {
    // state.file resolves like file= and binds the leaf to the same note.
    const f = ok('view:outline?state={"file":"Some Note"}');
    expect(f.state.file).toBe("Some Note.md");
    expect(f.file).toBe("Some Note.md");
    expect(buildViewState(spec('view:outline?state={"file":"Other.md"}'), ctx())).toEqual({ error: "Note not found: Other.md" });
    expect(buildViewState(spec('view:kanban?state={"file":3}'), ctx())).toEqual({ error: "state.file must be a note name" });
    // A non-string url would skip the web viewer's block check.
    expect(buildViewState(spec('view:web?state={"url":{"href":"https://e.org"}}'), ctx())).toEqual({ error: "state.url must be a string" });
    expect(ok('view:web?state={"url":"https://e.org"}').state.url).toBe("https://e.org");
    // Graph options must be an object.
    expect(buildViewState(spec('view:graph?state={"options":"x"}'), ctx())).toEqual({ error: "state.options must be an object" });
  });

  test("graph option helper alone", () => {
    expect(graphOptionsFrom({ filter: "a" }, false, 1)).toEqual({ search: "a", "collapse-filter": true });
  });
});
