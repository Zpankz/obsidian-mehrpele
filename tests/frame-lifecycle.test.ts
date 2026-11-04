import { describe, expect, test } from "bun:test";
import { RefreshCoalescer, SUSPEND_TTL_MS, SuspendedFrames, type Timers } from "../src/frame-lifecycle";

/** Manual timers: `tick(ms)` runs what is due. */
function fakeTimers(): Timers & { tick(ms: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    set(fn, ms) {
      const id = next++;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear(id) {
      due.delete(id as number);
    },
    tick(ms) {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        due.delete(id);
        t.fn();
      }
    },
    pending: () => due.size,
  };
}

const frame = () => {
  const f = { destroyed: 0, destroy: () => void f.destroyed++ };
  return f;
};

describe("SuspendedFrames (H1)", () => {
  test("a suspended frame that is never revived is destroyed after the TTL", () => {
    const t = fakeTimers();
    const s = new SuspendedFrames<ReturnType<typeof frame>>(SUSPEND_TTL_MS, t);
    const a = frame();
    const b = frame();
    s.add(a);
    s.add(b);
    expect(s.size).toBe(2);
    t.tick(SUSPEND_TTL_MS - 1);
    expect(a.destroyed + b.destroyed).toBe(0);
    t.tick(1);
    expect(a.destroyed).toBe(1);
    expect(b.destroyed).toBe(1);
    expect(s.size).toBe(0);
    expect(t.pending()).toBe(0);
  });

  test("a revived frame (deleted) is not destroyed", () => {
    const t = fakeTimers();
    const s = new SuspendedFrames<ReturnType<typeof frame>>(SUSPEND_TTL_MS, t);
    const a = frame();
    s.add(a);
    s.delete(a);
    t.tick(SUSPEND_TTL_MS * 5);
    expect(a.destroyed).toBe(0);
    expect(t.pending()).toBe(0);
  });

  test("destroyAll (plugin unload) destroys every waiting frame and clears its timers", () => {
    const t = fakeTimers();
    const s = new SuspendedFrames<ReturnType<typeof frame>>(SUSPEND_TTL_MS, t);
    const frames = [frame(), frame(), frame()];
    for (const f of frames) s.add(f);
    s.destroyAll();
    expect(frames.map((f) => f.destroyed)).toEqual([1, 1, 1]);
    expect(s.size).toBe(0);
    expect(t.pending()).toBe(0);
    t.tick(SUSPEND_TTL_MS);
    expect(frames.map((f) => f.destroyed)).toEqual([1, 1, 1]);
  });
});

type Target = { root: HTMLElement; refresh(): void; refreshes: number; visible: boolean };
const target = (visible: boolean): Target => {
  const t: Target = { root: {} as HTMLElement, refreshes: 0, visible, refresh: () => void t.refreshes++ };
  return t;
};

describe("RefreshCoalescer (M1)", () => {
  test("5 css-change events, 3 frames (1 detached) → 2 refreshes, 0 for the detached frame", () => {
    const ticks: (() => void)[] = [];
    const watched: { t: Target; onShown: () => void; disposed: boolean }[] = [];
    const targets = [target(true), target(true), target(false)];
    const c = new RefreshCoalescer<Target>({
      targets: () => targets,
      schedule: (fn) => void ticks.push(fn),
      shown: (t) => t.visible,
      watch: (t, onShown) => {
        const w = { t, onShown, disposed: false };
        watched.push(w);
        return () => void (w.disposed = true);
      },
    });
    for (let i = 0; i < 5; i++) c.request();
    expect(ticks.length).toBe(1);
    ticks.shift()!();
    const total = targets.reduce((n, t) => n + t.refreshes, 0);
    expect(total).toBeLessThanOrEqual(3);
    expect(targets.map((t) => t.refreshes)).toEqual([1, 1, 0]);
    expect(watched.map((w) => w.t)).toEqual([targets[2]]);
    expect(c.waitingCount).toBe(1);

    // Another burst while it's still hidden: no second watcher, still no refresh.
    c.request();
    ticks.shift()!();
    expect(targets.map((t) => t.refreshes)).toEqual([2, 2, 0]);
    expect(watched.length).toBe(1);

    // Shown again: one refresh, then it's no longer waiting.
    targets[2]!.visible = true;
    watched[0]!.onShown();
    expect(targets[2]!.refreshes).toBe(1);
    expect(c.waitingCount).toBe(0);
  });

  test("a hidden frame torn down without destroy is not pinned: once collected it leaves the waiting set", () => {
    const ticks: (() => void)[] = [];
    const refs: { target: Target | undefined; deref(): Target | undefined }[] = [];
    let targets = [target(true), target(false)];
    const c = new RefreshCoalescer<Target>({
      targets: () => targets,
      schedule: (fn) => void ticks.push(fn),
      shown: (t) => t.visible,
      watch: () => () => undefined,
      makeRef: (t) => {
        const r = { target: t as Target | undefined, deref: () => r.target };
        refs.push(r);
        return r;
      },
    });
    c.request();
    ticks.shift()!();
    expect(c.waitingCount).toBe(1);
    // The view is torn down without destroy(): the weak registry drops it, then GC collects it.
    targets = [targets[0]!];
    refs[0]!.target = undefined;
    expect(c.waitingCount).toBe(0);
    c.dispose();
  });

  test("forget and dispose drop hidden frames' watchers", () => {
    const ticks: (() => void)[] = [];
    const disposed: Target[] = [];
    const hidden = [target(false), target(false)];
    const c = new RefreshCoalescer<Target>({
      targets: () => hidden,
      schedule: (fn) => void ticks.push(fn),
      shown: (t) => t.visible,
      watch: (t) => () => void disposed.push(t),
    });
    c.request();
    ticks.shift()!();
    expect(c.waitingCount).toBe(2);
    c.forget(hidden[0]!);
    expect(disposed).toEqual([hidden[0]!]);
    c.dispose();
    expect(disposed).toEqual([hidden[0]!, hidden[1]!]);
    expect(c.waitingCount).toBe(0);
    c.request();
    expect(ticks.length).toBe(0);
  });
});
