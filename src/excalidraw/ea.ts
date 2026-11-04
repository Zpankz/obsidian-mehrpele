// Structural types for the Excalidraw-Obsidian runtime (verified against
// obsidian-excalidraw-plugin 2.29.0 source; no runtime import of that plugin).
export interface EaLike {
  verifyMinimumPluginVersion(version: string): boolean;
  create(params?: { filename?: string; foldername?: string; exactPath?: string; onNewPane?: boolean; silent?: boolean }): Promise<string>;
  addElementsToView(repositionToCursor?: boolean, save?: boolean, newElementsOnTop?: boolean): Promise<boolean>;
  /** Target a view; no argument = active, else last active, else first Excalidraw view (EA ≥ 2.x). */
  setView?(view?: unknown, show?: boolean): unknown;
  executeCLI?(request: Record<string, unknown>): Promise<{ ok?: boolean; data?: { idMap?: Record<string, string> }; error?: unknown }>;
  getCLIRuntime?: () => { convertToExcalidrawElements?: (skeletons: unknown[], opts?: { regenerateIds?: boolean }) => Record<string, unknown>[] } | undefined;
  elementsDict: Record<string, unknown>;
  imagesDict: Record<string, unknown>;
  clear(): void;
}

export interface ExcalidrawPluginLike {
  ea?: EaLike;
  getCLIRuntime?: EaLike["getCLIRuntime"];
  executeCLI?: EaLike["executeCLI"];
}

export const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";
export const MIN_EXCALIDRAW_VERSION = "2.29.0";

export type AppPluginsLike = {
  plugins?: { manifests?: Record<string, unknown>; plugins?: Record<string, unknown> };
};

/** `a >= b` for dotted numeric versions ("2.29.0"); pre-release tags are ignored. */
export function versionAtLeast(a: string, b: string): boolean {
  const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return true;
}

/** Settings-tab status line for the Excalidraw plugin, from its manifest (no EA call). */
export function excalidrawStatus(app: unknown): { ready: boolean; detail: string } {
  const plugins = (app as { plugins?: { manifests?: Record<string, { version?: string } | undefined> } }).plugins;
  const version = plugins?.manifests?.[EXCALIDRAW_PLUGIN_ID]?.version;
  const state = excalidrawState(app as AppPluginsLike);
  if (!state.installed) return { ready: false, detail: `Excalidraw is not installed (needs ${MIN_EXCALIDRAW_VERSION} or later).` };
  if (version && !versionAtLeast(version, MIN_EXCALIDRAW_VERSION)) {
    return { ready: false, detail: `Excalidraw ${version} is too old (needs ${MIN_EXCALIDRAW_VERSION} or later).` };
  }
  const name = version ? `Excalidraw ${version}` : "Excalidraw";
  if (!state.enabled) return { ready: false, detail: `${name} is installed but not enabled.` };
  return { ready: true, detail: `${name} detected.` };
}

/** `installed` = manifest present, `enabled` = plugin instance loaded. EA requires enabled. */
export function excalidrawState(app: AppPluginsLike): { installed: boolean; enabled: boolean } {
  return {
    installed: EXCALIDRAW_PLUGIN_ID in (app.plugins?.manifests ?? {}),
    enabled: EXCALIDRAW_PLUGIN_ID in (app.plugins?.plugins ?? {}),
  };
}

export function getExcalidrawPlugin(app: unknown): ExcalidrawPluginLike | undefined {
  const loaded = (app as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins ?? {};
  return loaded[EXCALIDRAW_PLUGIN_ID] as ExcalidrawPluginLike | undefined;
}

/** Fresh EA per call via window.ExcalidrawAutomate.getAPI() (guarded; global may outlive unload). */
export function getEA(app: unknown): EaLike | undefined {
  try {
    const w = (window as { ExcalidrawAutomate?: { getAPI: (view?: unknown) => EaLike } }).ExcalidrawAutomate;
    if (w?.getAPI) return w.getAPI();
  } catch { /* plugin mid-unload */ }
  return getExcalidrawPlugin(app)?.ea;
}

export function checkExcalidraw(app: unknown): { ok: true; ea: EaLike } | { ok: false; reason: "missing" | "disabled" | "outdated" } {
  const state = excalidrawState(app as AppPluginsLike);
  if (!state.installed) return { ok: false, reason: "missing" };
  if (!state.enabled) return { ok: false, reason: "disabled" };
  const ea = getEA(app);
  if (!ea) return { ok: false, reason: "disabled" };
  try { if (!ea.verifyMinimumPluginVersion(MIN_EXCALIDRAW_VERSION)) return { ok: false, reason: "outdated" }; } catch { return { ok: false, reason: "outdated" }; }
  return { ok: true, ea };
}
