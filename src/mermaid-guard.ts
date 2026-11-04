/**
 * Obsidian 1.14's Mermaid vault-trust gate. Untrusted vaults get every
 * `mermaid` fence wrapped by Obsidian's own post-processor (it runs before
 * plugin code-block processors) in
 *
 *   div.mermaid-wrapper.is-guarded
 *     > div.mermaid-guard-header   ("Display Mermaid diagrams in this vault?", Allow)
 *     > div.mermaid-guard-source > pre > code.language-mermaid
 *
 * and our `mermaid` processor then receives the block inside the guard's
 * source area. Pele renders SVG itself and runs no mermaid.js, so the block
 * takes the whole guard's place: no banner over a Pele diagram. The trust
 * flag is never read or written (the user's setting stays theirs), and a
 * guard that does not look like this is left alone (Pele still renders; at
 * worst the banner stays).
 */

export const MERMAID_GUARD = ".mermaid-wrapper.is-guarded";
const GUARD_SOURCE = ".mermaid-guard-source";

/** The DOM this needs (an Element satisfies it). */
export interface GuardNode<T> {
  closest(selector: string): T | null;
  querySelector(selector: string): T | null;
  contains(other: T | null): boolean;
  replaceWith(...nodes: T[]): void;
  readonly parentNode: unknown;
}

/**
 * Replace Obsidian's Mermaid guard around `el` with `el` itself. Returns
 * whether it did; false (nothing touched) when `el` is not inside a guard's
 * source area.
 */
export function unwrapMermaidGuard<T extends GuardNode<T>>(el: T): boolean {
  const guard = el.closest(MERMAID_GUARD);
  if (!guard || !guard.parentNode) return false;
  const source = guard.querySelector(`:scope > ${GUARD_SOURCE}`);
  if (!source || !source.contains(el)) return false;
  guard.replaceWith(el);
  return true;
}
