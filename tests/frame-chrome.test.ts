/**
 * DiagramFrame lifecycle on a minimal fake DOM (the real frame, bundled as
 * the plugin bundles it):
 * - M2: no per-frame observers or edit chrome until the first pointerover
 *   while edit is off; with edit on the edit tools attach at construction.
 * - H1: suspend hands the frame to the host's suspended set; a host without
 *   one gets the frame destroyed.
 * - The action bar's key scope (pushed while focus is in the bar) is popped
 *   when the frame or shell is suspended or destroyed.
 */
import "./helpers/dom-globals";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { ALIAS, EXTERNAL, PKG } from "./helpers/bundle";
import { deep, obsidianStub } from "./helpers/obsidian-stub";

type Listener = { fn: (ev: unknown) => void; capture: boolean };

/** Just enough of an element for DiagramFrame's constructor and lifecycle. */
class FakeEl {
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners = new Map<string, Listener[]>();
  classes = new Set<string>();
  classList = {
    add: (...c: string[]) => c.forEach((x) => this.classes.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.classes.delete(x)),
    toggle: (c: string, on?: boolean) => {
      const v = on ?? !this.classes.has(c);
      if (v) this.classes.add(c);
      else this.classes.delete(c);
      return v;
    },
    contains: (c: string) => this.classes.has(c),
  };
  textContent = "";
  clientWidth = 0;
  constructor(public tagName: string) {}
  get isConnected(): boolean {
    return false;
  }
  appendChild<T extends FakeEl>(c: T): T {
    this.children.push(c);
    c.parentElement = this;
    return c;
  }
  append(...cs: FakeEl[]): void {
    for (const c of cs) this.appendChild(c);
  }
  remove(): void {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k: string): void {
    delete this.attrs[k];
  }
  addEventListener(type: string, fn: (ev: unknown) => void, opt?: boolean | { capture?: boolean }): void {
    const capture = typeof opt === "boolean" ? opt : !!opt?.capture;
    const l = this.listeners.get(type) ?? [];
    if (!l.some((x) => x.fn === fn && x.capture === capture)) l.push({ fn, capture });
    this.listeners.set(type, l);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void, opt?: boolean | { capture?: boolean }): void {
    const capture = typeof opt === "boolean" ? opt : !!opt?.capture;
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((x) => !(x.fn === fn && x.capture === capture)));
  }
  /** Fire `type` at this element's own listeners (enough for root-level hooks). */
  fire(type: string): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l.fn({ type, target: this });
  }
  count(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
  closest(): null {
    return null;
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeEl[] {
    return [];
  }
  get ownerDocument(): unknown {
    return fakeDocument;
  }
}

/** Unknown members (setIcon helpers, Obsidian's DOM extensions): inert. */
const el = (tag: string): FakeEl =>
  new Proxy(new FakeEl(tag), {
    get(t, k, r) {
      if (k in t || typeof k === "symbol" || k === "then") return Reflect.get(t, k, r);
      return () => deep();
    },
  });

const fakeDocument = {
  createElement: (t: string) => el(t),
  createElementNS: (_ns: string, t: string) => el(t),
  body: el("body"),
};

let mutationObservers = 0;
let resizeObservers = 0;
class FakeMO {
  constructor() {
    mutationObservers++;
  }
  observe(): void {}
  disconnect(): void {}
}
class FakeRO {
  constructor() {
    resizeObservers++;
  }
  observe(): void {}
  disconnect(): void {}
}

const GLOBALS: Record<string, unknown> = {
  document: fakeDocument,
  activeDocument: fakeDocument,
  window: deep(),
  activeWindow: deep(),
  getComputedStyle: deep(),
  requestAnimationFrame: deep(),
  MutationObserver: FakeMO,
  ResizeObserver: FakeRO,
  IntersectionObserver: deep(),
};
const saved = new Map<string, PropertyDescriptor | undefined>();
let mod: { DiagramFrame: any; MehrpeleShell: any; defaultSettingsV3: () => any };

beforeAll(async () => {
  const r = await build({
    absWorkingDir: PKG,
    stdin: {
      // Built, not written out: the public export's import scan reads quoted `from` specifiers as this file's own imports.
      contents: [
        ["DiagramFrame", "diagram-frame"],
        ["MehrpeleShell", "mehrpele/shell"],
        ["defaultSettingsV3", "settings/schema"],
      ]
        .map(([name, file]) => `export { ${name} } from ${JSON.stringify(`./src/${file}`)};`)
        .join("\n"),
      resolveDir: PKG,
      loader: "ts",
    },
    bundle: true,
    external: EXTERNAL,
    format: "cjs",
    alias: ALIAS,
    target: "es2020",
    write: false,
    logLevel: "silent",
  });
  for (const [k, v] of Object.entries(GLOBALS)) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  const m: { exports: any } = { exports: {} };
  const req = (id: string): unknown => {
    if (id === "obsidian") return obsidianStub;
    if (id.startsWith("@codemirror/") || id.startsWith("@lezer/") || id === "electron") return deep();
    return require(id);
  };
  new Function("require", "module", "exports", r.outputFiles[0]!.text)(req, m, m.exports);
  mod = m.exports;
}, 60_000);

afterAll(() => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
});

