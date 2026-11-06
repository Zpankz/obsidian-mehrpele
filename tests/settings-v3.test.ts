import { describe, expect, test } from "bun:test";
import { editOptions } from "../src/edit/settings";
import { integrationOptions } from "../src/integrations/settings";
import { materialiseOptions } from "../src/materialise/settings";
import { mehrpeleOptions } from "../src/mehrpele/settings";
import { LEGACY_MAGNIFY, REFLOW_ANIMATE } from "../src/reflow-frame";
import { repairOptions } from "../src/repair-settings";
import { zoomMode } from "../src/settings";
import { DEFAULT_SETTINGS, normalizeSettings, type PeleSettings } from "../src/settings/v2";
import { loadSettings, NOTICE_FRESH, NOTICE_MIGRATED, NOTICE_SANITIZE_OFF, type SettingsHost } from "../src/settings/load";
import { migrate } from "../src/settings/migrate";
import { defaultSettingsV3, enabledFeatureIds, isEnabledV3, normalizeInPlace, normalizeV3, type SettingsV3 } from "../src/settings/schema";

type Obj = Record<string, unknown>;
const get = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Obj)[k] : undefined), o);
function set(o: Obj, path: string, value: unknown): Obj {
  const keys = path.split(".");
  let cur = o;
  for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Obj;
  cur[keys[keys.length - 1]] = value;
  return o;
}
const v2 = (path: string, value: unknown): Obj => set({ settingsVersion: 2 }, path, value);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** What the runtime reads from v3, in the v2 shape: the derive functions plus the retired constants. */
function runtime(s: SettingsV3): PeleSettings {
  const c = s.core, f = s.features;
  return {
    overrideMermaid: c.overrideMermaid, zoomMode: zoomMode(s), maxWidth: c.appearance.maxWidth, showErrorSnippet: true,
    fontFamily: c.appearance.fontFamily, fontSize: c.appearance.fontSize, settingsVersion: 2, iconsEnabled: c.iconsEnabled,
    defaultConfigJson: c.advanced.defaultConfigJson, allowLinks: c.security.allowLinks, allowRemoteImages: c.security.allowRemoteImages,
    sanitizeSvg: c.security.sanitize, ganttToday: c.ganttToday, maxSourceLength: c.advanced.maxSourceLength,
    repair: repairOptions(s), mehrpele: mehrpeleOptions(s), integrations: integrationOptions(s),
    mehrpeleEnabled: f["live-view"].enabled, cliEnabled: f.cli.enabled, materialise: materialiseOptions(s),
    canvas: { portals: f.canvas.portals, portalDepth: f.canvas.portalDepth, outputFolder: f.canvas.outputFolder, layout: f.canvas.layout },
    excalidrawSourceFolder: "", cliBundleSource: "",
    linkPolicy: { allowCommandUris: c.security.allowCommandUris, commandAllowlist: [...c.security.commandAllowlist] },
    nodeResize: f.resize.enabled ? "hover" : "off",
    reflow: { ...f.reflow, autoTurn: f.reflow.switchDirection, legacyMagnify: LEGACY_MAGNIFY, animate: REFLOW_ANIMATE },
    edit: editOptions(s),
  } as PeleSettings;
}

