import { describe, expect, test } from "bun:test";
import { createPopupGuard, suggestShowing } from "../../src/edit/popup-guard";

/** Minimal element: matches a class selector list like ".menu, .suggestion-container". */
function el(cls: string) {
  return {
    nodeType: 1,
    matches: (sel: string) => sel.split(",").some((s) => s.trim() === `.${cls}`),
    querySelector: () => null,
  };
}

function fakeDoc() {
  const open: string[] = [];
  let cb: ((records: Array<{ removedNodes: unknown[] }>) => void) | null = null;
  let observed: unknown = null;
  let disconnected = false;
  const deferred: Array<() => void> = [];
  class MO {
    constructor(fn: (records: Array<{ removedNodes: unknown[] }>) => void) {
      cb = fn;
    }
    observe(target: unknown) {
      observed = target;
    }
    disconnect() {
      disconnected = true;
    }
  }
  const body = {};
  const doc = {
    body,
    querySelector: (sel: string) => (open.some((c) => sel.includes(`.${c}`)) ? {} : null),
  };
  return {
    doc,
    body,
    open,
    remove: (cls: string) => cb?.([{ removedNodes: [el(cls)] }]),
    removeNode: (n: unknown) => cb?.([{ removedNodes: [n] }]),
    flush: () => deferred.splice(0).forEach((f) => f()),
    deps: { MutationObserver: MO as unknown as typeof MutationObserver, defer: (f: () => void) => void deferred.push(f) },
    state: () => ({ observed, disconnected }),
  };
}

describe("popup guard", () => {
  test("no popup: the key belongs to the inline editor", () => {
    const f = fakeDoc();
    const g = createPopupGuard(f.doc as unknown as Document, f.deps);
    expect(g.owns()).toBe(false);
    expect(f.state().observed).toBe(f.body);
  });

  test("an open menu or suggest owns the key", () => {
    const f = fakeDoc();
    const g = createPopupGuard(f.doc as unknown as Document, f.deps);
    f.open.push("menu");
    expect(g.owns()).toBe(true);
    f.open.length = 0;
    f.open.push("suggestion-container");
    expect(g.owns()).toBe(true);
  });

  test("a menu closed by this same keypress still owns it until the next task", () => {
    const f = fakeDoc();
    const g = createPopupGuard(f.doc as unknown as Document, f.deps);
    f.remove("menu"); // Obsidian's capture keymap closed the swatch menu on Escape
    expect(g.owns()).toBe(true);
    f.flush();
    expect(g.owns()).toBe(false);
  });

  test("a removed wrapper holding a menu claims the key", () => {
    const f = fakeDoc();
    const g = createPopupGuard(f.doc as unknown as Document, f.deps);
    const wrapper = { nodeType: 1, matches: () => false, querySelector: (sel: string) => (sel.includes(".menu") ? {} : null) };
    f.removeNode(wrapper);
    expect(g.owns()).toBe(true);
  });

  test("removed text nodes are ignored", () => {
    const f = fakeDoc();
    const g = createPopupGuard(f.doc as unknown as Document, f.deps);
    f.removeNode({ nodeType: 3, matches: () => true });
    expect(g.owns()).toBe(false);
  });

  test("only menus on body count as open", () => {
    const f = fakeDoc();
    let asked = "";
    const doc = { ...f.doc, querySelector: (sel: string) => ((asked = sel), null) };
    createPopupGuard(doc as unknown as Document, f.deps).owns();
    expect(asked).toBe("body > .menu, body > .suggestion-container");
  });

  test("removing unrelated nodes does not claim the key", () => {
    const f = fakeDoc();
    const g = createPopupGuard(f.doc as unknown as Document, f.deps);
    f.remove("tooltip");
    expect(g.owns()).toBe(false);
  });

  test("dispose disconnects the observer", () => {
    const f = fakeDoc();
    const g = createPopupGuard(f.doc as unknown as Document, f.deps);
    g.dispose();
    expect(f.state().disconnected).toBe(true);
  });

  test("works without MutationObserver (open popups only)", () => {
    const f = fakeDoc();
    const g = createPopupGuard(f.doc as unknown as Document, { MutationObserver: undefined, defer: f.deps.defer });
    expect(g.owns()).toBe(false);
    f.open.push("menu");
    expect(g.owns()).toBe(true);
    g.dispose();
  });
});

describe("suggestShowing", () => {
  test("no current suggest", () => {
    expect(suggestShowing(undefined)).toBe(false);
    expect(suggestShowing(null)).toBe(false);
  });
  test("open suggest owns the key", () => {
    expect(suggestShowing({ isOpen: true })).toBe(true);
  });
  test("a suggest dismissed with Esc stays current but no longer owns the key", () => {
    expect(suggestShowing({ isOpen: false })).toBe(false);
  });
  test("a suggest without isOpen counts as open (older builds)", () => {
    expect(suggestShowing({})).toBe(true);
  });
});
