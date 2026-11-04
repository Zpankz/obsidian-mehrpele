/** Obsidian-free teardown of rendered Mehrpele labels (unit-testable). */

interface ComponentLike {
  unload(): void;
}

interface ParentLike<C> {
  removeChild(child: C): unknown;
}

interface RenderedLike<C> {
  el: { remove(): void };
  component: C;
}

/**
 * Detach and unload every label's component from its parent. `unload()` alone
 * leaves the child in the parent's list (so a long-lived parent — the plugin —
 * keeps every superseded render alive); `removeChild` both removes and
 * unloads. Identical labels share one component, which is released once.
 * Returns the number of distinct components released.
 */
export function releaseRenderedLabels<C extends ComponentLike>(
  parent: ParentLike<C>,
  rendered: readonly RenderedLike<C>[],
): number {
  const seen = new Set<C>();
  for (const r of rendered) {
    if (!seen.has(r.component)) {
      seen.add(r.component);
      try {
        parent.removeChild(r.component);
      } catch {
        try {
          r.component.unload();
        } catch {
          /* already unloaded */
        }
      }
    }
    try {
      r.el.remove();
    } catch {
      /* detached */
    }
  }
  return seen.size;
}
