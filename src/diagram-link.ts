/**
 * DOM-free helpers for linking *to* a diagram
 * and for deep links *from* generated diagrams.
 *
 * - Stable block ids: `^pele-<hash8>` where hash8 = 32-bit FNV-1a (hex) of
 *   the block source — the same hash pele-render uses for Excalidraw ids.
 * - Block-id insertion after the closing fence: idempotent (an existing
 *   `^id` right after the fence is reused, never stacked), one text change.
 * - URI builders: `obsidian://adv-uri` (Advanced URI, single-encoded) and the
 *   core `obsidian://open` fallback; wikilinks to a block.
 */

import { DIAGRAM_FENCE_RE } from "./fence-locate";

/** Deterministic 32-bit FNV-1a hash, lowercase hex, 8 chars. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Block id (without `^`) for a diagram source. Trailing newline is ignored. */
export function diagramBlockId(source: string): string {
  return `pele-${fnv1a(source.replace(/\n$/, ""))}`;
}

/** Obsidian block ids: Latin letters, digits and dashes only. */
const BLOCK_ID_LINE_RE = /^\s*\^([A-Za-z0-9-]+)\s*$/;
const OPEN_FENCE_RE = DIAGRAM_FENCE_RE;

export type BlockIdPlan =
  | { kind: "exists"; id: string; fenceLine: number }
  | {
      kind: "insert";
      id: string;
      fenceLine: number;
      /** Character offset (in `text`) where `insert` goes. */
      offset: number;
      insert: string;
      /** `text` with the insertion applied. */
      text: string;
    }
  | { kind: "ambiguous" }
  | { kind: "missing" }
  | { kind: "unclosed" };

function bodyMatches(lines: readonly string[], fenceLine: number, body: readonly string[]): boolean {
  for (let k = 0; k < body.length; k++) {
    if (lines[fenceLine + 1 + k] !== body[k]) return false;
  }
  return true;
}

/** Locate a diagram block by fence+body (same trust rules as width persistence). */
function locateFence(lines: readonly string[], expectedLine: number, body: readonly string[]): number | "ambiguous" | null {
  if (OPEN_FENCE_RE.test(lines[expectedLine] ?? "") && bodyMatches(lines, expectedLine, body)) return expectedLine;
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (OPEN_FENCE_RE.test(lines[i] ?? "") && bodyMatches(lines, i, body)) hits.push(i);
  }
  if (hits.length === 1) return hits[0];
  return hits.length > 1 ? "ambiguous" : null;
}

function isClosingFence(line: string | undefined, open: string): boolean {
  if (line === undefined) return false;
  const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  return !!m && m[1][0] === open[0] && m[1].length >= open.length;
}

/** Existing block id attached to the block whose closing fence is `closeLine`. */
function existingIdAfter(lines: readonly string[], closeLine: number): string | null {
  const next = lines[closeLine + 1];
  const direct = next !== undefined ? BLOCK_ID_LINE_RE.exec(next) : null;
  if (direct) return direct[1];
  // Obsidian's documented form for structured blocks: blank line, then `^id`.
  if (next !== undefined && next.trim() === "") {
    const after = lines[closeLine + 2];
    const spaced = after !== undefined ? BLOCK_ID_LINE_RE.exec(after) : null;
    if (spaced) return spaced[1];
  }
  return null;
}

/** Make `id` unique among `^id` markers already present in the note. */
function uniqueId(lines: readonly string[], id: string): string {
  const taken = new Set<string>();
  for (const line of lines) {
    const m = /\s\^([A-Za-z0-9-]+)\s*$/.exec(` ${line}`);
    if (m) taken.add(m[1]);
  }
  if (!taken.has(id)) return id;
  let n = 2;
  while (taken.has(`${id}-${n}`)) n++;
  return `${id}-${n}`;
}

/**
 * Plan the idempotent `^id` insertion for the diagram whose opening fence is
 * expected at `fenceLine` (0-based) with body `source`. The id goes on the
 * line right after the closing fence; when the following line is not blank a
 * blank line is added after the id so it cannot merge into the next paragraph.
 */
export function planFenceBlockId(
  text: string,
  fenceLine: number,
  source: string,
  desiredId: string = diagramBlockId(source),
): BlockIdPlan {
  const lines = text.split("\n");
  const body = source.replace(/\n$/, "").split("\n");
  const hit = locateFence(lines, fenceLine, body);
  if (hit === "ambiguous") return { kind: "ambiguous" };
  if (hit === null) return { kind: "missing" };
  const open = OPEN_FENCE_RE.exec(lines[hit])![1];
  const closeLine = hit + 1 + body.length;
  if (!isClosingFence(lines[closeLine], open)) return { kind: "unclosed" };

  const existing = existingIdAfter(lines, closeLine);
  if (existing) return { kind: "exists", id: existing, fenceLine: hit };

  const id = uniqueId(lines, desiredId);
  let offset = 0;
  for (let i = 0; i <= closeLine; i++) offset += lines[i].length + 1;
  const hasNext = closeLine + 1 < lines.length;
  const nextBlank = !hasNext || lines[closeLine + 1].trim() === "";
  let insert: string;
  if (!hasNext) {
    // Closing fence is the last line (no trailing newline): offset points past
    // the end, so append after a newline instead.
    offset -= 1;
    insert = `\n^${id}`;
  } else {
    insert = nextBlank ? `^${id}\n` : `^${id}\n\n`;
  }
  return {
    kind: "insert",
    id,
    fenceLine: hit,
    offset,
    insert,
    text: text.slice(0, offset) + insert + text.slice(offset),
  };
}

// -- URI builders ---------------------------------------------------------------

export interface AdvancedUriTarget {
  vault: string;
  filepath: string;
  heading?: string;
  block?: string;
}

/** `obsidian://adv-uri?…` navigation link (current action; single-encoded). */
export function advancedUri(t: AdvancedUriTarget): string {
  const enc = encodeURIComponent;
  let uri = `obsidian://adv-uri?vault=${enc(t.vault)}&filepath=${enc(t.filepath)}`;
  if (t.block) uri += `&block=${enc(t.block.replace(/^\^/, ""))}`;
  else if (t.heading) uri += `&heading=${enc(t.heading)}`;
  return uri;
}

/** Core `obsidian://open` link (no heading/block precision). */
export function openUri(vault: string, file: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
}

/** `[[linktext#^id]]` for a block (linktext as produced by fileToLinktext). */
export function wikilinkToBlock(linktext: string, blockId: string): string {
  return `[[${linktext}#^${blockId.replace(/^\^/, "")}]]`;
}
