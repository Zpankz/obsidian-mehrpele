/**
 * The companion API host side: createHostApi's shape and unload order,
 * frame handles (identity across re-renders, overlay re-parenting, render/destroy
 * events), companion action buttons and menu items, against a small fake DOM; then the
 * bundled plugin's `api` field, ready event and unload override.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { Component, deep, obsidianStub } from "./helpers/obsidian-stub";
import { bundleMain } from "./helpers/bundle";

// The shared stub: with several files mocking "obsidian" in one run, the first mock's export names stick.
mock.module("obsidian", () => obsidianStub);
const { createHostApi, API_READY_EVENT, API_UNLOAD_EVENT } = await import("../src/api/host-api");
const { HandleRegistry, OVERLAY_CLASS, OVERLAY_LAYER_CLASS, sharedSizeObserver } = await import("../src/api/frame-handles");
const { CompanionActions, COMPANION_ACTION_CLASS } = await import("../src/api/frame-actions");
const { CompanionMenus } = await import("../src/api/menu-items");
const { contextItems } = await import("../src/context-menu-spec");
const { sourceDiagramType } = await import("../src/diagram-type");
const { AddonHints, FLOW_HINT_LAYER, FLOW_HINT_TEXT } = await import("../src/api/hints");

// region fake DOM
class FakeEl {
  className = "";
  textContent = "";
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  attrs = new Map<string, string>();
  listeners = new Map<string, ((e: unknown) => void)[]>();
  box = { left: 0, top: 0, width: 0, height: 0 };
  offsetWidth = 0;
  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDoc,
  ) {}
  get nextSibling(): FakeEl | null {
    const p = this.parentElement;
    return p ? (p.children[p.children.indexOf(this) + 1] ?? null) : null;
  }
  get previousSibling(): FakeEl | null {
    const p = this.parentElement;
    return p ? (p.children[p.children.indexOf(this) - 1] ?? null) : null;
  }
  get lastChild(): FakeEl | null {
    return this.children[this.children.length - 1] ?? null;
  }
  appendChild(c: FakeEl): FakeEl {
    c.remove();
    c.parentElement = this;
    this.children.push(c);
    return c;
  }
  /** Obsidian's `createDiv` element method: a child div, appended. */
  createDiv(o: { cls?: string; text?: string } = {}): FakeEl {
    const d = this.appendChild(this.ownerDocument.createElement("div"));
    d.className = o.cls ?? "";
    d.textContent = o.text ?? "";
    return d;
  }
  createEl(tag: string, o: { cls?: string; text?: string } = {}): FakeEl {
    const el = this.appendChild(this.ownerDocument.createElement(tag));
    el.className = o.cls ?? "";
    el.textContent = o.text ?? "";
    return el;
  }
  insertBefore(c: FakeEl, ref: FakeEl | null): FakeEl {
    if (!ref) return this.appendChild(c);
    c.remove();
    this.children.splice(this.children.indexOf(ref), 0, c);
    c.parentElement = this;
    return c;
  }
  remove(): void {
    const p = this.parentElement;
    if (!p) return;
    p.children.splice(p.children.indexOf(this), 1);
    this.parentElement = null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  /** Runs the `type` listeners, as the browser would on that event. */
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ type });
  }
  click(): void {
    const e = { preventDefault: () => undefined, stopPropagation: () => undefined };
    for (const fn of this.listeners.get("click") ?? []) fn(e);
  }
  /** Only `.cls[data-id="x"]`, as nodeRect asks. */
  querySelector(sel: string): FakeEl | null {
    const m = /^\.([\w-]+)\[data-id="(.*)"\]$/.exec(sel);
    if (!m) return null;
    for (const c of this.children) {
      if (c.className.split(" ").includes(m[1]!) && c.getAttribute("data-id") === m[2]) return c;
      const hit = c.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return this.box;
  }
}
class FakeDoc {
  createElement(tag: string): FakeEl {
    return new FakeEl(tag, this);
  }
}
// endregion fake DOM

const doc = new FakeDoc();
// Obsidian's `createDiv` global, creating in the fake document (restored after this file).
const savedCreateDiv = Object.getOwnPropertyDescriptor(globalThis, "createDiv");
beforeAll(() => {
  Object.defineProperty(globalThis, "createDiv", { value: () => doc.createElement("div"), configurable: true, writable: true });
});
afterAll(() => {
  if (savedCreateDiv) Object.defineProperty(globalThis, "createDiv", savedCreateDiv);
  else delete (globalThis as Record<string, unknown>).createDiv;
});
const div = (cls = ""): FakeEl => {
  const el = doc.createElement("div");
  el.className = cls;
  return el;
};

/** A frame or shell for `key`: root > host > mount > svg, and a bar with two built-ins. */
function surface(key: string, lang = "mermaid") {
  const root = div("pele-embed");
  const host = div("pele-host");
  const mount = div("pele-mount");
  const svg = doc.createElement("svg");
  const bar = div("embed-actions");
  root.appendChild(host);
  host.appendChild(mount);
  mount.appendChild(svg);
  root.appendChild(bar);
  bar.appendChild(div("embed-action builtin-zoom"));
  bar.appendChild(div("embed-action builtin-code"));
  const s = {
    key,
    sourcePath: key.split("#")[0]!,
    lang,
    fenceRest: "theme=x",
    root,
    host,
    mount,
    bar,
    rerenders: 0,
    /** What `locate` reports: the fence's live line and rest (null: can't tell). */
    loc: null as { line: number; rest: string; exact?: boolean } | null,
    locate: () => s.loc,
    svgEl: svg,
    svg: () => svg,
    diagramType: () => "flowchart",
    source: () => "flowchart LR\n  a --> b",
    rerender: () => void s.rerenders++,
  };
  return s;
}
type Surface = ReturnType<typeof surface>;
const asSurface = (s: Surface) => s as unknown as import("../src/api/frame-handles").FrameSurface;

/**
 * A handle registry with a manual animation-frame queue, a manual size observer and
 * manual timers (`elapse`).
 */
function registry() {
  const queue: (() => void)[] = [];
  /** Observed frame roots → their size callback (the fake ResizeObserver). */
  const observed = new Map<unknown, (shown: boolean) => void>();
  /** Pending `wait` timers. */
  const timers = new Set<{ cb: () => void; at: number }>();
  let now = 0;
  const actions = new CompanionActions(() => handles.refreshAllActions());
  const handles = new HandleRegistry({
    actions,
    provenance: (src) => (src.includes("pele-canvas") ? { nodes: { a: { canvasId: "c1" } } } : null),
    nextFrame: (cb) => void queue.push(cb),
    observeSize: (el, cb) => {
      observed.set(el, cb);
      return () => void observed.delete(el);
    },
    wait: (cb, ms) => {
      const t = { cb, at: now + ms };
      timers.add(t);
      return () => void timers.delete(t);
    },
  });
  const flush = (): void => {
    for (const cb of queue.splice(0)) cb();
  };
  /** Advances the manual clock by `ms`, running the timers that come due. */
  const elapse = (ms: number): void => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (t.at > now) continue;
      timers.delete(t);
      t.cb();
    }
  };
  const bind = (s: Surface) => handles.bind(asSurface(s));
  const unbind = (s: Surface) => handles.unbind(asSurface(s));
  const rendered = (s: Surface) => handles.rendered(asSurface(s));
  /** Gives the frame's host a size and reports it, as the frame root's ResizeObserver would. */
  const resize = (s: Surface, width: number, height: number): void => {
    s.host.box = { left: 0, top: 0, width, height };
    s.host.offsetWidth = width;
    observed.get(s.root)?.(width > 0 || height > 0);
  };
  return { handles, actions, flush, elapse, timers, bind, unbind, rendered, resize, observed, menus: new CompanionMenus() };
}

/** The surface `s` or its DOM nodes, wherever the handle's own fields (one level deep) still hold them. */
function pinned(h: unknown, s: Surface): string[] {
  const dead = new Set<unknown>([s, s.root, s.host, s.mount, s.bar, s.svgEl]);
  const out: string[] = [];
  for (const [k, v] of Object.entries(h as object)) {
    if (dead.has(v)) out.push(k);
    if (v && typeof v === "object" && !(v instanceof HandleRegistry))
      for (const [k2, v2] of Object.entries(v)) if (dead.has(v2)) out.push(`${k}.${k2}`);
  }
  return out;
}

const feature = (id: string, dispose: () => void) => ({ id, name: id, version: "0.0.1", requiredHostMinor: 1, dispose });

