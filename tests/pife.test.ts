/**
 * The build's PIFE pass (scripts/pife.mjs) on real esbuild output: it must
 * find the installed esbuild's minified lazy init helper (the production
 * build's form), wrap only the init arrows, and leave behaviour unchanged.
 */
import { describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { pife } from "../scripts/pife.mjs";

const files: Record<string, string> = {
  "entry.ts": `export function run(): number { const { heavy } = require("./heavy"); return heavy() + [1, 2].map((x) => x * 2).length; }`,
  "heavy.ts": `import { base } from "./base"; export const heavy = (): number => base * 2;`,
  "base.ts": `export const base = 20;`,
};

async function bundle(minify: boolean): Promise<string> {
  const r = await build({
    stdin: { contents: files["entry.ts"]!, resolveDir: "/virtual", loader: "ts" },
    bundle: true,
    format: "cjs",
    minify,
    target: "es2020",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "virtual",
        setup(b) {
          b.onResolve({ filter: /^\.\// }, (a) => ({ path: `${a.path.slice(2)}.ts`, namespace: "v" }));
          b.onLoad({ filter: /.*/, namespace: "v" }, (a) => ({ contents: files[a.path], loader: "ts" }));
        },
      },
    ],
  });
  return r.outputFiles[0]!.text;
}

function run(code: string): number {
  const mod: { exports: { run: () => number } } = { exports: {} as never };
  new Function("require", "module", "exports", code)(require, mod, mod.exports);
  return mod.exports.run();
}

describe("pife build pass", () => {
  test("wraps each lazy init arrow of a minified bundle, nothing else", async () => {
    const code = await bundle(true);
    const { code: out, wrapped } = pife(code);
    expect(wrapped).toBe(2); // heavy.ts and base.ts
    expect(out.length).toBe(code.length + 2 * wrapped);
    expect(out.replace(/[()]/g, "")).toBe(code.replace(/[()]/g, ""));
    expect(run(out)).toBe(run(code));
    expect(run(out)).toBe(42);
  });

  test("an unminified bundle (object-method inits) is left as is", async () => {
    const code = await bundle(false);
    expect(pife(code)).toEqual({ code, wrapped: 0 });
  });

  test("a bundle without lazy modules is left as is", () => {
    const code = `"use strict";var a=(e)=>()=>e;module.exports={run:()=>a(1)()};`;
    expect(pife(code)).toEqual({ code, wrapped: 0 });
  });
});
