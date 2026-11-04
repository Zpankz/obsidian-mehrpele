/**
 * Undo / redo for diagram edits written straight to a file (Reading view has
 * no editor history; Live Preview edits are CodeMirror transactions and use
 * the editor's own). Pure: each action is kept as a patch, the changed span
 * with some text either side, and applied by finding exactly that text again,
 * so an edit elsewhere in the note does not block undo, while a change to the
 * same place refuses instead of clobbering it. Stacks are per file and capped.
 */

export interface Patch {
  /** Text before the change (`removed` was replaced by `inserted`). */
  removed: string;
  inserted: string;
  /** Unchanged text just before and after the span. */
  pre: string;
  post: string;
  /** Where the span started in the text it was made on. */
  at: number;
  /** Lengths of the text before and after the change. */
  before: number;
  after: number;
}

export interface HistoryEntry {
  id: number;
  path: string;
  /** What was done ("colour", "node size"…), for notices. */
  label: string;
  patch: Patch;
}

/** Context kept either side of a change (characters). */
export const CONTEXT = 64;
/** Actions kept per file. */
export const HISTORY_CAP = 100;

/** The patch turning `before` into `after`, or null when they are equal. */
export function makePatch(before: string, after: string, context = CONTEXT): Patch | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  return {
    removed: before.slice(start, endB),
    inserted: after.slice(start, endA),
    pre: before.slice(Math.max(0, start - context), start),
    post: before.slice(endB, endB + context),
    at: start,
    before: before.length,
    after: after.length,
  };
}

/**
 * `text` with the patch reversed (undo: `inserted` back to `removed`) or
 * replayed (redo). Null when the patched text with its context is not found
 * (the note changed there since), or is ambiguous. The full context is tried
 * first; when it is gone it falls back to the changed lines plus one line
 * either side, so a block id added after the fence or typing a few lines away
 * does not block undo, while a change on or next to the edited lines does.
 * Either way the match must sit where the note's change in length since can
 * have moved it (grown by n: 0..n later; shrunk: up to n earlier), so the
 * same lines in another diagram are never taken for it.
 */
export function applyPatch(text: string, p: Patch, dir: "undo" | "redo"): string | null {
  const full = applyWith(text, p, p.pre, p.post, dir);
  if (full !== undefined) return full;
  const pre = p.pre.split("\n").slice(-2).join("\n");
  const post = p.post.split("\n").slice(0, 2).join("\n");
  if (pre === p.pre && post === p.post) return null;
  return applyWith(text, p, pre, post, dir) ?? null;
}

/** undefined: the context is not in `text` within reach; null: it is, but ambiguously. */
function applyWith(text: string, p: Patch, pre: string, post: string, dir: "undo" | "redo"): string | null | undefined {
  const from = dir === "undo" ? p.inserted : p.removed;
  const to = dir === "undo" ? p.removed : p.inserted;
  const needle = pre + from + post;
  const want = p.at - pre.length;
  // Only where the note's change in length can have moved it.
  const grew = text.length - (dir === "undo" ? p.after : p.before);
  const lo = Math.min(0, grew);
  const hi = Math.max(0, grew);
  const hits: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) if (i - want >= lo && i - want <= hi) hits.push(i);
  if (!hits.length) return undefined;
  // Nearest occurrence to where it was; another one equally near is ambiguous.
  hits.sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
  if (hits.length > 1 && Math.abs(hits[0] - want) === Math.abs(hits[1] - want)) return null;
  const i = hits[0] + pre.length;
  return text.slice(0, i) + to + text.slice(i + from.length);
}

export class EditHistory {
  private undoStacks = new Map<string, HistoryEntry[]>();
  private redoStacks = new Map<string, HistoryEntry[]>();
  private nextId = 1;

  constructor(private readonly cap = HISTORY_CAP) {}

  /** Record one action on `path`; a new action drops what could be redone. Null when nothing changed. */
  record(path: string, before: string, after: string, label: string): HistoryEntry | null {
    const patch = makePatch(before, after);
    if (!patch) return null;
    const entry: HistoryEntry = { id: this.nextId++, path, label, patch };
    const stack = this.undoStacks.get(path) ?? [];
    stack.push(entry);
    if (stack.length > this.cap) stack.splice(0, stack.length - this.cap);
    this.undoStacks.set(path, stack);
    this.redoStacks.delete(path);
    return entry;
  }

  peekUndo(path: string): HistoryEntry | null {
    return this.undoStacks.get(path)?.at(-1) ?? null;
  }

  peekRedo(path: string): HistoryEntry | null {
    return this.redoStacks.get(path)?.at(-1) ?? null;
  }

  /**
   * Undo the latest action on `path` in `text`: the new text and the entry
   * (now redoable), or a conflict (the entry is dropped: it can never apply)
   * or null when there is nothing to undo.
   */
  undo(path: string, text: string): { text: string; entry: HistoryEntry } | { conflict: HistoryEntry } | null {
    return this.step(path, text, "undo");
  }

  redo(path: string, text: string): { text: string; entry: HistoryEntry } | { conflict: HistoryEntry } | null {
    return this.step(path, text, "redo");
  }

  private step(path: string, text: string, dir: "undo" | "redo"): { text: string; entry: HistoryEntry } | { conflict: HistoryEntry } | null {
    const from = dir === "undo" ? this.undoStacks : this.redoStacks;
    const to = dir === "undo" ? this.redoStacks : this.undoStacks;
    const stack = from.get(path);
    const entry = stack?.pop();
    if (!entry) return null;
    const out = applyPatch(text, entry.patch, dir);
    if (out === null) return { conflict: entry };
    const other = to.get(path) ?? [];
    other.push(entry);
    if (other.length > this.cap) other.splice(0, other.length - this.cap);
    to.set(path, other);
    return { text: out, entry };
  }

  /** Put an entry back where `step` took it from (the write it was for did not happen). */
  restore(result: { entry: HistoryEntry }, dir: "undo" | "redo"): void {
    const from = dir === "undo" ? this.undoStacks : this.redoStacks;
    const to = dir === "undo" ? this.redoStacks : this.undoStacks;
    const path = result.entry.path;
    const moved = to.get(path);
    if (moved?.at(-1) === result.entry) moved.pop();
    const back = from.get(path) ?? [];
    back.push(result.entry);
    from.set(path, back);
  }

  rename(oldPath: string, newPath: string): void {
    for (const stacks of [this.undoStacks, this.redoStacks]) {
      const s = stacks.get(oldPath);
      stacks.delete(oldPath);
      if (s) stacks.set(newPath, s.map((e) => ({ ...e, path: newPath })));
    }
  }

  forget(path: string): void {
    this.undoStacks.delete(path);
    this.redoStacks.delete(path);
  }
}