describe("host add-on hints", () => {
  test("flow tokens, toggle and readiness reconcile one native button without a diagram redraw", () => {
    const r = registry();
    const flow = surface("Flow.md#0", "pele");
    flow.fenceRest = "width=400 cannoli";
    const plain = surface("Plain.md#0");
    plain.fenceRest = "not-cannoli";
    const h = r.bind(flow), p = r.bind(plain);
    let enabled = true, ready = false, opens = 0;
    const hints = new AddonHints({ handles: r.handles, enabled: () => enabled, ready: () => ready, openFlows: () => void opens++ });
    const layer = h.overlay(FLOW_HINT_LAYER) as unknown as FakeEl;
    expect(layer.children).toHaveLength(1);
    const button = layer.children[0]!;
    expect(button.tagName).toBe("button");
    expect(button.textContent).toBe(FLOW_HINT_TEXT);
    (button as unknown as HTMLButtonElement).onclick!({ stopPropagation() {} } as PointerEvent);
    expect(opens).toBe(1);
    r.rendered(flow); r.flush(); hints.refresh();
    expect(layer.children).toEqual([button]);
    expect((p.overlay(FLOW_HINT_LAYER) as unknown as FakeEl).children).toHaveLength(0);
    ready = true; hints.refresh();
    expect(layer.children).toHaveLength(0);
    ready = false; hints.refresh();
    expect(layer.children).toHaveLength(1);
    enabled = false; hints.refresh();
    expect(layer.children).toHaveLength(0);
    enabled = true; hints.refresh();
    hints.dispose(); hints.dispose();
    expect(layer.children).toHaveLength(0);
    r.rendered(flow); r.flush(); hints.refresh();
    expect(layer.children).toHaveLength(0);
    expect(flow.rerenders).toBe(0);
    r.handles.disposeAll();
  });

  test("feature metadata replacement notifies only the final state and stale disposers cannot erase it", () => {
    const { host, api } = hostApi();
    const states: (number | null)[] = [];
    const off = host.onFeaturesChanged(() => states.push(host.feature("addon")?.requiredHostMinor ?? null));
    const first = api.registerFeature(feature("addon", () => undefined));
    const def = { ...feature("addon", () => undefined), requiredHostMinor: 2 };
    const second = api.registerFeature(def);
    def.requiredHostMinor = 9;
    first();
    expect(states).toEqual([1, 2]);
    expect(host.feature("addon")?.requiredHostMinor).toBe(2);
    second();
    expect(states).toEqual([1, 2, null]);
    off(); host.unload();
  });

  test("throwing companion cleanup removes metadata and layers before notifying", () => {
    const { host, api, bind } = hostApi({ adopt: () => () => { throw new Error("cleanup"); } });
    const h = bind(surface("a.md#1"));
    const layer = h.overlay("addon") as unknown as FakeEl;
    const end = api.registerFeature(feature("addon", () => undefined));
    const seen: unknown[] = [];
    host.onFeaturesChanged(() => seen.push([host.feature("addon"), layer.parentElement]));
    expect(end).toThrow("cleanup");
    expect(seen).toEqual([[null, null]]);
    host.unload();
    expect(seen).toHaveLength(1);
  });
});

/** A host api over a fresh registry, with a recording workspace and feature registry. */
function hostApi(over: Partial<Parameters<typeof createHostApi>[0]> = {}) {
  const r = registry();
  const log: string[] = [];
  const triggers: [string, unknown, boolean][] = [];
  let host: ReturnType<typeof createHostApi>;
  const features = new Component();
  features.load();
  host = createHostApi({
    hostVersion: "1.2.3",
    pele: Object.freeze({ render: () => undefined }),
    workspace: {
      trigger: (name, arg) => {
        triggers.push([name, arg, host.api.isLive!()]);
        log.push(`trigger:${name}`);
      },
    },
    adopt: (def) => {
      const child = new Component();
      if (def.dispose) child.register(() => def.dispose!());
      features.addChild(child);
      return () => features.removeChild(child);
    },
    handles: r.handles,
    actions: r.actions,
    menus: r.menus,
    canvas: () => ({
      mermaidToCanvas: (src, opts) => ({ canvas: { nodes: [], edges: [] }, fidelity: "exact", dropped: [], src, opts }) as never,
      canvasToMermaid: (canvas, opts) => ({ source: `from:${JSON.stringify(canvas)}:${JSON.stringify(opts)}`, mehrpele: false }),
    }),
    read: async () => "{}",
    mountDiagram: () => undefined,
    onModify: () => () => undefined,
    schedule: () => () => undefined,
    ...over,
  });
  return { ...r, host, api: host.api, log, triggers };
}

