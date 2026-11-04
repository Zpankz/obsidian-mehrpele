/**
 * Following one diagram block through edits to its note (pure). A view that
 * shows a block remembers where it was; after each change to the note it
 * finds the block again, or learns it was deleted.
 */
import type { CodeBlock } from "./extract-blocks";

export interface BlockRef {
  lang: string;
  code: string;
  /** 0-based line of the opening fence when last seen. */
  startLine: number;
  /** How many diagram blocks the note had then. */
  count: number;
}

const same = (a: string, b: string) => a.trim() === b.trim();

/** The block showing `code` (nearest to `nearLine` when several do), or null. */
export function findBlock(blocks: readonly CodeBlock[], code: string, nearLine = 0): number | null {
  let best: number | null = null;
  for (let i = 0; i < blocks.length; i++) {
    if (!same(blocks[i].code, code)) continue;
    if (best === null || Math.abs(blocks[i].startLine - nearLine) < Math.abs(blocks[best].startLine - nearLine)) best = i;
  }
  return best;
}

/**
 * Where `prev` is now: its unchanged text wherever it moved; else, when no
 * block went away, the same-language block nearest its old place (edited in
 * place); else null — the block was deleted (or edited and another removed in
 * one change, which can't be told apart).
 */
export function relocate(blocks: readonly CodeBlock[], prev: BlockRef): number | null {
  const exact = findBlock(blocks, prev.code, prev.startLine);
  if (exact !== null) return exact;
  if (blocks.length < prev.count) return null;
  let best: number | null = null;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].lang !== prev.lang) continue;
    if (best === null || Math.abs(blocks[i].startLine - prev.startLine) < Math.abs(blocks[best].startLine - prev.startLine)) best = i;
  }
  return best;
}

export function refOf(blocks: readonly CodeBlock[], index: number): BlockRef {
  const b = blocks[index];
  return { lang: b.lang, code: b.code, startLine: b.startLine, count: blocks.length };
}
