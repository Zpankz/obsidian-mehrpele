/**
 * Partner-plugin detection + API adapters (structural, no Obsidian import
 * beyond types). Every lookup is lazy (at render time) because partner
 * `onload` order is not guaranteed; `window.BCAPI` is deleted on unload.
 *
 * API shapes follow each partner plugin's own source.
 */

export type DetectionStatus = "ok" | "not-installed" | "not-enabled" | "version-mismatch";

export interface Detection<T> {
  status: DetectionStatus;
  api?: T;
  detail: string;
}

// -- Breadcrumbs ----------------------------------------------------------------
// BCAPI: breadcrumbs/src/api/index.ts:11
//   fields :18, field_groups :22, refresh() :26, get_neighbours() :65
// window.BCAPI set in main.ts:140, deleted on unload :141-143.

export interface BcEdgeLike {
  source: string;
  target: string;
  field: string;
  /** "implied" for transitive/self-sibling edges (builders/index.ts:106,124). */
  sourceKind?: string;
  implied?: boolean;
}

export interface BcApiLike {
  fields?: { label: string }[];
  field_groups?: { label: string; fields: string[] }[];
  refresh?: () => Promise<void> | void;
  get_neighbours: (node?: string) => unknown;
}

// -- Datacore -------------------------------------------------------------------
// window.datacore: datacore/src/main.ts:68; DatacoreApi.tryQuery api.ts:74-76.
// Result: api/result.ts Success{successful:true,value} / Failure{successful:false,error}.
// Indexable: index/types/indexable.ts ($id/$types); MarkdownPage $path/$links/$tags.

export interface DatacoreResultLike<T> {
  successful: boolean;
  value?: T;
  error?: string;
}

export interface DatacoreApiLike {
  tryQuery: (query: string) => DatacoreResultLike<unknown[]>;
  core?: {
    revision?: number;
    initialized?: boolean;
    on?: (evt: string, cb: (...args: unknown[]) => void, ctx?: unknown) => unknown;
    offref?: (ref: unknown) => void;
  };
}

export interface DatacorePageLike {
  $id?: string;
  $path?: string;
  $file?: string;
  $name?: string;
  $tags?: string[];
  $links?: { path: string; display?: string }[];
  [key: string]: unknown;
}

// -- TaskNotes ------------------------------------------------------------------
// Access: app.plugins.plugins["tasknotes"].api (tasknotes/src/main.ts:201);
// apiVersion === 1 (runtime-api.ts:38, TaskNotesAPI.ts:722 apiVersion).
// listTasks runtime-api.ts:1142, getTaskDependencies :799/:1885,
// getBlockingTasks (TaskNotesAPI.ts:1904), events.on runtime-api.ts events API.

export interface TaskDependencyLike {
  uid: string;
  reltype?: string;
  gap?: string;
}

export interface TaskInfoLike {
  id?: string;
  title: string;
  status: string;
  priority?: string;
  due?: string;
  scheduled?: string;
  path: string;
  archived?: boolean;
  tags?: string[];
  projects?: string[];
  blockedBy?: TaskDependencyLike[];
  blocking?: string[];
  isBlocked?: boolean;
  completedDate?: string;
  [key: string]: unknown;
}

export interface ResolvedDependencyLike {
  dependency: TaskDependencyLike;
  task: TaskInfoLike | null;
  path: string | null;
}

export interface StatusConfigLike {
  value: string;
  label?: string;
  color?: string;
  isCompleted?: boolean;
}

export interface TaskNotesApiLike {
  apiVersion?: number;
  listTasks: (query?: unknown) => Promise<TaskInfoLike[]>;
  getTaskDependencies?: (path: string) => Promise<ResolvedDependencyLike[]>;
  getBlockingTasks?: (path: string) => Promise<TaskInfoLike[]>;
  catalog?: { statuses?: () => StatusConfigLike[] };
  events?: {
    on?: (event: string, handler: (payload: unknown) => void) => unknown;
    off?: (ref: unknown) => void;
  };
  on?: (event: string, handler: (payload: unknown) => void) => unknown;
  off?: (ref: unknown) => void;
}

// -- App/window access (injected so tests can fake) ------------------------------

export interface AppLike {
  plugins?: {
    plugins?: Record<string, { api?: unknown; enabled?: boolean } | undefined>;
    enabledPlugins?: Set<string> | string[];
  };
  workspace?: { getActiveFile?: () => { path: string } | null };
}

export interface WindowLike {
  BCAPI?: unknown;
  datacore?: unknown;
  peleMermaid?: unknown;
  [key: string]: unknown;
}

function pluginEntry(app: AppLike | undefined, id: string): { api?: unknown } | undefined {
  return app?.plugins?.plugins?.[id];
}

function pluginEnabled(app: AppLike | undefined, id: string): boolean {
  const enabled = app?.plugins?.enabledPlugins;
  if (enabled instanceof Set) return enabled.has(id);
  if (Array.isArray(enabled)) return enabled.includes(id);
  return pluginEntry(app, id) !== undefined;
}

