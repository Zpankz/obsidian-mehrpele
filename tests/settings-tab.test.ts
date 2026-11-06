/**
 * The declarative settings tab, as data: every v3 key has one control, every
 * feature has a page, names follow the copy rules, `visible` chains follow
 * their parent toggles, desktop-only rows disable on mobile, the Features
 * filter finds pages by alias, folds persist, and the tour buttons reach the
 * vault.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { apiGate, obsidianStub, SecretComponent } from "./helpers/obsidian-stub";

mock.module("obsidian", () => obsidianStub);
const D = await import("../src/settings-tab/definitions");
const { readControl, writeControl } = await import("../src/settings-tab/values");
const { FoldState, FOLDS_KEY, FOLDED_CLASS, revealFolded } = await import("../src/settings-tab/folds");
const { installTour, removeTour, removedMessage, TOUR_ASSET } = await import("../src/settings-tab/tour");
const schema = await import("../src/settings/schema");
const { FEATURES } = await import("../src/features/registry");
const { loadSettings, NOTICE_MIGRATED, NOTICE_SANITIZE_OFF } = await import("../src/settings/load");
const { sha256Hex } = await import("../src/features/assets");
type TabContext = import("../src/settings-tab/definitions").TabContext;
type PluginManagerLike = import("../src/features/companions").PluginManagerLike;
type SettingsV3 = import("../src/settings/schema").SettingsV3;
type ToggleId = import("../src/settings/schema").ToggleId;

type Node = Record<string, any>;
const Platform = obsidianStub.Platform as { isMobile: boolean };

afterEach(() => {
  Platform.isMobile = false;
});

function fakeCtx(opts: { v3?: SettingsV3; plugins?: PluginManagerLike; pending?: ToggleId[]; models?: string[]; folded?: string[] } = {}) {
  const v3 = opts.v3 ?? schema.defaultSettingsV3();
  const store = new Map<string, unknown>(opts.folded ? [[FOLDS_KEY, opts.folded]] : []);
  const runs: string[] = [];
  const ctx: TabContext = {
    app: {} as TabContext["app"],
    value: (k) => readControl(v3, k),
    set: async (k, v) => writeControl(v3, k, v),
    enabled: (id) => schema.isEnabledV3(v3, id),
    pendingReload: (id) => opts.pending?.includes(id) ?? false,
    needsReload: (id) => FEATURES.some((d) => d.id === id && d.kind === "module" && d.reload === "needed"),
    plugins: () => opts.plugins,
    folds: new FoldState({ loadLocalStorage: (k) => store.get(k), saveLocalStorage: (k, d) => void store.set(k, d) }),
    ollamaModels: () => opts.models ?? [],
    excalidrawStandsDown: () => false,
    run: new Proxy({}, { get: (_t, k) => async () => void runs.push(String(k)) }) as TabContext["run"],
  };
  return { ctx, v3, store, runs };
}

/** Visit every item, depth first, with its ancestors. */
function walk(items: unknown[], visit: (n: Node, path: Node[]) => void, path: Node[] = []): void {
  for (const it of items as Node[]) {
    visit(it, path);
    if (Array.isArray(it.items)) walk(it.items, visit, [...path, it]);
  }
}

function all(items: unknown[]): Node[] {
  const out: Node[] = [];
  walk(items, (n) => out.push(n));
  return out;
}

const byKey = (items: unknown[], key: string): Node => {
  const n = all(items).find((x) => x.control?.key === key);
  if (!n) throw new Error(`no control for ${key}`);
  return n;
};
const byName = (items: unknown[], name: string): Node => {
  const n = all(items).find((x) => x.name === name || x.heading === name);
  if (!n) throw new Error(`no item named ${name}`);
  return n;
};
/** An item is shown when it and every ancestor are visible. */
function shown(items: unknown[], target: Node): boolean {
  let result = false;
  walk(items, (n, path) => {
    if (n === target) result = [...path, n].every((x) => typeof x.visible !== "function" || x.visible() === true);
  });
  return result;
}

/** Dotted keys of every value; an empty object (a record such as a palette) is a leaf too. */
function leaves(o: unknown, prefix = ""): string[] {
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    const nested = v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0;
    return nested ? leaves(v, p) : [p];
  });
}

