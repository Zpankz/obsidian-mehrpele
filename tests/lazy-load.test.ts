/**
 * Module-init spy: build main.ts with a marker at the top of every source
 * module, run the bundle against a stub `obsidian`, construct the plugin and
 * await onload. With every feature off, no feature module body may have run;
 * with every feature on, the registry loads them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bundleMain, isFeatureCode } from "./helpers/bundle";
import { Component, deep, Notice, obsidianStub } from "./helpers/obsidian-stub";
import { defaultSettingsV3, setEnabledV3, TOGGLE_IDS } from "../src/settings/schema";

type G = typeof globalThis & {
  __peleInit?: string[];
  __peleData?: unknown;
};
const g = globalThis as G;

let code = "";
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
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

beforeAll(async () => {
  ({ code } = await bundleMain({ spy: true }));
  for (const k of DOM_GLOBALS) {
    savedGlobals.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: deep(), configurable: true, writable: true });
  }
}, 60_000);

afterAll(() => {
  for (const [k, d] of savedGlobals) {
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  delete g.__peleInit;
  delete g.__peleData;
});

/** Stored v3 settings with every toggle on or off. */
function v3With(on: boolean): unknown {
  const s = defaultSettingsV3();
  for (const id of TOGGLE_IDS) setEnabledV3(s, id, on);
  return s;
}

/**
 * Evaluate the bundle (as Obsidian does), construct the plugin and run its
 * load. `data` is what loadData returns (null: a fresh install).
 */
async function loadPlugin(data: unknown, app: unknown = deep()): Promise<{ ran: string[]; plugin: any }> {
  g.__peleInit = [];
  Component.domEvents.length = 0;
  Component.events.length = 0;
  g.__peleData = data;
  const mod: { exports: any } = { exports: {} };
  const req = (id: string): unknown => {
    if (id === "obsidian") return obsidianStub;
    if (id.startsWith("@codemirror/") || id.startsWith("@lezer/")) return deep();
    if (id === "electron") return deep();
    return require(id);
  };
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  const Cls = mod.exports.default ?? mod.exports;
  const plugin = new Cls(app, { id: "mehrpele", version: "0.0.0", dir: ".obsidian/plugins/mehrpele" });
  await plugin.load();
  return { ran: [...g.__peleInit], plugin };
}

const INTEGRATION_LANGS = ["pele-datacore", "pele-breadcrumbs", "pele-tasks"];

/** Registrations per integration language (a second one would be a leak: there is no unregister). */
function processorCount(plugin: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const lang of INTEGRATION_LANGS) {
    out[lang] = plugin.calls.filter(([m, a]: [string, unknown]) => m === "registerMarkdownCodeBlockProcessor" && a === lang).length;
  }
  return out;
}

function expectNoFeatureRan(ran: string[], plugin: any): void {
  expect(ran).toContain("main.ts");
  expect(ran.filter(isFeatureCode)).toEqual([]);
  expect(plugin.features.active()).toEqual([]);
  // No Bases view, no CLI handlers.
  const registered = plugin.calls.map(([m, a]: [string, unknown]) => `${m}:${String(a)}`);
  expect(registered.filter((r: string) => /registerBasesView|registerCliHandler/.test(r))).toEqual([]);
  // The integration code blocks are core shims (once each, inert while off).
  expect(processorCount(plugin)).toEqual({ "pele-datacore": 1, "pele-breadcrumbs": 1, "pele-tasks": 1 });
  for (const id of ["mehrpele:repair-diagram-under-cursor", "mehrpele:convert-diagram-to-canvas"]) expect(plugin.commands.has(id)).toBe(false);
  expect(Component.domEvents).not.toContain("pointermove");
}