/** Obsidian's keymap: what was pushed and popped. */
function keymapApp() {
  const k = { pushed: [] as unknown[], popped: [] as unknown[] };
  return { k, app: { scope: {}, keymap: { pushScope: (s: unknown) => void k.pushed.push(s), popScope: (s: unknown) => void k.popped.push(s) } } };
}

function host(opts: { edit: boolean; resize?: boolean; suspend?: boolean }) {
  const { k, app } = keymapApp();
  const settings = mod.defaultSettingsV3();
  settings.features.toolbar.enabled = opts.edit;
  settings.features["inline-edit"].enabled = opts.edit;
  settings.features.resize.enabled = opts.resize !== false;
  settings.features.repair.enabled = true;
  const h = {
    attached: 0,
    disposed: 0,
    registered: 0,
    unregistered: 0,
    suspended: [] as unknown[],
    keys: k,
    app,
    settings: () => settings,
    repair() {},
    openLightbox() {},
    internalLink() {},
    hoverLink() {},
    contextMenu() {},
    iconSvg: () => undefined,
    registerFrame: () => void h.registered++,
    unregisterFrame: () => void h.unregistered++,
    attachEdit: () => {
      h.attached++;
      return () => void h.disposed++;
    },
    ...(opts.suspend === false ? {} : { suspendFrame: (f: unknown) => void h.suspended.push(f) }),
  };
  return h;
}

const frameOpts = { source: "graph TD\n  A --> B\n", lang: "mermaid", sourcePath: "x.md", onRevealCode() {} };

describe("DiagramFrame chrome (M2)", () => {
  test("edit off: 0 observers and no edit attach until the first pointerover", () => {
    mutationObservers = 0;
    const h = host({ edit: false });
    const f = new mod.DiagramFrame(h, frameOpts);
    expect(mutationObservers).toBe(0);
    expect(h.attached).toBe(0);
    f.root.fire("pointerover");
    expect(h.attached).toBe(1);
    expect(mutationObservers).toBe(1); // node handles
    f.root.fire("pointerover");
    expect(h.attached).toBe(1);
    expect(mutationObservers).toBe(1);
    expect(f.root.count("pointerover")).toBe(0);
    f.destroy();
    expect(h.disposed).toBe(1);
  });

  test("edit on: edit tools attach at construction (open editors hand over before any pointer event)", () => {
    mutationObservers = 0;
    const h = host({ edit: true });
    const f = new mod.DiagramFrame(h, frameOpts);
    expect(h.attached).toBe(1);
    expect(mutationObservers).toBe(0);
    f.root.fire("pointerover");
    expect(h.attached).toBe(1);
    expect(mutationObservers).toBe(1);
    f.destroy();
  });

  test("edit turned on later: applySettings attaches without a hover", () => {
    const h = host({ edit: false });
    const f = new mod.DiagramFrame(h, frameOpts);
    expect(h.attached).toBe(0);
    h.settings().features.toolbar.enabled = true;
    f.applySettings();
    expect(h.attached).toBe(1);
    f.root.fire("pointerover");
    expect(h.attached).toBe(1);
    f.destroy();
  });

  test("edit turned off: applySettings detaches the edit tools; the next hover attaches them again", () => {
    const h = host({ edit: true });
    const f = new mod.DiagramFrame(h, frameOpts);
    f.root.fire("pointerover");
    expect(h.attached).toBe(1);
    h.settings().features.toolbar.enabled = false;
    h.settings().features["inline-edit"].enabled = false;
    f.applySettings();
    expect(h.disposed).toBe(1);
    // Like a frame never hovered: the first pointerover (or focus) attaches.
    expect(f.root.count("pointerover")).toBe(1);
    f.root.fire("pointerover");
    expect(h.attached).toBe(2);
    // An unrelated settings change while edit stays off keeps the hover-attached tools.
    f.applySettings();
    expect(h.disposed).toBe(1);
    f.destroy();
    expect(h.disposed).toBe(2);
    expect(f.root.count("pointerover")).toBe(0);
  });

  test("edit off: keyboard focus builds the chrome too (action tooltips get their hints)", () => {
    mutationObservers = 0;
    const h = host({ edit: false });
    const f = new mod.DiagramFrame(h, frameOpts);
    expect(h.attached).toBe(0);
    f.root.fire("focusin");
    expect(h.attached).toBe(1);
    expect(mutationObservers).toBe(1);
    expect(f.root.count("focusin")).toBe(0);
    expect(f.root.count("pointerover")).toBe(0);
    f.root.fire("pointerover");
    expect(h.attached).toBe(1);
    f.destroy();
  });

  test("destroyed before any hover: nothing built, the hover hook is gone", () => {
    mutationObservers = 0;
    const h = host({ edit: false });
    const f = new mod.DiagramFrame(h, frameOpts);
    f.destroy();
    expect(f.root.count("pointerover")).toBe(0);
    expect(f.root.count("focusin")).toBe(0);
    f.root.fire("pointerover");
    f.root.fire("focusin");
    expect(h.attached).toBe(0);
    expect(mutationObservers).toBe(0);
  });
});