/** v3 keys with no control, and why. */
const NO_CONTROL: Record<string, string> = {
  settingsVersion: "schema version, not a preference",
  "features.repair.jev.transport": "only the HTTP transport has a consumer; the CLI transport is not wired",
  "features.repair.jev.binPath": "CLI transport state; no consumer",
  "features.repair.jev.binConfirmed": "security state written by the binary confirmation, never by hand",
  "features.excalidraw.palette": "set by the Excalidraw conversion; no legacy control",
  "features.view-nodes.allowedSchemes": "a rendered text row, so the field can show the effective list on blur",
};

describe("coverage", () => {
  test("every v3 leaf maps to exactly one control, or is on the exclusion list", () => {
    const { ctx } = fakeCtx();
    const counts = new Map<string, number>();
    for (const n of all(D.buildDefinitions(ctx))) {
      if (n.control?.key) counts.set(n.control.key, (counts.get(n.control.key) ?? 0) + 1);
    }
    const keys = leaves(schema.defaultSettingsV3());
    for (const k of keys) {
      if (k in NO_CONTROL) expect({ k, n: counts.get(k) ?? 0 }).toEqual({ k, n: 0 });
      else expect({ k, n: counts.get(k) ?? 0 }).toEqual({ k, n: 1 });
    }
    // No control writes a key the schema does not have.
    expect([...counts.keys()].filter((k) => !keys.includes(k))).toEqual([]);
  });

  test("every control key round-trips through readControl and writeControl", () => {
    const { ctx, v3 } = fakeCtx();
    for (const n of all(D.buildDefinitions(ctx))) {
      const key = n.control?.key;
      if (!key) continue;
      const before = readControl(v3, key);
      writeControl(v3, key, before);
      expect({ key, v: readControl(v3, key) }).toEqual({ key, v: before });
    }
  });

  test("list keys edit as text; bad numbers keep the old value; typos throw", () => {
    const v3 = schema.defaultSettingsV3();
    writeControl(v3, "core.security.commandAllowlist", " a:b \n\n c:d ");
    expect(v3.core.security.commandAllowlist).toEqual(["a:b", "c:d"]);
    expect(readControl(v3, "features.view-nodes.allowedSchemes")).toBe("https, http");
    writeControl(v3, "features.nested.maxDepth", "");
    expect(v3.features.nested.maxDepth).toBe(3);
    writeControl(v3, "features.nested.maxDepth", "5");
    expect(v3.features.nested.maxDepth).toBe(5);
    expect(() => writeControl(v3, "features.nope.enabled", true)).toThrow("Unknown setting");
  });
});

describe("depth and scheme fields", () => {
  test("the two depth controls step by whole levels", () => {
    const defs = D.buildDefinitions(fakeCtx({ v3: everythingOn() }).ctx);
    for (const key of ["features.nested.maxDepth", "features.canvas.portalDepth"]) {
      expect({ key, step: byKey(defs, key).control.step }).toEqual({ key, step: 1 });
    }
  });

  test("the schemes field states the fallback and shows the effective list once it loses focus", () => {
    const { ctx, v3 } = fakeCtx({ v3: everythingOn() });
    const row = byName(D.buildDefinitions(ctx), "Allowed URL schemes");
    expect(row.desc).toContain("empty means https, http");
    const input = { value: "", blur: null as (() => void) | null };
    let change: ((v: string) => unknown) | null = null;
    const t = {
      inputEl: { addEventListener: (type: string, fn: () => void) => void (type === "blur" && (input.blur = fn)) },
      setPlaceholder: () => t,
      setValue: (v: string) => ((input.value = v), t),
      onChange: (fn: (v: string) => unknown) => ((change = fn), t),
    };
    row.render({ addText: (cb: (c: typeof t) => void) => cb(t) });
    expect(input.value).toBe("https, http");
    // Typing saves as it goes; an emptied list falls back once normalized.
    input.value = "";
    change!("");
    schema.normalizeInPlace(v3);
    expect(v3.features["view-nodes"].allowedSchemes).toEqual(["https", "http"]);
    expect(input.value).toBe("");
    input.blur!();
    expect(input.value).toBe("https, http");
    change!("HTTPS, javascript, ftp");
    schema.normalizeInPlace(v3);
    input.blur!();
    expect(input.value).toBe("https, ftp");
  });
});

