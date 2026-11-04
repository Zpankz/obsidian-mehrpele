/** Feature "repair": repair commands (the frame repair button loads repair on first use). */
import type { MarkdownView } from "obsidian";
import { repairAllInNote, repairUnderCursor } from "../editor-commands";
import type { FeatureContext } from "./types";

export function register({ plugin }: FeatureContext): void {
  plugin.addCommand({
    id: "repair-diagram-under-cursor",
    name: "Repair current diagram",
    editorCallback: (editor, view) => {
      void repairUnderCursor(plugin, editor, view as MarkdownView);
    },
  });
  plugin.addCommand({
    id: "repair-all-diagrams",
    name: "Repair all diagrams in current note",
    editorCallback: (_editor, view) => {
      void repairAllInNote(plugin, view as MarkdownView);
    },
  });
}
