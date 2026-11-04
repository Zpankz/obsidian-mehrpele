import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Community-store lint: a mobile-capable plugin (isDesktopOnly:false) must not use Node or
// Electron, must not install files outside the vault, must not build DOM from HTML strings,
// and must not ship sample-plugin code. Self-contained so it ships with the public export.

const root = join(import.meta.dir, "..");

const NODE_MODULES =
  "fs|os|path|child_process|electron|crypto|http|https|net|tls|dns|url|util|stream|zlib|worker_threads|process|buffer|events|readline|assert|vm|module|perf_hooks";
// Module names unambiguous enough to flag whatever function is called with them (aliased requires).
const ALIASED_MODULES = "electron|@electron/[\\w-]+|child_process|fs|fs/promises|original-fs|os";
// Globals a plugin can reach `require` or `electron` through.
const GLOBALS = "(?:window|activeWindow|globalThis|self)";

type Rule = { id: string; re: RegExp; bundle?: boolean };

const RULES: Rule[] = [
  {
    id: "node-require",
    re: new RegExp(`(?<![\\w$.])(?:__)?require\\s*(?:\\?\\.)?\\s*\\(\\s*["'\`](?:node:)?(?:${NODE_MODULES}|@electron/[\\w-]+)(?:/[\\w/]+)?["'\`]\\s*\\)`),
    bundle: true,
  },
  {
    id: "aliased-require",
    re: new RegExp(`(?<![\\w$.])[A-Za-z_$][\\w$]*\\s*(?:\\?\\.)?\\s*\\(\\s*["'\`](?:node:[\\w/]+|${ALIASED_MODULES})["'\`]\\s*\\)`),
    bundle: true,
  },
  {
    id: "window-require",
    // Also the TypeScript cast form: (window as unknown as { require: … }).require("os")
    re: new RegExp(
      `\\b${GLOBALS}\\s*(?:\\?\\.|\\.)\\s*require\\b|\\b${GLOBALS}\\s*\\[\\s*["'\`]require["'\`]\\s*\\]|\\(\\s*${GLOBALS}\\s+as\\b[\\s\\S]{0,400}?\\)\\s*\\??\\.\\s*require\\b`,
    ),
    bundle: true,
  },
  {
    id: "electron-global",
    re: new RegExp(`\\b${GLOBALS}\\s*(?:\\?\\.|\\.)\\s*electron\\b|\\bipcRenderer\\b`),
    bundle: true,
  },
  { id: "node-import", re: new RegExp(`\\bfrom\\s*["'](?:node:[\\w/]+|@electron/[\\w-]+|(?:${NODE_MODULES})(?:/[\\w/]+)?)["']`) },
  { id: "outside-vault", re: /\.local\/bin|\bchmod(?:Sync)?\b|\bexecFile(?:Sync)?\b/, bundle: true },
  { id: "plugins-dir", re: /configDir\s*\}?\s*(?:\+\s*)?["'`]?\/plugins\b/ },
  { id: "html-sink", re: /\.innerHTML\s*[+]?=(?!=)|\.outerHTML\s*[+]?=(?!=)|\binsertAdjacentHTML\s*\(/ },
  { id: "sample-code", re: /\bMyPlugin\b|\bSampleSettingTab\b|\bSampleModal\b|Sample Plugin|\bmySetting\b/ },
];

// Read-only: Extended Graph's data.json (merged into settings) and the old
// pele-mermaid data.json (one-time import in settings/load.ts). Neither writes there.
const PLUGINS_DIR_READERS = new Set(["src/integrations/extended-graph/index.ts", "src/settings/load.ts"]);

/** Strip // and /* *\/ comments so docs that mention a banned API don't trip the lint. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

export function storeViolations(text: string, opts: { bundle?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const r of RULES) if ((!opts.bundle || r.bundle) && r.re.test(text)) out.push(r.id);
  return out;
}

function sourceFiles(): string[] {
  const out = [join(root, "main.ts")];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
    }
  };
  walk(join(root, "src"));
  return out;
}

describe("store-lint scanner", () => {
  test("catches aliased and optional-call requires of Node and Electron", () => {
    expect(storeViolations('const req = window.require; req?.("electron")')).toEqual(
      expect.arrayContaining(["aliased-require", "window-require"]),
    );
    expect(storeViolations('t?.("electron")')).toEqual(["aliased-require"]);
    expect(storeViolations('require?.("child_process")')).toContain("node-require");
    expect(storeViolations('__require("node:fs/promises")')).toContain("node-require");
    expect(storeViolations('window["require"]')).toEqual(["window-require"]);
    expect(storeViolations('(window as unknown as { require: (m: string) => unknown }).require')).toEqual(["window-require"]);
    expect(storeViolations("window.electron.ipcRenderer.send('x')")).toContain("electron-global");
    expect(storeViolations('activeWindow.require("fs")')).toEqual(["window-require"]);
    expect(storeViolations('globalThis.require("os")')).toEqual(["window-require"]);
    expect(storeViolations('self?.require("child_process")')).toEqual(["window-require"]);
    expect(storeViolations('(activeWindow as any).require')).toEqual(["window-require"]);
    expect(storeViolations("activeWindow.electron")).toEqual(["electron-global"]);
    expect(storeViolations('require("@electron/remote")')).toEqual(expect.arrayContaining(["node-require"]));
    expect(storeViolations('r("@electron/remote")')).toEqual(["aliased-require"]);
    expect(storeViolations('import { app } from "@electron/remote";')).toEqual(["node-import"]);
    expect(storeViolations('import { ipcRenderer } from "electron";')).toEqual(
      expect.arrayContaining(["electron-global", "node-import"]),
    );
    expect(storeViolations('import * as fs from "node:fs";')).toEqual(["node-import"]);
  });
  test("catches installs outside the vault and HTML sinks", () => {
    expect(storeViolations("fs.chmodSync(dest, 0o755)")).toContain("outside-vault");
    expect(storeViolations("`${home}/.local/bin/pele-render`")).toContain("outside-vault");
    expect(storeViolations("cp.execFile(cmd, args)")).toContain("outside-vault");
    expect(storeViolations("`${app.vault.configDir}/plugins/x`")).toEqual(["plugins-dir"]);
    expect(storeViolations("el.innerHTML = s")).toEqual(["html-sink"]);
    expect(storeViolations("el.insertAdjacentHTML('beforeend', s)")).toEqual(["html-sink"]);
    expect(storeViolations("class MyPlugin extends Plugin {}")).toEqual(["sample-code"]);
  });
  test("leaves look-alikes alone", () => {
    expect(
      storeViolations(
        'el.getAttribute("path"); x.require("fs"); requires("path"); const h = svg.outerHTML; if (a.innerHTML === b) {} t("events")',
      ),
    ).toEqual([]);
  });
});

describe("store-lint over the plugin source", () => {
  for (const file of sourceFiles()) {
    const rel = relative(root, file);
    test(rel, () => {
      let hits = storeViolations(stripComments(readFileSync(file, "utf8")));
      if (PLUGINS_DIR_READERS.has(rel)) hits = hits.filter((h) => h !== "plugins-dir");
      expect(hits).toEqual([]);
    });
  }
});

describe("store-lint over the built bundle", () => {
  const bundle = join(root, "main.js");
  const newest = Math.max(...sourceFiles().map((f) => statSync(f).mtimeMs));
  const fresh = existsSync(bundle) && statSync(bundle).mtimeMs >= newest;
  const required = process.env.STORE_LINT_REQUIRE_BUNDLE === "1";
  test.skipIf(!fresh && !required)("main.js uses no Node, Electron or out-of-vault installs", () => {
    expect(existsSync(bundle)).toBe(true);
    expect(storeViolations(readFileSync(bundle, "utf8"), { bundle: true })).toEqual([]);
  });
});

describe("manifest fields", () => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  test("id, name, minAppVersion and mobile support", () => {
    expect(manifest).toMatchObject({ id: "mehrpele", name: "Mehrpele", minAppVersion: "1.13.1", isDesktopOnly: false });
  });
  test("description ≤ 250 chars and ends with a period", () => {
    expect(manifest.description.length).toBeLessThanOrEqual(250);
    expect(manifest.description.endsWith(".")).toBe(true);
  });
  test("versions.json and LICENSE ship beside the manifest", () => {
    expect(existsSync(join(root, "versions.json"))).toBe(true);
    expect(readFileSync(join(root, "LICENSE"), "utf8")).toMatch(/MIT License/);
  });
});
