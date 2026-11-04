/**
 * A floated action bar must not outlive its frame's place on screen: a tab
 * that moves to another note, a re-render, a hidden leaf, a layout shift or a
 * move to a popout all happen without a pointerleave. Minimal fake DOM (the
 * package has no DOM library); only what float-actions.ts touches.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("obsidian", () => ({ Platform: { isMobile: false } }));
const { attachFloatingActions, actionBarOf, sweepFloatingActions } = await import("../../src/edit/float-actions");

type Box = { left: number; top: number; right: number; bottom: number };
const ZERO: Box = { left: 0, top: 0, right: 0, bottom: 0 };

class FakeNode {
  parent: FakeEl | null = null;
  constructor(public ownerDocument: FakeDoc) {}
  get parentElement(): FakeEl | null {
    return this.parent;
  }
  get parentNode(): FakeEl | null {
    return this.parent;
  }
  get isConnected(): boolean {
    let n: FakeNode = this;
    while (n.parent) n = n.parent;
    return n === n.ownerDocument.documentElement;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.kids.splice(this.parent.kids.indexOf(this), 1);
    this.parent = null;
  }
  replaceWith(n: FakeNode): void {
    const p = this.parent;
    if (!p) return;
    n.remove();
    p.kids[p.kids.indexOf(this)] = n;
    n.parent = p;
    this.parent = null;
  }
}

class FakeEl extends FakeNode {
  kids: FakeNode[] = [];
  box: Box = ZERO;
  hidden = false;
  overflow = "visible";
  hover = false;
  style: Record<string, string> = {};
  private on = new Map<string, Set<() => void>>();
  constructor(doc: FakeDoc, public cls = "") {
    super(doc);
  }
  appendChild<T extends FakeNode>(n: T): T {
    n.remove();
    this.kids.push(n);
    n.parent = this;
    const adopt = (x: FakeNode): void => {
      x.ownerDocument = this.ownerDocument;
      if (x instanceof FakeEl) x.kids.forEach(adopt);
    };
    adopt(n);
    return n;
  }
  createDiv(o: { cls: string }): FakeEl {
    return this.appendChild(new FakeEl(this.ownerDocument, o.cls));
  }
  querySelector(sel: string): FakeEl | null {
    if (sel !== ":scope > .embed-actions") throw new Error(`fake querySelector: ${sel}`);
    return (this.kids.find((k) => k instanceof FakeEl && k.cls === "embed-actions") as FakeEl) ?? null;
  }
  contains(n: FakeNode): boolean {
    for (let x: FakeNode | null = n; x; x = x.parent) if (x === this) return true;
    return false;
  }
  get childElementCount(): number {
    return this.kids.filter((k) => k instanceof FakeEl).length;
  }
  get offsetWidth(): number {
    return 60;
  }
  get offsetHeight(): number {
    return 20;
  }
  /** Like the DOM: all zero when detached or inside display:none. */
  getBoundingClientRect(): DOMRect {
    let shown = this.isConnected;
    for (let p: FakeEl | null = this; p && shown; p = p.parent) shown = !p.hidden;
    const b = shown ? this.box : ZERO;
    return { ...b, width: b.right - b.left, height: b.bottom - b.top } as DOMRect;
  }
  matches(sel: string): boolean {
    return sel === ":hover" && this.hover;
  }
  addEventListener(t: string, f: () => void): void {
    if (!this.on.has(t)) this.on.set(t, new Set());
    this.on.get(t)!.add(f);
  }
  removeEventListener(t: string, f: () => void): void {
    this.on.get(t)?.delete(f);
  }
  fire(t: string): void {
    for (const f of [...(this.on.get(t) ?? [])]) f();
  }
}

