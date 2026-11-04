import { describe, expect, test } from "bun:test";
import { LiveRegistry, type WeakRefLike } from "../src/live-registry";

/** WeakRef stand-in whose target can be "collected" on demand. */
class FakeRef<T extends object> implements WeakRefLike<T> {
  static all: FakeRef<object>[] = [];
  constructor(private target: T | undefined) {
    FakeRef.all.push(this as unknown as FakeRef<object>);
  }
  deref(): T | undefined {
    return this.target;
  }
  collect(): void {
    this.target = undefined;
  }
}

const refOf = (obj: object) => FakeRef.all.find((r) => r.deref() === obj);

describe("LiveRegistry (css-change refresh set)", () => {
  test("iterates live members in insertion order; add is idempotent", () => {
    const reg = new LiveRegistry<{ id: number }>((t) => new FakeRef(t));
    const a = { id: 1 }, b = { id: 2 }, c = { id: 3 };
    reg.add(a);
    reg.add(b);
    reg.add(a);
    reg.add(c);
    expect([...reg].map((x) => x.id)).toEqual([1, 2, 3]);
    expect(reg.size).toBe(3);
    expect(reg.has(b)).toBe(true);
  });

  test("delete and clear unregister explicitly", () => {
    const reg = new LiveRegistry<{ id: number }>((t) => new FakeRef(t));
    const a = { id: 1 }, b = { id: 2 };
    reg.add(a);
    reg.add(b);
    expect(reg.delete(a)).toBe(true);
    expect(reg.delete(a)).toBe(false);
    expect([...reg]).toEqual([b]);
    reg.clear();
    expect([...reg]).toEqual([]);
    expect(reg.has(b)).toBe(false);
  });

  test("members collected without unregistering are skipped and pruned", () => {
    FakeRef.all = [];
    const reg = new LiveRegistry<{ id: number }>((t) => new FakeRef(t));
    const a = { id: 1 }, b = { id: 2 }, c = { id: 3 };
    for (const x of [a, b, c]) reg.add(x);
    refOf(b)?.collect();
    expect([...reg].map((x) => x.id)).toEqual([1, 3]);
    expect(reg.size).toBe(2);
    // Pruned for good: a later pass sees the same set.
    expect([...reg].map((x) => x.id)).toEqual([1, 3]);
  });

  test("a member removed during iteration (destroy → unregister) does not break the pass", () => {
    const reg = new LiveRegistry<{ id: number }>((t) => new FakeRef(t));
    const a = { id: 1 }, b = { id: 2 };
    reg.add(a);
    reg.add(b);
    const seen: number[] = [];
    for (const x of reg) {
      seen.push(x.id);
      reg.delete(x);
    }
    expect(seen).toEqual([1, 2]);
    expect(reg.size).toBe(0);
  });

  test("defaults to the platform WeakRef", () => {
    const reg = new LiveRegistry<object>();
    const a = {};
    reg.add(a);
    expect([...reg]).toEqual([a]);
  });
});

describe("runtimes without WeakRef (old iOS WebKit)", () => {
  test("the default registry falls back to strong refs instead of throwing", () => {
    const g = globalThis as { WeakRef?: unknown };
    const saved = g.WeakRef;
    g.WeakRef = undefined;
    try {
      const reg = new LiveRegistry<{ id: number }>();
      const a = { id: 1 };
      const b = { id: 2 };
      reg.add(a).add(b);
      expect([...reg]).toEqual([a, b]);
      expect(reg.delete(a)).toBe(true);
      expect([...reg]).toEqual([b]);
      expect(reg.size).toBe(1);
    } finally {
      g.WeakRef = saved;
    }
  });
});

describe("css-change wiring (main.ts)", () => {
  const main = require("node:fs").readFileSync(new URL("../main.ts", import.meta.url), "utf8") as string;
  test("frames and Mehrpele shells live in weak registries", () => {
    expect(main.includes("frames = new LiveRegistry<DiagramFrame>();")).toBe(true);
    expect(main.includes("mehrShells = new LiveRegistry<MehrpeleShell>();")).toBe(true);
  });
  test("css-change re-measures text and queues one coalesced refresh of every frame and shell", () => {
    const at = main.indexOf('on("css-change"');
    expect(at).toBeGreaterThan(-1);
    const body = main.slice(at, at + 400);
    expect(body).toContain("forgetTextWidths()");
    expect(body).toContain("this.cssRefresh.request()");
    expect(main).toMatch(/cssRefresh = new RefreshCoalescer<[^>]+>\(\{\s*targets: \(\) => \[\.\.\.this\.frames, \.\.\.this\.mehrShells\]/);
  });
  test("shared Mehrpele math (lightbox, Bases) refreshes the mounts that use it when MathJax lands", () => {
    const at = main.indexOf("private sharedMehrMath()");
    expect(at).toBeGreaterThan(-1);
    expect(main.slice(at, at + 400)).toMatch(/rerender: \(\) => \{\s*for \(const m of \[\.\.\.this\.sharedMathMounts\]\) m\.refresh\(\);/);
    const lb = main.slice(main.indexOf("openMehrpeleLightbox(shell"), main.indexOf("routeMehrSvgLink(\n"));
    expect(lb).toContain("this.sharedMathMounts.add(m)");
    expect(lb).toContain("this.sharedMathMounts.delete(mounted)");
    expect(main).toMatch(/liveMount: \(m, live\) =>/);
    const bases = require("node:fs").readFileSync(new URL("../src/mehrpele/bases-view.ts", import.meta.url), "utf8") as string;
    expect(bases).toContain("this.deps.liveMount?.(this.mounted, true)");
    expect(bases).toContain("this.deps.liveMount?.(this.mounted, false)");
  });
});
