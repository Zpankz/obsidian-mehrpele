/**
 * Companion plugins: which other community plugins a feature needs, and
 * whether each is installed and enabled. Read from Obsidian's plugin manager
 * on every call (cheap: two lookups), so the settings tab shows live state.
 */
import type { ToggleId } from "../settings/schema";

/** Flows is an add-on, not a host feature toggle. Install opens instructions until listing. */
export const FLOWS = {
  id: "mehrpele-cannoli", name: "Mehrpele Flows", minHostMinor: 1,
  installUrl: "https://github.com/Zpankz/mehrpele/tree/main/packages/mehrpele-cannoli#install",
} as const;
export interface AddonRegistration { version: string; requiredHostMinor: number }
export interface FlowStatus {
  kind: "missing" | "disabled" | "update-needed" | "ready";
  label: string;
  detail: string;
  /** Where Update leads; missing registration cannot establish a host API mismatch. */
  updateTarget?: "host" | "companion";
}

/** Enabled alone does not prove that diagram integration connected successfully. */
export function detectFlows(plugins: PluginManagerLike | undefined, hostMinor: number, registration?: AddonRegistration | null): FlowStatus {
  const state = detectCompanion(plugins, FLOWS.id);
  if (!state.installed) return { kind: "missing", label: "Not installed", detail: "Run LLM flows drawn as diagrams with your own provider keys; data goes only to providers you choose." };
  const version = state.version ? `Version ${state.version}` : "Installed";
  if (!state.enabled) return { kind: "disabled", label: "Installed, disabled", detail: `${version}; enable the add-on to run flows.` };
  const required = registration?.requiredHostMinor ?? FLOWS.minHostMinor;
  if (hostMinor < required) return { kind: "update-needed", label: "Update needed", updateTarget: "host", detail: `${version} needs Mehrpele API 1.${required}; this host provides 1.${hostMinor}.` };
  if (!registration) return { kind: "update-needed", label: "Update needed", updateTarget: "companion", detail: `${version}; diagram integration has not connected, so check that both plugins are up to date.` };
  return { kind: "ready", label: "Ready", detail: `${version}; diagram integration is connected.` };
}

export interface CompanionState {
  installed: boolean;
  enabled: boolean;
  version: string | null;
}

export interface PluginManagerLike {
  manifests?: Record<string, { version?: string } | undefined>;
  enabledPlugins?: Set<string>;
}

export interface Companion {
  /** Community plugin id. */
  id: string;
  /** Display name. */
  name: string;
  /** Lowest supported version, if any. */
  minVersion?: string;
  /** Optional companions add to a feature; the feature works without them. */
  optional?: boolean;
}

/** Kept equal to the Excalidraw feature's own constant (tests/settings-tab-companions.test.ts). */
export const MIN_EXCALIDRAW_VERSION = "2.29.0";

/** The companions each feature uses. */
export const COMPANIONS: Readonly<Partial<Record<ToggleId, readonly Companion[]>>> = {
  "integrations.datacore": [{ id: "datacore", name: "Datacore" }],
  "integrations.breadcrumbs": [{ id: "breadcrumbs", name: "Breadcrumbs" }],
  "integrations.tasknotes": [{ id: "tasknotes", name: "TaskNotes" }],
  "integrations.extended-graph": [{ id: "extended-graph", name: "Extended Graph" }],
  excalidraw: [{ id: "obsidian-excalidraw-plugin", name: "Excalidraw", minVersion: MIN_EXCALIDRAW_VERSION }],
  canvas: [{ id: "advanced-canvas", name: "Advanced Canvas", optional: true }],
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

/**
 * Installed = its manifest is present; enabled = also listed as enabled
 * (the enabled list can name a plugin that is no longer installed).
 */
export function detectCompanion(plugins: PluginManagerLike | undefined, id: string): CompanionState {
  const manifest = plugins?.manifests?.[id];
  const installed = !!manifest;
  return {
    installed,
    enabled: installed && plugins?.enabledPlugins?.has(id) === true,
    version: typeof manifest?.version === "string" ? manifest.version : null,
  };
}

/** Is this companion ready to use: installed, enabled and new enough? */
export function companionReady(c: Companion, s: CompanionState): boolean {
  return s.enabled && (!c.minVersion || !s.version || versionAtLeast(s.version, c.minVersion));
}

/** The first required companion of a feature that is not ready, or null. */
export function missingCompanion(plugins: PluginManagerLike | undefined, id: ToggleId): Companion | null {
  for (const c of COMPANIONS[id] ?? []) {
    if (!c.optional && !companionReady(c, detectCompanion(plugins, c.id))) return c;
  }
  return null;
}

/** One-line status for a companion row. */
export function companionStatus(c: Companion, s: CompanionState): string {
  const needs = c.minVersion ? ` (needs ${c.minVersion} or later)` : "";
  if (!s.installed) return `Not installed${needs}.`;
  const name = s.version ? `Version ${s.version}` : "Installed";
  if (c.minVersion && s.version && !versionAtLeast(s.version, c.minVersion)) return `${name} is too old${needs}.`;
  return s.enabled ? `${name}, enabled.` : `${name}, not enabled.`;
}
