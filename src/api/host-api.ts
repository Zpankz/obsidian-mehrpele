/**
 * The companion API (`plugin.api`, MehrpeleApiV1 with apiMinor 1). Companions find it at
 * `app.plugins.plugins.mehrpele.api`; the host also passes it with the
 * `mehrpele:api-ready` and `mehrpele:api-unload` workspace events.
 *
 * Unload order: `isLive()` turns false, `mehrpele:api-unload` fires with the
 * api, then the host disposes companion features, canvas mounts, frame handles, action
 * buttons and menu callbacks.
 */
import { Component, type TFile } from "obsidian";
import type { CanvasData } from "obsidian/canvas";
import type {
  CompanionFeatureDef,
  Disposer,
  FrameActionDef,
  FrameHandle,
  MehrpeleApiV1,
  MermaidToCanvasResult,
  PeleRuntime,
} from "mehrpele-api";
import type { CompanionActions } from "./frame-actions";
import type { FenceLocation, FrameCompanion, HandleRegistry } from "./frame-handles";
import type { CompanionMenus } from "./menu-items";

export const API_READY_EVENT = "mehrpele:api-ready";
export const API_UNLOAD_EVENT = "mehrpele:api-unload";

/** The pele-render canvas converters the api passes through. */
export interface CanvasConverters {
  mermaidToCanvas(src: string, opts?: object): MermaidToCanvasResult;
  canvasToMermaid(canvas: CanvasData, opts?: object): { source: string; mehrpele: boolean };
}

export interface HostApiDeps {
  hostVersion: string;
  pele: PeleRuntime;
  workspace: { trigger(name: string, ...data: unknown[]): void };
  /** FeatureRegistry.adopt. */
  adopt(def: CompanionFeatureDef): Disposer;
  handles: HandleRegistry;
  actions: CompanionActions;
  menus: CompanionMenus;
  /** Loads pele-render/canvas on first use. */
  canvas(): CanvasConverters;
  read(file: TFile): Promise<string>;
  /** The host's mountDiagram (owner, source, path, lang, no fence line, companion info). */
  mountDiagram(el: HTMLElement, owner: Component, source: string, sourcePath: string, lang: string, companion: FrameCompanion): void;
  /** Watches vault `modify` events for `file` (the host registers it on a Component); returns the unregister. */
  onModify(file: TFile, cb: (modified: { path: string }) => void): () => void;
  /** A timer (`window.setTimeout`); returns its cancel. */
  schedule(cb: () => void, ms: number): () => void;
}

/**
 * mountCanvas options. The public api takes `fenceRest`; the rest are host-internal (canvas
 * embeds): `key` and `locate` key the frame to its fence and follow it on resync, `sourcePath`
 * is the note holding the fence (resync rebuilds keys from it), and `live: false` skips the
 * re-render on canvas modify.
 */
export interface MountCanvasOpts {
  fenceRest?: string;
  key?: string;
  locate?: () => FenceLocation | null;
  sourcePath?: string;
  live?: boolean;
}

/** How long canvas modifies are coalesced before a re-render. */
export const CANVAS_RERENDER_MS = 120;

export interface HostApi {
  readonly api: MehrpeleApiV1;
  feature(id: string): Readonly<Pick<CompanionFeatureDef, "id" | "name" | "version" | "requiredHostMinor">> | null;
  onFeaturesChanged(cb: () => void): Disposer;
  /** mountCanvas with the host-internal options. */
  readonly mountCanvas: (file: TFile, el: HTMLElement, opts?: MountCanvasOpts) => { destroy(): void };
  /** Fires `mehrpele:api-ready` (from onLayoutReady). */
  ready(): void;
  /** Host unload, in the order above. Idempotent. */
  unload(): void;
}