describe("createHostApi", () => {
  test("api shape: version 1, minor 1, frozen, canvas opts passed through", () => {
    const { api } = hostApi();
    expect(api.apiVersion).toBe(1);
    expect(api.apiMinor).toBe(1);
    expect(api.hostVersion).toBe("1.2.3");
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.frames)).toBe(true);
    expect(Object.isFrozen(api.canvas)).toBe(true);
    expect(() => {
      (api as { apiVersion: number }).apiVersion = 2;
    }).toThrow();
    for (const k of ["registerFeature", "addFrameAction", "refreshActions", "addMenuItems", "mountCanvas", "isLive"] as const)
      expect(typeof api[k]).toBe("function");
    for (const k of ["list", "forElement", "onDidRender", "onDidDestroy"] as const) expect(typeof api.frames[k]).toBe("function");
    expect(api.isLive!()).toBe(true);
    const opts = { direction: "TB" };
    const res = api.canvas.mermaidToCanvas("flowchart LR", opts) as unknown as { opts: unknown };
    expect(res.opts).toBe(opts);
    expect(api.canvas.canvasToMermaid({ nodes: [], edges: [] }, { lang: "x" })).toBe('from:{"nodes":[],"edges":[]}:{"lang":"x"}');
  });

  test("ready() fires mehrpele:api-ready with the api", () => {
    const { host, api, triggers } = hostApi();
    host.ready();
    expect(triggers).toEqual([[API_READY_EVENT, api, true]]);
  });

  test("registerFeature disposer removes <id> and <id>:x layers from every frame, once", () => {
    const { api, bind, log } = hostApi();
    const a = bind(surface("a.md#1"));
    const b = bind(surface("b.md#4"));
    const keep = [a.overlay("other"), a.overlay("stubx"), b.overlay("stub-2")];
    const gone = [a.overlay("stub"), a.overlay("stub:badges"), b.overlay("stub:x:y")];
    const dispose = api.registerFeature(feature("stub", () => void log.push("dispose")));
    dispose();
    dispose();
    expect(log).toEqual(["dispose"]);
    for (const el of gone) expect((el as unknown as FakeEl).parentElement).toBeNull();
    for (const el of keep) expect((el as unknown as FakeEl).parentElement).not.toBeNull();
    // A new layer with a removed id is a fresh element.
    expect(a.overlay("stub")).not.toBe(gone[0]);
  });

  test("re-registering an id replaces the earlier registration; the stale disposer does nothing", () => {
    const { host, api, bind, log } = hostApi();
    const a = bind(surface("a.md#1"));
    const oldDispose = api.registerFeature(feature("stub", () => void log.push("old")));
    const oldLayer = a.overlay("stub:x") as unknown as FakeEl;
    const newDispose = api.registerFeature(feature("stub", () => void log.push("new")));
    expect(log).toEqual(["old"]);
    expect(oldLayer.parentElement).toBeNull();
    const newLayer = a.overlay("stub:x") as unknown as FakeEl;
    oldDispose();
    expect(log).toEqual(["old"]);
    expect(newLayer.parentElement).not.toBeNull();
    host.unload();
    expect(log).toEqual(["old", `trigger:${API_UNLOAD_EVENT}`, "new"]);
    newDispose();
    expect(log.length).toBe(3);
  });

  test("registerFeature after unload is refused: a no-op disposer, no adopt, no watching, a warning", () => {
    const adopted: string[] = [];
    const { host, api, bind, observed } = hostApi({
      adopt: (def) => {
        adopted.push(def.id);
        return () => undefined;
      },
    });
    host.unload();
    bind(surface("a.md#1"));
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const dispose = api.registerFeature(feature("late", () => undefined));
      expect(typeof dispose).toBe("function");
      expect(() => dispose()).not.toThrow();
      expect(adopted).toEqual([]);
      expect(observed.size).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("frame actions, menu items, frame listeners and canvas mounts after unload are refused", async () => {
    const mounted: unknown[] = [];
    const { host, api, bind, observed, actions, menus } = hostApi({ mountDiagram: (el) => void mounted.push(el) });
    host.unload();
    bind(surface("a.md#1"));
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const disposers = [
        api.addFrameAction({ id: "go", icon: "play", title: "Go", when: () => true, run: () => undefined }),
        api.addMenuItems(() => undefined),
        api.frames.onDidRender(() => undefined),
        api.frames.onDidDestroy(() => undefined),
      ];
      const m = api.mountCanvas({ path: "x.canvas" } as never, div() as unknown as HTMLElement);
      await Promise.resolve();
      await Promise.resolve();
      for (const d of [...disposers, m.destroy]) expect(() => d()).not.toThrow();
      expect(actions.size).toBe(0);
      expect(menus.size).toBe(0);
      expect(observed.size).toBe(0);
      expect(mounted).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(5);
    } finally {
      warn.mockRestore();
    }
  });

  test("unload: isLive false before api-unload, the arg is the api, then companion state goes", () => {
    const { host, api, triggers, log, bind, rendered, menus } = hostApi();
    api.registerFeature(feature("stub", () => void log.push("dispose")));
    const s = surface("a.md#1");
    const h = bind(s);
    api.addFrameAction({ id: "go", icon: "play", title: "Go", when: () => true, run: () => undefined });
    rendered(s);
    const overlay = h.overlay("stub:x") as unknown as FakeEl;
    api.addMenuItems((m) => void m.addItem((i) => i.setTitle("x")));
    host.unload();
    host.unload();
    expect(triggers).toEqual([[API_UNLOAD_EVENT, api, false]]);
    expect(log).toEqual([`trigger:${API_UNLOAD_EVENT}`, "dispose"]);
    expect(api.isLive!()).toBe(false);
    expect(h.isConnected()).toBe(false);
    expect(api.frames.list()).toEqual([]);
    expect(overlay.parentElement?.parentElement ?? null).toBeNull();
    expect(s.bar.children.some((c) => c.className.includes(COMPANION_ACTION_CLASS))).toBe(false);
    expect(menus.size).toBe(0);
    host.ready();
    expect(triggers.length).toBe(1);
  });

  test("mountCanvas reads the canvas, converts it and mounts with path#0 and fenceRest; destroy unloads", async () => {
    const mounted: unknown[][] = [];
    let owner: unknown = null;
    const { api } = hostApi({
      read: async () => '{"nodes":[],"edges":[]}',
      canvas: () => ({
        mermaidToCanvas: () => ({}) as never,
        canvasToMermaid: () => ({ source: "flowchart LR", mehrpele: true }),
      }),
      mountDiagram: (el, o, ...rest) => {
        owner = o;
        mounted.push([el, ...rest]);
      },
    });
    const el = div() as unknown as HTMLElement;
    const m = api.mountCanvas({ path: "Maps/x.canvas" } as never, el, { fenceRest: "theme=dark" });
    await Promise.resolve();
    await Promise.resolve();
    expect(mounted).toEqual([[el, "flowchart LR", "Maps/x.canvas", "mehrpele", { key: "Maps/x.canvas#0", fenceRest: "theme=dark" }]]);
    expect((owner as unknown as { _loaded: boolean })._loaded).toBe(true);
    m.destroy();
    expect((owner as unknown as { _loaded: boolean })._loaded).toBe(false);
    // Destroyed before the read finished: nothing mounts.
    const late = api.mountCanvas({ path: "y.canvas" } as never, el);
    late.destroy();
    await Promise.resolve();
    await Promise.resolve();
    expect(mounted.length).toBe(1);
  });

  test("mountCanvas destroy removes the frame it added and leaves the container's own children", async () => {
    const { api } = hostApi({
      mountDiagram: (el) => void (el as unknown as FakeEl).appendChild(div("pele-embed")),
    });
    const el = div("host-el");
    const own = div("companion-own");
    el.appendChild(own);
    const m = api.mountCanvas({ path: "x.canvas" } as never, el as unknown as HTMLElement);
    await Promise.resolve();
    await Promise.resolve();
    expect(el.children.map((c) => c.className)).toEqual(["companion-own", "pele-embed"]);
    m.destroy();
    expect(el.children).toEqual([own]);
    // Mounting again into the same element leaves one frame, not two.
    const again = api.mountCanvas({ path: "x.canvas" } as never, el as unknown as HTMLElement);
    await Promise.resolve();
    await Promise.resolve();
    expect(el.children.map((c) => c.className)).toEqual(["companion-own", "pele-embed"]);
    again.destroy();
  });

  test("host unload while a mountCanvas read is pending: nothing mounts and its owner unloads", async () => {
    let finish: (text: string) => void = () => undefined;
    const mounted: unknown[] = [];
    const { host, api } = hostApi({
      read: () => new Promise<string>((res) => (finish = res)),
      mountDiagram: (el) => void mounted.push(el),
    });
    const m = api.mountCanvas({ path: "x.canvas" } as never, div() as unknown as HTMLElement);
    host.unload();
    finish("{}");
    await Promise.resolve();
    await Promise.resolve();
    expect(mounted).toEqual([]);
    expect(() => m.destroy()).not.toThrow();
  });

  // region mountCanvas live
  /** A host with a fake vault `modify` source and a manual timer queue. */
  function liveHost(texts: (string | Promise<string>)[] = ['{"v":1}', '{"v":2}', '{"v":3}']) {
    const watchers = new Set<(f: { path: string }) => void>();
    const watched: string[] = [];
    const timers: { cb: () => void; ms: number; live: boolean }[] = [];
    const log: string[] = [];
    const mounts: { args: unknown[]; owner: Component; frame: FakeEl }[] = [];
    let reads = 0;
    const r = hostApi({
      read: async () => texts[Math.min(reads++, texts.length - 1)]!,
      canvas: () => ({
        mermaidToCanvas: () => ({}) as never,
        canvasToMermaid: (c) => ({ source: `flowchart ${JSON.stringify(c)}`, mehrpele: false }),
      }),
      mountDiagram: (el, owner, ...args) => {
        const n = mounts.length + 1;
        const frame = div(`frame-${n}`);
        log.push(`mount:${n}:children=${(el as unknown as FakeEl).children.map((c) => c.className).join(",")}`);
        (el as unknown as FakeEl).appendChild(frame);
        owner.register(() => void log.push(`unload:${n}`));
        mounts.push({ args, owner: owner as unknown as Component, frame });
      },
      onModify: (file, cb) => {
        watched.push(file.path);
        watchers.add(cb);
        return () => void watchers.delete(cb);
      },
      schedule: (cb, ms) => {
        const t = { cb, ms, live: true };
        timers.push(t);
        return () => void (t.live = false);
      },
    });
    const modify = (path: string): void => {
      for (const w of [...watchers]) w({ path });
    };
    const runTimers = (): void => {
      for (const t of timers.splice(0)) if (t.live) t.cb();
    };
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    };
    return { ...r, watchers, watched, timers, log, mounts, modify, runTimers, settle, reads: () => reads };
  }

  test("mountCanvas with key and locate: mount args carry them (no fence line: no write-back)", async () => {
    const h = liveHost();
    const locate = () => ({ line: 4, rest: "cannoli" });
    const el = div();
    h.host.mountCanvas({ path: "Maps/f.canvas" } as never, el as unknown as HTMLElement, { fenceRest: "cannoli", key: "Notes/a.md#4", locate });
    await h.settle();
    // The dep has no fence-line parameter: main.ts passes undefined, so edits never write into the fence body.
    expect(h.mounts.map((m) => m.args)).toEqual([
      ['flowchart {"v":1}', "Maps/f.canvas", "mermaid", { key: "Notes/a.md#4", fenceRest: "cannoli", locate }],
    ]);
    expect((h.mounts[0]!.args[3] as { locate: unknown }).locate).toBe(locate);
  });

  test("an embed's frame belongs to the note holding the fence, so resync keeps its key", async () => {
    const h = liveHost();
    const el = div();
    h.host.mountCanvas({ path: "Maps/f.canvas" } as never, el as unknown as HTMLElement, {
      fenceRest: "cannoli",
      key: "Notes/a.md#4",
      locate: () => ({ line: 4, rest: "cannoli" }),
      sourcePath: "Notes/a.md",
    });
    await h.settle();
    expect(h.mounts[0]!.args[1]).toBe("Notes/a.md");
  });

  test("a modify of the canvas re-reads, converts and mounts a new child with the same key before the old goes", async () => {
    const h = liveHost();
    const el = div();
    h.host.mountCanvas({ path: "Maps/f.canvas" } as never, el as unknown as HTMLElement, { fenceRest: "cannoli", key: "Notes/a.md#4" });
    await h.settle();
    expect(h.watched).toEqual(["Maps/f.canvas"]);
    h.modify("Maps/f.canvas");
    expect(h.reads()).toBe(1); // debounced, not yet
    expect(h.timers.map((t) => t.ms)).toEqual([120]);
    h.runTimers();
    await h.settle();
    expect(h.reads()).toBe(2);
    expect(h.log).toEqual(["mount:1:children=", "mount:2:children=frame-1", "unload:1"]);
    expect(h.mounts.map((m) => m.args)).toEqual([
      ['flowchart {"v":1}', "Maps/f.canvas", "mermaid", { key: "Notes/a.md#4", fenceRest: "cannoli" }],
      ['flowchart {"v":2}', "Maps/f.canvas", "mermaid", { key: "Notes/a.md#4", fenceRest: "cannoli" }],
    ]);
    expect(el.children.map((c) => c.className)).toEqual(["frame-2"]);
    expect(h.mounts[1]!.owner._loaded).toBe(true);
  });

  test("canvas modify after an LP fence moves mounts under its current key", async () => {
    const h = liveHost();
    const el = div();
    let line = 4;
    h.host.mountCanvas({ path: "Maps/f.canvas" } as never, el as unknown as HTMLElement, {
      key: "Notes/a.md#4", sourcePath: "Notes/a.md", fenceRest: "cannoli",
      locate: () => ({ line, rest: "cannoli" }),
    });
    await h.settle();
    line = 7;
    h.modify("Maps/f.canvas");
    h.runTimers();
    await h.settle();
    expect(h.mounts[1]!.args[3]).toMatchObject({ key: "Notes/a.md#7" });
  });

  test("repeated modifies coalesce into one re-render", async () => {
    const h = liveHost();
    h.host.mountCanvas({ path: "f.canvas" } as never, div() as unknown as HTMLElement);
    await h.settle();
    h.modify("f.canvas");
    h.modify("f.canvas");
    h.modify("f.canvas");
    h.runTimers();
    await h.settle();
    expect(h.reads()).toBe(2);
    expect(h.mounts.length).toBe(2);
  });

  test("a modify of another file does nothing", async () => {
    const h = liveHost();
    h.host.mountCanvas({ path: "f.canvas" } as never, div() as unknown as HTMLElement);
    await h.settle();
    h.modify("g.canvas");
    h.runTimers();
    await h.settle();
    expect(h.timers.length).toBe(0);
    expect(h.reads()).toBe(1);
    expect(h.mounts.length).toBe(1);
  });

  test("destroy unregisters the watcher; a modify pending or arriving after destroy mounts nothing", async () => {
    const h = liveHost();
    const el = div();
    const m = h.host.mountCanvas({ path: "f.canvas" } as never, el as unknown as HTMLElement);
    await h.settle();
    const cb = [...h.watchers][0]!;
    h.modify("f.canvas");
    m.destroy();
    expect(h.watchers.size).toBe(0);
    h.runTimers();
    cb({ path: "f.canvas" });
    h.runTimers();
    await h.settle();
    expect(h.reads()).toBe(1);
    expect(h.mounts.length).toBe(1);
    expect(el.children).toEqual([]);
  });

  test("a re-read pending at destroy (or host unload) mounts nothing", async () => {
    const h = liveHost();
    const m = h.host.mountCanvas({ path: "f.canvas" } as never, div() as unknown as HTMLElement);
    await h.settle();
    h.modify("f.canvas");
    h.runTimers();
    m.destroy();
    await h.settle();
    expect(h.mounts.length).toBe(1);
    const h2 = liveHost();
    h2.host.mountCanvas({ path: "f.canvas" } as never, div() as unknown as HTMLElement);
    await h2.settle();
    h2.modify("f.canvas");
    h2.runTimers();
    h2.host.unload();
    await h2.settle();
    expect(h2.mounts.length).toBe(1);
    expect(h2.watchers.size).toBe(0);
  });

  test("live: false mounts without a watcher", async () => {
    const h = liveHost();
    h.host.mountCanvas({ path: "f.canvas" } as never, div() as unknown as HTMLElement, { live: false });
    await h.settle();
    expect(h.watched).toEqual([]);
    expect(h.mounts.length).toBe(1);
  });

  test("a stale initial read rejection cannot replace tracking of a newer successful frame", async () => {
    let rejectInitial: (error: unknown) => void = () => {};
    const pending = new Promise<string>((_, reject) => { rejectInitial = reject; });
    const h = liveHost([pending, '{"v":2}', '{"v":3}']);
    const el = div();
    const err = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const mount = h.host.mountCanvas({ path: "f.canvas" } as never, el as unknown as HTMLElement);
      h.modify("f.canvas"); h.runTimers(); await h.settle();
      expect(el.children.map((c) => c.className)).toEqual(["frame-1"]);
      rejectInitial(new Error("stale read")); await h.settle();
      expect(err).not.toHaveBeenCalled();
      expect(el.children.map((c) => c.className)).toEqual(["frame-1"]);
      h.modify("f.canvas"); h.runTimers(); await h.settle();
      expect(el.children.map((c) => c.className)).toEqual(["frame-2"]);
      mount.destroy();
      expect(el.children).toEqual([]);
    } finally { err.mockRestore(); }
  });

  test("a re-render whose canvas fails to parse keeps the current frame", async () => {
    const h = liveHost(['{"v":1}', "{not json"]);
    const el = div();
    const err = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      h.host.mountCanvas({ path: "f.canvas" } as never, el as unknown as HTMLElement);
      await h.settle();
      h.modify("f.canvas");
      h.runTimers();
      await h.settle();
      expect(el.children.map((c) => c.className)).toEqual(["frame-1"]);
      expect(h.mounts[0]!.owner._loaded).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  test("a first-render error is a tracked element: a later good render removes it, the container's own children stay", async () => {
    const h = liveHost(["{not json", '{"v":2}']);
    const el = div();
    const own = div("companion-own");
    el.appendChild(own);
    const err = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      h.host.mountCanvas({ path: "f.canvas" } as never, el as unknown as HTMLElement);
      await h.settle();
      expect(el.children.map((c) => c.className)).toEqual(["companion-own", "pele-error"]);
      expect(el.children[1]!.textContent).toBe("Mehrpele: could not render f.canvas");
      expect(el.textContent).toBe("");
      h.modify("f.canvas");
      h.runTimers();
      await h.settle();
      expect(el.children.map((c) => c.className)).toEqual(["companion-own", "frame-1"]);
      expect(el.textContent).toBe("");
    } finally {
      err.mockRestore();
    }
  });

  test("a mount that throws after its owner loaded unloads that owner", async () => {
    let owner: unknown = null;
    const { api } = hostApi({
      mountDiagram: (_el, o) => {
        owner = o;
        throw new Error("boom");
      },
    });
    const el = div();
    const err = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      api.mountCanvas({ path: "x.canvas" } as never, el as unknown as HTMLElement);
      for (let i = 0; i < 4; i++) await Promise.resolve();
      expect(owner).not.toBeNull();
      expect((owner as { _loaded: boolean })._loaded).toBe(false);
      expect(el.children.map((c) => c.className)).toEqual(["pele-error"]);
    } finally {
      err.mockRestore();
    }
  });
  // endregion mountCanvas live
});