/** Same shape as a full saved v2 file (the test vault's), with neutral paths. */
const SAVED_V2: Obj = {
  overrideMermaid: true, zoomMode: "off", maxWidth: 0, showErrorSnippet: true, fontFamily: "", fontSize: 0,
  settingsVersion: 2, iconsEnabled: true, defaultConfigJson: "", allowLinks: true, allowRemoteImages: true,
  sanitizeSvg: false, ganttToday: true, maxSourceLength: 0,
  repair: {
    previewBeforeApplying: false, tierLinter: true, tierJev: false, tierLlm: false, jevTransport: "http",
    jevBaseUrl: "https://api.typesafe.ai", jevModel: "jev-latest", jevBinPath: "", jevBinConfirmed: "",
    jevMinConfidence: 0.2, jevKeySecretId: "pele-mermaid-jev-key", llmProvider: "anthropic", llmBaseUrl: "",
    llmModel: "claude-sonnet-5-5", llmMaxAttempts: 2, llmReasoningEffort: "none", llmTimeoutSec: 120,
    anthropicKeySecretId: "pele-mermaid-anthropic-key", openaiKeySecretId: "pele-mermaid-openai-key",
    jevConfirmedBinPath: "/opt/bin/jev",
  },
  mehrpele: {
    mermaidLabelMode: "directive", allowEmbeds: true, maxLabelWidth: 480, maxLabelHeight: 320, maxEmbedWidth: 640,
    maxEmbedHeight: 480, maxLabels: 50, lazyEmbeds: true, basesViewEnabled: true, embedDefaultWidth: 320,
    embedDefaultHeight: 240, embedSizing: "legible", minEmbedScale: 0.5, nestedDiagrams: true, maxNestingDepth: 3,
    embedScaling: "viewport", minEmbedUiScale: 0.75, noteCardLabels: true,
    viewNodes: { enabled: true, maxLiveViews: 6, webEnabled: true, allowedSchemes: ["https", "http"], defaultLocalGraphDepth: 1, attachedViews: true },
  },
  integrations: {
    breadcrumbs: { enabled: true, maxNodes: 200, showImplied: false, debounceMs: 250 },
    datacore: { enabled: true, maxNodes: 200, debounceMs: 250 },
    tasknotes: { enabled: true, maxNodes: 200, debounceMs: 250, doneStatuses: [], activeStatuses: [], critStatuses: [] },
    extendedGraph: { useColors: false },
  },
  mehrpeleEnabled: true, cliEnabled: true,
  materialise: { rootFolder: "{{folder}}/{{note}}", defaultKey: "canvas-link", keyStyle: "slug", rewriteBlock: true, onExisting: "link" },
  canvas: { portals: "link", portalDepth: 1, outputFolder: "", layout: "canvas" },
  excalidrawSourceFolder: "~/src/pele-excalidraw", cliBundleSource: "~/src/pele-render.mjs",
  linkPolicy: { allowCommandUris: true, commandAllowlist: [] },
  nodeResize: "hover",
  reflow: { enabled: true, switchDirection: true, autoTurn: true, minTextScale: 0.8, legacyMagnify: false, animate: true },
  edit: { toolbar: true, inlineEdit: true, autocomplete: { enabled: false, model: "" } },
};

