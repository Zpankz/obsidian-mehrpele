/**
 * The attached-views button and its keyboard route, on a small fake DOM (the
 * layer bundled as the plugin bundles it):
 * - the floating button is a button (role, tab stop) and stays while it has
 *   focus, whatever the pointer does;
 * - "Show attached views" targets the hovered node, else the first node with
 *   views in the diagram that holds (or last held) focus, then the next one
 *   while that node's panel is open.
 */
import "../../helpers/dom-globals";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { ALIAS, EXTERNAL, PKG } from "../../helpers/bundle";
import { deep, obsidianStub } from "../../helpers/obsidian-stub";

type Handler = (e: any) => void;

class FakeDoc {
  activeElement: FakeEl | null = null;
  body: FakeEl = new FakeEl(this);
}

/** One compound selector: `tag`, `.a.b`, `[x]`, `[x="v"]`, in any mix. */
function matchOne(el: FakeEl, sel: string): boolean {
  const tokens = sel.match(/\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]|^[\w-]+/g) ?? [];
  if (tokens.join("") !== sel) return false;
  return tokens.every((t) => {
    if (t.startsWith(".")) return el.cls.has(t.slice(1));
    if (t.startsWith("[")) {
      const [, k, v] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(t)!;
      return v === undefined ? el.getAttribute(k!) !== null : el.getAttribute(k!) === v;
    }
    return el.tag === t;
  });
}