describe("frame handles", () => {
  test("the same handle across a re-render and a rebind; destroyed only after a real destroy", () => {
    const { handles, bind, unbind, rendered, flush } = registry();
    const destroyed: unknown[] = [];
    handles.onDidDestroy((f) => void destroyed.push(f));
    const a = surface("n.md#3");
    const h = bind(a);
    rendered(a);
    expect(handles.handleOf(asSurface(a))).toBe(h);
    expect(h.key).toBe("n.md#3");
    expect(h.sourcePath).toBe("n.md");
    expect(h.lang).toBe("mermaid");
    expect(h.fenceRest).toBe("theme=x");
    expect(h.diagramType).toBe("flowchart");
    // The frame is replaced (LP widget rebuilt): unbind, then a new frame binds the same key.
    unbind(a);
    const b = surface("n.md#3", "mehrpele");
    expect(bind(b)).toBe(h);
    flush();
    expect(destroyed).toEqual([]);
    expect(h.isConnected()).toBe(true);
    expect(h.lang).toBe("mehrpele");
    expect(handles.forElement(b.svgEl as unknown as HTMLElement)).toBe(h);
    expect(handles.forElement(b.bar as unknown as HTMLElement)).toBe(h);
    expect(handles.forElement(a.svgEl as unknown as HTMLElement)).toBeNull();
    // Destroy with nothing rebinding: only on the next frame.
    unbind(b);
    expect(destroyed).toEqual([]);
    expect(h.isConnected()).toBe(true);
    flush();
    expect(destroyed).toEqual([h]);
    expect(h.isConnected()).toBe(false);
    expect(handles.list()).toEqual([]);
    // A new frame for the key after destroy gets a new handle.
    expect(bind(surface("n.md#3"))).not.toBe(h);
  });

  test("the overlay is the same node and stays attached across re-renders and frame-root replacement", () => {
    const { bind, unbind, rendered, flush } = registry();
    const a = surface("n.md#3");
    const h = bind(a);
    const layer = h.overlay("stub") as unknown as FakeEl;
    expect(h.overlay("stub")).toBe(layer as never);
    const container = layer.parentElement!;
    expect(container.className).toBe(OVERLAY_CLASS);
    expect(layer.className).toBe(OVERLAY_LAYER_CLASS);
    expect(layer.getAttribute("data-layer")).toBe("stub");
    expect(container.parentElement).toBe(a.host);
    expect(container.previousSibling).toBe(a.mount);
    // A re-render that rebuilt the host's children.
    a.host.children.splice(0).forEach((c) => (c.parentElement = null));
    a.host.appendChild(a.mount);
    rendered(a);
    expect(container.parentElement).toBe(a.host);
    expect(container.previousSibling).toBe(a.mount);
    // Frame-root replacement: the same container and layer move to the new frame.
    unbind(a);
    const b = surface("n.md#3");
    bind(b);
    flush();
    expect(layer.parentElement).toBe(container);
    expect(container.parentElement).toBe(b.host);
    expect(container.previousSibling).toBe(b.mount);
    expect(h.overlay("stub")).toBe(layer as never);
  });

  test("onDidRender fires once per render of a bound frame", () => {
    const { handles, bind, unbind, rendered } = registry();
    const seen: unknown[] = [];
    const off = handles.onDidRender((f) => void seen.push(f));
    const a = surface("n.md#3");
    const h = bind(a);
    rendered(a);
    rendered(a);
    expect(seen).toEqual([h, h]);
    unbind(a);
    rendered(a);
    expect(seen.length).toBe(2);
    off();
    const b = surface("n.md#3");
    bind(b);
    rendered(b);
    expect(seen.length).toBe(2);
  });

  test("nodeRect is relative to the host in its layout pixels; provenance reads the source", () => {
    const { bind } = registry();
    const a = surface("n.md#3");
    a.host.box = { left: 100, top: 50, width: 400, height: 200 };
    a.host.offsetWidth = 200; // CSS-scaled 2x
    const node = div("pele-node");
    node.setAttribute("data-id", "a");
    node.box = { left: 140, top: 70, width: 20, height: 10 };
    a.svgEl.appendChild(node);
    const h = bind(a);
    const r = h.nodeRect("a")!;
    expect([r.x, r.y, r.width, r.height]).toEqual([20, 10, 10, 5]);
    expect(h.nodeRect("missing")).toBeNull();
    expect(h.provenance()).toBeNull();
    expect(h.getSource()).toBe("flowchart LR\n  a --> b");
  });

  test("refreshNode coalesces into one re-render on the next frame", () => {
    const { bind, flush } = registry();
    const a = surface("n.md#3");
    const h = bind(a);
    h.refreshNode("a");
    h.refreshNode("b");
    expect(a.rerenders).toBe(0);
    flush();
    expect(a.rerenders).toBe(1);
  });

  // One key, two frames (Reading view + Live Preview of one leaf, or two split tabs).
  test("two frames of one key: the frame that becomes visible takes the layer and onDidRender fires", () => {
    const { handles, bind, rendered, resize, flush } = registry();
    handles.startWatching();
    const seen: unknown[] = [];
    handles.onDidRender((f) => void seen.push(f));
    // Reading view renders and is shown; the leaf's Live Preview frame exists but is hidden.
    const reading = surface("n.md#3");
    const lp = surface("n.md#3");
    const h = bind(reading);
    rendered(reading);
    resize(reading, 400, 200);
    expect(bind(lp)).toBe(h);
    resize(lp, 0, 0);
    const layer = h.overlay("stub") as unknown as FakeEl;
    const container = layer.parentElement!;
    expect(container.parentElement).toBe(reading.host);
    // A hidden frame rendering does not take the layer from the shown one.
    rendered(lp);
    expect(container.parentElement).toBe(reading.host);
    expect(seen).toEqual([h, h]);
    // Toggle to Live Preview: Reading hides (size → 0), LP shows (size > 0) without re-rendering.
    resize(reading, 0, 0);
    resize(lp, 400, 200);
    expect(container.parentElement).toBe(lp.host);
    expect(container.previousSibling).toBe(lp.mount);
    expect(h.overlay("stub")).toBe(layer as never);
    expect(seen).toEqual([h, h, h]);
    // Either frame maps to the handle.
    expect(handles.forElement(reading.svgEl as unknown as HTMLElement)).toBe(h);
    expect(handles.forElement(lp.svgEl as unknown as HTMLElement)).toBe(h);
    expect(handles.forElement(reading.bar as unknown as HTMLElement)).toBe(h);
    // Back to Reading view (shown in the other order): the layer follows.
    resize(reading, 400, 200);
    resize(lp, 0, 0);
    expect(container.parentElement).toBe(reading.host);
    expect(seen.length).toBe(4);
    // Repeated sizes of a shown frame are not activations.
    resize(reading, 420, 200);
    expect(seen.length).toBe(4);
    flush();
    expect(h.isConnected()).toBe(true);
  });

  test("the active frame hiding hands the layer to a shown frame of the key", () => {
    const { handles, bind, rendered, resize } = registry();
    handles.startWatching();
    const seen: unknown[] = [];
    handles.onDidRender((f) => void seen.push(f));
    const left = surface("n.md#3");
    const right = surface("n.md#3");
    const h = bind(left);
    resize(left, 300, 100);
    rendered(left);
    bind(right);
    resize(right, 300, 100);
    rendered(right);
    const container = (h.overlay("stub") as unknown as FakeEl).parentElement!;
    expect(container.parentElement).toBe(right.host);
    expect(seen.length).toBe(2);
    resize(right, 0, 0);
    expect(container.parentElement).toBe(left.host);
    expect(seen.length).toBe(3);
  });

  test("split tabs: closing the active tab hands the layer to the other and onDidRender fires once", () => {
    const { handles, bind, unbind, rendered, resize, flush } = registry();
    handles.startWatching();
    const seen: unknown[] = [];
    handles.onDidRender((f) => void seen.push(f));
    const left = surface("n.md#3");
    const right = surface("n.md#3");
    const h = bind(left);
    bind(right);
    resize(left, 300, 100);
    resize(right, 300, 100);
    rendered(left);
    rendered(right);
    const container = (h.overlay("stub") as unknown as FakeEl).parentElement!;
    expect(container.parentElement).toBe(right.host);
    expect(seen.length).toBe(2);
    unbind(right);
    expect(container.parentElement).toBe(left.host);
    expect(seen).toEqual([h, h, h]);
    flush();
    expect(seen.length).toBe(3);
    expect(h.isConnected()).toBe(true);
  });

  test("a Live Preview suspend handing over to a hidden Reading frame fires nothing", () => {
    const { handles, bind, unbind, rendered, resize, flush } = registry();
    handles.startWatching();
    const seen: unknown[] = [];
    handles.onDidRender((f) => void seen.push(f));
    const reading = surface("n.md#3");
    const lp = surface("n.md#3");
    const h = bind(reading);
    bind(lp);
    resize(reading, 0, 0);
    resize(lp, 300, 100);
    rendered(lp);
    expect(seen.length).toBe(1);
    // PF suspend: unbind, then suspend.
    unbind(lp);
    handles.suspend(asSurface(lp));
    flush();
    expect(seen.length).toBe(1);
    expect(h.isConnected()).toBe(true);
  });

  test("a destroyed handle drops its frames: no rect, a detached overlay, not connected", () => {
    const { handles, bind, unbind, rendered, resize, flush } = registry();
    handles.startWatching();
    const a = surface("n.md#3");
    const node = div("pele-node");
    node.setAttribute("data-id", "A");
    node.box = { left: 10, top: 10, width: 20, height: 10 };
    a.svgEl.appendChild(node);
    const h = bind(a);
    resize(a, 400, 200);
    rendered(a);
    const layer = h.overlay("stub") as unknown as FakeEl;
    unbind(a);
    flush();
    expect(h.isConnected()).toBe(false);
    expect(h.nodeRect("A")).toBeNull();
    expect(layer.parentElement?.parentElement ?? null).toBeNull();
    expect(() => h.overlay("late")).not.toThrow();
    expect((h.overlay("late") as unknown as FakeEl).parentElement?.parentElement ?? null).toBeNull();
    // Reads still answer from what the frame last showed.
    expect([h.key, h.sourcePath, h.lang, h.fenceRest, h.diagramType, h.getSource()]).toEqual([
      "n.md#3",
      "n.md",
      "mermaid",
      "theme=x",
      "flowchart",
      "flowchart LR\n  a --> b",
    ]);
    expect(pinned(h, a)).toEqual([]);
  });

  test("disposeAll drops every handle's frames", () => {
    const { handles, bind, rendered } = registry();
    const a = surface("n.md#3");
    const b = surface("n.md#3");
    const h = bind(a);
    bind(b);
    rendered(b);
    h.overlay("stub");
    handles.disposeAll();
    expect(h.isConnected()).toBe(false);
    expect(h.nodeRect("A")).toBeNull();
    expect(() => h.overlay("late")).not.toThrow();
    expect(pinned(h, a)).toEqual([]);
    expect(pinned(h, b)).toEqual([]);
  });

  test("nodeRect is null when the active frame is hidden or the node box is zero", () => {
    const { bind, rendered, resize } = registry();
    const a = surface("n.md#3");
    const node = div("pele-node");
    node.setAttribute("data-id", "A");
    node.box = { left: 10, top: 10, width: 20, height: 10 };
    a.svgEl.appendChild(node);
    const h = bind(a);
    // Never measured and laid out 0×0 (a hidden Reading-view frame): no rect, not a zero rect.
    expect(h.nodeRect("A")).toBeNull();
    resize(a, 400, 200);
    rendered(a);
    const r = h.nodeRect("A")!;
    expect([r.x, r.y, r.width, r.height]).toEqual([10, 10, 20, 10]);
    node.box = { left: 0, top: 0, width: 0, height: 0 };
    expect(h.nodeRect("A")).toBeNull();
    node.box = { left: 10, top: 10, width: 20, height: 10 };
    resize(a, 0, 0);
    expect(h.nodeRect("A")).toBeNull();
    resize(a, 400, 200);
    expect(h.nodeRect("A")).not.toBeNull();
  });

  test("size observers stop on unbind; the handle goes only when no bound frame remains", () => {
    const { handles, bind, unbind, rendered, resize, observed, flush } = registry();
    handles.startWatching();
    const destroyed: unknown[] = [];
    handles.onDidDestroy((f) => void destroyed.push(f));
    const a = surface("n.md#3");
    const b = surface("n.md#3");
    const h = bind(a);
    bind(b);
    expect(observed.size).toBe(2);
    resize(a, 0, 0);
    resize(b, 300, 100);
    rendered(b);
    unbind(b);
    expect(observed.size).toBe(1);
    flush();
    expect(destroyed).toEqual([]);
    expect(handles.forElement(a.svgEl as unknown as HTMLElement)).toBe(h);
    // The remaining frame holds the layer again.
    expect((h.overlay("stub") as unknown as FakeEl).parentElement!.parentElement).toBe(a.host);
    unbind(a);
    expect(observed.size).toBe(0);
    flush();
    expect(destroyed).toEqual([h]);
    // disposeAll stops the observers of frames still bound.
    const c = surface("m.md#1");
    bind(c);
    expect(observed.size).toBe(1);
    handles.disposeAll();
    expect(observed.size).toBe(0);
  });

  // A render whose reflow FLIP is still animating reports once the layout is final.
  test("onDidRender waits for the reflow animation to settle; a render meanwhile fires once", () => {
    const { handles, bind, unbind, rendered, elapse, timers, flush } = registry();
    const seen: unknown[] = [];
    handles.onDidRender((f) => void seen.push(f));
    let settle = 400;
    const a = Object.assign(surface("n.md#3"), { settleMs: () => settle });
    const h = bind(a);
    rendered(a);
    expect(seen).toEqual([]);
    elapse(200);
    // A newer layout mid-animation replaces the pending notice.
    rendered(a);
    elapse(399);
    expect(seen).toEqual([]);
    elapse(1);
    expect(seen).toEqual([h]);
    expect(timers.size).toBe(0);
    // Nothing animating: at once.
    settle = 0;
    rendered(a);
    expect(seen).toEqual([h, h]);
    // A handle destroyed while settling never reports.
    settle = 400;
    rendered(a);
    unbind(a);
    flush();
    elapse(1000);
    expect(seen).toEqual([h, h]);
    expect(timers.size).toBe(0);
  });

  // Frames cost no observer until a companion arrives.
  test("no size observation until a companion arrives; then every bound frame is watched", () => {
    const { handles, bind, observed } = registry();
    bind(surface("n.md#3"));
    bind(surface("m.md#1"));
    expect(observed.size).toBe(0);
    handles.onDidRender(() => undefined); // the registry's own listener is not a companion
    expect(observed.size).toBe(0);
    handles.startWatching();
    expect(observed.size).toBe(2);
    bind(surface("k.md#2"));
    expect(observed.size).toBe(3);
  });

  test("each companion entry point starts the size watch", () => {
    const entries: [string, (api: ReturnType<typeof hostApi>["api"]) => unknown][] = [
      ["registerFeature", (api) => api.registerFeature(feature("f", () => undefined))],
      ["frames.onDidRender", (api) => api.frames.onDidRender(() => undefined)],
      ["frames.onDidDestroy", (api) => api.frames.onDidDestroy(() => undefined)],
      ["addFrameAction", (api) => api.addFrameAction({ id: "x", icon: "x", title: "X", when: () => true, run: () => undefined })],
      ["addMenuItems", (api) => api.addMenuItems(() => undefined)],
    ];
    for (const [name, arrive] of entries) {
      const { api, bind, observed } = hostApi();
      bind(surface("n.md#3"));
      expect([name, observed.size]).toEqual([name, 0]);
      arrive(api);
      expect([name, observed.size]).toEqual([name, 1]);
    }
  });

  test("one shared ResizeObserver for every frame, disconnected when the last stops", () => {
    const made: { observed: Set<unknown>; disconnected: boolean; fire: (t: unknown, w: number) => void }[] = [];
    const g = globalThis as { ResizeObserver?: unknown };
    const prev = g.ResizeObserver;
    g.ResizeObserver = class {
      observed = new Set<unknown>();
      disconnected = false;
      fire: (t: unknown, w: number) => void;
      constructor(cb: (entries: unknown[]) => void) {
        this.fire = (target, w) => cb([{ target, contentRect: { width: w, height: w } }]);
        made.push(this);
      }
      observe(el: unknown) {
        this.observed.add(el);
      }
      unobserve(el: unknown) {
        this.observed.delete(el);
      }
      disconnect() {
        this.disconnected = true;
      }
    };
    try {
      const observe = sharedSizeObserver();
      const seen: [string, boolean][] = [];
      const a = {};
      const b = {};
      const stopA = observe(a as HTMLElement, (s) => void seen.push(["a", s]));
      const stopB = observe(b as HTMLElement, (s) => void seen.push(["b", s]));
      expect(made.length).toBe(1);
      expect(made[0]!.observed.size).toBe(2);
      made[0]!.fire(b, 0);
      made[0]!.fire(a, 10);
      expect(seen).toEqual([["b", false], ["a", true]]);
      stopA();
      expect(made[0]!.observed.size).toBe(1);
      expect(made[0]!.disconnected).toBe(false);
      stopB();
      expect(made[0]!.disconnected).toBe(true);
      observe(a as HTMLElement, () => undefined);
      expect(made.length).toBe(2);
    } finally {
      g.ResizeObserver = prev;
    }
  });

  // PF suspend (unregister, then suspend) / revive (register) / TTL destroy (unregister).
  test("a suspended frame keeps its handle, hidden; revival shows it again; the TTL's destroy ends it", () => {
    const { handles, bind, unbind, rendered, resize, flush } = registry();
    handles.startWatching();
    const seen: unknown[] = [];
    const destroyed: unknown[] = [];
    handles.onDidRender((f) => void seen.push(f));
    handles.onDidDestroy((f) => void destroyed.push(f));
    const a = surface("n.md#3");
    const node = div("pele-node");
    node.setAttribute("data-id", "A");
    node.box = { left: 10, top: 10, width: 20, height: 10 };
    a.svgEl.appendChild(node);
    const h = bind(a);
    resize(a, 400, 200);
    rendered(a);
    const layer = h.overlay("stub");
    expect(seen).toEqual([h]);
    // Suspended (scrolled out of the viewport).
    unbind(a);
    handles.suspend(asSurface(a));
    flush();
    expect(destroyed).toEqual([]);
    expect(h.isConnected()).toBe(true);
    expect(h.nodeRect("A")).toBeNull();
    expect(handles.forElement(a.svgEl as unknown as HTMLElement)).toBe(h);
    // Revived: the same handle and layer, and companions re-place.
    expect(bind(a)).toBe(h);
    expect(seen).toEqual([h, h]);
    expect(h.overlay("stub")).toBe(layer);
    expect(h.nodeRect("A")).not.toBeNull();
    // Suspended again, then the TTL destroys it: gone.
    unbind(a);
    handles.suspend(asSurface(a));
    flush();
    unbind(a);
    flush();
    expect(destroyed).toEqual([h]);
    expect(h.isConnected()).toBe(false);
  });

  test("diagramType comes from the source for every Mermaid type, before or without a render", () => {
    const types: [string, string][] = [
      ["classDiagram\n  class Plugin {\n    +onload()\n  }\n  Plugin --> DiagramChild", "class"],
      ["stateDiagram-v2\n  [*] --> Idle\n  Idle --> Rendering : open note", "state"],
      ["erDiagram\n  NOTE ||--o{ DIAGRAM : contains", "er"],
      ["mindmap\n  root((Pele))\n    Rendering", "mindmap"],
      ["%% pele-reflow off %%\nsequenceDiagram\n  A->>B: hi", "sequence"],
      ["flowchart LR\n  a --> b", "flowchart"],
    ];
    for (const [src, type] of types) expect(sourceDiagramType(src)).toBe(type);
    expect(sourceDiagramType("not a diagram")).toBeNull();
  });
});