describe("feature pages", () => {
  const { ctx } = fakeCtx();
  const pages = D.featurePages(ctx);
  const defaults = schema.defaultSettingsV3();

  test("every registry feature has one page, whose toggle writes its enable key with the schema default", () => {
    expect(pages.map((p) => p.featureId).sort()).toEqual(FEATURES.map((f) => f.id).sort());
    expect([...schema.TOGGLE_IDS].sort()).toEqual(FEATURES.map((f) => f.id).sort());
    for (const id of schema.TOGGLE_IDS) {
      const page = pages.find((p) => p.featureId === id)!;
      const t = (page.items as Node[])[0]!;
      expect(t.control).toMatchObject({ type: "toggle", key: D.enableKey(id) });
      if ("defaultValue" in t.control) expect(t.control.defaultValue).toBe(schema.isEnabledV3(defaults, id));
      expect(readControl(defaults, t.control.key)).toBe(schema.isEnabledV3(defaults, id));
    }
  });

  test("each page carries at least 3 aliases, also on its toggle for app-wide search", () => {
    const list = byName(D.buildDefinitions(ctx), "Features");
    const listPages = (list.items as Node[]).filter((n) => n.type === "page");
    expect(listPages.length).toBe(pages.length + 1); // + AI model provider
    for (const p of listPages) {
      expect({ page: p.name, n: p.aliases.length >= 3 }).toEqual({ page: p.name, n: true });
    }
    for (const p of pages) expect((p.items as Node[])[0]!.aliases).toEqual(p.aliases);
  });

  test("Options groups show only while the feature is on", () => {
    const { ctx: c, v3 } = fakeCtx();
    const page = D.featurePages(c).find((p) => p.featureId === "reflow")!;
    const opts = (page.items as Node[]).find((n) => n.heading === "Options")!;
    v3.features.reflow.enabled = false;
    expect(opts.visible()).toBe(false);
    v3.features.reflow.enabled = true;
    expect(opts.visible()).toBe(true);
  });

  test("summary: Off, On, a warning with the missing companion, Reload needed", () => {
    const plugins: PluginManagerLike = { manifests: {}, enabledPlugins: new Set() };
    const { ctx: c, v3 } = fakeCtx({ plugins });
    const page = () => D.featurePages(c).find((p) => p.featureId === "integrations.datacore")!;
    const fn = (v: unknown) => (typeof v === "function" ? v() : v);
    expect(fn(page().displayValue)).toBe("Off");
    expect(fn(page().status)).toBeNull();
    v3.features.integrations.datacore.enabled = true;
    expect(fn(page().displayValue)).toBe("On · Needs Datacore");
    expect(fn(page().status)).toBe("warning");
    plugins.manifests!.datacore = { version: "0.1.0" };
    expect(fn(page().displayValue)).toBe("On · Needs Datacore"); // installed, not enabled
    plugins.enabledPlugins!.add("datacore");
    expect(fn(page().displayValue)).toBe("On");
    expect(fn(page().status)).toBeNull();
    const pending = fakeCtx({ pending: ["cli"] });
    const cli = D.featurePages(pending.ctx).find((p) => p.featureId === "cli")!;
    expect(fn(cli.displayValue)).toBe("Reload needed");
    expect(byName(cli.items!, "Reload needed").visible()).toBe(true);
    expect(byName(D.featurePages(ctx).find((p) => p.featureId === "cli")!.items!, "Reload needed").visible()).toBe(false);
  });

  test("Requires rows offer Install, then Enable, as the companion's state changes", () => {
    const plugins: PluginManagerLike = { manifests: {}, enabledPlugins: new Set() };
    const { ctx: c, runs } = fakeCtx({ plugins });
    const page = D.featurePages(c).find((p) => p.featureId === "integrations.breadcrumbs")!;
    const row = byName((page.items as Node[]).find((n) => n.heading === "Requires")!.items, "Breadcrumbs");
    const paint = () => {
      const s = fakeSetting();
      row.render(s);
      return s;
    };
    let s = paint();
    expect(s.desc).toBe("Not installed.");
    expect(s.buttons.map((b) => b.text)).toEqual(["Install"]);
    s.buttons[0]!.click();
    expect(runs).toEqual(["openPluginPage"]);
    plugins.manifests!.breadcrumbs = { version: "4.0.0" };
    s = paint();
    expect(s.buttons.map((b) => b.text)).toEqual(["Enable"]);
    plugins.enabledPlugins!.add("breadcrumbs");
    s = paint();
    expect(s.desc).toBe("Version 4.0.0, enabled.");
    expect(s.buttons).toEqual([]);
  });
});

