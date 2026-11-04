import { describe, expect, test } from "bun:test";
import {
  formatViewDirective,
  hasViewDirective,
  parseEntrySpec,
  parseViewDirective,
  pruneViewDirective,
  setViewDirective,
  tokenizeParams,
  viewsForNode,
} from "../../../src/mehrpele/views/directive";

const block = `flowchart LR
  A[Hub] --> B["[[Note]]"]
%% pele-size A=200x80 %%
%% pele-view A=localgraph depth=1; A=backlink; B=graph search="path:Projects tag:#x" %%`;

describe("%% pele-view %% directive", () => {
  test("parses entries in order, a node may repeat", () => {
    const { views, errors } = parseViewDirective(block);
    expect(errors).toEqual([]);
    expect(views.map((v) => `${v.node}:${v.spec.type}`)).toEqual(["A:localgraph", "A:backlink", "B:graph"]);
    expect(views[0]!.spec.params).toEqual({ depth: "1" });
    expect(views[2]!.spec.params).toEqual({ search: "path:Projects tag:#x" });
    expect(viewsForNode(block, "A").map((s) => s.type)).toEqual(["localgraph", "backlink"]);
    expect(hasViewDirective(block)).toBe(true);
    expect(hasViewDirective("flowchart LR\n A")).toBe(false);
  });

  test("label syntax, quoted values with escapes, JSON state, several lines", () => {
    const src = `graph TD
%% pele-view A=view:outline?file=N; B=search query="say \\"hi\\"; ok" %%
%% pele-view C=my-view state={"a":{"b":"x;y"}} flag %%`;
    const { views, errors } = parseViewDirective(src);
    expect(errors).toEqual([]);
    expect(views[0]!.spec).toEqual({ kind: "view", type: "outline", params: { file: "N" } });
    expect(views[1]!.spec.params.query).toBe('say "hi"; ok');
    expect(views[2]!.spec.state).toEqual({ a: { b: "x;y" } });
    expect(views[2]!.spec.params).toEqual({ flag: "true" });
  });

  test("bad entries are reported, good ones kept", () => {
    const { views, errors } = parseViewDirective("%% pele-view =graph; A; B=bad!type; C=outline; D=x state={no %%");
    expect(views.map((v) => v.node)).toEqual(["C"]);
    expect(errors.map((e) => e.entry)).toEqual(["=graph", "A", "B=bad!type", "D=x state={no"]);
  });

  test("tokenizer", () => {
    expect(tokenizeParams('a=1 b="x y" c={"k":[1,2]} d')).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "x y" },
      { key: "c", value: '{"k":[1,2]}' },
      { key: "d", value: "true" },
    ]);
    expect(parseEntrySpec("")).toEqual({ error: "missing view type" });
  });

  test("serialise round-trips (quotes only where needed)", () => {
    const { views } = parseViewDirective(block);
    const line = formatViewDirective(views);
    expect(line).toBe('%% pele-view A=localgraph depth=1; A=backlink; B=graph search="path:Projects tag:#x" %%');
    expect(parseViewDirective(line).views).toEqual(views);
    expect(formatViewDirective([])).toBe("");
    const tricky = parseViewDirective('%% pele-view A=search query="50%; \\\\ \\"q\\"" %%').views;
    expect(parseViewDirective(formatViewDirective(tricky)).views).toEqual(tricky);
  });

  test("set: replaces in place (merging several lines), appends when absent, removes when empty", () => {
    const two = "flowchart LR\n  A --> B\n  %% pele-view A=outline %%\n%% pele-view B=tag %%\n";
    const views = parseViewDirective(two).views;
    expect(setViewDirective(two, views)).toBe("flowchart LR\n  A --> B\n  %% pele-view A=outline; B=tag %%\n");
    expect(setViewDirective("flowchart LR\n  A --> B\n", views)).toBe("flowchart LR\n  A --> B\n%% pele-view A=outline; B=tag %%\n");
    expect(setViewDirective(two, [])).toBe("flowchart LR\n  A --> B\n");
    expect(setViewDirective("flowchart LR\n  A", [])).toBe("flowchart LR\n  A");
  });

  test("prune drops entries of vanished nodes only; other directives untouched", () => {
    const r = pruneViewDirective(block, new Set(["A"]));
    expect(r.removed).toEqual(["B"]);
    expect(r.source).toContain("%% pele-size A=200x80 %%");
    expect(r.source).toContain("%% pele-view A=localgraph depth=1; A=backlink %%");
    expect(pruneViewDirective(block, new Set(["A", "B"]))).toEqual({ source: block, removed: [] });
    // Unparsable entries: never rewrite (they would be lost).
    const bad = "x\n%% pele-view A=outline; ??? %%";
    expect(pruneViewDirective(bad, new Set()).source).toBe(bad);
  });
});