describe("frame handles: a scrolling mount (minimum reflow scale)", () => {
  test("the active frame's mount scrolling re-fires onDidRender once per frame; others don't", () => {
    const { handles, bind, unbind, rendered, flush, resize } = registry();
    const a = surface("n.md#4");
    const b = surface("n.md#4");
    bind(a);
    // No companion yet: frames cost no listener.
    expect(a.mount.listeners.get("scroll")?.length ?? 0).toBe(0);
    handles.startWatching();
    bind(b);
    resize(a, 200, 100);
    resize(b, 200, 100);
    rendered(a);
    rendered(b);
    flush();
    const log: string[] = [];
    handles.onDidRender((f) => void log.push(f.key));
    b.mount.fire("scroll");
    b.mount.fire("scroll");
    expect(log).toEqual([]);
    flush();
    expect(log).toEqual(["n.md#4"]);
    // A frame that isn't the active one scrolled: the layer isn't there.
    a.mount.fire("scroll");
    flush();
    expect(log).toEqual(["n.md#4"]);
    // Hidden: it hands over to the shown frame (one render), and its own scroll is ignored.
    resize(b, 0, 0);
    expect(log).toEqual(["n.md#4", "n.md#4"]);
    b.mount.fire("scroll");
    flush();
    expect(log.length).toBe(2);
    // Gone: its listener goes too.
    unbind(b);
    expect(b.mount.listeners.get("scroll")?.length ?? 0).toBe(0);
    a.mount.fire("scroll");
    flush();
    expect(log.length).toBe(3);
  });
});