// One row per renamed v2 key: [v2 path, saved v2 value, v3 path, expected v3 value].
const RENAMES: [string, unknown, string, unknown][] = [
  ["overrideMermaid", false, "core.overrideMermaid", false],
  ["zoomMode", "off", "features.pan-zoom.enabled", false],
  ["zoomMode", "auto", "features.pan-zoom", { enabled: true, mode: "auto" }],
  ["zoomMode", "always", "features.pan-zoom", { enabled: true, mode: "always" }],
  ["maxWidth", 720, "core.appearance.maxWidth", 720],
  ["fontFamily", "Inter", "core.appearance.fontFamily", "Inter"],
  ["fontSize", 14, "core.appearance.fontSize", 14],
  ["iconsEnabled", false, "core.iconsEnabled", false],
  ["allowLinks", false, "core.security.allowLinks", false],
  ["linkPolicy.allowCommandUris", true, "core.security.allowCommandUris", true],
  ["linkPolicy.commandAllowlist", ["app:reload"], "core.security.commandAllowlist", ["app:reload"]],
  ["allowRemoteImages", false, "core.security.allowRemoteImages", false],
  ["sanitizeSvg", false, "core.security.sanitize", false],
  ["sanitizeSvg", true, "core.security.sanitize", true],
  ["ganttToday", false, "core.ganttToday", false],
  ["maxSourceLength", 9000, "core.advanced.maxSourceLength", 9000],
  ["defaultConfigJson", '{"theme":"dark"}', "core.advanced.defaultConfigJson", '{"theme":"dark"}'],
  ["settingsVersion", 2, "settingsVersion", 3],
  ["reflow.enabled", false, "features.reflow.enabled", false],
  ["reflow.switchDirection", false, "features.reflow.switchDirection", false],
  ["reflow.autoTurn", false, "features.reflow.switchDirection", false],
  ["reflow.minTextScale", 0.6, "features.reflow.minTextScale", 0.6],
  ["edit.toolbar", false, "features.toolbar.enabled", false],
  ["edit.inlineEdit", false, "features.inline-edit.enabled", false],
  ["edit.autocomplete.enabled", true, "features.autocomplete.enabled", true],
  ["edit.autocomplete.model", "qwen3", "features.autocomplete.model", "qwen3"],
  ["nodeResize", "off", "features.resize.enabled", false],
  ["nodeResize", "hover", "features.resize.enabled", true],
  ["mehrpeleEnabled", true, "features.live-view.enabled", true],
  ["mehrpele.mermaidLabelMode", "off", "features.live-view.mermaidLabelMode", "directive"],
  ["mehrpele.mermaidLabelMode", "always", "features.live-view.mermaidLabelMode", "always"],
  ["mehrpele.allowEmbeds", false, "features.live-view.embeds", false],
  ["mehrpele.maxLabelWidth", 500, "features.live-view.maxLabelWidth", 500],
  ["mehrpele.maxLabelHeight", 300, "features.live-view.maxLabelHeight", 300],
  ["mehrpele.maxEmbedWidth", 700, "features.live-view.maxEmbedWidth", 700],
  ["mehrpele.maxEmbedHeight", 400, "features.live-view.maxEmbedHeight", 400],
  ["mehrpele.maxLabels", 20, "features.live-view.maxLabels", 20],
  ["mehrpele.embedSizing", "exact", "features.live-view.minEmbedScale", 0],
  ["mehrpele.minEmbedScale", 0.7, "features.live-view.minEmbedScale", 0.7],
  ["mehrpele.noteCardLabels", false, "features.live-view.noteCardLabels", false],
  ["mehrpele.nestedDiagrams", false, "features.nested.enabled", false],
  ["mehrpele.maxNestingDepth", 5, "features.nested.maxDepth", 5],
  ["mehrpele.basesViewEnabled", false, "features.bases.enabled", false],
  ["mehrpele.viewNodes.enabled", false, "features.view-nodes.enabled", false],
  ["mehrpele.viewNodes.attachedViews", false, "features.view-nodes.attachedViews", false],
  ["mehrpele.viewNodes.maxLiveViews", 10, "features.view-nodes.maxLiveViews", 10],
  ["mehrpele.viewNodes.webEnabled", false, "features.view-nodes.webEnabled", false],
  ["mehrpele.viewNodes.allowedSchemes", ["https"], "features.view-nodes.allowedSchemes", ["https"]],
  ["repair.previewBeforeApplying", true, "features.repair.preview", true],
  ["repair.tierLinter", false, "features.repair.enabled", true],
  ["repair.tierJev", true, "features.repair.jev.enabled", true],
  ["repair.jevTransport", "cli", "features.repair.jev.transport", "cli"],
  ["repair.jevBaseUrl", "https://jev.local", "features.repair.jev.baseUrl", "https://jev.local"],
  ["repair.jevKeySecretId", "k", "features.repair.jev.keySecretId", "k"],
  ["repair.jevBinPath", "/opt/jev", "features.repair.jev.binPath", "/opt/jev"],
  ["repair.jevModel", "jev-2", "features.repair.jev.model", "jev-2"],
  ["repair.tierLlm", true, "features.repair.llm", true],
  ["repair.llmProvider", "openai", "llm.provider", "openai"],
  ["repair.llmBaseUrl", "http://localhost:11434/v1", "llm.baseUrl", "http://localhost:11434/v1"],
  ["repair.llmModel", "gpt-6", "llm.model", "gpt-6"],
  ["repair.llmReasoningEffort", "high", "llm.reasoningEffort", "high"],
  ["repair.llmTimeoutSec", 30, "llm.timeoutSec", 30],
  ["repair.anthropicKeySecretId", "a", "llm.anthropicKeySecretId", "a"],
  ["repair.openaiKeySecretId", "o", "llm.openaiKeySecretId", "o"],
  ["canvas.portals", "inline", "features.canvas.portals", "inline"],
  ["canvas.portalDepth", 3, "features.canvas.portalDepth", 3],
  ["canvas.layout", "auto", "features.canvas.layout", "auto"],
  ["canvas.outputFolder", "Canvases", "features.canvas.outputFolder", "Canvases"],
  ["materialise.rootFolder", "Notes", "features.materialise.rootFolder", "Notes"],
  ["materialise.defaultKey", "rel", "features.materialise.defaultKey", "rel"],
  ["materialise.keyStyle", "verbatim", "features.materialise.keyStyle", "verbatim"],
  ["integrations.breadcrumbs.enabled", true, "features.integrations.breadcrumbs.enabled", true],
  ["integrations.breadcrumbs.maxNodes", 400, "features.integrations.maxNodes", 400],
  ["integrations.breadcrumbs.showImplied", true, "features.integrations.breadcrumbs.showImplied", true],
  ["integrations.datacore.enabled", true, "features.integrations.datacore.enabled", true],
  ["integrations.datacore.maxNodes", 500, "features.integrations.maxNodes", 500],
  ["integrations.tasknotes.enabled", true, "features.integrations.tasknotes.enabled", true],
  ["integrations.tasknotes.maxNodes", 600, "features.integrations.maxNodes", 600],
  ["integrations.extendedGraph.useColors", true, "features.integrations.extended-graph.enabled", true],
  ["cliEnabled", false, "features.cli.enabled", false],
];

