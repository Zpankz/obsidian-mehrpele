/**
 * Where a block sits relative to Mehrpele frames, from the DOM alone. Core:
 * every processor call asks, so it must not load the Mehrpele feature.
 */

/**
 * Nesting of a processor-rendered block: whether it sits inside a Mehrpele
 * label, and how many Mehrpele diagrams enclose it (0 = a block in a note).
 */
export function mehrpeleNesting(el: HTMLElement): { inLabel: boolean; depth: number } {
  let depth = 0;
  for (let p: HTMLElement | null = el.parentElement; p; p = p.parentElement) {
    if (p.classList.contains("mehrpele-frame")) depth++;
  }
  return { inLabel: !!el.closest(".mehrpele-label"), depth };
}

/**
 * Size edits stay in memory inside embeds (as before) and inside Mehrpele
 * labels (the processor's section info describes the label, not the note).
 */
export function isReadOnlyFrameRoot(root: HTMLElement): boolean {
  return !!root.closest(".internal-embed, .mehrpele-label");
}

/** Rendered inside a Mehrpele label: never write repairs / block ids to the note. */
export function inMehrpeleLabel(root: HTMLElement): boolean {
  return !!root.closest(".mehrpele-label");
}
