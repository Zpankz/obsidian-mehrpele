/** FeatureRegistry: load on, unload off, reload-needed, companion adopt, toggles flipped mid-load. */
import { describe, expect, mock, test } from "bun:test";
import { Component, Notice, Plugin, obsidianStub } from "./helpers/obsidian-stub";

mock.module("obsidian", () => obsidianStub);
const { FeatureRegistry } = await import("../src/features/registry");
type Def = import("../src/features/types").FeatureDef;

function setup(defs: Def[], on: Set<string>) {
  const plugin = new Plugin({}, { id: "mehrpele" }) as any;
  plugin.load();
  const reg = new FeatureRegistry(plugin, (id) => on.has(id), defs);
  plugin.addChild(reg);
  return { plugin, reg };
}

const loads: string[] = [];
const commandFeature = (id: any, extra: Partial<Def> = {}): Def => ({
  id,
  name: id,
  kind: "module",
  load: async () => {
    loads.push(id);
    return { register: ({ plugin }) => void plugin.addCommand({ id: `${id}-cmd`, name: id }) };
  },
  ...extra,
} as Def);

describe("FeatureRegistry", () => {
  test("loads only what is on; turning off unloads and removes its commands", async () => {
    loads.length = 0;
    const on = new Set(["repair"]);
    const { plugin, reg } = setup([commandFeature("repair"), commandFeature("canvas")], on);
    await reg.sync();
    expect(loads).toEqual(["repair"]);
    expect([...plugin.commands.keys()]).toEqual(["mehrpele:repair-cmd"]);
    on.delete("repair");
    on.add("canvas");
    await reg.sync();
    expect(reg.active()).toEqual(["canvas"]);
    expect([...plugin.commands.keys()]).toEqual(["mehrpele:canvas-cmd"]);
  });

  test("on/off cycles leave no command cleanups on the plugin; each command is removed once", async () => {
    const on = new Set(["canvas"]);
    const { plugin, reg } = setup([commandFeature("canvas")], on);
    const base = plugin._cleanups.length;
    for (let i = 0; i < 3; i++) {
      on.add("canvas");
      await reg.sync();
      expect(plugin.commands.has("mehrpele:canvas-cmd")).toBe(true);
      on.delete("canvas");
      await reg.sync();
      expect(plugin.commands.has("mehrpele:canvas-cmd")).toBe(false);
      expect(plugin._cleanups.length).toBe(base);
    }
    expect(plugin.removed).toEqual(["mehrpele:canvas-cmd", "mehrpele:canvas-cmd", "mehrpele:canvas-cmd"]);
  });

  test("a feature turned off while loading never registers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const on = new Set(["repair"]);
    const def: Def = {
      id: "repair",
      name: "Repair",
      kind: "module",
      load: async () => {
        await gate;
        return { register: ({ plugin }) => void plugin.addCommand({ id: "late", name: "late" }) };
      },
    };
    const { plugin, reg } = setup([def], on);
    const done = reg.sync();
    on.delete("repair");
    release();
    await done;
    expect(reg.active()).toEqual([]);
    expect(plugin.commands.has("mehrpele:late")).toBe(false);
  });

  test("a feature whose register throws is not left half-running", async () => {
    const before = Component.domEvents.length;
    const def: Def = {
      id: "view-nodes",
      name: "View nodes",
      kind: "module",
      load: async () => ({
        register: ({ plugin }) => {
          plugin.registerDomEvent({} as any, "pointermove", () => {});
          expect(Component.domEvents.length).toBe(before + 1);
          throw new Error("boom");
        },
      }),
    };
    const { reg } = setup([def], new Set(["view-nodes"]));
    const err = console.error;
    console.error = () => {};
    try {
      await reg.sync();
    } finally {
      console.error = err;
    }
    expect(reg.active()).toEqual([]);
    expect(Component.domEvents.length).toBe(before);
    expect(Notice.shown.some((m) => m.includes("View nodes could not start"))).toBe(true);
  });

  test("adopt: a companion's dispose runs once, on disposer or host unload", () => {
    const { plugin, reg } = setup([], new Set());
    let a = 0;
    let b = 0;
    const off = reg.adopt({ id: "x", name: "X", version: "1", requiredHostMinor: 0, dispose: () => void a++ });
    reg.adopt({ id: "y", name: "Y", version: "1", requiredHostMinor: 0, dispose: () => void b++ });
    off();
    off();
    expect(a).toBe(1);
    plugin.unload();
    expect(b).toBe(1);
    expect(a).toBe(1);
  });
});
