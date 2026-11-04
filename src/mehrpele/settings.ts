/**
 * Mehrpele plugin settings. Pure (no obsidian import) so the
 * normalisation/applicability logic is unit-testable; the settings-tab rows
 * live in src/settings-tab/definitions.ts.
 * At runtime, `mehrpeleOptions(settings)` derives it from the v3 settings.
 */

// view-nodes: nested settings object (src/mehrpele/views/settings.ts)
import type { SettingsV3 } from "../settings/schema";
import { DEFAULT_VIEW_NODE_SETTINGS, normalizeViewNodeSettings, viewNodeOptions, type ViewNodeSettings } from "./views/settings";

export type MermaidLabelMode = "off" | "directive" | "always";
export type EmbedSizing = "legible" | "exact";
export type EmbedScaling = "viewport" | "zoom";

export interface MehrpeleSettings {
  /** Markdown labels in mermaid/pele blocks: off / directive only / always. */
  mermaidLabelMode: MermaidLabelMode;
  /** Sole-embed labels (.base, .canvas, notes) render live; off = link chips. */
  allowEmbeds: boolean;
  maxLabelWidth: number;
  maxLabelHeight: number;
  maxEmbedWidth: number;
  maxEmbedHeight: number;
  /** Beyond this many Markdown labels, the rest stay plain text. */
  maxLabels: number;
  /** IntersectionObserver gating for embed labels. */
  lazyEmbeds: boolean;
  /** Register the `mehrpele-diagram` Bases view. */
  basesViewEnabled: boolean;
  /** Default embed-node box when no `|WxH` size is given. */
  embedDefaultWidth: number;
  embedDefaultHeight: number;
  /**
   * Image / nested-diagram node sizing: `legible` enlarges explicit sizes
   * that would shrink the content below `minEmbedScale` of its natural size;
   * `exact` honours `|W` / `width=` as written. Both fit the embed maxima
   * with the aspect ratio kept (never clipped).
   */
  embedSizing: EmbedSizing;
  /** Legible mode floor, as a fraction of the content's natural size. */
  minEmbedScale: number;
  /** Render sole-diagram labels (inline fences, diagram embeds) as nested diagrams. */
  nestedDiagrams: boolean;
  /** Diagram levels allowed inside a diagram; deeper ones render plain. */
  maxNestingDepth: number;
  /**
   * Interactive embeds (Bases, graphs, notes, Canvas): `viewport` keeps their
   * controls at native size and gives them more room as the diagram grows;
   * `zoom` (legacy) scales them with the diagram like text and images.
   */
  embedScaling: EmbedScaling;
  /** Viewport scaling: smallest scale embed controls shrink to (0.25–1). */
  minEmbedUiScale: number;
  /** Note cards (`![[Note]]` nodes) show the file name above the node, as Canvas file cards do. */
  noteCardLabels: boolean;
  /** view-nodes: web/PDF/workspace views in nodes, `%% pele-view %%`. */
  viewNodes: ViewNodeSettings;
}

export const DEFAULT_MEHRPELE_SETTINGS: MehrpeleSettings = {
  mermaidLabelMode: "directive",
  allowEmbeds: true,
  maxLabelWidth: 480,
  maxLabelHeight: 320,
  maxEmbedWidth: 640,
  maxEmbedHeight: 480,
  maxLabels: 50,
  lazyEmbeds: true,
  basesViewEnabled: true,
  embedDefaultWidth: 320,
  embedDefaultHeight: 240,
  embedSizing: "legible",
  minEmbedScale: 0.5,
  nestedDiagrams: true,
  maxNestingDepth: 3,
  embedScaling: "viewport",
  minEmbedUiScale: 0.75,
  noteCardLabels: true,
  viewNodes: DEFAULT_VIEW_NODE_SETTINGS, // view-nodes
};

