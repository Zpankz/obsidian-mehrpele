/**
 * Plugin load and unload through the real bundle:
 * - H2: at app start (layout not ready at onload) restored Reading views are
 *   not re-rendered and no global resize fires; enabled after app start they are.
 *   A Live Preview leaf never counts toward the resize in "reading" mode.
 * - H1: unload destroys frames still waiting in the suspended set; a revived
 *   frame leaves it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bundleMain } from "./helpers/bundle";
import { deep, obsidianStub } from "./helpers/obsidian-stub";

const DOM_GLOBALS = [
  "document",
  "window",
  "activeDocument",
  "activeWindow",
  "navigator",
  "getComputedStyle",
  "requestAnimationFrame",
  "IntersectionObserver",
  "ResizeObserver",
  "MutationObserver",
];
const saved = new Map<string, PropertyDescriptor | undefined>();
let code = "";

beforeAll(async () => {
  ({ code } = await bundleMain());
  for (const k of DOM_GLOBALS) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: deep(), configurable: true, writable: true });
  }
}, 60_000);

afterAll(() => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  delete (globalThis as { __peleData?: unknown }).__peleData;
});

/** An object whose listed members are real and every other member an inert proxy. */
function withDeep<T extends object>(own: T): T {
  return new Proxy(own, {
    get(t, k, r) {
      if (k in t || typeof k === "symbol" || k === "then") return Reflect.get(t, k, r);
      return deep();
    },
  });
}

const FENCE = "# Note\n\n```mermaid\ngraph TD\n  A --> B\n```\n";

function fakeLeaf(mode: "preview" | "source", counts: { rerender: number }) {
  const MarkdownView = obsidianStub.MarkdownView as { prototype: object };
  const view = Object.create(MarkdownView.prototype) as Record<string, unknown>;
  Object.assign(view, {
    editor: undefined,
    getViewData: () => FENCE,
    getMode: () => mode,
    previewMode: { rerender: () => void counts.rerender++ },
  });
  return withDeep({ view, isDeferred: false });
}

function fakeApp(opts: { layoutReady: boolean; leaves: unknown[] }) {
  const ready: (() => void)[] = [];
  const triggered: string[] = [];
  const workspace = withDeep({
    layoutReady: opts.layoutReady,
    onLayoutReady: (cb: () => void) => void ready.push(cb),
    getLeavesOfType: (t: string) => (t === "markdown" ? opts.leaves : []),
    iterateAllLeaves: () => undefined,
    trigger: (name: string) => void triggered.push(name),
    on: () => deep(),
  });
  return { app: withDeep({ workspace }), ready, triggered };
}

async function loadWith(app: unknown): Promise<any> {
  (globalThis as { __peleData?: unknown }).__peleData = null;
  const mod: { exports: any } = { exports: {} };
  const req = (id: string): unknown => {
    if (id === "obsidian") return obsidianStub;
    if (id.startsWith("@codemirror/") || id.startsWith("@lezer/") || id === "electron") return deep();
    return require(id);
  };
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  const Cls = mod.exports.default ?? mod.exports;
  const plugin = new Cls(app, { id: "mehrpele", version: "0.0.0", dir: ".obsidian/plugins/mehrpele" });
  await plugin.load();
  return plugin;
}

/** Run the layout-ready callbacks and let the refresh queue drain. */
async function layoutReady(ready: (() => void)[]): Promise<void> {
  for (const cb of ready.splice(0)) cb();
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("startup refresh (H2)", () => {
  test("app start: restored Reading views are not re-rendered, no resize", async () => {
    const counts = { rerender: 0 };
    const { app, ready, triggered } = fakeApp({ layoutReady: false, leaves: [fakeLeaf("preview", counts)] });
    const plugin = await loadWith(app);
    await layoutReady(ready);
    expect(counts.rerender).toBe(0);
    expect(triggered.filter((t) => t === "resize")).toEqual([]);
    plugin.unload();
  });

  test("enabled after app start: each open Reading view re-renders once, one resize", async () => {
    const counts = { rerender: 0 };
    const { app, ready, triggered } = fakeApp({ layoutReady: true, leaves: [fakeLeaf("preview", counts)] });
    const plugin = await loadWith(app);
    await layoutReady(ready);
    expect(counts.rerender).toBe(1);
    expect(triggered.filter((t) => t === "resize").length).toBe(1);
    plugin.unload();
  });

  test("after app start with only a Live Preview leaf: the Reading refresh fires no resize", async () => {
    const counts = { rerender: 0 };
    const { app, ready, triggered } = fakeApp({ layoutReady: true, leaves: [fakeLeaf("source", counts)] });
    const plugin = await loadWith(app);
    await layoutReady(ready);
    expect(counts.rerender).toBe(0);
    expect(triggered.filter((t) => t === "resize")).toEqual([]);
    plugin.unload();
  });
});

describe("unload (H1)", () => {
  test("unload destroys frames waiting in the suspended set", async () => {
    const { app } = fakeApp({ layoutReady: true, leaves: [] });
    const plugin = await loadWith(app);
    const frames = [0, 1].map(() => {
      const f = { destroyed: 0, destroy: () => void f.destroyed++, companionSurface: () => null };
      return f;
    });
    for (const f of frames) plugin.suspendFrame(f);
    expect(plugin.suspended.size).toBe(2);
    plugin.unload();
    expect(frames.map((f) => f.destroyed)).toEqual([1, 1]);
    expect(plugin.suspended.size).toBe(0);
  });

  test("a frame revived through registerFrame leaves the suspended set: its countdown is off", async () => {
    const { app } = fakeApp({ layoutReady: true, leaves: [] });
    const plugin = await loadWith(app);
    const f = { destroyed: 0, destroy: () => void f.destroyed++, root: deep(), refresh: () => undefined, companionSurface: () => null };
    plugin.suspendFrame(f);
    expect(plugin.suspended.has(f)).toBe(true);
    plugin.registerFrame(f);
    expect(plugin.suspended.has(f)).toBe(false);
    expect(plugin.frames.has(f)).toBe(true);
    // Unload destroys it once, as a live frame; a stale countdown would destroy it a second time.
    plugin.unload();
    expect(f.destroyed).toBe(1);
  });
});
