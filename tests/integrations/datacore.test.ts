import { describe, expect, test } from "bun:test";
import { parse } from "pele";
import { createPeleComponent, type DcLike } from "../../src/integrations/datacore/component";
import { datacoreToGantt, datacoreToGraph } from "../../src/integrations/datacore/map";
import { unwrapDatacoreResult, type DatacorePageLike } from "../../src/integrations/detect";
import { flowchartFromGraph, ganttFromSpec } from "../../src/integrations/graph-to-pele";

// Fake pages shaped like MarkdownPage (datacore/src/index/types/markdown.ts:
// $path/$links/$tags; Link = {path, display} in expression/link.ts).
const pages: DatacorePageLike[] = [
  { $path: "Projects/Alpha.md", $name: "Alpha", $tags: ["#project"], $links: [{ path: "Projects/Beta.md" }, { path: "Outside.md" }] },
  { $path: "Projects/Beta.md", $name: "Beta", $tags: ["#project"], $links: [{ path: "Projects/Alpha" }] },
  {
    $path: "Tasks/Write.md",
    $name: "Write",
    $links: [],
    scheduled: "2026-02-01",
    due: "2026-02-05",
    status: "in-progress",
    project: "Projects/Alpha.md",
  },
  { $path: "Tasks/Undated.md", $name: "Undated", $links: [] },
];

describe("datacoreToGraph", () => {
  test("links only between matched pages; hrefs enable click-through", () => {
    const spec = datacoreToGraph(pages.slice(0, 2));
    expect(spec.nodes).toHaveLength(2);
    expect(spec.edges).toEqual([
      { from: "Projects/Alpha.md", to: "Projects/Beta.md", kind: "link" },
      { from: "Projects/Beta.md", to: "Projects/Alpha.md", kind: "link" },
    ]);
    const { source } = flowchartFromGraph(spec);
    expect(source).toContain('click Projects_Alpha "Projects/Alpha.md"');
    expect(parse(source).type).toBe("flowchart");
  });
});

describe("datacoreToGantt", () => {
  test("keeps dated pages only and maps status", () => {
    const spec = datacoreToGantt(pages);
    expect(spec.tasks).toHaveLength(1);
    expect(spec.tasks?.[0]).toMatchObject({ start: "2026-02-01", end: "2026-02-05", status: "active" });
    expect(parse(ganttFromSpec(spec).source).type).toBe("gantt");
  });

  test("stringifies non-string status fields (list, number)", () => {
    const dated = { $links: [], scheduled: "2026-02-01" };
    const spec = datacoreToGantt([
      { ...dated, $path: "Tasks/List.md", $name: "List", status: ["Done"] },
      { ...dated, $path: "Tasks/Num.md", $name: "Num", status: 2 },
    ]);
    expect(spec.tasks?.map((t) => t.status)).toEqual(["done", undefined]);
  });
});

describe("unwrapDatacoreResult + component", () => {
  test("unwraps Success/Failure without throwing (api/result.ts)", () => {
    expect(unwrapDatacoreResult({ successful: true, value: [1] })).toEqual({ ok: true, value: [1] });
    expect(unwrapDatacoreResult({ successful: false, error: "bad query" })).toEqual({ ok: false, error: "bad query" });
  });

  test("component(dc) mounts Pele into a ref via window.peleMermaid", () => {
    let mounted: { el: unknown; source: string } | null = null;
    let destroyed = false;
    const fakeDc: DcLike = {
      preact: { h: (type: unknown, props: unknown) => ({ type, props }) },
      useRef: (init: unknown) => ({ current: init }),
      useEffect: (fn: () => void | (() => void)) => {
        (globalThis as unknown as { __peleEffect?: unknown }).__peleEffect = fn;
      },
    };
    const api = {
      version: "0.1.0",
      mount: (el: HTMLElement, source: string) => {
        mounted = { el, source };
        return { destroy: () => (destroyed = true) };
      },
      render: () => ({}),
      component: () => () => null,
    };
    const Pele = createPeleComponent(fakeDc, api);
    const vnode = Pele({ source: "flowchart TD\n  A[\"Hi\"]" }) as { props: { ref: { current: unknown } } };
    // Simulate Preact assigning the DOM node, then run effects.
    vnode.props.ref.current = { tag: "DIV" };
    const cleanup = ((globalThis as unknown as { __peleEffect: () => () => void }).__peleEffect)();
    expect(mounted).not.toBeNull();
    expect(mounted!.source).toContain("flowchart");
    cleanup();
    expect(destroyed).toBe(true);
  });
});
