/**
 * The shared 1-click repair outcome (src/repair/apply.ts) used by frames and
 * Mehrpele shells: no-op, write-back failure, applied summary and its notices.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { RepairResult } from "pele-render/repair";
import { obsidianStub } from "./helpers/obsidian-stub";

mock.module("obsidian", () => obsidianStub);

const { applyRepairResult, repairSummary } = await import("../src/repair/apply");

const Notice = obsidianStub.Notice as { shown: string[] };

/** Settings with every review trigger off (linter tier, no preview). */
const plugin = {
  app: {},
  settings: { features: { repair: { preview: false, enabled: true, llm: false, jev: {} } }, llm: {} },
} as unknown as Parameters<typeof applyRepairResult>[0];

function target(source: string, applies = true) {
  const writes: string[] = [];
  return {
    writes,
    source,
    applyRepaired: async (next: string) => {
      writes.push(next);
      return applies;
    },
  };
}

const ok = (source: string, extra: Partial<RepairResult> = {}): RepairResult =>
  ({ ok: true, source, tier: "linter", fixes: ["quoted label"], attempts: [], ...extra }) as RepairResult;

beforeEach(() => {
  Notice.shown.length = 0;
});

describe("applyRepairResult", () => {
  test("an unchanged result reports the diagram as valid and writes nothing", async () => {
    const t = target("flowchart LR\n  A --> B");
    expect(await applyRepairResult(plugin, t, ok(t.source))).toBeNull();
    expect(await applyRepairResult(plugin, t, ok("other", { unchanged: true }))).toBeNull();
    expect(t.writes).toEqual([]);
    expect(Notice.shown).toEqual(["Pele: diagram is already valid.", "Pele: diagram is already valid."]);
  });

  test("a failed result opens the failure modal and writes nothing", async () => {
    const t = target("broken");
    const failed = { ok: false, fixes: [], attempts: [{ tier: "linter" }] } as unknown as RepairResult;
    expect(await applyRepairResult(plugin, t, failed)).toBeNull();
    expect(t.writes).toEqual([]);
    expect(Notice.shown).toEqual([]);
  });

  test("a write-back miss says nothing changed", async () => {
    const t = target("broken", false);
    expect(await applyRepairResult(plugin, t, ok("fixed"))).toBeNull();
    expect(t.writes).toEqual(["fixed"]);
    expect(Notice.shown).toEqual(["Pele: could not locate that diagram to apply the repair; nothing changed."]);
  });

  test("an applied repair returns the replaced source and summary, leaving the notice to the caller", async () => {
    const t = target("broken");
    expect(await applyRepairResult(plugin, t, ok("fixed"))).toEqual({
      oldSource: "broken",
      summary: "Repaired by linter: quoted label",
    });
    expect(t.writes).toEqual(["fixed"]);
    expect(Notice.shown).toEqual([]);
  });
});

describe("repairSummary", () => {
  test("joins fixes, defaults the tier and notes lossy drops", () => {
    expect(repairSummary({ fixes: ["a", "b"] })).toBe("Repaired by linter: a; b");
    expect(repairSummary({ tier: "jev", fixes: [] })).toBe("Repaired by jev: fixed");
    expect(repairSummary({ fixes: ["a"], lossy: true, dropped: ["x", "y"] })).toBe(
      "Repaired by linter: a (lossy): removed/commented x, y",
    );
    expect(repairSummary({ fixes: [], lossy: true, dropped: [] })).toBe("Repaired by linter: fixed (lossy): removed/commented content");
  });
});
