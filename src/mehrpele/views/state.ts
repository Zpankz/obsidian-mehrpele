/**
 * Workspace view state per view type (pure). Turns a parsed `view:` spec
 * into the `setState` payload the view expects, plus what the host must do
 * around it (bind the leaf to a file, keep graph options out of graph.json).
 *
 * Core view types are described here (which core plugin provides them,
 * whether they show a note, how query keys map to their state). Anything
 * else is a community view: `file=` becomes `state.file`, `state=` is
 * passed through once its `file`, `url` and `options` keys check out.
 */
import { parseBool, type ViewNodeSpec } from "./syntax";

export type FileNeed = "required" | "optional" | "none";

export interface CoreViewInfo {
  /** Internal (core) plugin id providing the view. */
  plugin: string;
  title: string;
  icon: string;
  /** Whether the view shows one note (default: the node's note / this note). */
  file: FileNeed;
  /** Desktop-only (webviews). */
  desktopOnly?: boolean;
}

export const CORE_VIEWS: Record<string, CoreViewInfo> = {
  localgraph: { plugin: "graph", title: "Local graph", icon: "lucide-git-fork", file: "required" },
  graph: { plugin: "graph", title: "Graph", icon: "lucide-git-fork", file: "none" },
  backlink: { plugin: "backlink", title: "Backlinks", icon: "links-coming-in", file: "required" },
  "outgoing-link": { plugin: "outgoing-link", title: "Outgoing links", icon: "links-going-out", file: "required" },
  outline: { plugin: "outline", title: "Outline", icon: "lucide-list", file: "required" },
  "file-properties": { plugin: "properties", title: "Properties", icon: "lucide-info", file: "required" },
  "all-properties": { plugin: "properties", title: "All properties", icon: "lucide-archive", file: "none" },
  tag: { plugin: "tag-pane", title: "Tags", icon: "lucide-tags", file: "none" },
  "file-explorer": { plugin: "file-explorer", title: "Files", icon: "lucide-folder-closed", file: "none" },
  search: { plugin: "global-search", title: "Search", icon: "lucide-search", file: "none" },
  bookmarks: { plugin: "bookmarks", title: "Bookmarks", icon: "lucide-bookmark", file: "none" },
  webviewer: { plugin: "webviewer", title: "Web viewer", icon: "lucide-globe", file: "none", desktopOnly: true },
};

export interface StateContext {
  /** Note the view shows when `file=` is not given (the node's note, else this note). */
  defaultFile: string | null;
  /** Resolve a written linkpath to a vault path (null = not found). */
  resolveFile(linkpath: string): string | null;
  /** Local graph depth when `depth=` is not given. */
  defaultDepth: number;
}

export interface BuiltViewState {
  type: string;
  /** `setState` payload. */
  state: Record<string, unknown>;
  /** The note the view is bound to (pinned leaf), if any. */
  file: string | null;
  /** Graph options to apply to the graph engine (global graph: never saved). */
  graphOptions?: Record<string, unknown>;
  core: CoreViewInfo | null;
  /** Human-readable title for chrome and placeholders. */
  title: string;
}

export interface StateError {
  error: string;
}

const GRAPH_BOOLS: Record<string, string> = {
  tags: "showTags",
  attachments: "showAttachments",
  orphans: "showOrphans",
  arrows: "showArrow",
};

const LOCAL_BOOLS: Record<string, string> = {
  incoming: "localBacklinks",
  backlinks: "localBacklinks",
  outgoing: "localForelinks",
  forelinks: "localForelinks",
  neighbors: "localInterlinks",
  neighbours: "localInterlinks",
};

function clampInt(v: string | undefined, lo: number, hi: number, fallback: number): number {
  const n = v === undefined ? NaN : Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** Graph engine options from query keys (local and global graph). */
export function graphOptionsFrom(params: Record<string, string>, local: boolean, defaultDepth: number): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const search = params.search ?? params.filter ?? params.query;
  if (search !== undefined) o.search = search;
  for (const [k, opt] of Object.entries(GRAPH_BOOLS)) {
    const b = parseBool(params[k]);
    if (b !== undefined) o[opt] = b;
  }
  const unresolved = parseBool(params.unresolved);
  if (unresolved !== undefined) o.hideUnresolved = !unresolved;
  // The filter/display panel stays collapsed unless asked for.
  o["collapse-filter"] = !(parseBool(params.controls) ?? false);
  if (local) {
    o.localJumps = clampInt(params.depth ?? params.jumps, 1, 5, Math.min(5, Math.max(1, Math.round(defaultDepth) || 1)));
    for (const [k, opt] of Object.entries(LOCAL_BOOLS)) {
      const b = parseBool(params[k]);
      if (b !== undefined) o[opt] = b;
    }
  }
  return o;
}