// Retired keys: gone from the saved v3, module constants at runtime.
const DROPS: [string, unknown, unknown][] = [
  ["showErrorSnippet", false, true],
  ["reflow.legacyMagnify", true, false],
  ["reflow.animate", false, true],
  ["mehrpele.lazyEmbeds", false, true],
  ["mehrpele.embedDefaultWidth", 100, 320],
  ["mehrpele.embedDefaultHeight", 100, 240],
  ["mehrpele.embedScaling", "zoom", "viewport"],
  ["mehrpele.minEmbedUiScale", 0.5, 0.75],
  ["mehrpele.viewNodes.defaultLocalGraphDepth", 3, 1],
  ["repair.jevMinConfidence", 0.5, 0.2],
  ["repair.llmMaxAttempts", 5, 2],
  ["materialise.rewriteBlock", false, true],
  ["materialise.onExisting", "overwrite", "link"],
  ["integrations.breadcrumbs.debounceMs", 900, 250],
  ["integrations.datacore.debounceMs", 900, 250],
  ["integrations.tasknotes.debounceMs", 900, 250],
  ["integrations.tasknotes.doneStatuses", ["done"], []],
  ["integrations.tasknotes.activeStatuses", ["doing"], []],
  ["integrations.tasknotes.critStatuses", ["urgent"], []],
  ["excalidrawSourceFolder", "~/x", ""],
  ["cliBundleSource", "~/y", ""],
];

describe("renamed keys: v2 → v3", () => {
  for (const [from, value, to, expected] of RENAMES) {
    test(`${from} = ${JSON.stringify(value)} → ${to}`, () => {
      const { settings } = migrate(v2(from, value));
      expect(get(settings, to)).toEqual(expected);
    });
  }

  for (const [key, value, fixed] of DROPS) {
    test(`${key} is dropped`, () => {
      const { settings } = migrate(v2(key, value));
      const leaf = key.split(".").pop()!;
      expect(JSON.stringify(settings)).not.toContain(`"${leaf}"`);
      expect(get(runtime(settings), key)).toEqual(fixed);
    });
  }

  test("unknown keys are dropped at every level", () => {
    const raw = clone(SAVED_V2);
    raw.bogus = 1;
    (raw.repair as Obj).jevConfirmedBinPath = "/opt/bin/jev";
    const json = JSON.stringify(migrate(raw).settings);
    expect(json).not.toContain("bogus");
    expect(json).not.toContain("jevConfirmedBinPath");
  });
});