describe("frame handles: a fence that moved (resync)", () => {
  /** Destroy and render events, as "destroy key" / "render key". */
  function events(handles: InstanceType<typeof HandleRegistry>): string[] {
    const log: string[] = [];
    handles.onDidDestroy((f) => void log.push(`destroy ${f.key}`));
    handles.onDidRender((f) => void log.push(`render ${f.key}`));
    return log;
  }

  test("lines added above: LP and RV move together to one new handle, old destroyed first", () => {
    const { handles, actions, bind, rendered, flush, resize } = registry();
    handles.startWatching();
    actions.add({ id: "go", icon: "play", title: "Go", when: () => true, run: () => undefined });
    const lp = surface("n.md#4");
    const rv = surface("n.md#4");
    const old = bind(rv);
    bind(lp);
    resize(lp, 200, 100);
    rendered(rv);
    rendered(lp);
    const container = (old.overlay("stub") as unknown as FakeEl).parentElement!;
    const log = events(handles);
    lp.loc = { line: 5, rest: "theme=x" };
    rv.loc = { line: 5, rest: "theme=x" };
    handles.resync();
    expect(log).toEqual(["destroy n.md#4", "render n.md#5"]);
    const h = handles.handleOf(asSurface(lp))!;
    expect(h).not.toBe(old);
    expect(handles.handleOf(asSurface(rv))).toBe(h);
    expect(h.key).toBe("n.md#5");
    expect(lp.key).toBe("n.md#5");
    expect(old.isConnected()).toBe(false);
    expect(container.parentElement).toBeNull();
    expect(handles.list().map((f) => f.key)).toEqual(["n.md#5"]);
    expect(handles.forElement(lp.bar as unknown as HTMLElement)).toBe(h);
    // The active surface stays active: the overlay goes into it.
    h.overlay("stub");
    expect(lp.host.children.some((c) => c.className === OVERLAY_CLASS)).toBe(true);
    // Buttons are re-synced, not duplicated, and run against the new handle.
    expect(lp.bar.children.filter((c) => c.getAttribute("data-action") === "go").length).toBe(1);
    // Idempotent: a second pane seeing the same edit changes nothing.
    handles.resync();
    flush();
    expect(log).toEqual(["destroy n.md#4", "render n.md#5"]);
    expect(h.isConnected()).toBe(true);
    // Still size-watched under the new handle: hiding the LP hands over to nothing shown, showing it renders.
    resize(lp, 0, 0);
    resize(lp, 200, 100);
    expect(log.at(-1)).toBe("render n.md#5");
  });

  test("two fences moving down get fresh handles, never the other fence's", () => {
    const { handles, bind } = registry();
    const a = surface("n.md#4");
    const b = surface("n.md#5");
    b.source = () => "flowchart LR\n  w --> v";
    const ha = bind(a);
    const hb = bind(b);
    a.loc = { line: 5, rest: "theme=x" };
    b.loc = { line: 6, rest: "theme=x" };
    handles.resync();
    const na = handles.handleOf(asSurface(a))!;
    const nb = handles.handleOf(asSurface(b))!;
    expect([na.key, nb.key]).toEqual(["n.md#5", "n.md#6"]);
    expect(na).not.toBe(hb);
    expect(na).not.toBe(ha);
    expect(nb).not.toBe(hb);
    expect(na.getSource()).toBe("flowchart LR\n  a --> b");
    expect(nb.getSource()).toBe("flowchart LR\n  w --> v");
    expect(handles.list().map((f) => f.key).sort()).toEqual(["n.md#5", "n.md#6"]);
  });

  test("a changed info-string rest updates in place and renders once; no new handle", () => {
    const { handles, bind, rendered } = registry();
    const a = surface("n.md#4");
    const h = bind(a);
    rendered(a);
    const log = events(handles);
    a.loc = { line: 4, rest: "theme=y" };
    handles.resync();
    expect(log).toEqual(["render n.md#4"]);
    expect(handles.handleOf(asSurface(a))).toBe(h);
    expect(h.fenceRest).toBe("theme=y");
    handles.resync();
    expect(log).toEqual(["render n.md#4"]);
  });

  test("a surface that can't locate its fence is left alone", () => {
    const { handles, bind } = registry();
    const a = surface("n.md#4");
    const h = bind(a);
    const log = events(handles);
    handles.resync();
    expect(log).toEqual([]);
    expect(handles.handleOf(asSurface(a))).toBe(h);
    expect(a.key).toBe("n.md#4");
  });

  test("a surface that can't locate (hidden Reading view) follows its handle's active surface", () => {
    const { handles, bind, rendered } = registry();
    const hiddenRv = surface("n.md#4");
    // Hidden views don't re-render: after a body edit its source is the old one.
    hiddenRv.source = () => "flowchart LR\n  a --> old";
    const lp = surface("n.md#4");
    bind(hiddenRv);
    bind(lp);
    rendered(lp);
    const log = events(handles);
    lp.loc = { line: 5, rest: "theme=y" };
    handles.resync();
    const h = handles.handleOf(asSurface(lp))!;
    expect(handles.handleOf(asSurface(hiddenRv))).toBe(h);
    expect([h.key, hiddenRv.key, hiddenRv.fenceRest]).toEqual(["n.md#5", "n.md#5", "theme=y"]);
    expect(log).toEqual(["destroy n.md#4", "render n.md#5"]);
    // Only the active surface leads: a non-active one moving leaves the others where they are.
    const other = surface("m.md#2");
    const otherLp = surface("m.md#2");
    bind(other);
    bind(otherLp);
    rendered(other);
    otherLp.loc = { line: 3, rest: "theme=x" };
    handles.resync();
    expect(other.key).toBe("m.md#2");
    expect(otherLp.key).toBe("m.md#3");
  });

  test("resyncSoon coalesces into one resync on the next frame; a surface becoming visible asks for one", () => {
    const { handles, bind, rendered, flush, resize } = registry();
    handles.startWatching();
    const lp = surface("n.md#4");
    bind(lp);
    resize(lp, 200, 100);
    rendered(lp);
    const log = events(handles);
    lp.loc = { line: 5, rest: "theme=x" };
    handles.resyncSoon();
    handles.resyncSoon();
    expect(log).toEqual([]);
    flush();
    expect(log).toEqual(["destroy n.md#4", "render n.md#5"]);
    // Hidden, moved meanwhile, shown again: the visibility change resyncs it.
    resize(lp, 0, 0);
    lp.loc = { line: 7, rest: "theme=x" };
    resize(lp, 200, 100);
    flush();
    expect(lp.key).toBe("n.md#7");
    expect(handles.list().map((f) => f.key)).toEqual(["n.md#7"]);
  });

  test("an editor surface leads: a Reading view whose section info lags the edit follows it", () => {
    const { handles, bind, rendered } = registry();
    const lp = surface("n.md#4");
    const rv = surface("n.md#4");
    bind(lp);
    bind(rv);
    rendered(lp);
    rendered(rv); // The Reading split rendered last: it is the active surface.
    const log = events(handles);
    rv.loc = { line: 4, rest: "theme=x" }; // Its section info still shows the old line.
    lp.loc = { line: 5, rest: "theme=x", exact: true };
    handles.resync();
    const h = handles.handleOf(asSurface(lp))!;
    expect(handles.handleOf(asSurface(rv))).toBe(h);
    expect(handles.list().map((f) => f.key)).toEqual(["n.md#5"]);
    expect(log).toEqual(["destroy n.md#4", "render n.md#5"]);
  });

  test("resyncSoon resyncs once more after views settle: a lagging surface catches up", () => {
    const { handles, bind, rendered, flush, elapse } = registry();
    const lp = surface("n.md#11");
    const rv = surface("n.md#12"); // A Reading split left alone on a key its fence has left.
    const h = bind(lp);
    const stale = bind(rv);
    rendered(lp);
    rendered(rv);
    lp.loc = { line: 11, rest: "theme=x", exact: true };
    rv.loc = { line: 12, rest: "theme=x" };
    const log = events(handles);
    handles.resyncSoon();
    flush();
    expect(log).toEqual([]);
    rv.loc = { line: 11, rest: "theme=x" }; // Its renderer caught up.
    elapse(1000);
    expect(handles.handleOf(asSurface(rv))).toBe(h);
    expect(stale.isConnected()).toBe(false);
    expect(log).toEqual(["destroy n.md#12"]);
  });

  test("a stale surface joins the handle already at its new key", () => {
    const { handles, bind } = registry();
    // RV re-rendered at the new line already; the LP surface is still on the old key.
    const rv = surface("n.md#5");
    const lp = surface("n.md#4");
    const h = bind(rv);
    const old = bind(lp);
    const log = events(handles);
    lp.loc = { line: 5, rest: "theme=x" };
    handles.resync();
    expect(handles.handleOf(asSurface(lp))).toBe(h);
    expect(old.isConnected()).toBe(false);
    // The handle's active surface (shown) stays active: nothing moved for companions there.
    expect(log).toEqual(["destroy n.md#4"]);
    expect(handles.forElement(lp.bar as unknown as HTMLElement)).toBe(h);
  });

  test("a surface follows another only if it shows the same diagram", () => {
    // Fences at 4 and 8 moved to 8 and 12. Fence 1's Reading view re-rendered first, at #8,
    // where fence 2's Live Preview still sits.
    const { handles, bind, rendered } = registry();
    const lp1 = surface("n.md#4");
    const lp2 = surface("n.md#8");
    lp2.source = () => "flowchart LR\n  w --> v";
    const rv1 = surface("n.md#8");
    bind(lp1);
    bind(lp2);
    bind(rv1);
    rendered(lp1);
    rendered(lp2);
    rendered(rv1);
    lp1.loc = { line: 8, rest: "theme=x", exact: true };
    lp2.loc = { line: 12, rest: "theme=x", exact: true };
    rv1.loc = { line: 8, rest: "theme=x" };
    handles.resync();
    expect(handles.handleOf(asSurface(rv1))).toBe(handles.handleOf(asSurface(lp1)));
    expect([lp1.key, rv1.key, lp2.key]).toEqual(["n.md#8", "n.md#8", "n.md#12"]);
    expect(handles.handleOf(asSurface(lp2))!.getSource()).toBe("flowchart LR\n  w --> v");
    expect(handles.handleOf(asSurface(lp1))!.getSource()).toBe("flowchart LR\n  a --> b");
  });

  test("same collision with identical diagrams: an editor claiming the view's line keeps it", () => {
    const { handles, bind, rendered } = registry();
    const lp1 = surface("n.md#4");
    const lp2 = surface("n.md#8");
    const rv1 = surface("n.md#8");
    bind(lp1);
    bind(lp2);
    bind(rv1);
    rendered(lp1);
    rendered(lp2);
    rendered(rv1);
    lp1.loc = { line: 8, rest: "theme=x", exact: true };
    lp2.loc = { line: 12, rest: "theme=x", exact: true };
    rv1.loc = { line: 8, rest: "theme=x" };
    handles.resync();
    expect([lp1.key, rv1.key, lp2.key]).toEqual(["n.md#8", "n.md#8", "n.md#12"]);
    expect(handles.handleOf(asSurface(rv1))).toBe(handles.handleOf(asSurface(lp1)));
    handles.resync();
    expect(rv1.key).toBe("n.md#8");
  });

  test("a fence moving while its layout settles tells companions once, after it settles", () => {
    const { handles, bind, rendered, elapse } = registry();
    let settle = 0;
    const lp = { ...surface("n.md#4"), settleMs: () => settle };
    lp.locate = () => lp.loc;
    bind(lp);
    const log = events(handles);
    settle = 200; // A reflow animation started.
    rendered(lp);
    elapse(50);
    settle = 150;
    lp.loc = { line: 5, rest: "theme=x", exact: true };
    handles.resync();
    expect(log).toEqual(["destroy n.md#4"]);
    elapse(150);
    expect(log).toEqual(["destroy n.md#4", "render n.md#5"]);
  });

  test("a widget suspended in the edit that moved its fence keeps its buttons tracked", () => {
    const { handles, actions, bind, rendered, flush } = registry();
    actions.add({ id: "go", icon: "play", title: "Go", when: () => true, run: () => undefined });
    const lp = surface("n.md#4");
    const rv = surface("n.md#4");
    bind(rv);
    bind(lp);
    rendered(rv);
    rendered(lp);
    handles.resyncSoon(); // The edit asks for a resync; the widget scrolls out in the same frame.
    handles.unbind(asSurface(lp));
    handles.suspend(asSurface(lp));
    rv.loc = { line: 5, rest: "theme=x" };
    flush();
    expect(lp.key).toBe("n.md#5");
    bind(lp); // Revived.
    expect(lp.bar.children.filter((c) => c.getAttribute("data-action") === "go").length).toBe(1);
  });

  test("a rest change on a handle a lagging surface joins still syncs buttons and renders", () => {
    const { handles, actions, bind, rendered } = registry();
    actions.add({ id: "run", icon: "play", title: "Run", when: (f) => f.fenceRest === "cannoli", run: () => undefined });
    const a = surface("n.md#5");
    const b = surface("n.md#4");
    bind(a);
    bind(b);
    rendered(a);
    rendered(b);
    const log = events(handles);
    a.loc = { line: 5, rest: "cannoli", exact: true };
    b.loc = { line: 5, rest: "cannoli" };
    handles.resync();
    const runs = (s: Surface) => s.bar.children.filter((c) => c.getAttribute("data-action") === "run").length;
    expect([runs(a), runs(b)]).toEqual([1, 1]);
    expect(log).toEqual(["destroy n.md#4", "render n.md#5"]);
  });

  test("a changed info-string rest re-evaluates the companion buttons", () => {
    const { handles, actions, bind, rendered } = registry();
    actions.add({ id: "run", icon: "play", title: "Run", when: (f) => f.fenceRest === "cannoli", run: () => undefined });
    const a = surface("n.md#4");
    bind(a);
    rendered(a);
    const runs = () => a.bar.children.filter((c) => c.getAttribute("data-action") === "run").length;
    expect(runs()).toBe(0);
    a.loc = { line: 4, rest: "cannoli" };
    handles.resync();
    expect(runs()).toBe(1);
  });
});

