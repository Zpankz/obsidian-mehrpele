/**
 * The one edit materialise makes to the source note: the block body rewrite
 * plus the `^block-id` after the fence (provenance anchor), and its revert.
 * Pure text transforms over the whole note; the caller dispatches them as one
 * CodeMirror change (Live Preview) or one vault.process (Reading view).
 */
import { planFenceBlockId } from "../diagram-link";
import { replaceBlockBody } from "../replace-block";

export interface SourceEdit {
  /** 0-based opening fence line. */
  fenceLine: number;
  before: string;
  after: string;
  /** Text inserted for the block id (to remove on revert), when it was new. */
  idInsert?: string;
}

export type SourceEditResult = { ok: true; text: string; edit: SourceEdit } | { ok: false; reason: string };

/** Block id for the block: the existing `^id` after the fence, or the one an edit would add. */
export function blockIdFor(text: string, fenceLine: number, source: string): { ok: true; id: string; isNew: boolean } | { ok: false; reason: string } {
  const plan = planFenceBlockId(text, fenceLine, source);
  if (plan.kind === "exists") return { ok: true, id: plan.id, isNew: false };
  if (plan.kind === "insert") return { ok: true, id: plan.id, isNew: true };
  return { ok: false, reason: plan.kind === "ambiguous" ? "the same diagram appears twice in the note" : plan.kind === "unclosed" ? "the diagram fence is not closed" : "the diagram changed; run the command again" };
}

/** Apply the rewrite (`after`, or null to keep the body) and the block id to the note text. */
export function applySourceEdit(text: string, fenceLine: number, before: string, after: string | null): SourceEditResult {
  const plan = planFenceBlockId(text, fenceLine, before);
  if (plan.kind !== "exists" && plan.kind !== "insert") {
    const id = blockIdFor(text, fenceLine, before);
    return { ok: false, reason: id.ok ? "the diagram changed; run the command again" : id.reason };
  }
  let next = plan.kind === "insert" ? plan.text : text;
  const fence = plan.fenceLine;
  if (after !== null && after !== before) {
    const r = replaceBlockBody(next, fence, before, after);
    if (!r.ok) return { ok: false, reason: "the diagram changed; run the command again" };
    next = r.text;
  }
  return { ok: true, text: next, edit: { fenceLine: fence, before, after: after ?? before, ...(plan.kind === "insert" ? { idInsert: plan.insert } : {}) } };
}

/** Undo applySourceEdit while the block still reads as written. */
export function revertSourceEdit(text: string, edit: SourceEdit): { ok: true; text: string } | { ok: false; reason: string } {
  let next = text;
  let fence = edit.fenceLine;
  if (edit.after !== edit.before) {
    const r = replaceBlockBody(next, fence, edit.after, edit.before);
    if (r.ok) {
      next = r.text;
      fence = r.fenceLine;
    } else {
      // Already back to the original (e.g. Cmd/Ctrl+Z in Live Preview): nothing to revert.
      const back = replaceBlockBody(next, fence, edit.before, edit.before);
      if (!back.ok) return { ok: false, reason: "the diagram was edited since; left as is" };
      fence = back.fenceLine;
    }
  }
  if (edit.idInsert) {
    const lines = next.split("\n");
    const closeLine = fence + 1 + edit.before.replace(/\n$/, "").split("\n").length;
    let lineStart = 0;
    for (let i = 0; i <= closeLine && i < lines.length; i++) lineStart += lines[i].length + 1;
    const closeEnd = lineStart - 1;
    if (next.startsWith(edit.idInsert, lineStart)) next = next.slice(0, lineStart) + next.slice(lineStart + edit.idInsert.length);
    else if (next.startsWith(edit.idInsert, closeEnd)) next = next.slice(0, closeEnd) + next.slice(closeEnd + edit.idInsert.length);
  }
  return { ok: true, text: next };
}

/** The smallest single replacement turning `a` into `b` (one CodeMirror change). */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}
