/**
 * Code-block option parsing (DOM-free).
 *
 * Blocks accept a small YAML/key-value subset so tests need no YAML library:
 * `key: value`, `key=value`, inline lists `[a, b]`, comma lists `a, b`,
 * quoted strings, booleans (`true/false/yes/no/on/off`) and numbers.
 * Unknown keys are preserved in `extra` and otherwise ignored.
 */

export type RawOptions = Record<string, string | string[]>;

/** Strip a trailing ` #comment` only outside single/double quotes. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && (inSingle || inDouble)) {
      i++;
      continue;
    }
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble && i > 0 && /\s/.test(line[i - 1])) {
      return line.slice(0, i);
    }
  }
  return line;
}

export function parseKeyValueOptions(source: string): RawOptions {
  const out: RawOptions = {};
  let currentListKey: string | null = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripComment(rawLine).trimEnd();
    if (!line.trim() || line.trim().startsWith("#") || line.trim() === "---") continue;
    const listItem = /^\s*-\s+(.*)$/.exec(rawLine);
    if (listItem && currentListKey) {
      const value = unquote(listItem[1].trim());
      const prev = out[currentListKey];
      out[currentListKey] = Array.isArray(prev) ? [...prev, value] : [value];
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (value === "") {
      currentListKey = key;
      out[key] = [];
      continue;
    }
    currentListKey = null;
    out[key] = parseValue(value);
  }
  // A key left with an empty list and no items means "present but empty".
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (Array.isArray(v) && v.length === 0) out[key] = "";
  }
  return out;
}

function parseValue(value: string): string | string[] {
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => unquote(s.trim())).filter((s) => s !== "");
  }
  return unquote(value);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function optString(raw: RawOptions, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = raw[key.toLowerCase()];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (Array.isArray(v) && v.length > 0) return v.join(", ");
  }
  return undefined;
}

export function optList(raw: RawOptions, ...keys: string[]): string[] {
  for (const key of keys) {
    const v = raw[key.toLowerCase()];
    if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
    if (typeof v === "string" && v.trim() !== "") {
      return v.split(",").map((s) => unquote(s.trim())).filter(Boolean);
    }
  }
  return [];
}

export function optBool(raw: RawOptions, key: string, fallback: boolean): boolean {
  const v = raw[key.toLowerCase()];
  if (typeof v !== "string") return fallback;
  const t = v.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(t)) return true;
  if (["false", "no", "off", "0"].includes(t)) return false;
  return fallback;
}

export function optInt(
  raw: RawOptions,
  keys: string | string[],
  fallback: number,
  min: number,
  max: number,
): number {
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const v = raw[key.toLowerCase()];
    if (typeof v !== "string" || v.trim() === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    return Math.max(min, Math.min(Math.floor(n), max));
  }
  return fallback;
}

// -- Breadcrumbs ---------------------------------------------------------

export interface BreadcrumbsOptions {
  /** Start note path/linktext; undefined = current note. */
  start?: string;
  /** Edge fields to follow; empty = all fields. */
  fields: string[];
  depth: number;
  direction: "TD" | "TB" | "LR" | "RL" | "BT";
  implied: boolean;
  mehrpele: boolean;
  maxNodes: number;
}

export const DEFAULT_BREADCRUMBS_OPTIONS: BreadcrumbsOptions = {
  fields: [],
  depth: 2,
  direction: "LR",
  implied: false,
  mehrpele: false,
  maxNodes: 200,
};

export function parseBreadcrumbsOptions(source: string): BreadcrumbsOptions {
  const raw = parseKeyValueOptions(source);
  const directionRaw = (optString(raw, "direction") ?? "LR").toUpperCase();
  const direction = (["TD", "TB", "LR", "RL", "BT"].includes(directionRaw)
    ? directionRaw
    : "LR") as BreadcrumbsOptions["direction"];
  return {
    start: optString(raw, "start", "start-note", "from"),
    fields: optList(raw, "fields", "field"),
    depth: optInt(raw, "depth", DEFAULT_BREADCRUMBS_OPTIONS.depth, 0, 10),
    direction,
    implied: optBool(raw, "implied", DEFAULT_BREADCRUMBS_OPTIONS.implied),
    mehrpele: optBool(raw, "mehrpele", DEFAULT_BREADCRUMBS_OPTIONS.mehrpele),
    maxNodes: optInt(raw, ["maxnodes", "max-nodes", "limit"], DEFAULT_BREADCRUMBS_OPTIONS.maxNodes, 1, 1000),
  };
}

// -- Datacore -------------------------------------------------------

export interface DatacoreBlockOptions {
  query: string;
  diagram: "flowchart" | "gantt";
  title?: string;
  maxNodes: number;
}

export const DEFAULT_DATACORE_BLOCK_OPTIONS: DatacoreBlockOptions = {
  query: "@page",
  diagram: "flowchart",
  maxNodes: 200,
};

export function parseDatacoreOptions(source: string): DatacoreBlockOptions {
  const raw = parseKeyValueOptions(source);
  const diagramRaw = (optString(raw, "diagram", "view") ?? "flowchart").toLowerCase();
  return {
    query: optString(raw, "query") ?? DEFAULT_DATACORE_BLOCK_OPTIONS.query,
    diagram: diagramRaw === "gantt" ? "gantt" : "flowchart",
    title: optString(raw, "title"),
    maxNodes: optInt(raw, ["maxnodes", "max-nodes", "limit"], DEFAULT_DATACORE_BLOCK_OPTIONS.maxNodes, 1, 1000),
  };
}

// -- TaskNotes --------------------------------------------------------------

export type TaskView = "gantt" | "dependencies" | "kanban";

export interface TaskBlockOptions {
  view: TaskView;
  status?: string[];
  tags: string[];
  project?: string;
  group?: string;
  maxNodes: number;
}

export const DEFAULT_TASK_BLOCK_OPTIONS: TaskBlockOptions = {
  view: "gantt",
  tags: [],
  maxNodes: 200,
};

export function parseTaskOptions(source: string): TaskBlockOptions {
  const raw = parseKeyValueOptions(source);
  const viewRaw = (optString(raw, "view") ?? "gantt").toLowerCase();
  const view: TaskView = viewRaw === "dependencies" || viewRaw === "kanban" ? viewRaw : "gantt";
  // `filter` may carry `status: x, tags: y` style fragments; keep it simple:
  // explicit keys win, a bare filter string is treated as a status filter.
  const filterStatus = optString(raw, "filter");
  const statuses = optList(raw, "status", "statuses");
  return {
    view,
    status: statuses.length > 0 ? statuses : filterStatus ? [filterStatus] : undefined,
    tags: optList(raw, "tags", "tag"),
    project: optString(raw, "project", "projects"),
    group: optString(raw, "group", "group-by", "groupby"),
    maxNodes: optInt(raw, ["maxnodes", "max-nodes", "limit"], DEFAULT_TASK_BLOCK_OPTIONS.maxNodes, 1, 1000),
  };
}
