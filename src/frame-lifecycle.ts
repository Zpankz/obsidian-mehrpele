import { LiveRegistry, type WeakRefLike } from "./live-registry";

/**
 * Frame lifecycle helpers (DOM-free; timers, scheduling and observers are injected for tests).
 *
 * - SuspendedFrames: Live Preview frames whose widget left the document wait
 *   here briefly in case CodeMirror puts the same DOM back, then are destroyed.
 * - RefreshCoalescer: a burst of css-change events refreshes each shown frame
 *   once per frame tick; hidden or detached frames refresh when next shown.
 */

/**
 * How long a suspended frame may wait to be revived. CodeMirror re-attaches a
 * widget's DOM within the same update or not at all (the widget's DOM cache is
 * dropped on destroy, so scrolling back builds a new frame); one second covers
 * a slow update without letting scrolled-away frames pile up.
 */
export const SUSPEND_TTL_MS = 1000;

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

const realTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id as number),
};

/** Suspended frames, destroyed after `ttl` unless revived (deleted) first. */
export class SuspendedFrames<F extends { destroy(): void }> {
  private readonly timers = new Map<F, unknown>();

  constructor(
    private readonly ttl = SUSPEND_TTL_MS,
    private readonly t: Timers = realTimers,
  ) {}

  get size(): number {
    return this.timers.size;
  }

  has(frame: F): boolean {
    return this.timers.has(frame);
  }

  /** Start (or restart) the frame's countdown. */
  add(frame: F): void {
    this.delete(frame);
    this.timers.set(
      frame,
      this.t.set(() => {
        this.timers.delete(frame);
        frame.destroy();
      }, this.ttl),
    );
  }

  /** The frame was revived or destroyed: stop its countdown. */
  delete(frame: F): void {
    const id = this.timers.get(frame);
    if (id === undefined) return;
    this.t.clear(id);
    this.timers.delete(frame);
  }

  /** Plugin unload: destroy every frame still waiting. */
  destroyAll(): void {
    const frames = [...this.timers.keys()];
    for (const id of this.timers.values()) this.t.clear(id);
    this.timers.clear();
    for (const f of frames) {
      try {
        f.destroy();
      } catch {
        /* already gone */
      }
    }
  }
}

export interface Refreshable {
  readonly root: HTMLElement;
  refresh(): void;
}

export interface CoalescerDeps<T extends Refreshable> {
  /** Everything that may need a refresh (registered frames and shells). */
  targets: () => Iterable<T>;
  /** Run `fn` once on the next frame tick. */
  schedule?: (fn: () => void) => void;
  /** Whether the target is laid out and visible now. */
  shown?: (t: T) => boolean;
  /** Call `onShown` once when the target is next shown; returns a disposer. */
  watch?: (t: T, onShown: () => void) => () => void;
  /** Weak reference factory for the waiting set (tests inject a collectable stand-in). */
  makeRef?: (t: T) => WeakRefLike<T>;
}

const isShown = (t: Refreshable): boolean => t.root.isConnected && t.root.clientWidth > 0;

/** rAF, with a timer fallback for a window whose frames are throttled. */
function nextTick(fn: () => void): void {
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    fn();
  };
  window.requestAnimationFrame(run);
  window.setTimeout(run, 100);
}

function watchShown(t: Refreshable, onShown: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => undefined;
  const ro = new ResizeObserver(() => {
    if (!isShown(t)) return;
    ro.disconnect();
    onShown();
  });
  ro.observe(t.root);
  return () => ro.disconnect();
}

export class RefreshCoalescer<T extends Refreshable> {
  private pending = false;
  private disposed = false;
  /**
   * Targets that were hidden at the last flush, held weakly like the frame
   * registry: one torn down without destroy() is collected, not pinned here.
   */
  private readonly waiting: LiveRegistry<T>;
  private readonly disposers = new WeakMap<T, () => void>();
  private readonly schedule: (fn: () => void) => void;
  private readonly shown: (t: T) => boolean;
  private readonly watch: (t: T, onShown: () => void) => () => void;

  constructor(private readonly deps: CoalescerDeps<T>) {
    this.schedule = deps.schedule ?? nextTick;
    this.shown = deps.shown ?? isShown;
    this.watch = deps.watch ?? watchShown;
    this.waiting = new LiveRegistry<T>(deps.makeRef);
  }

  /** Number of hidden targets waiting to be shown. */
  get waitingCount(): number {
    return this.waiting.size;
  }

  request(): void {
    if (this.pending || this.disposed) return;
    this.pending = true;
    this.schedule(() => this.flush());
  }

  /** The target was unregistered or destroyed: drop its watcher. */
  forget(t: T): void {
    if (!this.waiting.delete(t)) return;
    const dispose = this.disposers.get(t);
    this.disposers.delete(t);
    dispose?.();
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.waiting) this.disposers.get(t)?.();
    this.waiting.clear();
  }

  private flush(): void {
    this.pending = false;
    if (this.disposed) return;
    const all = [...this.deps.targets()];
    // Read every visibility first, then refresh: no layout read after a write.
    const shown = all.map((t) => this.shown(t));
    all.forEach((t, i) => {
      if (shown[i]) {
        this.forget(t);
        this.refreshOne(t);
      } else if (!this.waiting.has(t)) {
        this.waiting.add(t);
        this.disposers.set(
          t,
          this.watch(t, () => {
            this.waiting.delete(t);
            this.disposers.delete(t);
            if (!this.disposed) this.refreshOne(t);
          }),
        );
      }
    });
  }

  private refreshOne(t: T): void {
    try {
      t.refresh();
    } catch (e) {
      console.error("[pele-mermaid] refresh failed", e);
    }
  }
}