describe("lazy load (module-init spy)", () => {
  test("fresh install (v3 defaults): plugin load runs no feature module", async () => {
    const { ran, plugin } = await loadPlugin(null);
    expectNoFeatureRan(ran, plugin);
    plugin.unload();
  });

  test("all features off: plugin load runs no feature module", async () => {
    const { ran, plugin } = await loadPlugin(v3With(false));
    expectNoFeatureRan(ran, plugin);
    plugin.unload();
  });

  test("all features on: the registry loads and registers them (spy control)", async () => {
    const { ran, plugin } = await loadPlugin(v3With(true));
    expect(ran).toContain("src/mehrpele/views/plugin.ts");
    expect(ran).toContain("src/integrations/datacore/index.ts");
    expect(plugin.features.active().length).toBeGreaterThan(5);
    expect(plugin.commands.has("mehrpele:repair-diagram-under-cursor")).toBe(true);
    expect(plugin.features.active()).toContain("view-nodes");
    expect(Component.domEvents).toContain("pointermove");
    expect(plugin.calls.some(([m]: [string]) => m === "registerBasesView")).toBe(true);
    // Toggle off (v3, as the settings tab writes): a runtime-removable
    // feature's commands go away without a reload.
    const s = plugin.settings;
    s.features.repair.enabled = s.features.repair.jev.enabled = s.features.repair.llm = false;
    s.features["view-nodes"].enabled = false;
    // Through saveData: settings sections that save directly still sync features.
    await plugin.saveData(s);
    expect(plugin.commands.has("mehrpele:repair-diagram-under-cursor")).toBe(false);
    expect(plugin.features.active()).not.toContain("repair");
    expect(plugin.features.active()).not.toContain("view-nodes");
    expect(Component.domEvents).not.toContain("pointermove");
    // A reload-needed feature stays until reload, with a notice.
    Notice.shown.length = 0;
    s.features.cli.enabled = false;
    await plugin.saveSettings();
    expect(plugin.features.active()).toContain("cli");
    expect([...plugin.features.pendingReload]).toEqual(["cli"]);
    expect(Notice.shown.some((m) => m.includes("reload"))).toBe(true);
    plugin.unload();
  });

  test("excalidraw: off removes its commands and on restores them, no reload", async () => {
    const { ran, plugin } = await loadPlugin(v3With(true));
    const CMDS = ["mehrpele:convert-diagram-to-excalidraw", "mehrpele:insert-diagram-into-excalidraw"];
    expect(ran).toContain("src/excalidraw/converter.ts");
    for (const id of CMDS) expect(plugin.commands.has(id)).toBe(true);
    expect(plugin.excalidraw).not.toBeNull();
    expect(plugin.calls.some(([m, a]: [string, unknown]) => m === "registerCliHandler" && a === "pele:excalidraw")).toBe(true);
    const s = plugin.settings;
    s.features.excalidraw.enabled = false;
    await plugin.saveSettings();
    for (const id of CMDS) expect(plugin.commands.has(id)).toBe(false);
    expect(plugin.features.active()).not.toContain("excalidraw");
    expect(plugin.excalidraw).toBeNull();
    expect([...plugin.features.pendingReload]).not.toContain("excalidraw");
    // The CLI handler stays registered (cli feature) and checks the toggle when called.
    const cli = plugin.cliHandlers.get("pele:excalidraw")!;
    await expect(cli({ path: "a.md" })).rejects.toThrow("Excalidraw conversion is off");
    s.features.excalidraw.enabled = true;
    await plugin.saveSettings();
    for (const id of CMDS) expect(plugin.commands.has(id)).toBe(true);
    expect(plugin.excalidraw).not.toBeNull();
    plugin.unload();
  });

  test("excalidraw stands down while the retired pele-excalidraw plugin is enabled", async () => {
    // An inert app, except for a plugins registry listing the old plugin as installed and enabled.
    const inert = deep();
    const registry = { enabledPlugins: new Set(["pele-excalidraw"]), manifests: { "pele-excalidraw": {} }, plugins: {} };
    const app = new Proxy(inert, { get: (t, k) => (k === "plugins" ? registry : t[k]) });
    Notice.shown.length = 0;
    const { plugin } = await loadPlugin(v3With(true), app);
    expect(plugin.excalidrawStandsDown()).toBe(true);
    expect(Notice.shown.filter((m) => m.includes("Disable the retired Excalidraw conversion plugin"))).toHaveLength(1);
    // The CLI handler is left to the old plugin.
    expect(plugin.calls.some(([m, a]: [string, unknown]) => m === "registerCliHandler" && a === "pele:excalidraw")).toBe(false);
    const cmd = plugin.commands.get("mehrpele:convert-diagram-to-excalidraw");
    // Hidden from the palette while standing down.
    expect(cmd?.editorCheckCallback?.(true, deep(), deep()) ?? false).toBe(false);
    plugin.unload();
  });
});