function searchState(params: Record<string, string>, into: Record<string, unknown>): void {
  const q = params.search ?? params.filter;
  if (q !== undefined) {
    into.showSearch = true;
    into.searchQuery = q;
  }
}

/** Build the state for a `view:` spec; an error when a required note is missing. */
export function buildViewState(spec: ViewNodeSpec, ctx: StateContext): BuiltViewState | StateError {
  const core = CORE_VIEWS[spec.type] ?? null;
  const p = spec.params;
  const need: FileNeed = core ? core.file : p.file !== undefined ? "required" : "none";
  let file: string | null = null;
  if (need !== "none") {
    const written = p.file ?? p.note;
    if (written !== undefined && written.trim()) {
      const clean = written.trim().replace(/^\[\[|\]\]$/g, "");
      file = ctx.resolveFile(clean);
      if (!file) return { error: `Note not found: ${clean}` };
    } else {
      file = ctx.defaultFile;
      if (!file && need === "required") return { error: `${core?.title ?? spec.type} needs a note (file=…)` };
    }
  }
  const state: Record<string, unknown> = {};
  let graphOptions: Record<string, unknown> | undefined;
  switch (spec.type) {
    case "localgraph":
      graphOptions = graphOptionsFrom(p, true, ctx.defaultDepth);
      state.options = graphOptions;
      break;
    case "graph":
      graphOptions = graphOptionsFrom(p, false, ctx.defaultDepth);
      break;
    case "backlink": {
      const unlinked = parseBool(p.unlinked);
      if (unlinked !== undefined) state.unlinkedCollapsed = !unlinked;
      const ctxB = parseBool(p.context);
      if (ctxB !== undefined) state.extraContext = ctxB;
      const collapse = parseBool(p.collapse);
      if (collapse !== undefined) state.collapseAll = collapse;
      if (p.sort) state.sortOrder = p.sort;
      searchState(p, state);
      break;
    }
    case "outline":
    case "tag":
    case "file-explorer":
    case "bookmarks":
    case "all-properties":
      searchState(p, state);
      if (p.sort) state.sortOrder = p.sort;
      if (spec.type === "tag") {
        const h = parseBool(p.hierarchy);
        if (h !== undefined) state.useHierarchy = h;
      }
      break;
    case "search": {
      const q = p.query ?? p.search ?? p.q;
      if (q !== undefined) state.query = q;
      const c = parseBool(p.case);
      if (c !== undefined) state.matchingCase = c;
      const x = parseBool(p.context);
      if (x !== undefined) state.extraContext = x;
      const collapse = parseBool(p.collapse);
      if (collapse !== undefined) state.collapseAll = collapse;
      if (p.sort) state.sortOrder = p.sort;
      break;
    }
    case "webviewer":
      if (p.url) {
        state.url = p.url;
        state.navigate = true;
      }
      break;
    default:
      break;
  }
  // `state=` is the escape hatch: merged last, wins over the keys above, but
  // the keys the host acts on are checked first.
  if (spec.state) {
    const s = spec.state;
    if ("file" in s) {
      if (typeof s.file !== "string" || !s.file.trim()) return { error: "state.file must be a note name" };
      const clean = s.file.trim().replace(/^\[\[|\]\]$/g, "");
      file = ctx.resolveFile(clean);
      if (!file) return { error: `Note not found: ${clean}` };
    }
    if ("url" in s && typeof s.url !== "string") return { error: "state.url must be a string" };
    if ("options" in s && (!s.options || typeof s.options !== "object" || Array.isArray(s.options))) return { error: "state.options must be an object" };
  }
  if (file) state.file = file;
  if (spec.state) Object.assign(state, spec.state, file ? { file } : {});
  if (spec.type === "graph" && spec.state?.options && typeof spec.state.options === "object") {
    graphOptions = { ...(graphOptions ?? {}), ...(spec.state.options as Record<string, unknown>) };
    delete state.options;
  }
  const title = core?.title ?? spec.type;
  return {
    type: spec.type,
    state,
    file,
    ...(graphOptions ? { graphOptions } : {}),
    core,
    title,
  };
}

export function isStateError(v: BuiltViewState | StateError): v is StateError {
  return "error" in v && !("type" in v);
}
