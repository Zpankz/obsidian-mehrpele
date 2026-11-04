/**
 * Live Preview refresh after an integration toggle: Obsidian's code-block
 * widget caches the DOM of its last render (the off hint or the output), so
 * the toggled languages' caches are dropped before the in-place redraw.
 * Other toggles leave integration widgets alone.
 */
import { describe, expect, mock, test } from "bun:test";
import { obsidianStub } from "./helpers/obsidian-stub";

mock.module("obsidian", () => obsidianStub);

const { refreshLeaves } = await import("../src/refresh-leaves");
const { LpTakeover } = await import("../src/lp-patch");

const NOTE = "# Note\n\n```pele-breadcrumbs\nnode: here\n```\n";

function fakeApp(
  lp: { isPatched: boolean; clearStaleWidgetCaches(cm: unknown, force?: ReadonlySet<string>): number } | null,
  mode: "source" | "preview" = "source",
) {
  const counts = { redraws: 0, rebuilds: 0, rerenders: 0 };
  const cm = {
    state: { doc: { toString: () => NOTE } },
    scrollDOM: { scrollTop: 0, scrollLeft: 0 },
    setState: () => void counts.redraws++,
    requestMeasure: () => undefined,
    dom: { querySelectorAll: () => [], querySelector: () => null },
  };
  const MarkdownView = obsidianStub.MarkdownView as { prototype: object };
  const view = Object.assign(Object.create(MarkdownView.prototype), {
    editor: { cm },
    getMode: () => mode,
    previewMode: { rerender: () => void counts.rerenders++ },
  });
  const leaf = { view, rebuildView: async () => void counts.rebuilds++ };
  const app = {
    workspace: { getLeavesOfType: () => [leaf], trigger: () => undefined },
    plugins: { plugins: { mehrpele: { lp, settings: {} } } },
  };
  return { app: app as never, counts };
}

describe("refreshLeaves with toggled integration languages", () => {
  test("drops the toggled languages' widget caches, then redraws in place", async () => {
    const forced: string[][] = [];
    const lp = { isPatched: true, clearStaleWidgetCaches: (_cm: unknown, f?: ReadonlySet<string>) => (forced.push([...(f ?? [])]), 1) };
    const { app, counts } = fakeApp(lp);
    await refreshLeaves(app, "reading+live", ["pele-breadcrumbs"]);
    expect(forced).toEqual([["pele-breadcrumbs"]]);
    // The hidden Reading view re-renders too, so a mode switch shows the new state.
    expect(counts).toEqual({ redraws: 1, rebuilds: 0, rerenders: 1 });
  });

  test("in Reading view the hidden editor's toggled widgets are dropped and redrawn too", async () => {
    const forced: string[][] = [];
    const lp = { isPatched: true, clearStaleWidgetCaches: (_cm: unknown, f?: ReadonlySet<string>) => (forced.push([...(f ?? [])]), 1) };
    const { app, counts } = fakeApp(lp, "preview");
    await refreshLeaves(app, "reading+live", ["pele-breadcrumbs"]);
    expect(forced).toEqual([["pele-breadcrumbs"]]);
    expect(counts).toEqual({ redraws: 1, rebuilds: 0, rerenders: 1 });
  });

  test("an unrelated refresh forces nothing, in either mode", async () => {
    const forced: string[][] = [];
    const lp = { isPatched: true, clearStaleWidgetCaches: (_cm: unknown, f?: ReadonlySet<string>) => (forced.push([...(f ?? [])]), 0) };
    const { app, counts } = fakeApp(lp);
    await refreshLeaves(app, "reading+live");
    expect(forced).toEqual([[]]);
    expect(counts).toEqual({ redraws: 1, rebuilds: 0, rerenders: 0 });
    const reading = fakeApp(lp, "preview");
    await refreshLeaves(reading.app, "reading+live");
    expect(forced).toEqual([[]]);
    expect(reading.counts).toEqual({ redraws: 0, rebuilds: 0, rerenders: 1 });
  });

  test("without the LP patch the caches can't be dropped: the leaf is rebuilt", async () => {
    const { app, counts } = fakeApp(null);
    await refreshLeaves(app, "reading+live", ["pele-breadcrumbs"]);
    expect(counts.rebuilds).toBe(1);
  });
});

describe("LpTakeover.clearStaleWidgetCaches", () => {
  function setup() {
    class Widget {}
    const take = new LpTakeover({ isOverrideOn: () => true } as never);
    (take as unknown as { patchedProto: object }).patchedProto = Widget.prototype;
    const built = { querySelector: () => ({}) }; // rendered content (has a .pele-embed / output)
    const make = (lang: string) => Object.assign(Object.create(Widget.prototype), { lang, containerEl: built });
    const widgets = [make("pele-breadcrumbs"), make("pele-tasks"), make("pele")];
    const deco = {
      iter() {
        let i = 0;
        return {
          get value() {
            return i < widgets.length ? { spec: { widget: widgets[i] } } : null;
          },
          next: () => void i++,
        };
      },
    };
    const view = { state: { facet: () => [deco] } } as never;
    return { take, widgets, view, built };
  }

  test("forced languages are reset whatever they show; others keep their cache", () => {
    const { take, widgets, view, built } = setup();
    expect(take.clearStaleWidgetCaches(view, new Set(["pele-breadcrumbs"]))).toBe(1);
    expect(widgets.map((w) => w.containerEl)).toEqual([undefined, built, built]);
  });

  test("no forced languages: rendered widgets keep their cache", () => {
    const { take, widgets, view } = setup();
    expect(take.clearStaleWidgetCaches(view)).toBe(0);
    expect(widgets.every((w) => w.containerEl)).toBe(true);
  });
});