export function createHostApi(deps: HostApiDeps): HostApi {
  let live = true;
  /** Live companion features by id → their disposer. */
  const features = new Map<string, Disposer>();
  const metadata = new Map<string, Readonly<Pick<CompanionFeatureDef, "id" | "name" | "version" | "requiredHostMinor">>>();
  const listeners = new Set<() => void>();
  let replacing = 0;
  const changed = (): void => {
    if (!live || replacing) return;
    for (const cb of [...listeners]) {
      try { cb(); } catch (e) { console.error("Mehrpele: an add-on status listener failed", e); }
    }
  };
  /** Live canvas mounts → their destroy (host unload runs it, so a pending read mounts nothing). */
  const mounts = new Set<() => void>();

  // Frames are size-watched only once a companion registers something.
  const companionArrived = (): void => deps.handles.startWatching();

  /** A companion call after host unload registers nothing: warn and hand back a no-op disposer. */
  const ignoredAfterUnload = (call: string): Disposer => {
    console.warn(`Mehrpele: ${call} after the host unloaded was ignored`);
    return () => undefined;
  };

  const registerFeature = (def: CompanionFeatureDef): Disposer => {
    if (!live) return ignoredAfterUnload(`registerFeature(${def.id})`);
    // Re-registering an id replaces the earlier registration (disposed first; its disposer is then spent).
    replacing++;
    try {
      features.get(def.id)?.();
      const release = deps.adopt(def);
      let done = false;
      const dispose = (): void => {
        if (done) return;
        done = true;
        if (features.get(def.id) === dispose) {
          features.delete(def.id);
          metadata.delete(def.id);
        }
        try {
          release();
        } finally {
          deps.handles.removeLayers(def.id);
          changed();
        }
      };
      features.set(def.id, dispose);
      metadata.set(def.id, Object.freeze({ id: def.id, name: def.name, version: def.version, requiredHostMinor: def.requiredHostMinor }));
      try { companionArrived(); } catch (e) { dispose(); throw e; }
      return dispose;
    } finally {
      replacing--;
      changed();
    }
  };

  const mountCanvas = (file: TFile, el: HTMLElement, opts?: MountCanvasOpts): { destroy(): void } => {
    if (!live) return { destroy: ignoredAfterUnload(`mountCanvas(${file.path})`) };
    let gone = false;
    /** The shown render's owner, and the elements it added to `el` (destroy removes them, and only them). */
    let owner: Component | null = null;
    let added: Element[] = [];
    /** Bumped per render: a slower earlier read never replaces a later one. */
    let renders = 0;
    let unwatch: (() => void) | null = null;
    let cancelTimer: (() => void) | null = null;
    const destroy = (): void => {
      if (gone) return;
      gone = true;
      mounts.delete(destroy);
      unwatch?.();
      cancelTimer?.();
      owner?.unload();
      owner = null;
      for (const n of added) n.remove();
      added = [];
    };
    mounts.add(destroy);
    const companion: FrameCompanion = {
      key: opts?.key ?? `${file.path}#0`,
      fenceRest: opts?.fenceRest ?? "",
      ...(opts?.locate ? { locate: opts.locate } : {}),
    };
    const render = (): void => {
      const mine = ++renders;
      const first = mine === 1;
      void deps
        .read(file)
        .then((text) => {
          if (gone || mine !== renders) return;
          const r = deps.canvas().canvasToMermaid(JSON.parse(text) as CanvasData);
          // The new frame mounts before the old one goes, so the key's handle keeps a surface.
          const next = new Component();
          next.load();
          const before = new Set(Array.from(el.children));
          try {
            const location = opts?.locate?.();
            const currentCompanion = location && opts?.sourcePath
              ? { ...companion, key: `${opts.sourcePath}#${location.line}`, fenceRest: location.rest }
              : companion;
            deps.mountDiagram(el, next, r.source, opts?.sourcePath ?? file.path, r.mehrpele ? "mehrpele" : "mermaid", currentCompanion);
          } catch (e) {
            // The failed mount's owner and anything it added go; the shown render stays.
            next.unload();
            for (const n of Array.from(el.children)) if (!before.has(n)) n.remove();
            throw e;
          }
          const prev = { owner, added };
          owner = next;
          added = Array.from(el.children).filter((n) => !before.has(n));
          prev.owner?.unload();
          for (const n of prev.added) n.remove();
        })
        .catch((e: unknown) => {
          if (gone || mine !== renders) return;
          console.error(`Mehrpele: could not render ${file.path}`, e);
          // A failed re-render (say, a half-written save) keeps the frame on screen.
          // The error is a tracked element: a later good render removes it; the container's own children stay.
          if (first) added = [el.createDiv({ cls: "pele-error", text: `Mehrpele: could not render ${file.path}` })];
        });
    };
    if (opts?.live !== false) {
      unwatch = deps.onModify(file, (modified) => {
        if (gone || modified.path !== file.path) return;
        cancelTimer?.();
        cancelTimer = deps.schedule(() => {
          cancelTimer = null;
          if (!gone) render();
        }, CANVAS_RERENDER_MS);
      });
    }
    render();
    return { destroy };
  };

  const api: MehrpeleApiV1 = Object.freeze({
    apiVersion: 1,
    apiMinor: 1,
    hostVersion: deps.hostVersion,
    pele: deps.pele,
    registerFeature,
    frames: Object.freeze({
      list: (): FrameHandle[] => deps.handles.list(),
      forElement: (el: HTMLElement): FrameHandle | null => deps.handles.forElement(el),
      onDidRender: (cb: (f: FrameHandle) => void): Disposer => {
        if (!live) return ignoredAfterUnload("frames.onDidRender");
        companionArrived();
        const off = deps.handles.onDidRender(cb);
        return () => void off();
      },
      onDidDestroy: (cb: (f: FrameHandle) => void): Disposer => {
        if (!live) return ignoredAfterUnload("frames.onDidDestroy");
        companionArrived();
        const off = deps.handles.onDidDestroy(cb);
        return () => void off();
      },
    }),
    addFrameAction: (def: FrameActionDef): Disposer => {
      if (!live) return ignoredAfterUnload(`addFrameAction(${def.id})`);
      companionArrived();
      return deps.actions.add(def);
    },
    refreshActions: (frame: FrameHandle): void => deps.handles.refreshActions(frame),
    addMenuItems: (cb: Parameters<MehrpeleApiV1["addMenuItems"]>[0]): Disposer => {
      if (!live) return ignoredAfterUnload("addMenuItems");
      companionArrived();
      return deps.menus.add(cb);
    },
    canvas: Object.freeze({
      mermaidToCanvas: (src: string, opts?: object): MermaidToCanvasResult => deps.canvas().mermaidToCanvas(src, opts),
      canvasToMermaid: (canvas: CanvasData, opts?: object): string => deps.canvas().canvasToMermaid(canvas, opts).source,
    }),
    mountCanvas,
    isLive: (): boolean => live,
  });

  return {
    api,
    feature: (id) => metadata.get(id) ?? null,
    onFeaturesChanged: (cb) => {
      if (!live) return () => undefined;
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    mountCanvas,
    ready: () => {
      if (live) deps.workspace.trigger(API_READY_EVENT, api);
    },
    unload: () => {
      if (!live) return;
      live = false;
      listeners.clear();
      try {
        deps.workspace.trigger(API_UNLOAD_EVENT, api);
      } catch (e) {
        console.error("Mehrpele: an api-unload listener failed", e);
      }
      for (const dispose of [...features.values()]) {
        try {
          dispose();
        } catch (e) {
          console.error("Mehrpele: a companion feature failed to dispose", e);
        }
      }
      for (const destroy of [...mounts]) destroy();
      deps.handles.disposeAll();
      deps.actions.clear();
      deps.menus.clear();
    },
  };
}