describe("v2 → v3: absent keys take the OLD default", () => {
  const { settings: s } = migrate({ settingsVersion: 2 });
  test.each([
    ["features.toolbar.enabled", true],
    ["features.inline-edit.enabled", true],
    ["features.resize.enabled", true],
    ["features.pan-zoom.enabled", false],
    ["features.live-view.enabled", false],
    ["features.nested.enabled", true],
    ["features.bases.enabled", true],
    ["features.view-nodes.enabled", true],
    ["features.view-nodes.webEnabled", true],
    ["features.cli.enabled", true],
    ["features.repair.enabled", true],
    ["features.canvas.enabled", true],
    ["features.materialise.enabled", true],
    ["features.excalidraw.enabled", false],
    ["features.integrations.breadcrumbs.enabled", false],
    ["core.security.allowRemoteImages", true],
    ["features.reflow.switchDirection", true],
  ])("%s = %p", (path, expected) => {
    expect(get(s, path)).toBe(expected);
  });

  test("absent sanitizeSvg takes the NEW default", () => {
    expect(s.core.security.sanitize).toBe(true);
  });

  test("v1 zoomMode auto is reset before mapping", () => {
    expect(migrate({ zoomMode: "auto" }).settings.features["pan-zoom"].enabled).toBe(false);
    expect(migrate({ settingsVersion: 2, zoomMode: "auto" }).settings.features["pan-zoom"].enabled).toBe(true);
  });

  test("excalidraw follows pele-excalidraw being enabled", () => {
    expect(migrate({ settingsVersion: 2 }, { peleExcalidrawEnabled: true }).settings.features.excalidraw.enabled).toBe(true);
  });
});

describe("v2 → v3: jevBinConfirmed", () => {
  test("kept when it equals the bin path", () => {
    const raw = { settingsVersion: 2, repair: { jevBinPath: "/opt/jev", jevBinConfirmed: "/opt/jev" } };
    expect(migrate(raw).settings.features.repair.jev.binConfirmed).toBe("/opt/jev");
  });
  test("cleared when it differs", () => {
    const raw = { settingsVersion: 2, repair: { jevBinPath: "/opt/jev", jevBinConfirmed: "/tmp/evil" } };
    expect(migrate(raw).settings.features.repair.jev.binConfirmed).toBe("");
  });
});

describe("fresh install", () => {
  test("add-on hints default on through migration and preserve explicit false", () => {
    expect(migrate({ settingsVersion: 2 }).settings.core.showAddonHints).toBe(true);
    expect(migrate({ settingsVersion: 3, core: {}, features: {} }).settings.core.showAddonHints).toBe(true);
    expect(migrate({ settingsVersion: 3, core: { showAddonHints: false }, features: {} }).settings.core.showAddonHints).toBe(false);
    expect(migrate({ settingsVersion: 3, core: { showAddonHints: "false" }, features: {} }).settings.core.showAddonHints).toBe(true);
  });
  test("null → defaults, saved", () => {
    const r = migrate(null);
    expect(r).toEqual({ settings: defaultSettingsV3(), changed: true, from: "fresh" });
  });

  test("exactly the 8 features are on", () => {
    expect(enabledFeatureIds(migrate(null).settings).sort()).toEqual(
      ["render-core", "pele-diagram-types", "mermaid-override", "lp-takeover", "link-guard", "math", "hover", "reflow"].sort(),
    );
  });

  test("light and private: sanitize on, remote images off, switchDirection off", () => {
    const s = migrate(null).settings;
    expect(s.core.security.sanitize).toBe(true);
    expect(s.core.security.allowRemoteImages).toBe(false);
    expect(s.features["view-nodes"].webEnabled).toBe(false);
    expect(s.features.reflow.switchDirection).toBe(false);
  });
});