describe("MehrpeleShell edit attach", () => {
  function shellPlugin(edit: boolean) {
    const settings = mod.defaultSettingsV3();
    settings.features.toolbar.enabled = edit;
    const { k, app } = keymapApp();
    const p = {
      settings,
      app,
      keys: k,
      attached: 0,
      disposed: 0,
      attachEdit: () => {
        p.attached++;
        return () => void p.disposed++;
      },
      registerMehr() {},
      unregisterMehr() {},
    };
    return p;
  }
  const shellOpts = { source: "graph TD\n  A --> B\n", lang: "mehrpele", sourcePath: "x.md", onRevealCode() {} };
  const component = { addChild() {}, removeChild() {} };

  test("edit off: attaches on the first hover; edit on: at construction", () => {
    const off = shellPlugin(false);
    const s = new mod.MehrpeleShell(off, component, shellOpts);
    expect(off.attached).toBe(0);
    s.root.fire("pointerover");
    expect(off.attached).toBe(1);
    expect(s.root.count("pointerover")).toBe(0);
    s.destroy();
    expect(off.disposed).toBe(1);
    const on = shellPlugin(true);
    const t = new mod.MehrpeleShell(on, component, shellOpts);
    expect(on.attached).toBe(1);
    t.destroy();
  });

  test("edit turned off: syncEdit detaches; the next hover attaches again", () => {
    const p = shellPlugin(true);
    const s = new mod.MehrpeleShell(p, component, shellOpts);
    p.settings.features.toolbar.enabled = false;
    s.syncEdit();
    expect(p.disposed).toBe(1);
    s.syncEdit();
    expect(p.disposed).toBe(1);
    s.root.fire("focusin");
    expect(p.attached).toBe(2);
    s.syncEdit(); // still off, attached by focus: kept
    expect(p.disposed).toBe(1);
    s.destroy();
    expect(p.disposed).toBe(2);
    expect(s.root.count("pointerover")).toBe(0);
    expect(s.root.count("focusin")).toBe(0);
  });

  test("destroy pops the action bar's key scope", () => {
    const p = shellPlugin(false);
    const s = new mod.MehrpeleShell(p, component, shellOpts);
    s.actionBar.fire("focusin");
    expect(p.keys.pushed.length).toBe(1);
    s.destroy();
    expect(p.keys.popped).toEqual(p.keys.pushed);
    expect(s.actionBar.count("focusin")).toBe(0);
  });
});

describe("DiagramFrame suspend (H1)", () => {
  test("suspend unregisters and hands the frame to the host's suspended set", () => {
    resizeObservers = 0;
    const h = host({ edit: false });
    const f = new mod.DiagramFrame(h, frameOpts);
    f.suspend(() => {});
    expect(h.unregistered).toBe(1);
    expect(h.suspended).toEqual([f]);
    expect(resizeObservers).toBe(1); // the revive observer
    // The host's TTL fires: destroy releases the edit chrome too.
    f.root.fire("pointerover");
    f.destroy();
    expect(h.disposed).toBe(1);
  });

  test("a host without a suspended set gets the frame destroyed instead", () => {
    resizeObservers = 0;
    const h = host({ edit: true, suspend: false });
    const f = new mod.DiagramFrame(h, frameOpts);
    f.suspend(() => {});
    expect(h.disposed).toBe(1);
    expect(resizeObservers).toBe(0);
  });
});

describe("DiagramFrame action bar keys", () => {
  test("suspend pops the key scope, a revive's focus pushes it again, destroy pops it and drops the listeners", () => {
    const h = host({ edit: false });
    const f = new mod.DiagramFrame(h, frameOpts);
    f.actionBar.fire("focusin");
    expect(h.keys.pushed.length).toBe(1);
    f.suspend(() => {});
    expect(h.keys.popped).toEqual(h.keys.pushed);
    f.actionBar.fire("focusin");
    expect(h.keys.pushed.length).toBe(2);
    f.destroy();
    expect(h.keys.popped).toEqual(h.keys.pushed);
    expect(f.actionBar.count("focusin")).toBe(0);
    expect(f.actionBar.count("focusout")).toBe(0);
  });
});

describe("DiagramFrame repair buttons", () => {
  test("show on an error frame only while Repair is on, and follow the toggle live", () => {
    const h = host({ edit: false });
    const f = new mod.DiagramFrame(h, frameOpts);
    // Visibility is the `pele-hidden` class (display:none in styles.css), not inline display.
    const shown = () => [!f.wrenchBtn.classList.contains("pele-hidden"), !f.errorRepairBtn.classList.contains("pele-hidden")];
    expect(shown()).toEqual([false, false]);
    f.showError(new Error("Parse error"));
    expect(shown()).toEqual([true, true]);
    h.settings().features.repair.enabled = false;
    f.applySettings();
    expect(shown()).toEqual([false, false]);
    h.settings().features.repair.enabled = true;
    f.applySettings();
    expect(shown()).toEqual([true, true]);
    f.hideError();
    f.applySettings();
    expect(shown()).toEqual([false, false]);
    f.destroy();
  });
});
