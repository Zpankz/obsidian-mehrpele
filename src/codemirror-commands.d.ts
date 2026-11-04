/** The one export used from Obsidian's bundled @codemirror/commands (external at build time, no types installed). */
declare module "@codemirror/commands" {
  import type { AnnotationType } from "@codemirror/state";
  export const isolateHistory: AnnotationType<"before" | "after" | "full">;
}
