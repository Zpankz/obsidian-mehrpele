/**
 * Settings schema v2: migration input only (see ./migrate.ts). Nothing at
 * runtime holds a v2 object; the plugin keeps `SettingsV3` in memory.
 */
import { normalizeIntegrationSettings, type IntegrationSettings } from "../integrations/settings";
import { normalizeMaterialiseSettings, type MaterialiseSettings } from "../materialise/settings";
import { normalizeMehrpeleSettings, type MehrpeleSettings } from "../mehrpele/settings";
import { DEFAULT_REPAIR_SETTINGS, type RepairSettings } from "../repair-settings";
import { DEFAULT_EDIT_SETTINGS, normalizeEditSettings, type EditSettings } from "../edit/settings";
import type { ZoomMode } from "../settings";

export interface PeleSettings {
  /** Override Obsidian's built-in `mermaid` blocks (applied at plugin load; see README). */
  overrideMermaid: boolean;
  zoomMode: ZoomMode;
  /** Max diagram width in px; 0 = fit container. */
  maxWidth: number;
  showErrorSnippet: boolean;
  /** CSS font-family override; empty = Obsidian's diagram font (--font-mermaid, else the text font). */
  fontFamily: string;
  /** Base font size in px; 0 = Pele default. */
  fontSize: number;
  /** Schema version of saved settings; see normalizeSettings. */
  settingsVersion: number;
  /** Resolve diagram icons (fa:/lucide:) via Obsidian's Lucide set. */
  iconsEnabled: boolean;
  /** App-controlled default Mermaid config (JSON object text; diagram frontmatter/directives override). */
  defaultConfigJson: string;
  allowLinks: boolean;
  allowRemoteImages: boolean;
  sanitizeSvg: boolean;
  /** Gantt "today" marker (passes now: Date.now() to Pele). */
  ganttToday: boolean;
  /** Max diagram source length in chars; 0 = Pele default (50000). */
  maxSourceLength: number;
  repair: RepairSettings;
  mehrpele: MehrpeleSettings;
  integrations: IntegrationSettings;
  /** Master switch for Mehrpele (quoted-label Markdown). Default off. */
  mehrpeleEnabled: boolean;
  /** Register pele:* Obsidian CLI handlers (takes effect on reload). */
  cliEnabled: boolean;
  /** "Materialise diagram as notes" (src/materialise). */
  materialise: MaterialiseSettings;
  /** Canvas conversion settings. */
  canvas: {
    portals: "link" | "inline";
    portalDepth: number;
    outputFolder: string;
    /** Canvas → Mermaid: `canvas` pins card positions (`%% pele-layout canvas %%`), `auto` lets Pele lay out. */
    layout: "auto" | "canvas";
  };
  /** Excalidraw companion: local build source folder. */
  excalidrawSourceFolder: string;
  /** Standalone pele-render CLI install source bundle. */
  cliBundleSource: string;
  /** obsidian:// links clicked in diagrams: command URIs are off unless allowlisted; writes never. */
  linkPolicy: { allowCommandUris: boolean; commandAllowlist: string[] };
  /** Per-node box handles: shown on hover, or off (`%% pele-size %%` still renders). */
  nodeResize: "hover" | "off";
  /** Responsive reflow (layout width, direction switching, floor then scroll). */
  reflow: ReflowSettings;
  /** pele-edit: hover toolbar + inline label editor (src/edit). */
  edit: EditSettings;
}

export interface ReflowSettings {
  /** Re-lay out diagrams for the space they have; off = legacy CSS scaling. */
  enabled: boolean;
  /** Flowchart (and mindmap, timeline, …) LR/RL → top-down when the layout does not fit. */
  switchDirection: boolean;
  /** Class, state and ER diagrams with no written direction turn sideways when too wide. */
  autoTurn: boolean;
  /** Smallest text scale before a diagram scrolls instead (0.3–1). */
  minTextScale: number;
  /** `width=N` magnifies the diagram to fill the frame (pre-reflow behaviour). */
  legacyMagnify: boolean;
  /** Animate layout changes (skipped with reduced motion). */
  animate: boolean;
}

