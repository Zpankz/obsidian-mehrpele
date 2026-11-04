/**
 * Live-view pool policy (pure). Every view node (and open attached-view
 * panel) is an entry; at most `cap` are live at once. Canvas keeps web
 * pages loaded for good (no reload when panned back); notes can be long, so
 * here views far off screen are kept warm for `keepAliveMs`, then released.
 *
 * Order of claim on a live slot: pinned (lightbox, open panel, the view the
 * user just clicked), then entries near the viewport — most recently near
 * first. Entries beyond the cap show a placeholder ("click to load").
 */

export interface PoolEntry {
  id: string;
  /** Within the mount margin of the viewport right now. */
  near: boolean;
  /** Last time (ms) the entry was near (or created). */
  lastNear: number;
  /** Currently mounted. */
  live: boolean;
  /** Always wants a slot (lightbox, open panel, explicitly loaded). */
  pinned?: boolean;
  /** Last explicit user activation (click to load), ms. */
  activated?: number;
}

export interface PoolPlan {
  mount: string[];
  unmount: string[];
  /** Wanted but over the cap (placeholder with "click to load"). */
  deferred: string[];
}

export interface PoolPolicy {
  cap: number;
  /** A live entry that left the viewport stays loaded this long (if a slot allows). */
  keepAliveMs: number;
}

export const DEFAULT_POOL_POLICY: PoolPolicy = { cap: 6, keepAliveMs: 30_000 };

function rank(e: PoolEntry): number[] {
  // Higher sorts first.
  return [e.pinned ? 1 : 0, e.activated ?? 0, e.near ? 1 : 0, e.lastNear, e.live ? 1 : 0];
}

function cmpRank(a: PoolEntry, b: PoolEntry): number {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Decide which entries mount, which release and which wait. Deterministic. */
export function planPool(entries: readonly PoolEntry[], policy: PoolPolicy, now: number): PoolPlan {
  const cap = Math.max(0, Math.floor(policy.cap));
  const wanted = entries.filter((e) => e.pinned || e.near).sort(cmpRank);
  const keep = new Set(wanted.slice(0, cap).map((e) => e.id));
  const deferred = wanted.slice(cap).map((e) => e.id);
  // Warm entries (off screen, recently near) keep their slot while room remains.
  const warm = entries
    .filter((e) => e.live && !keep.has(e.id) && !deferred.includes(e.id) && now - e.lastNear < policy.keepAliveMs)
    .sort(cmpRank);
  for (const e of warm) {
    if (keep.size >= cap) break;
    keep.add(e.id);
  }
  const mount = entries.filter((e) => !e.live && keep.has(e.id)).map((e) => e.id);
  const unmount = entries.filter((e) => e.live && !keep.has(e.id)).map((e) => e.id);
  return { mount, unmount, deferred };
}

/** Earliest time a warm entry expires (to schedule the next plan), or null. */
export function nextExpiry(entries: readonly PoolEntry[], policy: PoolPolicy, now: number): number | null {
  let best: number | null = null;
  for (const e of entries) {
    if (!e.live || e.near || e.pinned) continue;
    const t = e.lastNear + policy.keepAliveMs;
    if (t > now && (best === null || t < best)) best = t;
  }
  return best;
}

/**
 * Which dock a slot adopts: the first key in `base`, `base#2`, … whose dock
 * is free (missing, or not showing another placed slot). Twin labels
 * (sequence header/footer, two identical blocks) get their own dock; a
 * superseded render's slot (never placed) never blocks adoption.
 */
export function adoptionKey(base: string, takenBy: (key: string) => "free" | "same" | "other" | "none"): string {
  for (let i = 1; ; i++) {
    const key = i === 1 ? base : `${base}#${i}`;
    const t = takenBy(key);
    if (t !== "other") return key;
  }
}