/** Merge persisted (possibly partial) data over the defaults. */
export function normalizeMehrpeleSettings(
  data: Partial<MehrpeleSettings> | null | undefined,
): MehrpeleSettings {
  const merged = { ...DEFAULT_MEHRPELE_SETTINGS, ...(data ?? {}) };
  merged.viewNodes = normalizeViewNodeSettings(data?.viewNodes); // view-nodes
  if (!["off", "directive", "always"].includes(merged.mermaidLabelMode)) {
    merged.mermaidLabelMode = DEFAULT_MEHRPELE_SETTINGS.mermaidLabelMode;
  }
  if (merged.embedSizing !== "legible" && merged.embedSizing !== "exact") {
    merged.embedSizing = DEFAULT_MEHRPELE_SETTINGS.embedSizing;
  }
  if (typeof merged.minEmbedScale !== "number" || !Number.isFinite(merged.minEmbedScale) || merged.minEmbedScale <= 0) {
    merged.minEmbedScale = DEFAULT_MEHRPELE_SETTINGS.minEmbedScale;
  }
  merged.minEmbedScale = Math.min(1, merged.minEmbedScale);
  if (typeof merged.noteCardLabels !== "boolean") merged.noteCardLabels = DEFAULT_MEHRPELE_SETTINGS.noteCardLabels;
  if (typeof merged.nestedDiagrams !== "boolean") merged.nestedDiagrams = DEFAULT_MEHRPELE_SETTINGS.nestedDiagrams;
  if (typeof merged.maxNestingDepth !== "number" || !Number.isInteger(merged.maxNestingDepth) || merged.maxNestingDepth < 0) {
    merged.maxNestingDepth = DEFAULT_MEHRPELE_SETTINGS.maxNestingDepth;
  }
  merged.maxNestingDepth = Math.min(merged.maxNestingDepth, 8);
  if (merged.embedScaling !== "viewport" && merged.embedScaling !== "zoom") {
    merged.embedScaling = DEFAULT_MEHRPELE_SETTINGS.embedScaling;
  }
  if (typeof merged.minEmbedUiScale !== "number" || !Number.isFinite(merged.minEmbedUiScale)) {
    merged.minEmbedUiScale = DEFAULT_MEHRPELE_SETTINGS.minEmbedUiScale;
  }
  merged.minEmbedUiScale = Math.min(1, Math.max(0.25, merged.minEmbedUiScale));
  for (const key of [
    "maxLabelWidth", "maxLabelHeight", "maxEmbedWidth", "maxEmbedHeight",
    "maxLabels", "embedDefaultWidth", "embedDefaultHeight",
  ] as const) {
    const v = merged[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      merged[key] = DEFAULT_MEHRPELE_SETTINGS[key];
    }
  }
  return merged;
}

/** Should a block use Mehrpele rendering, given its language/source/mode? */
export function mehrpeleApplies(
  lang: string,
  source: string,
  settings: MehrpeleSettings,
  hasDirective: boolean,
): boolean {
  if (lang === "mehrpele") return true;
  if (lang !== "mermaid" && lang !== "pele") return false;
  switch (settings.mermaidLabelMode) {
    case "always":
      return true;
    case "directive":
      return hasDirective;
    default:
      return false;
  }
}

/** Retired options, now fixed. */
export const LAZY_EMBEDS = true;
export const EMBED_DEFAULT_WIDTH = 320;
export const EMBED_DEFAULT_HEIGHT = 240;
export const EMBED_SCALING: EmbedScaling = "viewport";
export const MIN_EMBED_UI_SCALE = 0.75;

/** Runtime Mehrpele options from the v3 settings (live view, nested, Bases, view nodes). Read-only. */
export function mehrpeleOptions(s: SettingsV3): MehrpeleSettings {
  const f = s.features, lv = f["live-view"];
  return {
    mermaidLabelMode: lv.mermaidLabelMode,
    allowEmbeds: lv.embeds,
    maxLabelWidth: lv.maxLabelWidth,
    maxLabelHeight: lv.maxLabelHeight,
    maxEmbedWidth: lv.maxEmbedWidth,
    maxEmbedHeight: lv.maxEmbedHeight,
    maxLabels: lv.maxLabels,
    lazyEmbeds: LAZY_EMBEDS,
    basesViewEnabled: f.bases.enabled,
    embedDefaultWidth: EMBED_DEFAULT_WIDTH,
    embedDefaultHeight: EMBED_DEFAULT_HEIGHT,
    // v3 stores "exact" as a floor of 0.
    embedSizing: lv.minEmbedScale === 0 ? "exact" : "legible",
    minEmbedScale: lv.minEmbedScale,
    nestedDiagrams: f.nested.enabled,
    maxNestingDepth: f.nested.maxDepth,
    embedScaling: EMBED_SCALING,
    minEmbedUiScale: MIN_EMBED_UI_SCALE,
    noteCardLabels: lv.noteCardLabels,
    viewNodes: viewNodeOptions(s),
  };
}
