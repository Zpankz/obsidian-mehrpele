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
import type { FrameCompanion, HandleRegistry } from "./frame-handles";
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
}

export interface HostApi {
  readonly api: MehrpeleApiV1;
  /** Fires `mehrpele:api-ready` (from onLayoutReady). */
  ready(): void;
  /** Host unload, in the order above. Idempotent. */
  unload(): void;
}

export function createHostApi(deps: HostApiDeps): HostApi {
  let live = true;
  /** Live companion features by id → their disposer. */
  const features = new Map<string, Disposer>();
  /** Live canvas mounts → their destroy (host unload runs it, so a pending read mounts nothing). */
  const mounts = new Set<() => void>();

  // Frames are size-watched only once a companion registers something.
  const companionArrived = (): void => deps.handles.startWatching();

  const registerFeature = (def: CompanionFeatureDef): Disposer => {
    if (!live) {
      console.warn(`Mehrpele: registerFeature(${def.id}) after the host unloaded was ignored`);
      return () => undefined;
    }
    // Re-registering an id replaces the earlier registration (disposed first; its disposer is then spent).
    features.get(def.id)?.();
    const release = deps.adopt(def);
    companionArrived();
    let done = false;
    const dispose = (): void => {
      if (done) return;
      done = true;
      if (features.get(def.id) === dispose) features.delete(def.id);
      try {
        release();
      } finally {
        deps.handles.removeLayers(def.id);
      }
    };
    features.set(def.id, dispose);
    return dispose;
  };

  const mountCanvas = (file: TFile, el: HTMLElement, opts?: { fenceRest?: string }): { destroy(): void } => {
    const owner = new Component();
    owner.load();
    let gone = false;
    /** The elements this mount added to `el` (destroy removes them, and only them). */
    let added: Element[] = [];
    const destroy = (): void => {
      if (gone) return;
      gone = true;
      mounts.delete(destroy);
      owner.unload();
      for (const n of added) n.remove();
      added = [];
    };
    mounts.add(destroy);
    void deps
      .read(file)
      .then((text) => {
        if (gone) return;
        const r = deps.canvas().canvasToMermaid(JSON.parse(text) as CanvasData);
        const companion = { key: `${file.path}#0`, fenceRest: opts?.fenceRest ?? "" };
        const before = new Set(Array.from(el.children));
        deps.mountDiagram(el, owner, r.source, file.path, r.mehrpele ? "mehrpele" : "mermaid", companion);
        added = Array.from(el.children).filter((n) => !before.has(n));
      })
      .catch((e: unknown) => {
        if (gone) return;
        console.error(`Mehrpele: could not render ${file.path}`, e);
        el.textContent = `Mehrpele: could not render ${file.path}`;
      });
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
        companionArrived();
        const off = deps.handles.onDidRender(cb);
        return () => void off();
      },
      onDidDestroy: (cb: (f: FrameHandle) => void): Disposer => {
        companionArrived();
        const off = deps.handles.onDidDestroy(cb);
        return () => void off();
      },
    }),
    addFrameAction: (def: FrameActionDef): Disposer => {
      companionArrived();
      return deps.actions.add(def);
    },
    refreshActions: (frame: FrameHandle): void => deps.handles.refreshActions(frame),
    addMenuItems: (cb: Parameters<MehrpeleApiV1["addMenuItems"]>[0]): Disposer => {
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
    ready: () => {
      if (live) deps.workspace.trigger(API_READY_EVENT, api);
    },
    unload: () => {
      if (!live) return;
      live = false;
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
