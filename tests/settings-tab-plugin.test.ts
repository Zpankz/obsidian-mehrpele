/**
 * The settings tab inside the built plugin: the tab registered at load reads
 * and writes dotted v3 keys, and a write saves and syncs the feature registry
 * at once (no reload for runtime features), rebuilding the definitions only
 * when a feature toggle changed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bundleMain } from "./helpers/bundle";
import { deep, obsidianStub, Notice } from "./helpers/obsidian-stub";
import { defaultSettingsV3, setEnabledV3, TOGGLE_IDS } from "../src/settings/schema";

const g = globalThis as typeof globalThis & { __peleData?: unknown };
let code = "";
const saved = new Map<string, PropertyDescriptor | undefined>();
const DOM = ["document", "window", "activeDocument", "activeWindow", "navigator", "getComputedStyle", "requestAnimationFrame", "IntersectionObserver", "ResizeObserver", "MutationObserver"];

beforeAll(async () => {
  ({ code } = await bundleMain());
  for (const k of DOM) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: deep(), configurable: true, writable: true });
  }
}, 60_000);

afterAll(() => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  delete g.__peleData;
});

async function loadPlugin(data: unknown): Promise<{ plugin: any; tab: any }> {
  g.__peleData = data;
  const mod: { exports: any } = { exports: {} };
  const req = (id: string): unknown => {
    if (id === "obsidian") return obsidianStub;
    if (id.startsWith("@codemirror/") || id.startsWith("@lezer/") || id === "electron") return deep();
    return require(id);
  };
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  const Cls = mod.exports.default ?? mod.exports;
  const plugin = new Cls(deep(), { id: "mehrpele", version: "0.0.0", dir: ".obsidian/plugins/mehrpele" });
  await plugin.load();
  const tab = plugin.calls.find(([m]: [string]) => m === "addSettingTab")?.[1];
  return { plugin, tab };
}

function allOn(): unknown {
  const s = defaultSettingsV3();
  for (const id of TOGGLE_IDS) setEnabledV3(s, id, true);
  return s;
}

describe("settings tab in the plugin", () => {
  test("private settings hooks preserve their receiver and fail with a useful manual route", async () => {
    const { plugin, tab } = await loadPlugin(null);
    const calls: string[] = [];
    const setting = {
      open() { expect(this).toBe(setting); calls.push("open"); },
      openTabById(id: string) { expect(this).toBe(setting); calls.push(id); },
    };
    tab.getSettingDefinitions();
    tab.app = { setting };
    tab.getElementForDefinition = () => { throw new Error("Private hook changed"); };
    const notices = Notice.shown;
    const before = notices.length;
    expect(() => tab.openFlows()).not.toThrow();
    expect(calls).toEqual(["open", "mehrpele"]);
    expect(notices.slice(before)).toContain("Mehrpele: open add-ons → flows.");
    tab.app = {};
    expect(tab.openPluginSettings("mehrpele-cannoli")).toBe(false);
    await expect(tab.enableAddon("mehrpele-cannoli")).resolves.toBeUndefined();
    expect(notices.at(-1)).toContain("Community plugins");
    plugin.unload();
  });
  test("one tab, with definitions built from the live settings", async () => {
    const { plugin, tab } = await loadPlugin(null);
    expect(plugin.calls.filter(([m]: [string]) => m === "addSettingTab")).toHaveLength(1);
    const defs = tab.getSettingDefinitions();
    expect(defs.length).toBeGreaterThan(4);
    expect(tab.getControlValue("features.reflow.enabled")).toBe(true);
    expect(tab.getControlValue("core.security.commandAllowlist")).toBe("");
    plugin.unload();
  });

  test("setControlValue writes the key, saves, syncs the registry and refreshes", async () => {
    const { plugin, tab } = await loadPlugin(allOn());
    const writes: unknown[] = [];
    const saveData = plugin.saveData.bind(plugin);
    plugin.saveData = async (d: unknown) => {
      writes.push(JSON.parse(JSON.stringify(d)));
      return saveData(d);
    };
    expect(plugin.commands.has("mehrpele:repair-diagram-under-cursor")).toBe(true);

    // A feature toggle: saved as v3, the feature unloads at once, the definitions rebuild.
    const u0 = tab.updates, r0 = tab.refreshes;
    await tab.setControlValue("features.repair.enabled", false);
    expect(plugin.settings.features.repair.enabled).toBe(false);
    expect((writes.at(-1) as any).features.repair.enabled).toBe(false);
    expect(plugin.features.active()).not.toContain("repair");
    expect(plugin.commands.has("mehrpele:repair-diagram-under-cursor")).toBe(false);
    expect(tab.updates).toBe(u0 + 1);
    expect(tab.refreshes).toBe(r0 + 1);

    // And back on, live.
    await tab.setControlValue("features.repair.enabled", true);
    expect(plugin.features.active()).toContain("repair");
    expect(plugin.commands.has("mehrpele:repair-diagram-under-cursor")).toBe(true);

    // An option: saved, refreshes visibility, no rebuild.
    const u1 = tab.updates;
    await tab.setControlValue("features.reflow.minTextScale", 0.5);
    expect((writes.at(-1) as any).features.reflow.minTextScale).toBe(0.5);
    expect(tab.getControlValue("features.reflow.minTextScale")).toBe(0.5);
    expect(tab.updates).toBe(u1);
    await tab.setControlValue("core.security.commandAllowlist", "a:b\nc:d");
    expect((writes.at(-1) as any).core.security.commandAllowlist).toEqual(["a:b", "c:d"]);

    // The provider names the AI page's summary: rebuild so it shows the new one.
    const llm = () => tab.getSettingDefinitions().flatMap((d: any) => d.items ?? []).find((p: any) => p.name === "AI model provider");
    const before = llm().displayValue();
    const u2 = tab.updates;
    await tab.setControlValue("llm.provider", "openai");
    expect(tab.updates).toBe(u2 + 1);
    expect(llm().displayValue()).toBe("OpenAI-compatible");
    expect(before).not.toBe("OpenAI-compatible");

    // A reload-needed feature stays until reload, and its page says so.
    await tab.setControlValue("features.cli.enabled", false);
    expect([...plugin.features.pendingReload]).toEqual(["cli"]);
    const list = tab.getSettingDefinitions().find((d: any) => d.heading === "Features");
    const cli = list.items.find((p: any) => p.featureId === "cli");
    expect(cli.displayValue()).toBe("Reload needed");

    await expect(tab.setControlValue("features.nope", true)).rejects.toThrow("Unknown setting");
    plugin.unload();
  });

  test("hint changes refresh only add-on hints, without rebuilding existing diagrams", async () => {
    const { plugin, tab } = await loadPlugin(null);
    let refreshes = 0, redraws = 0;
    plugin.refreshAddonHints = () => refreshes++;
    plugin.refreshLiveMounts = () => redraws++;
    await tab.setControlValue("core.showAddonHints", false);
    expect(plugin.settings.core.showAddonHints).toBe(false);
    expect(refreshes).toBe(1);
    expect(redraws).toBe(0);
    plugin.unload();
  });

  test("an integration toggle re-renders open notes, so rendered blocks follow it (no reload)", async () => {
    const { plugin, tab } = await loadPlugin(allOn());
    const rerenders: unknown[] = [];
    plugin.rerenderAllMarkdownViews = (langs?: string[]) => void rerenders.push(langs);
    for (const on of [false, true]) {
      await tab.setControlValue("features.integrations.tasknotes.enabled", on);
      await tab.setControlValue("features.integrations.breadcrumbs.enabled", on);
      await tab.setControlValue("features.integrations.datacore.enabled", on);
    }
    // Each names its block language, so Live Preview widgets of that language re-render too.
    const langs = [["pele-tasks"], ["pele-breadcrumbs"], ["pele-datacore"]];
    expect(rerenders).toEqual([...langs, ...langs]);
    expect(plugin.features.pendingReload.size).toBe(0);
    await tab.setControlValue("features.integrations.maxNodes", 50);
    expect(rerenders).toHaveLength(6);
    plugin.unload();
  });

  test("a number the schema rounds or clamps rebuilds the tab, so the field shows the stored value", async () => {
    const { plugin, tab } = await loadPlugin(allOn());
    const u0 = tab.updates;
    await tab.setControlValue("features.nested.maxDepth", 2.5);
    expect(tab.getControlValue("features.nested.maxDepth")).toBe(3);
    expect(tab.updates).toBe(u0 + 1);
    await tab.setControlValue("features.canvas.portalDepth", 4);
    expect(tab.getControlValue("features.canvas.portalDepth")).toBe(4);
    expect(tab.updates).toBe(u0 + 1);
    plugin.unload();
  });

  test("the Bases toggle refreshes open Bases views both ways; unloaded views are left alone", async () => {
    const { plugin, tab } = await loadPlugin(allOn());
    let refreshed = 0;
    const view = { refresh: () => void refreshed++ };
    const deps = plugin.mehrBasesDeps();
    deps.liveView(view, true);
    await tab.setControlValue("features.bases.enabled", false);
    expect(refreshed).toBe(1);
    await tab.setControlValue("features.bases.enabled", true);
    expect(refreshed).toBe(2);
    await tab.setControlValue("features.reflow.minTextScale", 0.5);
    expect(refreshed).toBe(2);
    deps.liveView(view, false);
    await tab.setControlValue("features.bases.enabled", false);
    expect(refreshed).toBe(2);
    plugin.unload();
  });
});