/** A window whose timers run only when the test says so. */
class FakeWin {
  private next = 1;
  timers = new Map<number, { fn: () => void; every: boolean }>();
  setTimeout(fn: () => void): number {
    this.timers.set(this.next, { fn, every: false });
    return this.next++;
  }
  setInterval(fn: () => void): number {
    this.timers.set(this.next, { fn, every: true });
    return this.next++;
  }
  clearTimeout(id: number): void {
    this.timers.delete(id);
  }
  clearInterval(id: number): void {
    this.timers.delete(id);
  }
  /** Run every pending timer once (one-shots are dropped). */
  tick(): void {
    for (const [id, t] of [...this.timers]) {
      if (!t.every) this.timers.delete(id);
      t.fn();
    }
  }
  getComputedStyle(el: FakeEl) {
    return { overflowX: el.overflow, overflowY: el.overflow };
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

class FakeDoc {
  defaultView = new FakeWin();
  documentElement: FakeEl;
  body: FakeEl;
  constructor() {
    this.documentElement = new FakeEl(this, "html");
    Object.defineProperty(this.documentElement, "clientWidth", { value: 1000 });
    Object.defineProperty(this.documentElement, "clientHeight", { value: 800 });
    this.body = this.documentElement.appendChild(new FakeEl(this, "body"));
  }
  createComment(): FakeNode {
    return new FakeNode(this);
  }
}

const floats = (doc: FakeDoc) => doc.body.kids.filter((k) => k instanceof FakeEl && k.cls === "pele-floating-actions");

/** A nested frame inside a clipping overlay item; its bar sticks out on the right. */
function setup() {
  const doc = new FakeDoc();
  const leaf = doc.body.createDiv({ cls: "leaf" });
  leaf.box = { left: 300, top: 100, right: 900, bottom: 700 };
  const item = leaf.createDiv({ cls: "mehrpele-overlay-item" });
  item.overflow = "hidden";
  item.box = { left: 400, top: 200, right: 500, bottom: 300 };
  const root = item.createDiv({ cls: "pele-embed" });
  root.box = { left: 400, top: 200, right: 500, bottom: 300 };
  const bar = root.createDiv({ cls: "embed-actions" });
  bar.createDiv({ cls: "embed-action" });
  bar.box = { left: 450, top: 204, right: 520, bottom: 224 }; // past the item's right edge
  const detach = attachFloatingActions(root as unknown as HTMLElement);
  root.fire("pointerenter");
  // Every test starts from a floated bar, so none can pass without one.
  expect(floats(doc)).toHaveLength(1);
  return { doc, leaf, item, root, bar, detach };
}

describe("floated action bar", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  // Detach even when a test fails, so no watch entry leaks into the next test.
  afterEach(() => s.detach());

  test("hover floats the clipped bar into a body layer", () => {
    expect(floats(s.doc)).toHaveLength(1);
    expect(actionBarOf(s.root as unknown as HTMLElement)).toBe(s.bar as unknown as HTMLElement);
  });

  test("a sweep leaves a bar whose frame is still in place floated", () => {
    sweepFloatingActions();
    s.doc.defaultView.tick();
    expect(floats(s.doc)).toHaveLength(1);
  });

  test("frame detached without pointerleave (tab moved to another note): sweep puts the bar back", () => {
    s.root.remove();
    sweepFloatingActions();
    expect(floats(s.doc)).toHaveLength(0);
    expect(s.bar.parent).toBe(s.root);
  });

  test("frame detached: the watch removes the layer even with no workspace event", () => {
    s.root.remove();
    s.doc.defaultView.tick();
    expect(floats(s.doc)).toHaveLength(0);
  });

  test("leaf hidden (active-leaf-change to another tab): bar restored", () => {
    s.leaf.hidden = true;
    sweepFloatingActions();
    expect(floats(s.doc)).toHaveLength(0);
    expect(s.bar.parent).toBe(s.root);
  });

  test("frame re-rendered in place: the stale bar is dropped, the new one kept", () => {
    s.root.kids.slice().forEach((k) => k.remove());
    const fresh = s.root.createDiv({ cls: "embed-actions" });
    s.doc.defaultView.tick();
    expect(floats(s.doc)).toHaveLength(0);
    expect(s.bar.parent).toBeNull();
    expect(s.root.kids).toEqual([fresh]);
  });

  test("frame moved (layout-change): bar restored, then re-floated at the new place on the next move", () => {
    s.root.box = { left: 100, top: 200, right: 200, bottom: 300 };
    s.item.box = s.root.box;
    s.bar.box = { left: 150, top: 204, right: 220, bottom: 224 };
    sweepFloatingActions();
    expect(floats(s.doc)).toHaveLength(0);
    s.root.fire("pointermove");
    const [layer] = floats(s.doc) as FakeEl[];
    expect(layer).toBeDefined();
    expect(Number.parseInt(layer!.style.left!)).toBeLessThan(200);
  });

  test("frame moved to a popout window: bar leaves the old window", () => {
    const popout = new FakeDoc();
    const host = popout.body.createDiv({ cls: "leaf" });
    host.appendChild(s.item);
    sweepFloatingActions();
    expect(floats(s.doc)).toHaveLength(0);
    expect(s.bar.parent).toBe(s.root);
    expect(s.doc.defaultView.timers.size).toBe(0);
  });

  test("restore stops the watch", () => {
    s.root.remove();
    sweepFloatingActions();
    expect(s.doc.defaultView.timers.size).toBe(0);
  });
});
