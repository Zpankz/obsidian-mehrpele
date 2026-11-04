/** Feature "canvas": diagram → canvas command, canvas → Mermaid commands and file menu. */
import type { MarkdownView } from "obsidian";
import { registerCanvasToMermaid } from "../canvas-convert-ui";
import { convertDiagramAtCursor } from "../editor-commands";
import type { FeatureContext } from "./types";

export function register({ plugin }: FeatureContext): void {
  plugin.addCommand({
    id: "convert-diagram-to-canvas",
    name: "Convert diagram to canvas",
    editorCallback: (editor, view) => {
      void convertDiagramAtCursor(plugin, editor, view as MarkdownView);
    },
  });
  registerCanvasToMermaid(plugin);
}