/** Nothing a feature registered lingers after off, and on again registers it once. */
describe("toggle on → off → on", () => {
  /** Swap a DOM global for this test (the shared ones are inert proxies that drop writes). */
  function withGlobal(name: string, value: unknown): () => void {
    const prev = Object.getOwnPropertyDescriptor(globalThis, name)!;
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    return () => Object.defineProperty(globalThis, name, prev);
  }

  async function toggle(plugin: any, set: (s: any) => void): Promise<void> {
    set(plugin.settings);
    await plugin.saveSettings();
  }

  test("commands: off removes every feature command, on restores the same set", async () => {
    const { plugin } = await loadPlugin(v3With(true));
    const on = [...plugin.commands.keys()].sort();
    const off = (s: any) => {
      s.features.repair.enabled = s.features.repair.jev.enabled = s.features.repair.llm = false;
      s.features.canvas.enabled = s.features.materialise.enabled = s.features.excalidraw.enabled = false;
    };
    const back = (s: any) => {
      s.features.repair.enabled = s.features.canvas.enabled = s.features.materialise.enabled = s.features.excalidraw.enabled = true;
    };
    await toggle(plugin, off);
    const offKeys = [...plugin.commands.keys()].sort();
    expect(offKeys.length).toBeLessThan(on.length);
    expect(offKeys).not.toContain("mehrpele:repair-diagram-under-cursor");
    await toggle(plugin, back);
    expect([...plugin.commands.keys()].sort()).toEqual(on);
    await toggle(plugin, off);
    expect([...plugin.commands.keys()].sort()).toEqual(offKeys);
    plugin.unload();
  });

  test("integration code blocks: registered once, a hint while off, the handler while on", async () => {
    const { plugin } = await loadPlugin(v3With(true));
    const render = (lang: string) => {
      const appended: { cls?: string; text?: string }[] = [];
      const children: unknown[] = [];
      const base = deep();
      // The hint is created through the block's own element (createDiv), never the global document.
      const el = new Proxy(base, { get: (_t, k) => (k === "createDiv" ? (o: { cls?: string; text?: string }) => (appended.push(o), {}) : base[k]) });
      const restore = withGlobal("document", undefined);
      try {
        plugin.processors.get(lang)!("", el, { sourcePath: "a.md", addChild: (c: unknown) => children.push(c) });
      } finally {
        restore();
      }
      return { hint: appended[0]?.text, children: children.length };
    };
    const set = (on: boolean) => (s: any) => {
      for (const k of ["datacore", "breadcrumbs", "tasknotes"]) s.features.integrations[k].enabled = on;
    };
    for (const on of [false, true, false, true]) {
      await toggle(plugin, set(on));
      for (const [lang, name] of [["pele-datacore", "Datacore"], ["pele-breadcrumbs", "Breadcrumbs"], ["pele-tasks", "TaskNotes"]] as const) {
        expect(render(lang)).toEqual(on ? { hint: undefined, children: 1 } : { hint: `Turn on ${name} in Mehrpele settings`, children: 0 });
      }
      expect(processorCount(plugin)).toEqual({ "pele-datacore": 1, "pele-breadcrumbs": 1, "pele-tasks": 1 });
      expect(plugin.features.pendingReload.size).toBe(0);
    }
    plugin.unload();
  });

  test("listeners: Extended Graph's vault event and Datacore's global go with the toggle", async () => {
    // A window that keeps the Datacore global (the rest stays inert).
    const base = deep();
    const kept: { peleMermaid?: unknown } = {};
    const restore = withGlobal(
      "window",
      new Proxy(base, {
        get: (_t, k) => (k === "peleMermaid" ? kept.peleMermaid : base[k]),
        set: (_t, k, v) => (k === "peleMermaid" ? ((kept.peleMermaid = v), true) : true),
        deleteProperty: (_t, k) => (k === "peleMermaid" ? delete kept.peleMermaid : true),
      }),
    );
    const { plugin } = await loadPlugin(v3With(true));
    const w = window as unknown as { peleMermaid?: unknown };
    const onEvents = Component.events.length;
    expect(w.peleMermaid).toBeDefined();
    const set = (on: boolean) => (s: any) => {
      s.features.integrations["extended-graph"].enabled = on;
      s.features.integrations.datacore.enabled = on;
    };
    await toggle(plugin, set(false));
    expect(Component.events.length).toBe(onEvents - 1);
    expect(w.peleMermaid).toBeUndefined();
    await toggle(plugin, set(true));
    expect(Component.events.length).toBe(onEvents);
    expect(w.peleMermaid).toBeDefined();
    await toggle(plugin, set(false));
    expect(Component.events.length).toBe(onEvents - 1);
    plugin.unload();
    expect(w.peleMermaid).toBeUndefined();
    restore();
  });

  test("Bases view and CLI handlers: registered once, CLI answers feature off while off", async () => {
    const { plugin } = await loadPlugin(v3With(true));
    const count = (m: string, id: string) => plugin.calls.filter(([c, a]: [string, unknown]) => c === m && a === id).length;
    const set = (on: boolean) => (s: any) => {
      s.features.bases.enabled = on;
      s.features.cli.enabled = on;
    };
    for (const on of [false, true, false, true]) {
      await toggle(plugin, set(on));
      expect(count("registerBasesView", "mehrpele-diagram")).toBe(1);
      expect(count("registerCliHandler", "pele:types")).toBe(1);
      const out = await plugin.cliHandlers.get("pele:types")!({});
      if (on) expect(out).toContain("flowchart");
      else expect(out).toContain("feature off");
    }
    plugin.unload();
  });
});
