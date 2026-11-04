/**
 * Does this Obsidian ship its own Pele (1.15+)? Core exposes it lazily as
 * `window.pele`; before that loads, the API version is the signal (the user
 * agent still reports the installer build, so it is not used).
 *
 * Pure: callers pass `window` and Obsidian's `requireApiVersion`.
 */
export const CORE_PELE_VERSION = "1.15.0";

export interface CorePeleProbe {
  /** Defaults to globalThis (window in Obsidian). */
  win?: { pele?: unknown };
  apiVersionAtLeast?: (version: string) => boolean;
}

export function hasCorePele({ win = window as { pele?: unknown }, apiVersionAtLeast }: CorePeleProbe = {}): boolean {
  if (win?.pele) return true;
  try {
    return apiVersionAtLeast?.(CORE_PELE_VERSION) === true;
  } catch {
    return false;
  }
}