describe("companion actions and menus", () => {
  const isCompanion = (c: FakeEl) => c.className.includes(COMPANION_ACTION_CLASS);

  test("companion actions come after the built-ins; the disposer removes them everywhere", () => {
    const { handles, actions, bind, rendered } = registry();
    const a = surface("a.md#1");
    const b = surface("b.md#2");
    bind(a);
    bind(b);
    rendered(a);
    rendered(b);
    const ran: string[] = [];
    const offOne = actions.add({ id: "one", icon: "star", title: "One", when: () => true, run: (f) => void ran.push(f.key) });
    actions.add({ id: "two", icon: (f) => (f.key === "a.md#1" ? "a" : "b"), title: "Two", when: (f) => f.key !== "b.md#2", run: () => undefined });
    for (const s of [a, b]) rendered(s);
    expect(a.bar.children.map((c) => c.getAttribute("data-action") ?? c.className)).toEqual([
      "embed-action builtin-zoom",
      "embed-action builtin-code",
      "one",
      "two",
    ]);
    expect(b.bar.children.map((c) => c.getAttribute("data-action") ?? c.className)).toEqual([
      "embed-action builtin-zoom",
      "embed-action builtin-code",
      "one",
    ]);
    expect(a.bar.children[3]!.getAttribute("data-icon")).toBe("a");
    expect(a.bar.children[2]!.className).toBe(`embed-action ${COMPANION_ACTION_CLASS}`);
    // Keyboard: companion actions are buttons with a tab stop, like the built-ins.
    expect(a.bar.children[2]!.getAttribute("role")).toBe("button");
    expect((a.bar.children[2] as unknown as { tabIndex: number }).tabIndex).toBe(0);
    a.bar.children[2]!.click();
    expect(ran).toEqual(["a.md#1"]);
    // Re-render keeps the same buttons in place.
    const before = [...a.bar.children];
    rendered(a);
    expect(a.bar.children).toEqual(before);
    offOne();
    offOne();
    expect(a.bar.children.filter(isCompanion).map((c) => c.getAttribute("data-action"))).toEqual(["two"]);
    expect(b.bar.children.filter(isCompanion)).toEqual([]);
    // refreshActions re-evaluates `when` for one frame.
    let show = true;
    actions.add({ id: "three", icon: "x", title: "Three", when: () => show, run: () => undefined });
    expect(b.bar.children.filter(isCompanion).length).toBe(1);
    show = false;
    handles.refreshActions(handles.handleOf(asSurface(b))!);
    expect(b.bar.children.filter(isCompanion)).toEqual([]);
  });

  test("a new frame of a bound key evaluates its actions against its own source", () => {
    const { actions, bind, rendered } = registry();
    // Reading view stays bound; Live Preview rebuilds the fence with edited source.
    const reading = surface("a.md#1");
    const lp = { ...surface("a.md#1"), source: () => "flowchart LR\n  a --> b\n  %% go" };
    bind(reading);
    rendered(reading);
    actions.add({ id: "go", icon: "play", title: "Go", when: (f) => f.getSource().includes("%% go"), run: () => undefined });
    expect(reading.bar.children.filter(isCompanion)).toEqual([]);
    bind(lp);
    rendered(lp);
    const buttons = lp.bar.children.filter(isCompanion);
    expect(buttons.map((c) => c.getAttribute("data-action"))).toEqual(["go"]);
  });

  test("menu items come after the built-ins; the disposer stops the callback", () => {
    const { bind, menus } = registry();
    const h = bind(surface("a.md#1"));
    const picked: string[] = [];
    const off = menus.add((menu, frame) => {
      menu.addItem((i) => i.setTitle("Badge").setIcon("tag").setSection("Stub").onClick(() => void picked.push(frame.key)));
      menu.addItem((i) => i.setTitle("Hidden").setDisabled(true));
    });
    const caps = { link: true, excalidraw: false, width: false, nodeSize: false, allSizes: false };
    const builtins = contextItems(caps).map((s) => s.id);
    const all = contextItems(caps, menus.sections(h));
    expect(all.map((s) => s.id)).toEqual([...builtins, "ext:0:0"]);
    const ext = all[all.length - 1]!;
    expect(ext.label).toBe("Stub");
    expect(ext.items.map((i) => [i.label, i.icon])).toEqual([["Badge", "tag"]]);
    ext.items[0]!.onPick!({} as MouseEvent);
    expect(picked).toEqual(["a.md#1"]);
    off();
    expect(contextItems(caps, menus.sections(h)).map((s) => s.id)).toEqual(builtins);
  });

  // Criterion 8: one companion's failure never breaks the bar, the menu or other companions.
  test("a throwing when, icon, title or run leaves the bar and the other buttons working", async () => {
    const { actions, bind, rendered } = registry();
    const a = surface("a.md#1");
    bind(a);
    const err = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const boom = (): never => {
        throw new Error("boom");
      };
      const ran: string[] = [];
      actions.add({ id: "when", icon: "x", title: "W", when: boom, run: () => undefined });
      actions.add({ id: "icon", icon: boom, title: "I", when: () => true, run: () => undefined });
      actions.add({ id: "title", icon: "x", title: boom, when: () => true, run: () => undefined });
      actions.add({ id: "run", icon: "x", title: "R", when: () => true, run: boom });
      actions.add({ id: "async", icon: "x", title: "A", when: () => true, run: async () => boom() });
      actions.add({ id: "good", icon: "x", title: "G", when: () => true, run: () => void ran.push("good") });
      expect(() => rendered(a)).not.toThrow();
      const ids = a.bar.children.map((c) => c.getAttribute("data-action") ?? c.className);
      expect(ids).toEqual(["embed-action builtin-zoom", "embed-action builtin-code", "run", "async", "good"]);
      for (const c of a.bar.children.filter(isCompanion)) expect(() => c.click()).not.toThrow();
      await new Promise((r) => setTimeout(r, 0));
      expect(ran).toEqual(["good"]);
      const logged = err.mock.calls.map((c) => String(c[0]));
      for (const id of ["when", "icon", "title", "run", "async"])
        expect(logged).toContain(`Mehrpele: frame action ${id} failed`);
    } finally {
      err.mockRestore();
    }
  });

  test("a throwing menu callback or item leaves the menu and the other items working", () => {
    const { bind, menus } = registry();
    const h = bind(surface("a.md#1"));
    const err = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const picked: string[] = [];
      menus.add(() => {
        throw new Error("boom");
      });
      menus.add((menu) => {
        menu.addItem((i) =>
          i.setTitle("Bad").onClick(() => {
            throw new Error("boom");
          }),
        );
        menu.addItem((i) => i.setTitle("Good").onClick(() => void picked.push("good")));
      });
      const secs = menus.sections(h);
      expect(secs.map((s) => s.items.map((i) => i.label))).toEqual([["Bad", "Good"]]);
      for (const it of secs[0]!.items) expect(() => it.onPick!({} as MouseEvent)).not.toThrow();
      expect(picked).toEqual(["good"]);
      expect(err.mock.calls.map((c) => String(c[0]))).toEqual([
        "Mehrpele: a companion menu callback failed",
        "Mehrpele: a companion menu item failed",
      ]);
    } finally {
      err.mockRestore();
    }
  });

  test("an async menu onClick that rejects is caught and logged", async () => {
    const { bind, menus } = registry();
    const h = bind(surface("a.md#1"));
    const err = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      menus.add((menu) => void menu.addItem((i) => i.setTitle("Async").onClick(async () => Promise.reject(new Error("boom")))));
      const item = menus.sections(h)[0]!.items[0]!;
      expect(() => item.onPick!({} as MouseEvent)).not.toThrow();
      await new Promise((r) => setTimeout(r, 0));
      expect(err.mock.calls.map((c) => String(c[0]))).toEqual(["Mehrpele: a companion menu item failed"]);
    } finally {
      err.mockRestore();
    }
  });

  test("a throwing onDidRender listener does not stop the others", () => {
    const { handles, bind, rendered } = registry();
    const a = surface("a.md#1");
    const h = bind(a);
    const err = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const seen: unknown[] = [];
      handles.onDidRender(() => {
        throw new Error("boom");
      });
      handles.onDidRender((f) => void seen.push(f));
      expect(() => rendered(a)).not.toThrow();
      expect(seen).toEqual([h]);
      expect(err.mock.calls.map((c) => String(c[0]))).toEqual(["Mehrpele: a frames.onDidRender callback failed"]);
    } finally {
      err.mockRestore();
    }
  });
});