/** Just enough of Setting for render rows. */
function fakeSetting() {
  const s = {
    desc: "",
    classes: [] as string[],
    buttons: [] as { text: string; click: () => unknown }[],
    settingEl: { addClass: (c: string) => void s.classes.push(c) },
    controlEl: { empty: () => void (s.buttons = []) },
    setDesc(d: string) {
      s.desc = d;
      return s;
    },
    addButton(cb: (b: unknown) => void) {
      const entry = { text: "", click: () => undefined as unknown };
      const b = {
        buttonEl: { setAttribute() {}, removeAttribute() {} },
        setButtonText: (t: string) => ((entry.text = t), b),
        onClick: (fn: () => unknown) => ((entry.click = fn), b),
      };
      cb(b);
      s.buttons.push(entry);
      return s;
    },
  };
  return s;
}

test("Flows actions use live state and preserve the same button through enable", async () => {
  const { ctx, runs } = fakeCtx();
  let state: import("../src/features/companions").FlowStatus = { kind: "missing", label: "Not installed", detail: "Missing." };
  ctx.flows = () => state;
  let repaint = () => {};
  ctx.watchFlows = (_el, paint) => { repaint = paint; };
  const page = D.flowsPage(ctx);
  const row = (page.items as Node[])[0]!;
  const setting = fakeSetting();
  row.render(setting);
  const button = setting.buttons[0]!;
  expect(button.text).toBe("Install");
  await button.click();
  expect(runs).toEqual(["openPluginPage"]);
  state = { ...state, kind: "disabled", label: "Installed, disabled" }; repaint();
  expect(button.text).toBe("Enable");
  let release = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let enables = 0;
  ctx.run = { ...ctx.run, enablePlugin: async () => { enables++; await waiting; }, openPluginPage: () => void runs.push("openPluginPage"), openPluginSettings: () => void runs.push("openPluginSettings"), updateHost: () => void runs.push("updateHost") } as TabContext["run"];
  const enabling = button.click();
  await button.click();
  expect(enables).toBe(1);
  state = { ...state, kind: "ready", label: "Ready" };
  release(); await enabling;
  expect(setting.buttons).toEqual([button]);
  expect(button.text).toBe("Open settings");
  await button.click();
  expect(runs.at(-1)).toBe("openPluginSettings");
  state = { ...state, kind: "update-needed", label: "Update needed", updateTarget: "host" }; repaint();
  await button.click();
  expect(runs.at(-1)).toBe("updateHost");
});

test("Flows update routes disconnected companions to instructions and known API mismatches to the host", async () => {
  const { detectFlows, FLOWS } = await import("../src/features/companions");
  const pm = { manifests: { [FLOWS.id]: { version: "0.0.1" } }, enabledPlugins: new Set([FLOWS.id]) };
  let state = detectFlows(pm, 1);
  const { ctx } = fakeCtx();
  ctx.flows = () => state;
  const calls: string[] = [];
  ctx.run = { ...ctx.run, openPluginPage: id => { calls.push(`plugin:${id}`); }, updateHost: () => { calls.push("host"); } } as TabContext["run"];
  const setting = fakeSetting();
  (D.flowsPage(ctx).items as Node[])[0]!.render(setting);
  await setting.buttons[0]!.click();
  expect(calls).toEqual([`plugin:${FLOWS.id}`]);
  state = detectFlows(pm, 0);
  await setting.buttons[0]!.click();
  state = detectFlows(pm, 1, { version: "0.1.0", requiredHostMinor: 2 });
  await setting.buttons[0]!.click();
  expect(calls).toEqual([`plugin:${FLOWS.id}`, "host", "host"]);
});