export const DEFAULT_REFLOW_SETTINGS: ReflowSettings = {
  enabled: true,
  switchDirection: true,
  autoTurn: true,
  minTextScale: 0.8,
  legacyMagnify: false,
  animate: true,
};

/** Tolerant normalisation of saved reflow settings. */
export function normalizeReflowSettings(data: Partial<ReflowSettings> | null | undefined): ReflowSettings {
  const d = data ?? {};
  const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
  const floor = typeof d.minTextScale === "number" && Number.isFinite(d.minTextScale) ? Math.min(1, Math.max(0.3, d.minTextScale)) : DEFAULT_REFLOW_SETTINGS.minTextScale;
  return {
    enabled: bool(d.enabled, DEFAULT_REFLOW_SETTINGS.enabled),
    switchDirection: bool(d.switchDirection, DEFAULT_REFLOW_SETTINGS.switchDirection),
    autoTurn: bool(d.autoTurn, DEFAULT_REFLOW_SETTINGS.autoTurn),
    minTextScale: floor,
    legacyMagnify: bool(d.legacyMagnify, DEFAULT_REFLOW_SETTINGS.legacyMagnify),
    animate: bool(d.animate, DEFAULT_REFLOW_SETTINGS.animate),
  };
}

export const SETTINGS_VERSION = 2;

export const DEFAULT_SETTINGS: PeleSettings = {
  overrideMermaid: true,
  // Lightbox provides zoom; Pele's in-place pan/zoom is opt-in.
  zoomMode: "off",
  maxWidth: 0,
  showErrorSnippet: true,
  fontFamily: "",
  fontSize: 0,
  settingsVersion: SETTINGS_VERSION,
  iconsEnabled: true,
  defaultConfigJson: "",
  allowLinks: true,
  allowRemoteImages: true,
  sanitizeSvg: false,
  ganttToday: true,
  maxSourceLength: 0,
  repair: { ...DEFAULT_REPAIR_SETTINGS },
  mehrpele: normalizeMehrpeleSettings(null),
  integrations: normalizeIntegrationSettings(null),
  mehrpeleEnabled: false,
  cliEnabled: true,
  materialise: normalizeMaterialiseSettings(null),
  canvas: { portals: "link", portalDepth: 1, outputFolder: "", layout: "canvas" },
  excalidrawSourceFolder: "",
  cliBundleSource: "",
  linkPolicy: { allowCommandUris: false, commandAllowlist: [] },
  nodeResize: "hover",
  reflow: { ...DEFAULT_REFLOW_SETTINGS },
  edit: { ...DEFAULT_EDIT_SETTINGS }, // pele-edit
};

/** Merge persisted (possibly partial/legacy) data over defaults. */
export function normalizeSettings(data: Partial<PeleSettings> | null | undefined): PeleSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
  merged.repair = { ...DEFAULT_REPAIR_SETTINGS, ...(data?.repair ?? {}) };
  merged.mehrpele = normalizeMehrpeleSettings(data?.mehrpele);
  merged.integrations = normalizeIntegrationSettings(data?.integrations);
  merged.canvas = { ...DEFAULT_SETTINGS.canvas, ...(data?.canvas ?? {}) };
  merged.materialise = normalizeMaterialiseSettings(data?.materialise);
  if (merged.canvas.layout !== "auto") merged.canvas.layout = "canvas";
  merged.linkPolicy = {
    allowCommandUris: data?.linkPolicy?.allowCommandUris === true,
    commandAllowlist: Array.isArray(data?.linkPolicy?.commandAllowlist)
      ? data.linkPolicy.commandAllowlist.filter((id): id is string => typeof id === "string" && id.trim() !== "")
      : [],
  };
  if (merged.nodeResize !== "off") merged.nodeResize = "hover";
  merged.reflow = normalizeReflowSettings(data?.reflow);
  merged.edit = normalizeEditSettings(data?.edit); // pele-edit
  // v1 defaulted zoomMode to "auto"; the lightbox replaced it in v2, so reset
  // the old default rather than leave Pele's +/- controls over every diagram.
  if (data && (data.settingsVersion ?? 1) < 2 && data.zoomMode === "auto") merged.zoomMode = "off";
  merged.settingsVersion = SETTINGS_VERSION;
  return merged;
}
