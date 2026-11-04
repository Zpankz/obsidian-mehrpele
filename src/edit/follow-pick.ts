/**
 * Which re-rendered frame takes the selection back after a write. Only one
 * in the workspace leaf the edit was made in, shown on screen, and at the
 * same place among that leaf's diagrams: never a duplicate tab or a split
 * of the same note (or a hidden one, which would draw at the window's
 * top-left). Pure, so the rule is testable without Obsidian.
 */

/** Where a frame is: its workspace leaf's view (Reading or editing; null outside a leaf, e.g. a popover) and its index among that view's visible diagrams. */
export interface Origin {
  leaf: unknown;
  order: number;
}

export interface ResumeCandidate<T> extends Origin {
  ref: T;
  /** Shown (has a non-empty client rect). */
  visible: boolean;
  /** Shows the note and targets, and has settled. */
  ready: boolean;
}

/** The frame to resume in, or null to keep waiting (no fallback to another leaf). */
export function pickResume<T>(cands: ResumeCandidate<T>[], origin: Origin): T | null {
  const inLeaf = cands.filter((c) => c.leaf === origin.leaf);
  // The edited frame is not shown yet: the others may have been renumbered
  // around it, so wait for it.
  if (inLeaf.some((c) => !c.visible && c.order === origin.order)) return null;
  const here = inLeaf.filter((c) => c.visible);
  // The edited diagram itself: wait for it rather than take a twin.
  const same = here.find((c) => c.order === origin.order);
  if (same) return same.ready ? same.ref : null;
  // The leaf's diagrams were renumbered: the nearest one there.
  let best: ResumeCandidate<T> | null = null;
  for (const c of here) {
    if (c.ready && (!best || Math.abs(c.order - origin.order) < Math.abs(best.order - origin.order))) best = c;
  }
  return best?.ref ?? null;
}

/** On screen: display:none / hidden tabs have no client rects. */
export function isShown(el: Element): boolean {
  if (!el.isConnected || !el.getClientRects().length) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