export function getBcApi(app?: AppLike, win?: WindowLike): Detection<BcApiLike> {
  const w = win ?? (typeof window !== "undefined" ? (window as unknown as WindowLike) : undefined);
  const fromWindow = w?.BCAPI as BcApiLike | undefined;
  if (fromWindow && typeof fromWindow.get_neighbours === "function") {
    return { status: "ok", api: fromWindow, detail: "Breadcrumbs API found (window.BCAPI)." };
  }
  const entry = pluginEntry(app, "breadcrumbs");
  const fromPlugin = entry?.api as BcApiLike | undefined;
  if (fromPlugin && typeof fromPlugin.get_neighbours === "function") {
    return { status: "ok", api: fromPlugin, detail: "Breadcrumbs API found (plugin.api)." };
  }
  if (!entry && !fromWindow) {
    return { status: "not-installed", detail: "Breadcrumbs is not installed." };
  }
  return { status: "not-enabled", detail: "Breadcrumbs is installed but its API is unavailable (enable it, then reload)." };
}

export function getDatacoreApi(app?: AppLike, win?: WindowLike): Detection<DatacoreApiLike> {
  const w = win ?? (typeof window !== "undefined" ? (window as unknown as WindowLike) : undefined);
  const fromWindow = w?.datacore as DatacoreApiLike | undefined;
  if (fromWindow && typeof fromWindow.tryQuery === "function") {
    return { status: "ok", api: fromWindow, detail: "Datacore API found (window.datacore)." };
  }
  const entry = pluginEntry(app, "datacore");
  const fromPlugin = entry?.api as DatacoreApiLike | undefined;
  if (fromPlugin && typeof (fromPlugin).tryQuery === "function") {
    return { status: "ok", api: fromPlugin, detail: "Datacore API found (plugin.api)." };
  }
  if (!entry && !fromWindow && !pluginEnabled(app, "datacore")) {
    return { status: "not-installed", detail: "Datacore is not installed." };
  }
  return { status: "not-enabled", detail: "Datacore is installed but window.datacore is unavailable (enable it, then reload)." };
}

export function getTaskNotesApi(app?: AppLike): Detection<TaskNotesApiLike> {
  const entry = pluginEntry(app, "tasknotes");
  const api = entry?.api as TaskNotesApiLike | undefined;
  if (!entry && !api) return { status: "not-installed", detail: "TaskNotes is not installed." };
  if (!api || typeof api.listTasks !== "function") {
    return { status: "not-enabled", detail: "TaskNotes is installed but its API is unavailable (enable it, then reload)." };
  }
  if (api.apiVersion !== undefined && api.apiVersion !== 1) {
    return { status: "version-mismatch", api, detail: `TaskNotes API v${String(api.apiVersion)} found; this integration targets v1.` };
  }
  return { status: "ok", api, detail: "TaskNotes API v1 found." };
}

/** Unwrap a Datacore Result without throwing (tryQuery contract, api.ts:74). */
export function unwrapDatacoreResult<T>(result: DatacoreResultLike<T>): { ok: true; value: T } | { ok: false; error: string } {
  if (result && result.successful && result.value !== undefined) return { ok: true, value: result.value };
  return { ok: false, error: result?.error ?? "Datacore query failed." };
}

/** Normalise a Breadcrumbs EdgeList/edge array into plain edge records. */
export function normaliseBcEdges(raw: unknown, graph?: unknown): BcEdgeLike[] {
  const list = extractEdgeStructs(raw);
  const out: BcEdgeLike[] = [];
  for (const item of list) {
    const edge = toBcEdge(item, graph);
    if (edge) out.push(edge);
  }
  return out;
}

function extractEdgeStructs(raw: unknown): unknown[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const r = raw as { get_edges?: () => unknown[]; to_array?: () => unknown[] };
  try {
    if (typeof r.get_edges === "function") return r.get_edges();
  } catch { /* fall through */ }
  try {
    if (typeof r.to_array === "function") return r.to_array();
  } catch { /* fall through */ }
  return [];
}

function toBcEdge(item: unknown, graph?: unknown): BcEdgeLike | null {
  if (!item || typeof item !== "object") return null;
  const e = item as Record<string, unknown>;
  // Plain fake/record shape used in tests and by defensive callers.
  if (typeof e.source === "string" && typeof e.target === "string") {
    const field = typeof e.field === "string" ? e.field : typeof e.edge_type === "string" ? e.edge_type : "";
    const kind = typeof e.sourceKind === "string" ? e.sourceKind : typeof e.edge_source === "string" ? e.edge_source : undefined;
    return { source: e.source, target: e.target, field, sourceKind: kind, implied: e.implied === true || kind === "implied" };
  }
  // WASM EdgeStruct: methods need the graph (breadcrumbs_graph_wasm.d.ts).
  const struct = item as {
    edge_type?: string;
    source_path?: (g: unknown) => string;
    target_path?: (g: unknown) => string;
    is_self_loop?: () => boolean;
    edge_data?: (g: unknown) => { edge_source?: string };
  };
  try {
    if (typeof struct.source_path === "function" && typeof struct.target_path === "function" && graph !== undefined) {
      const data = typeof struct.edge_data === "function" ? struct.edge_data(graph) : undefined;
      const sourceKind = data?.edge_source;
      return {
        source: struct.source_path(graph),
        target: struct.target_path(graph),
        field: struct.edge_type ?? "",
        sourceKind,
        implied: sourceKind === "implied",
      };
    }
  } catch { /* unreadable edge */ }
  return null;
}
