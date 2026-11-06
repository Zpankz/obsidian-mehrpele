/**
 * The lazy-loading tests bundle main.ts through tests/helpers/bundle.ts, and tsc
 * type-checks through tsconfig paths; both must resolve the same pele-render
 * subpaths (and externals) as the shipped build in esbuild.config.mjs.
 */
import { describe, expect, test } from "bun:test";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { ALIAS, EXTERNAL, PKG } from "./helpers/bundle";

const config = await Bun.file(resolve(PKG, "esbuild.config.mjs")).text();
const tsconfig = (await Bun.file(resolve(PKG, "tsconfig.json")).json()) as { compilerOptions: { paths: Record<string, string[]> } };

/** The string-literal entries of the config's `key: [ … ]` / `key: { … }` block. */
function block(key: string, open: string, close: string): string {
  const start = config.indexOf(`${key}: ${open}`);
  expect(start).toBeGreaterThan(-1);
  return config.slice(start, config.indexOf(close, start));
}

describe("build config parity", () => {
  test("bundle helper externals match esbuild.config.mjs", () => {
    const literals = [...block("external", "[", "]").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
    expect(EXTERNAL.filter((e) => !builtins.has(e))).toEqual(literals);
  });

  test("bundle helper and tsconfig alias the same pele-render subpaths as esbuild.config.mjs", () => {
    const aliased = [...block("alias", "{", "}").matchAll(/^\s*"(pele-render\/[^"]+)":/gm)].map((m) => m[1]).sort();
    expect(Object.keys(ALIAS).sort()).toEqual(aliased);
    expect(Object.keys(tsconfig.compilerOptions.paths).filter((k) => k.startsWith("pele-render/")).sort()).toEqual(aliased);
  });
});