describe("round trips", () => {
  test("v2 → v3 keeps every behaviour the runtime reads", () => {
    const before = normalizeSettings(clone(SAVED_V2) as Partial<PeleSettings>);
    const after = runtime(migrate(clone(SAVED_V2)).settings);
    const strip = (s: PeleSettings) => {
      const o = clone(normalizeSettings(s)) as unknown as Obj;
      // Retired or merged keys whose fixed values may differ from what was stored.
      for (const k of ["excalidrawSourceFolder", "cliBundleSource", "settingsVersion", "sanitizeSvg"]) delete o[k];
      delete (o.repair as Obj).jevConfirmedBinPath;
      return o;
    };
    expect(strip(after)).toEqual(strip(before));
    expect(after.sanitizeSvg).toBe(false);
  });

  test("v1 → v3", () => {
    const v1 = { overrideMermaid: true, zoomMode: "auto", maxWidth: 600, allowRemoteImages: false };
    const s = migrate(v1).settings;
    expect(s.features["pan-zoom"].enabled).toBe(false);
    expect(s.core.appearance.maxWidth).toBe(600);
    expect(s.core.security.allowRemoteImages).toBe(false);
    expect(s.features.toolbar.enabled).toBe(true);
    expect(s.settingsVersion).toBe(3);
  });

  test("v3 saves and reloads to the same settings", () => {
    const s = migrate(clone(SAVED_V2)).settings;
    const saved = JSON.parse(JSON.stringify(s));
    expect(migrate(saved)).toEqual({ settings: s, changed: false, from: "v3" });
  });

  test("normalizeInPlace keeps sub-object references live", () => {
    const s = defaultSettingsV3();
    const vn = s.features["view-nodes"];
    vn.enabled = true;
    s.features.canvas.portalDepth = 9;
    normalizeInPlace(s);
    expect(s.features["view-nodes"]).toBe(vn);
    expect(isEnabledV3(s, "view-nodes")).toBe(true);
    expect(s.features.canvas.portalDepth).toBe(5);
    expect(s).toEqual(normalizeV3(clone(s)));
  });

  test("canvas portal depth keeps the old tab's 0–5 range", () => {
    const s = defaultSettingsV3();
    s.features.canvas.portalDepth = 0;
    expect(normalizeV3(clone(s)).features.canvas.portalDepth).toBe(0);
    expect(migrate(v2("canvas.portalDepth", 0)).settings.features.canvas.portalDepth).toBe(0);
    expect(normalizeV3(set(clone(defaultSettingsV3()) as unknown as Obj, "features.canvas.portalDepth", 9)).features.canvas.portalDepth).toBe(5);
  });

  test("fractional depths round to the nearest level, then clamp", () => {
    const depth = (key: string, v: unknown) => {
      const s = normalizeV3(set(clone(defaultSettingsV3()) as unknown as Obj, key, v));
      return key.endsWith("maxDepth") ? s.features.nested.maxDepth : s.features.canvas.portalDepth;
    };
    const cases: [string, unknown, number][] = [
      ["features.nested.maxDepth", 2.5, 3],
      ["features.nested.maxDepth", 1.4, 1],
      ["features.nested.maxDepth", 9.4, 8],
      ["features.nested.maxDepth", -1, 0],
      ["features.nested.maxDepth", "x", 3],
      ["features.canvas.portalDepth", 2.5, 3],
      ["features.canvas.portalDepth", 5.6, 5],
      ["features.canvas.portalDepth", -0.4, 0],
    ];
    for (const [key, v, want] of cases) expect({ key, v, got: depth(key, v) }).toEqual({ key, v, got: want });
  });
});

describe("idempotence", () => {
  const inputs: [string, unknown][] = [
    ["null", null],
    ["empty v2", { settingsVersion: 2 }],
    ["saved v2", clone(SAVED_V2)],
    ["v1", { zoomMode: "auto", nodeResize: "off" }],
    ["v3 defaults", defaultSettingsV3()],
    ["garbage v3", { settingsVersion: 3, core: { appearance: { maxWidth: -5 } }, features: { nested: { maxDepth: 99 } }, x: 1 }],
  ];
  for (const [name, raw] of inputs) {
    test(`migrate(migrate(x)) == migrate(x): ${name}`, () => {
      const once = migrate(clone(raw)).settings;
      const twice = migrate(clone(once));
      expect(twice.settings).toEqual(once);
      expect(twice.changed).toBe(false);
    });
  }

  test("normalizeV3 is a fixed point", () => {
    const s = normalizeV3({ settingsVersion: 3, features: { "view-nodes": { allowedSchemes: ["javascript", "HTTPS"] } } });
    expect(normalizeV3(s)).toEqual(s);
    expect(s.features["view-nodes"].allowedSchemes).not.toContain("javascript");
  });
});

