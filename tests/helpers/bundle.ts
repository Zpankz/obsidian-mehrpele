/**
 * Builds main.ts the way esbuild.config.mjs does (same externals, aliases,
 * format), in memory, for the lazy-loading tests. tests/build-config-parity.test.ts
 * fails when the two (or tsconfig paths) drift.
 */
import { build, type Metafile, type Plugin } from "esbuild";
import { existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export const PKG = resolve(import.meta.dir, "../..");
// The monorepo reads pele-render from its sibling package; the public export vendors it into lib/pele-render.
const VENDORED = resolve(PKG, "lib/pele-render");
const RENDER = existsSync(VENDORED) ? VENDORED : resolve(PKG, "../pele-render/src");

export const EXTERNAL = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

export const ALIAS = {
  "pele-render/repair": resolve(RENDER, "repair/index.ts"),
  "pele-render/canvas": resolve(RENDER, "canvas/index.ts"),
  "pele-render/pele": resolve(RENDER, "pele.ts"),
  "pele-render/node-size": resolve(RENDER, "node-size/index.ts"),
  "pele-render/reflow": resolve(RENDER, "reflow/index.ts"),
  "pele-render/excalidraw": resolve(RENDER, "excalidraw/index.ts"),
  "pele-render/extract": resolve(RENDER, "extract.ts"),
};

/** Package-relative path, as esbuild's metafile names inputs (`src/x.ts`, `../pele-render/src/y.ts`). */
export const rel = (abs: string): string => relative(PKG, abs).split("\\").join("/");

/**
 * Feature code: reachable only through src/features (the
 * registry's dynamic imports and the sync accessors in src/features/lazy.ts).
 */
export const FEATURE_CODE: readonly RegExp[] = [
  /^src\/edit\//,
  /^src\/mehrpele\//,
  /^src\/materialise\//,
  /^src\/integrations\//,
  /^src\/cli\//,
  /^src\/canvas\//,
  /^src\/repair\//,
  /^src\/excalidraw\//,
  // The Excalidraw converter (feature "excalidraw").
  /^(\.\.\/pele-render\/src|lib\/pele-render)\/excalidraw\//,
  // The canvas converter entry (core reaches its layout helpers via pele.ts, reflow and repair).
  /^(\.\.\/pele-render\/src|lib\/pele-render)\/canvas\/index\.ts$/,
];

/**
 * Feature-folder modules the core may load eagerly: settings data (defaults,
 * normalisers) and the pure SettingsV3 → runtime derivations (`xOptions(v3)`),
 * which import no feature UI or behaviour. Each entry must stay import-light; the spy test lists
 * what they pull in.
 */
export const EAGER_ALLOWED: ReadonlySet<string> = new Set([
  "src/edit/settings.ts",
  "src/integrations/settings.ts",
  "src/materialise/plan.ts",
  "src/materialise/settings.ts",
  "src/mehrpele/settings.ts",
  "src/mehrpele/views/settings.ts",
]);

export const isFeatureCode = (path: string): boolean =>
  !EAGER_ALLOWED.has(path) && FEATURE_CODE.some((re) => re.test(path));

/** Prepends `globalThis.__peleInit.push(path)` to every bundled source module: its body ran. */
const spyPlugin: Plugin = {
  name: "module-init-spy",
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, async (args) => {
      const path = rel(args.path);
      if (path.includes("node_modules/")) return undefined;
      const text = await readFile(args.path, "utf8");
      return { contents: `globalThis.__peleInit?.push(${JSON.stringify(path)});\n${text}`, loader: "ts" };
    });
  },
};

export async function bundleMain(opts: { spy?: boolean } = {}): Promise<{ code: string; metafile: Metafile }> {
  const r = await build({
    absWorkingDir: PKG,
    entryPoints: ["main.ts"],
    bundle: true,
    external: EXTERNAL,
    format: "cjs",
    alias: ALIAS,
    target: "es2020",
    treeShaking: true,
    write: false,
    metafile: true,
    logLevel: "silent",
    plugins: opts.spy ? [spyPlugin] : [],
  });
  return { code: r.outputFiles[0]!.text, metafile: r.metafile };
}

/** Inputs reachable from main.ts through static `import` statements only (what runs at module eval). */
export function eagerInputs(metafile: Metafile): Set<string> {
  const seen = new Set<string>();
  const stack = ["main.ts"];
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    for (const imp of metafile.inputs[p]?.imports ?? []) {
      if (imp.kind === "import-statement" && !imp.external) stack.push(imp.path);
    }
  }
  return seen;
}
