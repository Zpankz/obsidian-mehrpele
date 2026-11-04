/**
 * The feature registry. Feature code is reachable only
 * from here (dynamic imports) and from ./lazy (on-demand requires); a static
 * import from core fails tests/lazy-guard.test.ts.
 *
 * Every `module` feature whose toggle is on is imported, then registered on
 * its own child Component. Turning the toggle off unloads that child, which
 * removes what the feature registered (`reload: "needed"` features go inert
 * at once; their registration stays until the plugin reloads).
 */
import { Component, Notice, type Plugin } from "obsidian";
import type PeleMermaidPlugin from "../../main";
import type { FeatureId } from "./enabled";
import type { CompanionFeature, FeatureContext, FeatureDef, ModuleFeatureDef } from "./types";

/**
 * One entry per settings toggle (TOGGLE_IDS). Toggle-less features
 * (core rendering, LP takeover, link guard, undo, copy/export
 * SVG, validate, settings) are core and have no entry.
 */
export const FEATURES: readonly FeatureDef[] = [
  { id: "reflow", name: "Reflow", kind: "flag" },
  { id: "pan-zoom", name: "Pan and zoom", kind: "flag" },
  { id: "resize", name: "Node resize", kind: "flag" },
  { id: "toolbar", name: "Edit toolbar", kind: "flag" },
  { id: "inline-edit", name: "Inline label editing", kind: "flag" },
  { id: "autocomplete", name: "Label autocomplete", kind: "flag" },
  { id: "live-view", name: "Mehrpele (Markdown labels)", kind: "flag" },
  { id: "nested", name: "Nested diagrams", kind: "flag" },
  { id: "excalidraw", name: "Excalidraw conversion", kind: "module", load: () => import("./register-excalidraw") },
  { id: "bases", name: "Bases view", kind: "module", reload: "needed", load: () => import("./register-bases") },
  { id: "view-nodes", name: "View nodes", kind: "module", load: () => import("./register-view-nodes") },
  { id: "repair", name: "Repair", kind: "module", load: () => import("./register-repair") },
  { id: "canvas", name: "Canvas conversion", kind: "module", load: () => import("./register-canvas") },
  { id: "materialise", name: "Materialise as notes", kind: "module", load: () => import("./register-materialise") },
  { id: "cli", name: "Obsidian CLI handlers", kind: "module", reload: "needed", load: () => import("./register-cli") },
  // Integration code blocks are core (./integration-blocks.ts): one processor per language, inert while off.
  { id: "integrations.breadcrumbs", name: "Breadcrumbs", kind: "flag" },
  {
    id: "integrations.datacore",
    name: "Datacore",
    kind: "module",
    load: () => import("./register-integrations").then((m) => m.datacore),
  },
  { id: "integrations.tasknotes", name: "TaskNotes", kind: "flag" },
  {
    id: "integrations.extended-graph",
    name: "Extended Graph colours",
    kind: "module",
    load: () => import("./register-integrations").then((m) => m.extendedGraph),
  },
];

/** Plugin methods that add something to clean up: routed to the feature's Component. */
const SCOPED = new Set(["register", "registerEvent", "registerDomEvent", "registerInterval", "addChild", "removeChild"]);

/**
 * The plugin as one feature sees it: registrations land on `component`
 * (commands are removed when it unloads); everything else, reads and
 * writes, is the plugin itself.
 */
export function scopedPlugin<P extends Plugin>(plugin: P, component: Component): P {
  return new Proxy(plugin, {
    get(target, key, receiver) {
      if (typeof key === "string" && SCOPED.has(key)) {
        const fn = (component as unknown as Record<string, (...a: unknown[]) => unknown>)[key];
        return fn.bind(component);
      }
      if (key === "addCommand") {
        return (cmd: Parameters<P["addCommand"]>[0]) => {
          // addCommand rewrites cmd.id to "<plugin id>:<id>" and removeCommand
          // adds the prefix again: keep the id as written.
          const id = cmd.id;
          const added = target.addCommand(cmd);
          component.register(() => target.removeCommand(id));
          return added;
        };
      }
      const v = Reflect.get(target, key, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

export class FeatureRegistry extends Component {
  private readonly running = new Map<FeatureId, Component>();
  /** Turned off while running a `reload: "needed"` feature: inert now, registration removed on the next reload. */
  readonly pendingReload = new Set<FeatureId>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly plugin: PeleMermaidPlugin,
    private readonly isEnabled: (id: FeatureId) => boolean,
    readonly defs: readonly FeatureDef[] = FEATURES,
  ) {
    super();
  }

  /** Ids of the module features running now. */
  active(): FeatureId[] {
    return [...this.running.keys()];
  }

  /**
   * Bring running features in line with the toggles: load what is on, unload
   * what is off. Calls are queued, so overlapping settings saves apply in order.
   */
  sync(): Promise<void> {
    this.queue = this.queue.then(() => this.apply()).catch((e) => console.error("[mehrpele] feature sync failed", e));
    return this.queue;
  }

  /**
   * A companion's registration (MehrpeleApiV1 `registerFeature`): its
   * `dispose` runs when the returned disposer is called or the host unloads.
   */
  adopt(def: CompanionFeature): () => void {
    const child = new Component();
    if (def.dispose) child.register(() => def.dispose!());
    this.addChild(child);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.removeChild(child);
    };
  }

  onunload(): void {
    this.closed = true;
    this.running.clear();
  }

  private async apply(): Promise<void> {
    for (const def of this.defs) {
      if (this.closed) return;
      if (def.kind !== "module") continue;
      const on = this.isEnabled(def.id);
      const child = this.running.get(def.id);
      if (on) {
        this.pendingReload.delete(def.id);
        if (!child) await this.start(def);
      } else if (child) {
        this.stop(def, child);
      }
    }
  }

  private async start(def: ModuleFeatureDef): Promise<void> {
    let mod;
    try {
      mod = await def.load();
    } catch (e) {
      this.failed(def, "load", e);
      return;
    }
    // Unloaded, or turned off again while it was loading.
    if (this.closed || !this.isEnabled(def.id)) return;
    const component = new Component();
    this.addChild(component);
    this.running.set(def.id, component);
    const ctx: FeatureContext = { plugin: scopedPlugin(this.plugin, component), component };
    try {
      mod.register(ctx);
    } catch (e) {
      this.failed(def, "start", e);
      this.running.delete(def.id);
      this.removeChild(component);
    }
  }

  /** Features that failed since launch: one Notice each (sync runs on every save). */
  private readonly notified = new Set<FeatureId>();

  private failed(def: ModuleFeatureDef, step: "load" | "start", e: unknown): void {
    console.error(`[mehrpele] could not ${step} feature ${def.id}`, e);
    if (this.notified.has(def.id)) return;
    this.notified.add(def.id);
    new Notice(`Mehrpele: ${def.name} could not start. See the developer console.`);
  }

  private stop(def: ModuleFeatureDef, child: Component): void {
    if (def.reload === "needed") {
      if (!this.pendingReload.has(def.id)) {
        this.pendingReload.add(def.id);
        new Notice(`Mehrpele: ${def.name} is off now; its registration is removed when the plugin reloads.`);
      }
      return;
    }
    this.running.delete(def.id);
    this.removeChild(child);
  }
}