describe("copy rules", () => {
  /** Capitalised words allowed after the first: product, plugin and format names. */
  const PROPER = new Set([
    "Pele", "Mehrpele", "Mermaid", "Markdown", "Canvas", "Excalidraw", "Bases", "Gantt", "Graph", "Jev", "Ollama",
    "Obsidian", "Lucide", "Datacore", "Breadcrumbs", "TaskNotes", "Flows",
  ]);
  const BADGE = / (Desktop only|Needs [^.]+)\.$/;

  function names(): { name: string; desc?: string }[] {
    const { ctx } = fakeCtx({ v3: everythingOn() });
    return all(D.buildDefinitions(ctx)).flatMap((n) => {
      const name = n.name ?? n.heading;
      return typeof name === "string" ? [{ name, desc: n.desc }] : [];
    });
  }

  test("names: sentence case, at most 40 characters, never 'settings'", () => {
    const bad: string[] = [];
    for (const { name } of names()) {
      const words = name.split(/\s+/).map((w) => w.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, ""));
      const ok =
        name.length <= 40 &&
        !/settings/i.test(name) &&
        /^\p{Lu}/u.test(words[0]!) &&
        words.slice(1).every((w) => !/^\p{Lu}/u.test(w) || PROPER.has(w) || /^[\p{Lu}\d]{2,}$/u.test(w));
      if (!ok) bad.push(name);
    }
    expect(bad).toEqual([]);
  });

  test("descriptions are one sentence (badges aside)", () => {
    const bad: string[] = [];
    for (const { name, desc } of names()) {
      if (typeof desc !== "string" || desc === "") continue;
      let d = desc;
      while (BADGE.test(d)) d = d.replace(BADGE, "");
      if (!d.endsWith(".") || /[.!?]\s+\p{Lu}/u.test(d)) bad.push(`${name}: ${desc}`);
    }
    expect(bad).toEqual([]);
  });
});

function everythingOn(): SettingsV3 {
  const v3 = schema.defaultSettingsV3();
  for (const id of schema.TOGGLE_IDS) schema.setEnabledV3(v3, id, true);
  return v3;
}

describe("visible chains", () => {
  test("sub-options follow their parent toggle", () => {
    const { ctx, v3 } = fakeCtx({ v3: everythingOn() });
    const defs = D.buildDefinitions(ctx);
    const chains: [string, (on: boolean) => void][] = [
      ["features.live-view.maxEmbedWidth", (on) => void (v3.features["live-view"].embeds = on)],
      ["features.live-view.maxEmbedHeight", (on) => void (v3.features["live-view"].embeds = on)],
      ["Allowed URL schemes", (on) => void (v3.features["view-nodes"].webEnabled = on)],
      ["features.repair.jev.keySecretId", (on) => void (v3.features.repair.jev.enabled = on)],
      ["features.repair.jev.baseUrl", (on) => void (v3.features.repair.jev.enabled = on)],
      ["features.repair.jev.model", (on) => void (v3.features.repair.jev.enabled = on)],
      ["core.security.commandAllowlist", (on) => void (v3.core.security.allowCommandUris = on)],
      ["features.reflow.minTextScale", (on) => void (v3.features.reflow.enabled = on)],
      ["features.integrations.maxNodes", (on) => {
        v3.features.integrations.datacore.enabled = on;
        v3.features.integrations.breadcrumbs.enabled = on;
        v3.features.integrations.tasknotes.enabled = on;
      }],
      ["llm.baseUrl", (on) => void (v3.llm.provider = on ? "openai" : "anthropic")],
      ["llm.anthropicKeySecretId", (on) => void (v3.llm.provider = on ? "anthropic" : "openai")],
    ];
    for (const [key, setOn] of chains) {
      const n = key.includes(".") ? byKey(defs, key) : byName(defs, key);
      setOn(false);
      expect({ key, shown: shown(defs, n) }).toEqual({ key, shown: false });
      setOn(true);
      expect({ key, shown: shown(defs, n) }).toEqual({ key, shown: true });
    }
  });

  test("the AI provider page shows while repair rewrites with a model or autocomplete is on", () => {
    const { ctx, v3 } = fakeCtx();
    const defs = D.buildDefinitions(ctx);
    const page = byName(defs, "AI model provider");
    expect(page.visible()).toBe(false);
    v3.features.repair.enabled = true;
    expect(page.visible()).toBe(false);
    v3.features.repair.llm = true;
    expect(page.visible()).toBe(true);
    v3.features.repair.enabled = false;
    v3.features.autocomplete.enabled = true;
    expect(page.visible()).toBe(true);
  });

  test("the sanitising warning shows only while sanitising is off", () => {
    const { ctx, v3 } = fakeCtx();
    const defs = D.buildDefinitions(ctx);
    const warn = byName(defs, "SVG sanitising is off");
    expect(warn.visible()).toBe(false);
    v3.core.security.sanitize = false;
    expect(warn.visible()).toBe(true);
    const s = fakeSetting();
    warn.render(s);
    expect(s.classes).toEqual(["mehrpele-warning"]);
  });

  test("the Ollama model picker shows only with models to pick", () => {
    const v3 = schema.defaultSettingsV3();
    v3.llm.provider = "openai";
    expect(byName(D.buildDefinitions(fakeCtx({ v3 }).ctx), "Ollama model").visible()).toBe(false);
    const row = byName(D.buildDefinitions(fakeCtx({ v3, models: ["llama3"] }).ctx), "Ollama model");
    expect(row.visible()).toBe(true);
    expect(row.searchable).toBe(false);
  });
});