class FakeEl {
  nodeType = 1;
  cls = new Set<string>();
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  listeners: Record<string, Handler[]> = {};
  shown = true;
  tabIndex = -1;
  text = "";
  /** querySelector answers, by selector. */
  picks: Record<string, FakeEl> = {};
  constructor(
    public ownerDocument: FakeDoc,
    cls = "",
    public tag = "div",
  ) {
    for (const c of cls.split(" ")) if (c) this.cls.add(c);
  }
  add(...cs: FakeEl[]): this {
    for (const c of cs) {
      c.parentElement = this;
      this.children.push(c);
    }
    return this;
  }
  createDiv(o?: { cls?: string } | string): FakeEl {
    const el = new FakeEl(this.ownerDocument, typeof o === "string" ? o : (o?.cls ?? ""));
    this.add(el);
    return el;
  }
  createSpan(o?: { cls?: string } | string): FakeEl {
    return this.createDiv(o);
  }
  hide(): void {
    this.shown = false;
  }
  show(): void {
    this.shown = true;
  }
  setText(t: string): void {
    this.text = t;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  getAttribute(k: string): string | null {
    if (k.startsWith("data-")) return this.dataset[k.slice(5)] ?? this.attrs[k] ?? null;
    return this.attrs[k] ?? null;
  }
  addEventListener(type: string, fn: Handler): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: Handler): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  dispatchEvent(e: any): boolean {
    for (const fn of this.listeners[e.type] ?? []) fn(e);
    return true;
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
    this.dispatchEvent({ type: "focusin", target: this });
  }
  blur(): void {
    this.ownerDocument.activeElement = this.ownerDocument.body;
    this.dispatchEvent({ type: "focusout", target: this });
  }
  contains(o: FakeEl | null): boolean {
    for (let n = o; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  matches(sel: string): boolean {
    return sel.split(",").some((s) => matchOne(this, s.trim()));
  }
  closest(sel: string): FakeEl | null {
    for (let n: FakeEl | null = this; n; n = n.parentElement) if (n.matches(sel)) return n;
    return null;
  }
  querySelector(sel: string): FakeEl | null {
    return this.picks[sel] ?? null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 };
  }
  remove(): void {}
  get isConnected(): boolean {
    return true;
  }
}

const SVG_QUERY = ":scope > .pele-mount svg, :scope .mehrpele-mount > svg";
const SRC = "flowchart LR\n  A --> B\n  B --> C\n%% pele-view A=localgraph; A=backlink; B=outline %%";

let mod: { AttachedViewsLayer: any; actionBarOwners: WeakMap<FakeEl, FakeEl> };
const doc = new FakeDoc();
const saved = new Map<string, PropertyDescriptor | undefined>();
const GLOBALS: Record<string, unknown> = { document: doc, Element: FakeEl };

beforeAll(async () => {
  const r = await build({
    absWorkingDir: PKG,
    stdin: { contents: `export { AttachedViewsLayer } from "./src/mehrpele/views/attach"; export { actionBarOwners } from "./src/action-bar-location";`, resolveDir: PKG, loader: "ts" },
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

/** A frame: root > (.pele-host > svg > nodes A, B, C) + .embed-actions > action. */
function diagram() {
  const root = new FakeEl(doc, "pele-embed");
  const wrapper = new FakeEl(doc, "pele-host");
  const svg = new FakeEl(doc, "", "svg");
  const bar = new FakeEl(doc, "embed-actions");
  const action = new FakeEl(doc, "embed-action");
  action.setAttribute("role", "button");
  root.add(wrapper, bar);
  wrapper.add(svg);
  bar.add(action);
  wrapper.picks[SVG_QUERY] = svg;
  root.picks[":scope > .pele-host"] = wrapper;
  root.picks[":scope > .embed-actions"] = bar;
  bar.picks[":scope > [role=button]"] = action;
  const nodes: Record<string, FakeEl> = {};
  for (const id of ["A", "B", "C"]) {
    const n = new FakeEl(doc, "pele-node", "g");
    n.dataset.id = id;
    svg.add(n);
    svg.picks[`.pele-node[data-id="${id}"]`] = n;
    nodes[id] = n;
  }
  return { root, wrapper, bar, action, nodes };
}

function layer(opts: { attachedViews?: boolean } = {}) {
  const d = diagram();
  const settings = { enabled: true, attachedViews: opts.attachedViews !== false };
  const host = { app: {}, settings: () => settings, notify() {} };
  const resolve = (w: FakeEl) => (w === d.wrapper ? { source: SRC, sourcePath: "n.md", wrapper: w } : null);
  const l = new mod.AttachedViewsLayer(host, {}, resolve);
  const btn = doc.body.children.at(-1)!;
  return { l, btn, settings, ...d };
}

describe("attach button", () => {
  test("is a tab-reachable button that stays while it has focus", async () => {
    const { l, btn, nodes } = layer();
    expect(btn.cls.has("mehrpele-view-attach-btn")).toBe(true);
    expect(btn.getAttribute("role")).toBe("button");
    expect(btn.tabIndex).toBe(0);
    l.update(nodes.A);
    expect(btn.shown).toBe(true);
    btn.focus();
    l.update(new FakeEl(doc, "markdown-preview-view"));
    await Bun.sleep(420);
    expect(btn.shown).toBe(true);
    btn.blur();
    await Bun.sleep(420);
    expect(btn.shown).toBe(false);
    l.destroy();
  });
});

describe("keyboard route", () => {
  test("finds the owning diagram when its focused bar is floated under the body", () => {
    const { l, root, bar, action, wrapper } = layer();
    const floating = new FakeEl(doc, "pele-floating-actions");
    floating.add(bar);
    mod.actionBarOwners.set(bar, root);
    l.onFocusIn({ target: action });
    expect(l.keyboardTarget()?.info.wrapper).toBe(wrapper);
    mod.actionBarOwners.delete(bar);
    l.destroy();
  });
  test("skips stale directives and is unavailable when all referenced nodes are gone", () => {
    const { l, action, wrapper } = layer();
    const svg = wrapper.querySelector(SVG_QUERY)!;
    delete svg.picks['.pele-node[data-id="A"]'];
    l.onFocusIn({ target: action });
    expect(l.keyboardTarget().node).toBe("B");
    delete svg.picks['.pele-node[data-id="B"]'];
    expect(l.keyboardTarget()).toBeNull();
    l.destroy();
  });
  test("accepts focused elements from another window's realm", () => {
    const { l, action, wrapper } = layer();
    const other = new FakeDoc();
    const foreign = { ownerDocument: other, isConnected: true, closest: action.closest.bind(action) };
    wrapper.ownerDocument = other;
    expect(foreign instanceof FakeEl).toBe(false);
    l.onFocusIn({ target: foreign });
    expect(l.keyboardTarget()?.info.wrapper).toBe(wrapper);
    l.destroy();
  });
  test("uses the diagram action as the return target when opening hides the button", () => {
    const { l, btn, action, wrapper } = layer();
    wrapper.parentElement!.picks[":scope > .embed-actions > [role=button]"] = action;
    btn.focus();
    const observed: { opener: FakeEl | null } = { opener: null };
    l.openPanel = () => ({ takeFocus() { observed.opener = doc.activeElement; } });
    l.openFromKeyboard({ info: { wrapper } });
    expect(observed.opener).toBe(action);
    l.destroy();
  });
  test("targets the hovered node, else the focused diagram's first node with views, then the next while its panel is open", () => {
    const { l, action, wrapper, nodes, settings } = layer();
    expect(l.keyboardTarget()).toBeNull();
    l.onFocusIn({ target: action });
    const first = l.keyboardTarget();
    expect(first.node).toBe("A");
    expect(first.views.length).toBe(2);
    expect(first.info.wrapper).toBe(wrapper);
    // Focus in the command palette keeps the diagram that had it.
    const modal = new FakeEl(doc, "modal-container");
    const input = new FakeEl(doc, "prompt-input", "input");
    modal.add(input);
    l.onFocusIn({ target: input });
    expect(l.keyboardTarget().node).toBe("A");
    // With that node's panel open, the next node with views; then round again.
    l.panel = { node: "A", info: first.info, el: new FakeEl(doc, "mehrpele-view-panel"), close() {} };
    expect(l.keyboardTarget().node).toBe("B");
    // Also with focus in that panel (its tab took focus when it opened).
    const tab = new FakeEl(doc, "mehrpele-view-panel-tab");
    l.panel.el.add(tab);
    l.onFocusIn({ target: tab });
    expect(l.keyboardTarget().node).toBe("B");
    l.panel = { node: "B", info: first.info, el: l.panel.el, close() {} };
    expect(l.keyboardTarget().node).toBe("A");
    l.panel = null;
    // The hovered node (the button's) comes first.
    l.update(nodes.B);
    expect(l.keyboardTarget().node).toBe("B");
    l.update(nodes.C);
    settings.attachedViews = false;
    expect(l.keyboardTarget()).toBeNull();
    settings.attachedViews = true;
    // Focus elsewhere (an editor) drops the diagram.
    l.onFocusIn({ target: new FakeEl(doc, "cm-content") });
    l.update(new FakeEl(doc, "cm-content"));
    (l as any).hideNow();
    expect(l.keyboardTarget()).toBeNull();
    l.destroy();
  });
});
