// Structural types for the Excalidraw-Obsidian runtime (verified against
// obsidian-excalidraw-plugin 2.29.0 source; no runtime import of that plugin).
// Return types are deliberately loose where a foreign build may resolve nothing.

/** An Excalidraw element as stored in `ea.elementsDict` (only `id` is read here). */
export type ExcalidrawElementLike = { id: string };

/** An embedded image as Excalidraw stores it in `ea.imagesDict` (fields EA 2.29 reads). */
export interface EaImageEntry {
  mimeType: string;
  dataURL: string;
  id: string;
  created: number;
  isHyperLink: boolean;
  hyperlink: null;
  file: null;
  hasSVGwithBitmap: boolean;
  latex: null;
}

export interface EaLike {
  verifyMinimumPluginVersion(version: string): boolean;
  create(params?: { filename?: string; foldername?: string; exactPath?: string; onNewPane?: boolean; silent?: boolean }): Promise<string | undefined>;
  addElementsToView(repositionToCursor?: boolean, save?: boolean, newElementsOnTop?: boolean): Promise<boolean>;
  /** Target a view; no argument = active, else last active, else first Excalidraw view (EA ≥ 2.x). */
  setView?(view?: unknown, show?: boolean): unknown;
  executeCLI?(request: Record<string, unknown>): Promise<{ ok?: boolean; data?: { idMap?: Record<string, string> }; error?: unknown } | undefined>;
  getCLIRuntime?: () => { convertToExcalidrawElements?: (skeletons: readonly unknown[], opts?: { regenerateIds?: boolean }) => ExcalidrawElementLike[] } | undefined;
  elementsDict: Record<string, unknown>;
  imagesDict: Record<string, EaImageEntry>;
  clear(): void;
}

export interface ExcalidrawPluginLike {
  ea?: EaLike;
  getCLIRuntime?: EaLike["getCLIRuntime"];
}

export const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";
export const MIN_EXCALIDRAW_VERSION = "2.29.0";
export const EXCALIDRAW_INSTALL_URL = `obsidian://show-plugin?id=${EXCALIDRAW_PLUGIN_ID}`;

/** Obsidian's undocumented `app.plugins` registry; every helper here reads it through this one narrowing. */
type PluginRegistry = { manifests?: Record<string, unknown>; plugins?: Record<string, unknown> };
function pluginRegistry(app: unknown): PluginRegistry {
  return (app as { plugins?: PluginRegistry } | null | undefined)?.plugins ?? {};
}

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
  const manifest = pluginRegistry(app).manifests?.[EXCALIDRAW_PLUGIN_ID] as { version?: string } | undefined;
  const version = manifest?.version;
  const state = excalidrawState(app);
  if (!state.installed) return { ready: false, detail: `Excalidraw is not installed (needs ${MIN_EXCALIDRAW_VERSION} or later).` };
  if (version && !versionAtLeast(version, MIN_EXCALIDRAW_VERSION)) {
    return { ready: false, detail: `Excalidraw ${version} is too old (needs ${MIN_EXCALIDRAW_VERSION} or later).` };
  }
  const name = version ? `Excalidraw ${version}` : "Excalidraw";
  if (!state.enabled) return { ready: false, detail: `${name} is installed but not enabled.` };
  return { ready: true, detail: `${name} detected.` };
}

/** `installed` = manifest present, `enabled` = plugin instance loaded. EA requires enabled. */
export function excalidrawState(app: unknown): { installed: boolean; enabled: boolean } {
  const registry = pluginRegistry(app);
  return {
    installed: EXCALIDRAW_PLUGIN_ID in (registry.manifests ?? {}),
    enabled: EXCALIDRAW_PLUGIN_ID in (registry.plugins ?? {}),
  };
}

export function getExcalidrawPlugin(app: unknown): ExcalidrawPluginLike | undefined {
  return pluginRegistry(app).plugins?.[EXCALIDRAW_PLUGIN_ID] as ExcalidrawPluginLike | undefined;
}

/**
 * A fresh EA from window.ExcalidrawAutomate.getAPI() when available (guarded; the global may outlive
 * unload), else the plugin's own shared `ea`.
 */
export function getEa(app: unknown): EaLike | undefined {
  try {
    const w = (window as { ExcalidrawAutomate?: { getAPI: (view?: unknown) => EaLike } }).ExcalidrawAutomate;
    if (w?.getAPI) return w.getAPI();
  } catch { /* plugin mid-unload */ }
  return getExcalidrawPlugin(app)?.ea;
}

export function checkExcalidraw(app: unknown): { ok: true; ea: EaLike } | { ok: false; reason: "missing" | "disabled" | "outdated" } {
  const state = excalidrawState(app);
  if (!state.installed) return { ok: false, reason: "missing" };
  if (!state.enabled) return { ok: false, reason: "disabled" };
  const ea = getEa(app);
  if (!ea) return { ok: false, reason: "disabled" };
  try { if (!ea.verifyMinimumPluginVersion(MIN_EXCALIDRAW_VERSION)) return { ok: false, reason: "outdated" }; } catch { return { ok: false, reason: "outdated" }; }
  return { ok: true, ea };
}