describe("desktop-only rows", () => {
  test("disabled with a badge on mobile, enabled on desktop", () => {
    const { ctx } = fakeCtx({ v3: everythingOn() });
    const defs = D.buildDefinitions(ctx);
    const rows = [byKey(defs, "features.view-nodes.webEnabled"), byKey(defs, "features.cli.enabled")];
    for (const r of rows) {
      expect(r.desc).toContain(D.DESKTOP_ONLY);
      expect(r.control.disabled()).toBe(false);
    }
    Platform.isMobile = true;
    for (const r of rows) expect(r.control.disabled()).toBe(true);
  });
});

describe("secret rows on apps before 1.13.2", () => {
  afterEach(() => {
    apiGate.ok = () => true;
    SecretComponent.made = [];
  });

  /** Name → key of every secret control, as 1.13.2+ builds them. */
  const secretRows = () =>
    Object.fromEntries(all(D.buildDefinitions(fakeCtx().ctx)).filter((n) => n.control?.type === "secret").map((n) => [String(n.name), String(n.control.key)]));

  test("1.13.2+ uses the secret control for every key-reference setting", () => {
    const keys = all(D.buildDefinitions(fakeCtx().ctx)).map((n) => n.control?.key).filter((k) => /keySecretId$/i.test(String(k)));
    expect(keys).toHaveLength(3);
    expect(Object.values(secretRows()).sort()).toEqual(keys.sort());
  });

  test("older apps get a SecretComponent row on the same key, never a text control", () => {
    const rows = secretRows();
    apiGate.ok = (v) => v !== "1.13.2";
    const { ctx, v3 } = fakeCtx();
    const defs = D.buildDefinitions(ctx);
    expect(all(defs).filter((n) => /keySecretId$/i.test(String(n.control?.key ?? "")))).toEqual([]);
    for (const [name, key] of Object.entries(rows)) {
      writeControl(v3, key, "stored-id");
      const row = byName(defs, name);
      expect(row.control).toBeUndefined();
      const els: unknown[] = [];
      row.render({ controlEl: {}, addComponent: (cb: (el: unknown) => unknown) => void els.push(cb(els.length)) });
      const sc = SecretComponent.made.at(-1)!;
      expect(els).toEqual([sc]);
      expect(sc.app).toBe(ctx.app);
      expect(sc.value).toBe("stored-id");
      sc.change!("picked-secret");
      expect(readControl(v3, key)).toBe("picked-secret");
      sc.change!("");
      expect(readControl(v3, key)).toBe("picked-secret");
    }
  });
});

describe("Features filter", () => {
  const list = byName(D.buildDefinitions(fakeCtx().ctx), "Features");
  const match = (q: string) => (list.items as Node[]).filter((n) => list.search.match(n, q)).map((n) => n.name);

  test("is one list with a search and muted category rows that skip the filter", () => {
    expect(list.type).toBe("list");
    const cats = (list.items as Node[]).filter((n) => n.categoryPages);
    expect(cats.map((c) => c.name)).toEqual(["Viewing", "Layout", "Editing", "Markdown labels", "Repair", "Convert", "Integrations", "Desktop"]);
    for (const c of cats) {
      expect(c.searchable).toBe(false);
      const s = fakeSetting();
      c.render(s);
      expect(s.classes).toEqual(["mehrpele-category"]);
    }
  });

  test("an alias finds its page and its category; an empty query shows everything", () => {
    expect(match("palette")).toEqual(["Editing", "Editing toolbar"]);
    expect(match("PALETTE ")).toEqual(["Editing", "Editing toolbar"]);
    expect(match("")).toEqual((list.items as Node[]).map((n) => n.name));
  });

  test("children's names count too", () => {
    // "Smallest text size" is an option inside the reflow page.
    expect(match("smallest text")).toEqual(["Layout", "Fit diagrams to the column"]);
    expect(match("ollama")).toEqual(["Repair", "AI model provider"]);
  });
});

