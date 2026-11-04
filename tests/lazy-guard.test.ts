/**
 * Feature code loads only through src/features: never through a static
 * import that the plugin's module eval would run.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { Metafile } from "esbuild";
import { bundleMain, eagerInputs, isFeatureCode } from "./helpers/bundle";

let metafile: Metafile;
beforeAll(async () => {
  ({ metafile } = await bundleMain());
}, 60_000);

describe("lazy guard", () => {
  test("no feature module is statically reachable from main.ts", () => {
    const reach = eagerInputs(metafile);
    const eager = [...reach].filter(isFeatureCode).sort();
    // Where core code imports feature code statically: the edges to cut.
    const cuts = eager.flatMap((p) => {
      const from = [...reach].filter(
        (k) => !isFeatureCode(k) && metafile.inputs[k]?.imports.some((x) => x.path === p && x.kind === "import-statement"),
      );
      return from.length ? [`${p} <- ${from.join(", ")}`] : [];
    });
    expect(cuts).toEqual([]);
    expect(eager).toEqual([]);
  });

  test("feature entries (src/features/register-*) are imported only by the registry, dynamically", () => {
    const bad: string[] = [];
    for (const [from, input] of Object.entries(metafile.inputs)) {
      for (const imp of input.imports) {
        if (!/^src\/features\/register-/.test(imp.path)) continue;
        if (from !== "src/features/registry.ts" || imp.kind !== "dynamic-import") bad.push(`${from} -(${imp.kind})-> ${imp.path}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("the registry has feature entries to load", () => {
    const entries = Object.keys(metafile.inputs).filter((p) => /^src\/features\/register-/.test(p));
    expect(entries.length).toBeGreaterThan(0);
  });
});
