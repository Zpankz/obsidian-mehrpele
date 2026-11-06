/**
 * A stand-in for the `obsidian` module, enough to construct the plugin and
 * run onload outside Obsidian: real Component lifecycle (children, register
 * callbacks), everything else an inert deep proxy.
 */

/** Any property, call or construction gives another inert proxy. */
export function deep(): any {
  const fn = function () {};
  return new Proxy(fn, {
    get(_t, k) {
      if (k === "then") return undefined; // not a thenable
      if (k === Symbol.toPrimitive) return () => "";
      if (k === Symbol.iterator) return function* () {};
      if (typeof k === "symbol") return undefined;
      return deep();
    },
    apply: () => deep(),
    construct: () => deep(),
  });
}

/** Unknown methods on stub classes: callable no-ops. */
const inertProto = new Proxy(Object.prototype, {
  get(t, k, r) {
    if (k in t || typeof k === "symbol" || k === "then") return Reflect.get(t, k, r);
    return () => deep();
  },
});

export class Component {
  _loaded = false;
  _children: Component[] = [];
  _cleanups: (() => void)[] = [];
  load(): unknown {
    if (this._loaded) return undefined;
    this._loaded = true;
    const r = this.onload();
    for (const c of this._children) c.load();
    return r;
  }
  onload(): unknown {
    return undefined;
  }
  unload(): void {
    if (!this._loaded) return;
    this._loaded = false;
    for (const c of this._children.splice(0)) c.unload();
    for (const f of this._cleanups.splice(0)) f();
    this.onunload();
  }
  onunload(): void {}
  addChild<T extends Component>(c: T): T {
    this._children.push(c);
    if (this._loaded) c.load();
    return c;
  }
  removeChild<T extends Component>(c: T): T {
    const i = this._children.indexOf(c);
    if (i >= 0) {
      this._children.splice(i, 1);
      c.unload();
    }
    return c;
  }
  register(f: () => void): void {
    this._cleanups.push(f);
  }
  /** Event refs registered by any component and not yet cleaned up. */
  static events: unknown[] = [];
  registerEvent(ref: unknown): void {
    Component.events.push(ref);
    this.register(() => {
      const i = Component.events.indexOf(ref);
      if (i >= 0) Component.events.splice(i, 1);
    });
  }
  /** DOM event types registered by any component and not yet cleaned up. */
  static domEvents: string[] = [];
  registerDomEvent(_el: unknown, type: string): void {
    Component.domEvents.push(type);
    this.register(() => {
      const i = Component.domEvents.indexOf(type);
      if (i >= 0) Component.domEvents.splice(i, 1);
    });
  }
  registerInterval(id: number): number {
    return id;
  }
}
Object.setPrototypeOf(Component.prototype, inertProto);

export class Plugin extends Component {
  /** Commands currently added, by id. */
  commands = new Map<string, unknown>();
  /** Calls to plugin-level registration methods: [method, first arg]. */
  calls: [string, unknown][] = [];
  constructor(
    public app: any,
    public manifest: any,
  ) {
    super();
  }
  async loadData(): Promise<unknown> {
    return (globalThis as { __peleData?: unknown }).__peleData ?? null;
  }
  async saveData(): Promise<void> {}
  /** Every command removal (prefixed id), in order. */
  removed: string[] = [];
  // As Obsidian: addCommand rewrites cmd.id to "<plugin id>:<id>" and registers
  // the command's removal on `this`; removeCommand takes the unprefixed id and
  // adds the prefix itself.
  addCommand(cmd: { id: string }): unknown {
    cmd.id = `${this.manifest.id}:${cmd.id}`;
    this.commands.set(cmd.id, cmd);
    const id = cmd.id;
    this.register(() => this.dropCommand(id));
    return cmd;
  }
  removeCommand(id: string): void {
    this.dropCommand(`${this.manifest.id}:${id}`);
  }
  private dropCommand(id: string): void {
    this.removed.push(id);
    this.commands.delete(id);
  }
  registerView(type: string): void {
    this.calls.push(["registerView", type]);
  }
  /** The last processor registered per language. */
  processors = new Map<string, (source: string, el: unknown, ctx: unknown) => unknown>();
  registerMarkdownCodeBlockProcessor(lang: string, handler?: (source: string, el: unknown, ctx: unknown) => unknown): unknown {
    this.calls.push(["registerMarkdownCodeBlockProcessor", lang]);
    if (handler) this.processors.set(lang, handler);
    return deep();
  }
  registerBasesView(id: string): boolean {
    this.calls.push(["registerBasesView", id]);
    return true;
  }
  cliHandlers = new Map<string, (p: Record<string, string>) => Promise<string>>();
  registerCliHandler(id: string, _desc?: string, _flags?: unknown, handler?: (p: Record<string, string>) => Promise<string>): void {
    this.calls.push(["registerCliHandler", id]);
    if (handler) this.cliHandlers.set(id, handler);
  }
  addSettingTab(tab: unknown): void {
    this.calls.push(["addSettingTab", tab]);
  }
}