describe("folds", () => {
  function fakeButton(groupEl: { classes: Set<string> }, cls: string) {
    const b: any = {
      attrs: {} as Record<string, string>,
      setIcon: (i: string) => ((b.icon = i), b),
      setTooltip: (t: string) => ((b.tooltip = t), b),
      onClick: (fn: () => void) => ((b.click = fn), b),
    };
    b.extraSettingsEl = {
      setAttribute: (k: string, v: string) => void (b.attrs[k] = v),
      closest: (sel: string) =>
        sel === `.${cls}`
          ? { classList: { toggle: (c: string, on: boolean) => void (on ? groupEl.classes.add(c) : groupEl.classes.delete(c)) } }
          : null,
    };
    return b;
  }

  test("FoldState reads and writes local storage", () => {
    const store = new Map<string, unknown>([[FOLDS_KEY, ["security", 3]]]);
    const ls = { loadLocalStorage: (k: string) => store.get(k), saveLocalStorage: (k: string, d: unknown) => void store.set(k, d) };
    const f = new FoldState(ls);
    expect(f.isFolded("security")).toBe(true);
    expect(f.isFolded("learn")).toBe(false);
    f.set("learn", true);
    f.set("advanced", true);
    expect(store.get(FOLDS_KEY)).toEqual(["advanced", "learn", "security"]);
    f.set("security", false);
    expect(new FoldState(ls).isFolded("security")).toBe(false);
    expect(new FoldState({ loadLocalStorage: () => "junk", saveLocalStorage: () => {} }).isFolded("junk")).toBe(false);
  });

  test("search navigation into a folded section clicks its chevron open", () => {
    let clicks = 0;
    const chevron = { click: () => void clicks++ };
    const group = { querySelector: (sel: string) => (sel.includes("[aria-expanded='false']") ? chevron : null) };
    const row = (folded: boolean) => ({ closest: (sel: string) => (folded && sel === `.${FOLDED_CLASS}` ? group : null) }) as unknown as Element;
    revealFolded(row(false));
    revealFolded(undefined);
    expect(clicks).toBe(0);
    revealFolded(row(true));
    expect(clicks).toBe(1);
  });

  test("every section has a chevron that folds by class and remembers it", () => {
    const g = globalThis as { window?: unknown };
    const hadWindow = "window" in g;
    const savedWindow = g.window;
    g.window = { setTimeout: (fn: () => void) => fn() };
    try {
      const { ctx, store } = fakeCtx({ folded: ["appearance"] });
      const groups = (D.buildDefinitions(ctx) as Node[]).filter((n) => n.cls?.startsWith("mehrpele-section-"));
      expect(groups.map((g) => g.cls.slice("mehrpele-section-".length))).toEqual([...D.SECTIONS]);
      const appearance = groups[0]!;
      const el = { classes: new Set<string>() };
      const b = fakeButton(el, appearance.cls);
      appearance.extraButtons[0](b);
      expect(b.icon).toBe("chevron-right");
      expect(b.attrs["aria-expanded"]).toBe("false");
      expect(el.classes.has(FOLDED_CLASS)).toBe(true);
      // Folding never hides items through `visible`, so search still finds them.
      expect(appearance.visible).toBeUndefined();
      b.click();
      expect(b.icon).toBe("chevron-down");
      expect(b.tooltip).toBe("Hide appearance");
      expect(b.attrs["aria-expanded"]).toBe("true");
      expect(el.classes.has(FOLDED_CLASS)).toBe(false);
      expect(store.get(FOLDS_KEY)).toEqual([]);
    } finally {
      if (hadWindow) g.window = savedWindow;
      else delete g.window;
    }
  });
});