// region bundled plugin
describe("plugin.api (bundled main.ts)", () => {
  let code = "";
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const DOM_GLOBALS = ["document", "window", "activeDocument", "activeWindow", "navigator", "getComputedStyle", "requestAnimationFrame", "IntersectionObserver", "ResizeObserver", "MutationObserver"];
  beforeAll(async () => {
    ({ code } = await bundleMain());
    for (const k of DOM_GLOBALS) {
      saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
      Object.defineProperty(globalThis, k, { value: deep(), configurable: true, writable: true });
    }
  }, 60_000);
  afterAll(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  });

  test("api is set on load, api-ready fires on layout ready, unload fires api-unload before teardown", async () => {
    const log: string[] = [];
    const layout: (() => void)[] = [];
    let plugin: any;
    const inert = (over: Record<string, unknown>) =>
      new Proxy({}, { get: (_t, k) => (k in over ? over[k as string] : k === "then" || typeof k === "symbol" ? undefined : deep()) });
    const workspace = inert({
      onLayoutReady: (cb: () => void) => void layout.push(cb),
      trigger: (name: string, arg: unknown) => {
        log.push(`${name}:${arg === plugin.api}:${plugin.api.isLive()}`);
      },
    });
    const app = inert({ workspace });
    const mod: { exports: any } = { exports: {} };
    const req = (id: string): unknown => {
      if (id === "obsidian") return obsidianStub;
      if (id.startsWith("@codemirror/") || id.startsWith("@lezer/") || id === "electron") return deep();
      return require(id);
    };
    new Function("require", "module", "exports", code)(req, mod, mod.exports);
    const Cls = mod.exports.default ?? mod.exports;
    plugin = new Cls(app, { id: "mehrpele", version: "9.9.9", dir: ".obsidian/plugins/mehrpele" });
    await plugin.load();
    const api = plugin.api;
    expect(api.apiVersion).toBe(1);
    expect(api.apiMinor).toBe(1);
    expect(api.hostVersion).toBe("9.9.9");
    expect(Object.isFrozen(api)).toBe(true);
    expect(log).toEqual([]);
    for (const cb of layout) {
      try {
        cb();
      } catch {
        /* other layout-ready work against the inert app */
      }
    }
    expect(log).toEqual(["mehrpele:api-ready:true:true"]);
    api.registerFeature({ id: "stub", dispose: () => void log.push("feature-dispose") });
    plugin.unload();
    expect(log.slice(1)).toEqual(["mehrpele:api-unload:true:false", "feature-dispose"]);
    expect(api.isLive()).toBe(false);
    expect(plugin.features._loaded).toBe(false);
  });
});
// endregion bundled plugin
