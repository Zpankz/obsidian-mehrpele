/** Feature off/on cycles leave nothing behind. */
import { describe, expect, mock, test } from "bun:test";
import { Component, Plugin, obsidianStub } from "./helpers/obsidian-stub";

mock.module("obsidian", () => obsidianStub);
const { scopedPlugin } = await import("../src/features/registry");
const { materialiseFor } = await import("../src/materialise/index");
const { registerEmbedRenderer, embedRenderers } = await import("../src/mehrpele/embeds");

describe("feature lifecycle", () => {
  test("materialise: the feature and the CLI share one controller; its commands go with the feature", () => {
    const plugin = new Plugin({}, { id: "mehrpele" }) as any;
    plugin.load();
    const feature = new Component() as any;
    const cli = new Component() as any;
    plugin.addChild(feature);
    plugin.addChild(cli);
    const viaFeature = scopedPlugin(plugin, feature);
    const viaCli = scopedPlugin(plugin, cli);
    // One "last run" for undo, whichever proxy asks.
    expect(materialiseFor(viaFeature)).toBe(materialiseFor(viaCli));
    materialiseFor(viaCli).registerCommands(viaFeature);
    expect(plugin.commands.has("mehrpele:undo-last-materialise")).toBe(true);
    plugin.removeChild(feature);
    expect(plugin.commands.has("mehrpele:undo-last-materialise")).toBe(false);
    expect(plugin.commands.has("mehrpele:materialise-diagram-as-notes")).toBe(false);
  });

  test("an embed renderer can be unregistered (view nodes off, then on)", () => {
    const before = embedRenderers().length;
    const off = registerEmbedRenderer(() => true, () => true);
    expect(embedRenderers().length).toBe(before + 1);
    off();
    off();
    expect(embedRenderers().length).toBe(before);
  });
});
