import { expect, test } from "bun:test";
import { BEFORE_CORE, registerBeforeCore } from "../src/processor-order";

// Obsidian 1.15+ renders ```mermaid in Reading view with its own post-processor
// (sortOrder 0, registered before any plugin). Post-processors run sorted by
// sortOrder, ties in registration order, so ours must sort strictly first.
type Proc = { name: string; sortOrder: number };
const runOrder = (procs: Proc[]) => [...procs].sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.name);

test("registers the processor with a sort order ahead of core's", () => {
  const calls: { lang: string; sortOrder?: number }[] = [];
  const plugin = {
    registerMarkdownCodeBlockProcessor: (lang: string, _h: unknown, sortOrder?: number) => {
      calls.push({ lang, sortOrder });
      return {};
    },
  };
  registerBeforeCore(plugin, "mermaid", () => {});
  expect(calls).toEqual([{ lang: "mermaid", sortOrder: BEFORE_CORE }]);
  expect(BEFORE_CORE).toBeLessThan(0);
});

test("our processor runs before core's even though core registered first", () => {
  const procs: Proc[] = [
    { name: "core-mermaid", sortOrder: 0 },
    { name: "pele-mermaid", sortOrder: BEFORE_CORE },
  ];
  expect(runOrder(procs)[0]).toBe("pele-mermaid");
});