describe("tour notes", () => {
  // The tour downloads through assets.ts, which uses window timers as Obsidian requires; bun has no `window`.
  const g = globalThis as { window?: unknown };
  const hadWindow = "window" in g;
  beforeAll(() => { if (!hadWindow) g.window = globalThis; });
  afterAll(() => { if (!hadWindow) delete g.window; });
  const enc = new TextEncoder();
  const PACK = { version: "0.1.0", notes: [{ path: "00 Welcome.md", content: "# Hi" }, { path: "01 Diagrams.md", content: "# D" }] };
  const BYTES = enc.encode(JSON.stringify(PACK)).buffer as ArrayBuffer;

  function deps() {
    const files = new Map<string, string>();
    const trashed: string[] = [];
    const cache = new Map<string, ArrayBuffer>();
    const vault = {
      getAbstractFileByPath: (p: string) => (files.has(p) ? { path: p } : [...files.keys()].some((f) => f.startsWith(`${p}/`)) ? { path: p } : null),
      getFiles: () => [...files.keys()].map((path) => ({ path })),
      createFolder: async () => {},
      create: async (p: string, d: string) => void files.set(p, d),
      read: async (f: unknown) => files.get((f as { path: string }).path)!,
      trash: async (f: unknown) => {
        trashed.push((f as { path: string }).path);
        files.delete((f as { path: string }).path);
      },
    };
    const adapter = {
      exists: async (p: string) => cache.has(p),
      readBinary: async (p: string) => cache.get(p)!,
      writeBinary: async (p: string, d: ArrayBuffer) => void cache.set(p, d),
      mkdir: async () => {},
    };
    return { files, trashed, vault, adapter };
  }

  test("Install and Remove buttons reach the tour, and Remove keeps edited notes", async () => {
    const pins = { [TOUR_ASSET]: { sha256: await sha256Hex(BYTES), bytes: BYTES.byteLength } };
    const { files, trashed, vault, adapter } = deps();
    let downloads = 0;
    const d = { vault, adapter, dir: ".obsidian/plugins/mehrpele", version: "0.1.0", pins, get: async () => (downloads++, { status: 200, arrayBuffer: BYTES }) };
    const r = await installTour(d);
    expect(r.created).toEqual(["Mehrpele tour/00 Welcome.md", "Mehrpele tour/01 Diagrams.md"]);
    files.set("Mehrpele tour/01 Diagrams.md", "# D\n\nmine");
    const removed = await removeTour(d);
    expect(downloads).toBe(1); // the second call reads the cached pack
    expect(trashed).toEqual(["Mehrpele tour/00 Welcome.md"]);
    expect(removedMessage(removed)).toBe("Mehrpele: removed 1 tour notes. Kept 1 you edited.");
    expect(removedMessage({ removed: ["a", "b"], kept: [] })).toBe("Mehrpele: removed 2 tour notes.");

    const { ctx, runs } = fakeCtx();
    const row = byName(D.buildDefinitions(ctx), "Tour notes");
    const s = fakeSetting();
    row.render(s);
    expect(s.buttons.map((b) => b.text)).toEqual(["Install", "Remove"]);
    for (const b of s.buttons) b.click();
    expect(runs).toEqual(["installTour", "removeTour"]);
  });
});

describe("sanitize notice on migration", () => {
  function host(data: unknown) {
    const saved: unknown[] = [];
    return {
      saved,
      h: {
        loadData: async () => data,
        saveData: async (d: unknown) => void saved.push(JSON.parse(JSON.stringify(d))),
        manifest: { dir: ".obsidian/plugins/mehrpele" },
        app: { vault: { configDir: ".obsidian", adapter: { exists: async () => false, read: async () => "" } } },
      },
    };
  }

  test("fires once, on the v2 load that turned sanitising off, never again", async () => {
    const first = host({ settingsVersion: 2, sanitizeSvg: false });
    const notes: string[] = [];
    await loadSettings(first.h, (m) => notes.push(m));
    expect(notes).toEqual([NOTICE_MIGRATED, NOTICE_SANITIZE_OFF]);
    const again: string[] = [];
    await loadSettings(host(first.saved[0]).h, (m) => again.push(m));
    expect(again).toEqual([]);
  });

  test("silent when sanitising stays on", async () => {
    const notes: string[] = [];
    await loadSettings(host({ settingsVersion: 2, sanitizeSvg: true }).h, (m) => notes.push(m));
    expect(notes).toEqual([NOTICE_MIGRATED]);
  });
});
