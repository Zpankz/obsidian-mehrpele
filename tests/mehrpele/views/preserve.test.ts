import { describe, expect, test } from "bun:test";
import { canvasToMermaid, mermaidToCanvas } from "pele-render/canvas";
import { rewriteBlock } from "../../../src/materialise/rewrite";
import { parseViewDirective } from "../../../src/mehrpele/views/directive";
import { pruneNoteViews } from "../../../src/mehrpele/views/plugin-pure";

const VIEW = '%% pele-view A=localgraph depth=1; A=backlink; B=search query="tag:#x" %%';

describe("%% pele-view %% survives the block tools", () => {
  test("materialise rewrite keeps the line verbatim", () => {
    const src = `flowchart LR\n  A[x] --> B(y)\n${VIEW}`;
    const out = rewriteBlock(src, "flowchart", new Map([["A", "n/A"], ["B", "n/B"]]), { addDirective: false });
    expect(out.split("\n").pop()).toBe(VIEW);
    expect(parseViewDirective(out).views).toEqual(parseViewDirective(src).views);
  });

  test("canvas round trip keeps each node's views (under the ids after conversion)", () => {
    const src = `flowchart LR\n  A[Hub] --> B["[[Note]]"]\n${VIEW}\n`;
    const canvas = mermaidToCanvas(src, { mehrpele: true }).canvas;
    const back = canvasToMermaid(canvas, {}).source;
    expect(parseViewDirective(back).views).toEqual(parseViewDirective(src).views);
    // A card renamed on the canvas side keeps its views under its new id.
    const hub = canvas.nodes.find((n) => (n as { peleId?: string }).peleId === "A")!;
    delete (hub as { peleId?: string }).peleId;
    hub.text = "Projects hub";
    const renamed = canvasToMermaid({ ...canvas, metadata: {} }, {}).source;
    const views = parseViewDirective(renamed).views;
    expect(views.map((v) => `${v.node}=${v.spec.type}`)).toEqual(["projects_hub=localgraph", "projects_hub=backlink", "B=search"]);
  });

  test("Remove stale attached views: only entries of vanished nodes go", () => {
    const md = "# N\n\n```mermaid\nflowchart LR\n  A --> B\n%% pele-view A=outline; Gone=tag %%\n```\n\n```mermaid\nflowchart LR\n  X\n%% pele-view X=outline %%\n```\n";
    const plan = pruneNoteViews(md);
    expect(plan).toEqual([{ firstLine: 3, lastLine: 5, body: "flowchart LR\n  A --> B\n%% pele-view A=outline %%" }]);
  });
});
