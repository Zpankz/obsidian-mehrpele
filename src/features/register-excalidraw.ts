/**
 * Feature "excalidraw": diagram → Excalidraw drawing (commands, the diagram
 * menu item and the pele:excalidraw CLI handler read `plugin.excalidraw`).
 * While the retired pele-excalidraw plugin is enabled, its own commands and
 * handler stay in charge and these stand down.
 */
import { MarkdownView, Notice } from "obsidian";
import { ExcalidrawConverter } from "../excalidraw/converter";
import type { FeatureContext } from "./types";

/** The stand-down Notice shows once per launch, not on every toggle. */
let warned = false;

export function register({ plugin, component }: FeatureContext): void {
  const converter = new ExcalidrawConverter(plugin.app, () => {
    const ex = plugin.settings.features.excalidraw;
    return { palette: ex.palette, scale: ex.scale };
  });
  plugin.excalidraw = converter;
  component.register(() => {
    if (plugin.excalidraw === converter) plugin.excalidraw = null;
  });

  if (plugin.excalidrawStandsDown() && !warned) {
    warned = true;
    new Notice("Mehrpele: Excalidraw conversion is now built in. Disable the retired Excalidraw conversion plugin.", 10000);
  }

  plugin.addCommand({
    id: "convert-diagram-to-excalidraw",
    name: "Convert current diagram to Excalidraw",
    editorCheckCallback: (checking, editor, view) => {
      if (plugin.excalidrawStandsDown() || !(view instanceof MarkdownView)) return false;
      if (!checking) void converter.convertUnderCursor(editor, view);
      return true;
    },
  });
  plugin.addCommand({
    id: "insert-diagram-into-excalidraw",
    name: "Insert diagram into active Excalidraw drawing",
    checkCallback: (checking) => {
      if (plugin.excalidrawStandsDown()) return false;
      if (!checking) void converter.promptAndInsert();
      return true;
    },
  });
}
