/**
 * Keyboard access helpers (src/a11y.ts) on a small fake DOM:
 * - asButton: role and tab stop; Enter/Space activate once, keep the key from
 *   the page, and pass the key's modifiers on (synthetic click) or hand the
 *   trusted keydown to a direct handler.
 * - trapTarget / FocusTrap: Tab wraps inside the dialog at both ends, enters
 *   from outside at the edge, falls back to the root, and focus goes back to
 *   the opener on release only while it is still in the document.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { asButton, FocusTrap, isActivationKey, isEditableTarget, modalKeyRoute, trapTarget } from "../src/a11y";

type Handler = (e: any) => void;

class FakeDoc {
  activeElement: FakeEl | null = null;
  body!: FakeEl;
}

class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Handler[]> = {};
  shown = true;
  connected = true;
  tabIndex = -1;
  constructor(
    public ownerDocument: FakeDoc,
    public tag = "div",
  ) {
    if (tag === "button") this.tabIndex = 0; // as in the DOM
  }
  add(...cs: FakeEl[]): this {
    for (const c of cs) {
      c.parent = this;
      this.children.push(c);
    }
    return this;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
    if (k === "tabindex") this.tabIndex = Number(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  hasAttribute(k: string): boolean {
    return k in this.attrs || (k === "tabindex" && this.tabIndex !== -1 && this.tag === "div");
  }
  addEventListener(type: string, fn: Handler): void {
    (this.listeners[type] ??= []).push(fn);
  }
  dispatchEvent(e: any): boolean {
    for (const fn of this.listeners[e.type] ?? []) fn(e);
    return true;
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  get isConnected(): boolean {
    return this.connected;
  }
  contains(other: FakeEl | null): boolean {
    for (let n = other; n; n = n.parent) if (n === this) return true;
    return false;
  }
  getClientRects(): unknown[] {
    return this.shown ? [{}] : [];
  }
  /** Only the trap's FOCUSABLE query is asked here: listed tags and tab-indexed elements, in document order. */
  querySelectorAll(sel: string): FakeEl[] {
    const parts = sel.split(",").map((s) => s.trim());
    const hit = (c: FakeEl): boolean =>
      parts.some((p) => p === c.tag || p.startsWith(`${c.tag}:`) || (p === "[tabindex]" && ("tabindex" in c.attrs || c.tabIndex >= 0)));
    const out: FakeEl[] = [];
    const walk = (n: FakeEl): void => {
      for (const c of n.children) {
        if (hit(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  matches(sel: string): boolean {
    return sel.split(",").some((s) => s.trim() === this.tag);
  }
}

function key(k: string, extra: Record<string, unknown> = {}) {
  const e = {
    type: "keydown",
    key: k,
    repeat: false,
    isComposing: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isTrusted: true,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    stopPropagation() {
      e.propagationStopped = true;
    },
    ...extra,
  };
  return e;
}

beforeAll(() => {
  // asButton's synthetic click (no DOM in bun's test runtime).
  (globalThis as any).MouseEvent ??= class {
    type: string;
    constructor(type: string, init: Record<string, unknown> = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
});

describe("isActivationKey", () => {
  test("Enter and Space, not repeats or IME composition", () => {
    expect(isActivationKey({ key: "Enter", repeat: false, isComposing: false })).toBe(true);
    expect(isActivationKey({ key: " ", repeat: false, isComposing: false })).toBe(true);
    expect(isActivationKey({ key: "Enter", repeat: true, isComposing: false })).toBe(false);
    expect(isActivationKey({ key: "Enter", repeat: false, isComposing: true })).toBe(false);
    expect(isActivationKey({ key: "a", repeat: false, isComposing: false })).toBe(false);
    expect(isActivationKey({ key: "Spacebar", repeat: false, isComposing: false })).toBe(false);
  });
});

describe("asButton", () => {
  const doc = new FakeDoc();
  const mk = () => new FakeEl(doc) as unknown as HTMLElement & FakeEl;

  test("gives role=button and a tab stop", () => {
    const el = asButton(mk());
    expect(el.getAttribute("role")).toBe("button");
    expect(el.tabIndex).toBe(0);
  });

  test("a mouse press does not move focus (default prevented), the click still runs", () => {
    const el = asButton(mk());
    const down = { type: "mousedown", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    el.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  test("Enter and Space click once each, with the key's modifiers, and keep the key from the page", () => {
    const el = asButton(mk());
    const clicks: any[] = [];
    el.addEventListener("click", (e: any) => clicks.push(e));
    const enter = key("Enter", { metaKey: true, altKey: true });
    el.dispatchEvent(enter);
    const space = key(" ", { shiftKey: true });
    el.dispatchEvent(space);
    expect(clicks.length).toBe(2);
    expect(clicks[0]).toMatchObject({ type: "click", bubbles: true, cancelable: true, metaKey: true, altKey: true, ctrlKey: false, shiftKey: false });
    expect(clicks[1]).toMatchObject({ metaKey: false, shiftKey: true });
    for (const e of [enter, space]) {
      expect(e.defaultPrevented).toBe(true);
      expect(e.propagationStopped).toBe(true);
    }
  });

  test("other keys, auto-repeat and composition do nothing and pass through", () => {
    const el = asButton(mk());
    let clicks = 0;
    el.addEventListener("click", () => clicks++);
    for (const e of [key("a"), key("Tab"), key("Escape"), key("Enter", { repeat: true }), key(" ", { isComposing: true })]) {
      el.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
      expect(e.propagationStopped).toBe(false);
    }
    expect(clicks).toBe(0);
  });

  test("a direct handler gets the trusted keydown instead of a synthetic click", () => {
    const got: any[] = [];
    const el = asButton(mk(), (e) => got.push(e));
    let clicks = 0;
    el.addEventListener("click", () => clicks++);
    const e = key("Enter", { ctrlKey: true });
    el.dispatchEvent(e);
    expect(clicks).toBe(0);
    expect(got).toEqual([e]);
    expect(got[0].isTrusted).toBe(true);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("trapTarget", () => {
  const items = ["a", "b", "c"];
  test("wraps forward from the last and backward from the first", () => {
    expect(trapTarget(items, "c", false)).toBe("a");
    expect(trapTarget(items, "a", true)).toBe("c");
  });
  test("leaves moves inside the list to the browser", () => {
    expect(trapTarget(items, "a", false)).toBeNull();
    expect(trapTarget(items, "b", false)).toBeNull();
    expect(trapTarget(items, "b", true)).toBeNull();
    expect(trapTarget(items, "c", true)).toBeNull();
  });
  test("enters at the edge when focus is outside", () => {
    expect(trapTarget(items, null, false)).toBe("a");
    expect(trapTarget(items, null, true)).toBe("c");
    expect(trapTarget(items, "x", false)).toBe("a");
  });
  test("a single stop wraps onto itself; an empty list has none", () => {
    expect(trapTarget(["only"], "only", false)).toBe("only");
    expect(trapTarget(["only"], "only", true)).toBe("only");
    expect(trapTarget([], null, false)).toBeNull();
  });
});

describe("FocusTrap", () => {
  function setup() {
    const doc = new FakeDoc();
    doc.body = new FakeEl(doc, "body");
    const opener = new FakeEl(doc);
    opener.tabIndex = 0;
    const root = new FakeEl(doc);
    const first = new FakeEl(doc, "button");
    const hidden = new FakeEl(doc, "button");
    hidden.shown = false;
    const skipped = new FakeEl(doc);
    skipped.setAttribute("tabindex", "-1");
    const close = new FakeEl(doc);
    close.tabIndex = 0;
    root.add(first, hidden, skipped, close);
    doc.body.add(opener, root);
    opener.focus();
    const trap = new FocusTrap(root as unknown as HTMLElement);
    return { doc, opener, root, first, close, trap };
  }
  const tab = (shiftKey = false) => key("Tab", { shiftKey });

  test("tab stops are the shown, tabbable elements in order", () => {
    const { trap, first, close } = setup();
    expect(trap.focusables()).toEqual([first, close] as any);
  });

  test("embedded web views (iframe, webview) are tab stops unless tabindex=-1", () => {
    const { doc, root, first, close, trap } = setup();
    const frame = new FakeEl(doc, "iframe");
    frame.tabIndex = 0; // as in the DOM
    const view = new FakeEl(doc, "webview"); // Electron's webview reports tabIndex -1 without the attribute
    const off = new FakeEl(doc, "webview");
    off.setAttribute("tabindex", "-1");
    root.add(frame, view, off);
    expect(trap.focusables()).toEqual([first, close, frame, view] as any);
  });

  test("activate focuses the given element and remembers the opener; release gives focus back", () => {
    const { doc, trap, opener, close } = setup();
    trap.activate(close as unknown as HTMLElement);
    expect(doc.activeElement).toBe(close);
    trap.release();
    expect(doc.activeElement).toBe(opener);
  });

  test("Tab wraps at both ends and is left to the browser in between", () => {
    const { doc, trap, first, close } = setup();
    trap.activate(close as unknown as HTMLElement);
    const fwd = tab();
    expect(trap.onTab(fwd)).toBe(true);
    expect(fwd.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(first);
    const back = tab(true);
    expect(trap.onTab(back)).toBe(true);
    expect(doc.activeElement).toBe(close);
    first.focus();
    const mid = tab();
    expect(trap.onTab(mid)).toBe(false);
    expect(mid.defaultPrevented).toBe(false);
  });

  test("focus outside the dialog comes back in at the edge", () => {
    const { doc, trap, opener, first, close } = setup();
    trap.activate(close as unknown as HTMLElement);
    opener.focus();
    trap.onTab(tab());
    expect(doc.activeElement).toBe(first);
    opener.focus();
    trap.onTab(tab(true));
    expect(doc.activeElement).toBe(close);
  });

  test("no tab stops: the root itself takes focus and keeps it", () => {
    const doc = new FakeDoc();
    doc.body = new FakeEl(doc, "body");
    const root = new FakeEl(doc);
    doc.body.add(root);
    const trap = new FocusTrap(root as unknown as HTMLElement);
    trap.activate();
    expect(doc.activeElement).toBe(root);
    expect(root.tabIndex).toBe(-1);
    const e = tab();
    expect(trap.onTab(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(root);
  });

  test("non-Tab keys are ignored", () => {
    const { trap } = setup();
    const e = key("Enter");
    expect(trap.onTab(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  test("an opener removed meanwhile, or none (body had focus), gets nothing", () => {
    const a = setup();
    a.trap.activate(a.close as unknown as HTMLElement);
    a.opener.connected = false;
    a.trap.release();
    expect(a.doc.activeElement).toBe(a.close);

    const b = setup();
    b.doc.activeElement = b.doc.body;
    b.trap.activate(b.close as unknown as HTMLElement);
    b.trap.release();
    expect(b.doc.activeElement).toBe(b.close);
  });

  test("release is one-shot", () => {
    const { doc, trap, opener, close } = setup();
    trap.activate(close as unknown as HTMLElement);
    trap.release();
    close.focus();
    trap.release();
    expect(doc.activeElement).toBe(close);
    expect(opener).toBeTruthy();
  });
});

describe("isEditableTarget", () => {
  const doc = new FakeDoc();
  test("inputs, textareas, selects and contenteditable keep their keys", () => {
    expect(isEditableTarget(new FakeEl(doc, "input") as any)).toBe(true);
    expect(isEditableTarget(new FakeEl(doc, "textarea") as any)).toBe(true);
    expect(isEditableTarget(new FakeEl(doc, "select") as any)).toBe(true);
    const ce = Object.assign(new FakeEl(doc), { isContentEditable: true });
    expect(isEditableTarget(ce as any)).toBe(true);
  });
  test("buttons, divs, null and non-elements do not", () => {
    expect(isEditableTarget(new FakeEl(doc, "button") as any)).toBe(false);
    expect(isEditableTarget(new FakeEl(doc) as any)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as any)).toBe(false);
  });
});

describe("modalKeyRoute", () => {
  const doc = new FakeDoc();
  const ce = Object.assign(new FakeEl(doc), { isContentEditable: true });
  test("Tab from form controls stays in the trap (they navigate with Tab, they do not indent)", () => {
    for (const tag of ["input", "textarea", "select", "button", "div"]) {
      expect(modalKeyRoute("Tab", new FakeEl(doc, tag) as any)).toBe("trap");
    }
  });
  test("editors (contenteditable) keep Tab; Escape always reaches the modal", () => {
    expect(modalKeyRoute("Tab", ce as any)).toBe("own");
    expect(modalKeyRoute("Escape", ce as any)).toBe("modal");
    expect(modalKeyRoute("Escape", new FakeEl(doc, "input") as any)).toBe("modal");
  });
  test("other keys: editable targets keep them, the rest are modal shortcuts", () => {
    expect(modalKeyRoute("+", new FakeEl(doc, "input") as any)).toBe("own");
    expect(modalKeyRoute("ArrowRight", ce as any)).toBe("own");
    expect(modalKeyRoute("+", new FakeEl(doc) as any)).toBe("modal");
    expect(modalKeyRoute("ArrowRight", null)).toBe("modal");
  });
});