describe("loadSettings", () => {
  function host(data: unknown, opts: { dir?: string; legacy?: string; excalidraw?: boolean } = {}) {
    const saved: unknown[] = [];
    const files: Record<string, string> = {};
    if (opts.legacy !== undefined) files[".obsidian/plugins/pele-mermaid/data.json"] = opts.legacy;
    const h: SettingsHost = {
      loadData: async () => data,
      saveData: async (d) => void saved.push(JSON.parse(JSON.stringify(d))),
      manifest: { dir: opts.dir ?? ".obsidian/plugins/pele-mermaid" },
      app: {
        vault: { configDir: ".obsidian", adapter: { exists: async (p) => p in files, read: async (p) => files[p] } },
        plugins: { enabledPlugins: new Set(opts.excalidraw ? ["pele-excalidraw"] : []) },
      },
    };
    return { h, saved };
  }

  test("fresh: saves v3 defaults and says so", async () => {
    const { h, saved } = host(null);
    const notes: string[] = [];
    const r = await loadSettings(h, (m) => notes.push(m));
    expect(saved).toEqual([defaultSettingsV3()]);
    expect(notes).toEqual([NOTICE_FRESH]);
    expect(r.settings.features.toolbar.enabled).toBe(false);
  });

  test("v2: migrates, saves once, keeps behaviour", async () => {
    const { h, saved } = host(clone(SAVED_V2), { excalidraw: true });
    const notes: string[] = [];
    const r = await loadSettings(h, (m) => notes.push(m));
    expect(saved).toHaveLength(1);
    expect((saved[0] as SettingsV3).settingsVersion).toBe(3);
    expect((saved[0] as SettingsV3).features.excalidraw.enabled).toBe(true);
    // SAVED_V2 stored sanitizeSvg: false, so the migration also warns once.
    expect(notes).toEqual([NOTICE_MIGRATED, NOTICE_SANITIZE_OFF]);
    expect(r.settings.features.toolbar.enabled).toBe(true);
    expect(r.settings.features["live-view"].enabled).toBe(true);
  });

  test("v3: no save, no notice", async () => {
    const { h, saved } = host(defaultSettingsV3());
    const notes: string[] = [];
    await loadSettings(h, (m) => notes.push(m));
    expect(saved).toEqual([]);
    expect(notes).toEqual([]);
  });

  test("imports pele-mermaid/data.json when the new folder has none", async () => {
    const { h, saved } = host(null, { dir: ".obsidian/plugins/mehrpele", legacy: JSON.stringify(SAVED_V2) });
    const r = await loadSettings(h);
    expect(r.imported).toBe(true);
    expect(r.from).toBe("v2");
    expect((saved[0] as SettingsV3).features.toolbar.enabled).toBe(true);
  });

  test("a broken legacy file falls back to fresh", async () => {
    const { h } = host(null, { dir: ".obsidian/plugins/mehrpele", legacy: "{not json" });
    expect((await loadSettings(h)).from).toBe("fresh");
  });

  test("no import when this install already lives in the old folder", async () => {
    const { h } = host(null, { legacy: JSON.stringify(SAVED_V2) });
    expect((await loadSettings(h)).imported).toBe(false);
  });
});

test("DEFAULT_SETTINGS (v2 normaliser input) still carries the old defaults", () => {
  expect(DEFAULT_SETTINGS.edit.toolbar).toBe(true);
  expect(DEFAULT_SETTINGS.sanitizeSvg).toBe(false);
});
