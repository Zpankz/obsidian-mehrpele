/**
 * View-node settings (pure). Stored as `features["view-nodes"]` (v3);
 * `viewNodeOptions` derives the runtime shape.
 */
import type { SettingsV3 } from "../../settings/schema";

export interface ViewNodeSettings {
  /** Web pages, PDFs and workspace views inside Mehrpele nodes; `%% pele-view %%`. */
  enabled: boolean;
  /** Most views live at once (beyond: placeholders, click to load). */
  maxLiveViews: number;
  /** Web pages in nodes (desktop: sandboxed webview, like Canvas link cards). */
  webEnabled: boolean;
  /** URL schemes a web node may load (lower case, no colon). */
  allowedSchemes: string[];
  /** Local graph depth when a view does not say `depth=`. */
  defaultLocalGraphDepth: number;
  /** Show the attached-view button when hovering a node with `%% pele-view %%`. */
  attachedViews: boolean;
}

export const DEFAULT_VIEW_NODE_SETTINGS: ViewNodeSettings = {
  enabled: true,
  maxLiveViews: 6,
  webEnabled: true,
  allowedSchemes: ["https", "http"],
  defaultLocalGraphDepth: 1,
  attachedViews: true,
};

/** Schemes that can never be loaded in a node (Obsidian URIs run commands; local files). */
export const NEVER_SCHEMES = new Set(["obsidian", "file", "app", "javascript", "data", "vbscript", "blob", "chrome", "devtools"]);

export function normalizeViewNodeSettings(raw: unknown): ViewNodeSettings {
  const d = (raw && typeof raw === "object" ? raw : {}) as Partial<ViewNodeSettings>;
  const out: ViewNodeSettings = { ...DEFAULT_VIEW_NODE_SETTINGS };
  if (typeof d.enabled === "boolean") out.enabled = d.enabled;
  if (typeof d.webEnabled === "boolean") out.webEnabled = d.webEnabled;
  if (typeof d.attachedViews === "boolean") out.attachedViews = d.attachedViews;
  if (typeof d.maxLiveViews === "number" && Number.isFinite(d.maxLiveViews)) {
    out.maxLiveViews = Math.min(32, Math.max(1, Math.round(d.maxLiveViews)));
  }
  if (typeof d.defaultLocalGraphDepth === "number" && Number.isFinite(d.defaultLocalGraphDepth)) {
    out.defaultLocalGraphDepth = Math.min(5, Math.max(1, Math.round(d.defaultLocalGraphDepth)));
  }
  if (Array.isArray(d.allowedSchemes)) {
    const schemes = parseSchemes(d.allowedSchemes.join(","));
    out.allowedSchemes = schemes.length ? schemes : [...DEFAULT_VIEW_NODE_SETTINGS.allowedSchemes];
  }
  return out;
}

/** `https, http` → ["https", "http"]; unsafe and malformed schemes dropped. */
export function parseSchemes(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const s = raw.trim().toLowerCase().replace(/:(\/\/)?$/, "");
    if (!s || !/^[a-z][a-z0-9+.-]*$/.test(s) || NEVER_SCHEMES.has(s) || out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

/** May a web node load this URL? */
export function webUrlAllowed(url: string, settings: Pick<ViewNodeSettings, "allowedSchemes">): boolean {
  let scheme: string;
  try {
    scheme = new URL(url).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    return false;
  }
  return !NEVER_SCHEMES.has(scheme) && settings.allowedSchemes.includes(scheme);
}

/** Sub-frame schemes that are never allowed (pages legitimately use about:, data:, blob: there). */
export function isGuardedScheme(url: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  if (!m) return false;
  const scheme = m[1].toLowerCase();
  return !["http", "https", "about", "data", "blob"].includes(scheme);
}

/** Same origin as the app itself (mobile: http://localhost, capacitor://localhost). */
export function isAppOrigin(url: string, appOrigin: string): boolean {
  try {
    const o = new URL(url).origin;
    return o !== "null" && o === appOrigin;
  } catch {
    return false;
  }
}

export const WEB_OFF = "Web pages in nodes are off (Settings › Mehrpele › View nodes)";

/** Why a URL may not load in a node, or its "open" action run (null = it may). */
export function webBlockReason(url: string, settings: Pick<ViewNodeSettings, "webEnabled" | "allowedSchemes">): string | null {
  if (!settings.webEnabled) return WEB_OFF;
  if (!webUrlAllowed(url, settings)) return `Blocked URL scheme: ${url.split(":")[0]}:`;
  return null;
}

/** Local graph depth when a view does not say `depth=` (no longer a setting). */
export const DEFAULT_LOCAL_GRAPH_DEPTH = 1;

/** Runtime view-node options from the v3 settings. Read-only. */
export function viewNodeOptions(s: SettingsV3): ViewNodeSettings {
  const vn = s.features["view-nodes"];
  return {
    enabled: vn.enabled,
    maxLiveViews: vn.maxLiveViews,
    webEnabled: vn.webEnabled,
    allowedSchemes: [...vn.allowedSchemes],
    defaultLocalGraphDepth: DEFAULT_LOCAL_GRAPH_DEPTH,
    attachedViews: vn.attachedViews,
  };
}
