/** Obsidian-free helpers for the view-node commands (unit-tested). */
import { nodeSizeCaps } from "pele-render/node-size";
import { extractBlocks } from "../../extract-blocks";
import { hasViewDirective, pruneViewDirective } from "./directive";

/** Per block body: `%% pele-view %%` entries of vanished nodes removed. */
export function pruneNoteViews(markdown: string): { firstLine: number; lastLine: number; body: string }[] {
  const out: { firstLine: number; lastLine: number; body: string }[] = [];
  for (const b of extractBlocks(markdown, ["mermaid", "pele", "mehrpele"])) {
    if (b.endLine <= b.startLine + 1 || !hasViewDirective(b.code)) continue;
    if (b.code.split("\n").length !== b.endLine - b.startLine - 1) continue;
    const caps = nodeSizeCaps(b.code);
    if (!caps) continue;
    const next = pruneViewDirective(b.code, new Set(caps.keys())).source;
    if (next !== b.code) out.push({ firstLine: b.startLine + 1, lastLine: b.endLine - 1, body: next });
  }
  return out;
}
