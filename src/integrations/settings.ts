/** Integration settings (pure, DOM-free). Every integration is off by default. */
import type { SettingsV3 } from "../settings/schema";

export interface BreadcrumbsIntegrationSettings {
  enabled: boolean;
  maxNodes: number;
  /** Include implied/transitive edges (dimmed) instead of filtering them. */
  showImplied: boolean;
  debounceMs: number;
}

export interface DatacoreIntegrationSettings {
  enabled: boolean;
  maxNodes: number;
  debounceMs: number;
}

export interface TaskNotesIntegrationSettings {
  enabled: boolean;
  maxNodes: number;
  debounceMs: number;
  /** Status values treated as done (gantt `done`). Read from TaskNotes at runtime when empty. */
  doneStatuses: string[];
  activeStatuses: string[];
  critStatuses: string[];
}

export interface ExtendedGraphIntegrationSettings {
  /** Map Extended Graph's explicit tag/property/folder/link colours (and shapes) onto generated diagrams. */
  useColors: boolean;
}

export interface IntegrationSettings {
  breadcrumbs: BreadcrumbsIntegrationSettings;
  datacore: DatacoreIntegrationSettings;
  tasknotes: TaskNotesIntegrationSettings;
  extendedGraph: ExtendedGraphIntegrationSettings;
}

export const DEFAULT_INTEGRATION_SETTINGS: IntegrationSettings = {
  breadcrumbs: { enabled: false, maxNodes: 200, showImplied: false, debounceMs: 250 },
  datacore: { enabled: false, maxNodes: 200, debounceMs: 250 },
  tasknotes: {
    enabled: false,
    maxNodes: 200,
    debounceMs: 250,
    doneStatuses: [],
    activeStatuses: [],
    critStatuses: [],
  },
  extendedGraph: { useColors: false },
};

export function normalizeIntegrationSettings(
  data: Partial<IntegrationSettings> | null | undefined,
): IntegrationSettings {
  const d = DEFAULT_INTEGRATION_SETTINGS;
  const clampNodes = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(Math.floor(v), 1000)) : fallback;
  const clampDebounce = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(Math.floor(v), 5000)) : fallback;
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  return {
    breadcrumbs: {
      enabled: data?.breadcrumbs?.enabled ?? d.breadcrumbs.enabled,
      maxNodes: clampNodes(data?.breadcrumbs?.maxNodes, d.breadcrumbs.maxNodes),
      showImplied: data?.breadcrumbs?.showImplied ?? d.breadcrumbs.showImplied,
      debounceMs: clampDebounce(data?.breadcrumbs?.debounceMs, d.breadcrumbs.debounceMs),
    },
    datacore: {
      enabled: data?.datacore?.enabled ?? d.datacore.enabled,
      maxNodes: clampNodes(data?.datacore?.maxNodes, d.datacore.maxNodes),
      debounceMs: clampDebounce(data?.datacore?.debounceMs, d.datacore.debounceMs),
    },
    tasknotes: {
      enabled: data?.tasknotes?.enabled ?? d.tasknotes.enabled,
      maxNodes: clampNodes(data?.tasknotes?.maxNodes, d.tasknotes.maxNodes),
      debounceMs: clampDebounce(data?.tasknotes?.debounceMs, d.tasknotes.debounceMs),
      doneStatuses: strList(data?.tasknotes?.doneStatuses),
      activeStatuses: strList(data?.tasknotes?.activeStatuses),
      critStatuses: strList(data?.tasknotes?.critStatuses),
    },
    extendedGraph: {
      useColors: data?.extendedGraph?.useColors === true,
    },
  };
}

/** Refresh debounce for generated diagrams (no longer a setting). */
export const INTEGRATION_DEBOUNCE_MS = 250;

/** Runtime integration options from the v3 settings (`maxNodes` is shared). Read-only. */
export function integrationOptions(s: SettingsV3): IntegrationSettings {
  const i = s.features.integrations;
  const maxNodes = i.maxNodes, debounceMs = INTEGRATION_DEBOUNCE_MS;
  return {
    breadcrumbs: { enabled: i.breadcrumbs.enabled, maxNodes, showImplied: i.breadcrumbs.showImplied, debounceMs },
    datacore: { enabled: i.datacore.enabled, maxNodes, debounceMs },
    tasknotes: { enabled: i.tasknotes.enabled, maxNodes, debounceMs, doneStatuses: [], activeStatuses: [], critStatuses: [] },
    extendedGraph: { useColors: i["extended-graph"].enabled },
  };
}
