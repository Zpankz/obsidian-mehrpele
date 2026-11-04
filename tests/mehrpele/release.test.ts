import { describe, expect, test } from "bun:test";
import { releaseRenderedLabels } from "../../src/mehrpele/release";

class FakeComponent {
  unloaded = 0;
  unload() {
    this.unloaded++;
  }
}

class FakeParent {
  children: FakeComponent[] = [];
  removeChild(c: FakeComponent) {
    const i = this.children.indexOf(c);
    if (i >= 0) {
      this.children.splice(i, 1);
      c.unload();
    }
  }
}

describe("releaseRenderedLabels", () => {
  test("removes label components from the parent (not just unload) and detaches DOM", () => {
    const parent = new FakeParent();
    const a = new FakeComponent();
    const b = new FakeComponent();
    parent.children.push(a, b);
    let removed = 0;
    const el = { remove: () => void removed++ };
    // Two labels share `a` (identical Markdown is cloned, component shared).
    const n = releaseRenderedLabels(parent, [
      { el, component: a },
      { el, component: a },
      { el, component: b },
    ]);
    expect(n).toBe(2);
    expect(parent.children).toEqual([]);
    expect(a.unloaded).toBe(1);
    expect(b.unloaded).toBe(1);
    expect(removed).toBe(3);
  });

  test("falls back to unload when the parent refuses", () => {
    const c = new FakeComponent();
    releaseRenderedLabels({ removeChild: () => { throw new Error("x"); } }, [{ el: { remove() {} }, component: c }]);
    expect(c.unloaded).toBe(1);
  });
});
