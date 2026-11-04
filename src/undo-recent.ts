/** How long the last-pressed diagram stays the Mod+Z fallback. */
export const RECENT_MS = 10 * 60_000;

/**
 * The diagram last pressed in, if it can still take Mod+Z when nothing has
 * focus: connected, pressed recently, and shown. A background tab keeps its
 * diagrams connected but hidden; undoing there would change an unseen note.
 */
export function recentDiagram(last: { el: Element; at: number } | null, now: number): Element | null {
  if (!last || !last.el.isConnected || now - last.at >= RECENT_MS) return null;
  const shown = (last.el as Element & { isShown?: () => boolean }).isShown;
  return typeof shown === "function" && !shown.call(last.el) ? null : last.el;
}