export class PluginSettingTab {
  containerEl: any = deep();
  /** Calls to update() and refreshDomState(), for declarative-tab tests. */
  updates = 0;
  refreshes = 0;
  constructor(
    public app: any,
    public plugin: any,
  ) {}
  display(): void {}
  hide(): void {}
  update(): void {
    this.updates++;
  }
  refreshDomState(): void {
    this.refreshes++;
  }
}
Object.setPrototypeOf(PluginSettingTab.prototype, inertProto);

export class Notice {
  static shown: string[] = [];
  constructor(message: string) {
    Notice.shown.push(message);
  }
}
Object.setPrototypeOf(Notice.prototype, inertProto);

/** A class that any stub base can stand for (views, modals, suggesters). */
function stubClass(): any {
  class Stub {
    constructor(..._a: unknown[]) {}
  }
  Object.setPrototypeOf(Stub.prototype, inertProto);
  return Stub;
}

/** `requireApiVersion` answers through this; tests swap `ok` to play an older app. */
export const apiGate = { ok: (_version: string): boolean => true };

/** Records each instance so a test can drive its onChange. */
export class SecretComponent {
  static made: SecretComponent[] = [];
  value = "";
  change: ((v: string) => unknown) | null = null;
  constructor(public app: unknown, public el: unknown) {
    SecretComponent.made.push(this);
  }
  setValue(v: string): this {
    this.value = v;
    return this;
  }
  onChange(cb: (v: string) => unknown): this {
    this.change = cb;
    return this;
  }
}

/** Keeps its parent and registrations, as Obsidian's (tests call `keys[i].func`). */
export class Scope {
  keys: { modifiers: string[] | null; key: string | null; func: (evt: unknown, ctx: unknown) => unknown }[] = [];
  constructor(public parent?: Scope) {}
  register(modifiers: string[] | null, key: string | null, func: (evt: unknown, ctx: unknown) => unknown) {
    const h = { modifiers, key, func };
    this.keys.push(h);
    return h;
  }
}

const known: Record<string, unknown> = {
  SecretComponent,
  Scope,
  Component,
  Plugin,
  PluginSettingTab,
  Notice,
  MarkdownRenderChild: class extends Component {
    constructor(public containerEl: unknown) {
      super();
    }
  },
  Platform: { isMobile: false, isDesktop: true, isDesktopApp: true, isMacOS: true },
  apiVersion: "1.14.4",
  requireApiVersion: (v: string) => apiGate.ok(v),
  // Records the icon on elements that take attributes (tests read `data-icon`).
  setIcon: (el: { setAttribute?(k: string, v: string): void } | null | undefined, icon: string) => el?.setAttribute?.("data-icon", icon),
  // As Obsidian: the tooltip is the element's aria-label.
  setTooltip: (el: { setAttribute?(k: string, v: string): void } | null | undefined, tip: string) => el?.setAttribute?.("aria-label", tip),
};
// Named ESM imports need own keys up front (the Proxy below only fills on read).
for (const k of ["App", "BasesView", "ItemView", "Modal", "Setting", "SuggestModal", "MarkdownView", "TAbstractFile", "TFile", "TFolder"]) known[k] = stubClass();
for (const k of [
  "getFrontMatterInfo", "parseYaml", "finishRenderMath", "loadMathJax", "renderMath",
  "getAllTags", "getIcon", "normalizePath", "requestUrl", "resolveSubpath",
]) known[k] = () => deep();
// A CodeMirror state field: an opaque token (fake editor states answer `field()` themselves).
known.editorLivePreviewField = {};

/** The `obsidian` module: known members above; any other is a stub class (callable, extendable). */
export const obsidianStub: Record<string, unknown> = new Proxy(known, {
  get(t, k) {
    if (typeof k === "symbol") return undefined;
    if (k === "__esModule") return false;
    if (!(k in t)) t[k] = /^[A-Z]/.test(k) ? stubClass() : () => deep();
    return t[k];
  },
});
