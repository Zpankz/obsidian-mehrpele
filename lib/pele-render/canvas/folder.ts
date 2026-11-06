/**
 * Folder embeds (pele-mermaid view nodes): `A["![[Projects/]]"]` shows the
 * folder's files as an interactive Bases view. The base is generated, never
 * written: an inline `base` code block with a folder filter, default columns
 * (name, modified, tags) and one view per available view type (table, cards,
 * list, kanban when installed), the chosen one first. Pure; shared by the
 * plugin (rendering, "Save as .base") and canvas conversion (a text card
 * holding the same block, so Canvas shows the same live view).
 *
 * Forms: `![[Projects/]]`, `![[Projects/|recursive|cards]]` (alias tokens:
 * `recursive`, a view type), `![[view:folder?path=Projects&recursive=1&view=cards]]`.
 * A `![[Projects]]` that resolves to a folder (vault lookup, plugin only) is
 * one too.
 */

export interface FolderSpec {
  /** Vault-relative folder path, no leading/trailing slash ("" = vault root). */
  path: string;
  /** Include subfolders. */
  recursive: boolean;
  /** View shown first: table | cards | list | kanban | another Bases view type. */
  view: string;
}

export const FOLDER_VIEW_TYPES = ["table", "cards", "list", "kanban"] as const;

const VIEW_NAMES: Record<string, string> = { table: "Table", cards: "Cards", list: "List", kanban: "Kanban" };

export function normalizeFolderPath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && ["", "1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

/** View types an alias token may name (others are aliases or sizes and are ignored). */
export const FOLDER_TOKEN_VIEWS: readonly string[] = [...FOLDER_VIEW_TYPES, "base-graph", "mehrpele-diagram"];

/**
 * Apply `|recursive|cards|640x400` alias tokens to a spec: `recursive` (or
 * `subfolders`) and a known view type; sizes and any other alias text are
 * ignored, so they never change which view is shown.
 */
export function applyFolderTokens(spec: FolderSpec, aliasOrSize: string | undefined, views: readonly string[] = FOLDER_TOKEN_VIEWS): FolderSpec {
  const known = new Map(views.map((v) => [v.toLowerCase(), v]));
  for (const raw of (aliasOrSize ?? "").split("|")) {
    const t = raw.trim().toLowerCase();
    const view = known.get(t);
    if (t === "recursive" || t === "subfolders") spec.recursive = true;
    else if (view !== undefined) spec.view = view;
  }
  return spec;
}

/** Folder spec from `![[Projects/|…]]` (linkpath ends with `/`), else null. */
export function folderSpecFromEmbed(linkpath: string, aliasOrSize?: string): FolderSpec | null {
  const lp = linkpath.trim();
  if (!lp.endsWith("/")) return null;
  return applyFolderTokens({ path: normalizeFolderPath(lp), recursive: false, view: "table" }, aliasOrSize);
}

/** Folder spec from `view:folder` query params (`path`, `recursive`, `view`). */
export function folderSpecFromParams(params: Record<string, string>): FolderSpec | { error: string } {
  const path = params.path ?? params.folder;
  if (path === undefined) return { error: "view:folder needs path=…" };
  const view = (params.view ?? "table").trim().toLowerCase();
  return { path: normalizeFolderPath(path), recursive: truthy(params.recursive), view: /^[\w-]+$/.test(view) ? view : "table" };
}

/** The label for a spec (the short `![[folder/]]` form). */
export function formatFolderEmbed(spec: FolderSpec, size?: string): string {
  // A path a wikilink cannot carry (`#` `^` start a subpath, `|` `[` `]` end the target) uses the long form.
  if (/[#^|[\]%]/.test(spec.path)) {
    const enc = (v: string): string => v.replace(/[%&=|\][#^\n]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
    const params = [`path=${enc(spec.path)}`, spec.recursive ? "recursive=1" : "", spec.view !== "table" ? `view=${enc(spec.view)}` : ""].filter(Boolean);
    return `![[view:folder?${params.join("&")}${size ? `|${size}` : ""}]]`;
  }
  const tokens = [spec.recursive ? "recursive" : "", spec.view !== "table" ? spec.view : "", size ?? ""].filter(Boolean);
  return `![[${spec.path ? `${spec.path}/` : "/"}${tokens.length ? `|${tokens.join("|")}` : ""}]]`;
}

const q = (s: string): string => JSON.stringify(s);

/**
 * The base definition (YAML) for a folder. `viewTypes` = the Bases view
 * types available (unknown ones are dropped; table always works).
 */
export function folderBaseYaml(spec: FolderSpec, viewTypes: readonly string[] = ["table", "cards", "list"]): string {
  const available = new Set(viewTypes);
  available.add("table");
  const types = FOLDER_VIEW_TYPES.filter((t) => available.has(t)) as string[];
  if (available.has(spec.view) && !types.includes(spec.view)) types.push(spec.view);
  const first = available.has(spec.view) ? spec.view : "table";
  const ordered = [first, ...types.filter((t) => t !== first)];
  const filter = spec.path
    ? spec.recursive
      ? `file.inFolder(${q(spec.path)})`
      : `file.folder == ${q(spec.path)}`
    : spec.recursive
      ? null
      : `file.folder == "/"`;
  const lines: string[] = [];
  if (filter) lines.push("filters:", "  and:", `    - ${q(filter)}`);
  lines.push("views:");
  for (const t of ordered) {
    lines.push(`  - type: ${t}`, `    name: ${VIEW_NAMES[t] ?? t}`);
    if (t === "table") lines.push("    order:", "      - file.name", "      - file.mtime", "      - file.tags", "    sort:", "      - property: file.mtime", "        direction: DESC");
    else if (t === "cards") lines.push("    order:", "      - file.name", "      - file.tags");
    else if (t === "list") lines.push("    order:", "      - file.name", "      - file.mtime");
    else if (t === "kanban") lines.push("    order:", "      - file.name");
  }
  return lines.join("\n");
}

/** The inline base block (a ```base fence) for a folder. */
export function folderBaseBlock(spec: FolderSpec, viewTypes?: readonly string[]): string {
  return "```base\n" + folderBaseYaml(spec, viewTypes) + "\n```";
}

/** Folder spec from a whole label (`![[x/…]]` or `![[view:folder?…]]`), else null. */
export function parseFolderLabel(label: string): FolderSpec | null {
  const m = /^!\[\[([^[\]\n]+)\]\]$/.exec(label.trim());
  if (!m) return null;
  const [target = "", ...rest] = m[1].split("|");
  const t = target.trim();
  if (/^view:folder(\?|$)/i.test(t)) {
    const query = t.slice(t.indexOf("?") + 1);
    const params: Record<string, string> = {};
    if (t.includes("?")) {
      for (const part of query.split("&")) {
        const eq = part.indexOf("=");
        const k = safeDecode((eq >= 0 ? part.slice(0, eq) : part).trim()).toLowerCase();
        if (k) params[k] = eq >= 0 ? safeDecode(part.slice(eq + 1)) : "true";
      }
    }
    const s = folderSpecFromParams(params);
    return "error" in s ? null : s;
  }
  // `#` / `^` start a subpath in a wikilink: the plugin reads `![[C# notes/]]` as a link to "C", so do we.
  if (/[#^]/.test(t)) return null;
  return folderSpecFromEmbed(t, rest.join("|") || undefined);
}

/** Percent-decode run by run (as the plugin's view: query does); malformed runs stay as written. */
function safeDecode(s: string): string {
  return s.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}
