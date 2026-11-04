/**
 * Weakly-held set of live frames/shells that css-change (and settings changes)
 * walk. Members unregister on destroy; one that never does (a torn-down view
 * whose cleanup was skipped) is collected with its DOM and pruned here instead
 * of being pinned and refreshed forever.
 */
export interface WeakRefLike<T extends object> {
  deref(): T | undefined;
}

/**
 * A WeakRef where the runtime has one; else (iOS < 14.5 WebKit, inside
 * minAppVersion) a strong holder: members are then pruned only by delete().
 */
function defaultRef<T extends object>(target: T): WeakRefLike<T> {
  return typeof WeakRef === "function" ? new WeakRef(target) : { deref: () => target };
}

export class LiveRegistry<T extends object> implements Iterable<T> {
  private refs = new Set<WeakRefLike<T>>();
  private index = new WeakMap<T, WeakRefLike<T>>();

  constructor(private makeRef: (target: T) => WeakRefLike<T> = defaultRef) {}

  add(item: T): this {
    if (this.index.has(item)) return this;
    const ref = this.makeRef(item);
    this.index.set(item, ref);
    this.refs.add(ref);
    return this;
  }

  delete(item: T): boolean {
    const ref = this.index.get(item);
    if (!ref) return false;
    this.index.delete(item);
    return this.refs.delete(ref);
  }

  has(item: T): boolean {
    return this.index.has(item);
  }

  clear(): void {
    this.refs.clear();
    this.index = new WeakMap();
  }

  /** Live member count (prunes dead refs). */
  get size(): number {
    let n = 0;
    const live = this[Symbol.iterator]();
    while (!live.next().done) n++;
    return n;
  }

  /** Snapshot of live members, pruning collected ones; safe to mutate the registry while walking it. */
  *[Symbol.iterator](): Iterator<T> {
    const live: T[] = [];
    for (const ref of [...this.refs]) {
      const item = ref.deref();
      if (item === undefined) this.refs.delete(ref);
      else live.push(item);
    }
    yield* live;
  }
}
