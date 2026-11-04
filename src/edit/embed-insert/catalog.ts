/**
 * Insert-embed catalogue (pure): what the popover offers, grouped as it is
 * laid out, and the Mehrpele label syntax each choice produces.
 *
 * Sole-embed kinds (views, canvases, bases, folders, web pages, PDFs,
 * images) replace the label — an embed node is the embed. Content kinds
 * (callout, table, LaTeX, nested mermaid, wikilink) are added to the label's
 * text (or replace a placeholder such as "New") and open the inline editor.
 */
import { formatFolderEmbed } from "pele-render/canvas";
import { encodeParamValue } from "../../mehrpele/views/syntax";

export type GroupId = "views" | "content" | "media";

export type ItemId =
  | "graph" | "canvas" | "base" | "folder"
  | "callout" | "table" | "latex" | "mermaid"
  | "webpage" | "pdf" | "image" | "wikilink";

export interface CatalogItem {
  id: ItemId;
  group: GroupId;
  icon: string;
  label: string;
  /** Has a row of sub-choices (graph views, base view types, folder depth). */
  sub?: boolean;
}

/** The groups, in order; each has its own toolbar button (icon + tooltip). */
export const GROUPS: { id: GroupId; label: string; icon: string; button: string }[] = [
  { id: "views", label: "Views", icon: "app-window", button: "Insert view" },
  { id: "content", label: "Content", icon: "pilcrow", button: "Insert content" },
  { id: "media", label: "Media & links", icon: "paperclip", button: "Insert media or link" },
];

export const ITEMS: CatalogItem[] = [
  { id: "graph", group: "views", icon: "git-fork", label: "Graph or other view", sub: true },
  { id: "canvas", group: "views", icon: "layout-dashboard", label: "Canvas" },
  { id: "base", group: "views", icon: "database", label: "Base", sub: true },
  { id: "folder", group: "views", icon: "folder-open", label: "Folder (files as a base)", sub: true },
  { id: "callout", group: "content", icon: "message-square-quote", label: "Callout" },
  { id: "table", group: "content", icon: "table-2", label: "Table" },
  { id: "latex", group: "content", icon: "sigma", label: "LaTeX" },
  { id: "mermaid", group: "content", icon: "workflow", label: "Mermaid (nested diagram)" },
  { id: "webpage", group: "media", icon: "globe", label: "Web page" },
  { id: "pdf", group: "media", icon: "file-text", label: "PDF" },
  { id: "image", group: "media", icon: "image", label: "Image" },
  { id: "wikilink", group: "media", icon: "link", label: "Wikilink" },
];

/** What a popover shows: one group's items (a toolbar group button), or every group. */
export function groupsFor(group?: GroupId): { id: GroupId; label: string; items: CatalogItem[] }[] {
  return GROUPS.filter((g) => !group || g.id === group).map((g) => ({ id: g.id, label: g.label, items: ITEMS.filter((i) => i.group === g.id) }));
}

export interface SubItem {
  id: string;
  icon: string;
  label: string;
}

/** Graph sub-choices: local graph, a filtered graph, linked panes, any view type. */
export const GRAPH_SUBS: SubItem[] = [
  { id: "localgraph", icon: "git-fork", label: "Local graph of this note" },
  { id: "graph", icon: "filter", label: "Graph, filtered by a search" },
  { id: "backlink", icon: "links-coming-in", label: "Backlinks" },
  { id: "outline", icon: "list", label: "Outline" },
  { id: "other", icon: "layout-panel-top", label: "Another view type…" },
];

export const FOLDER_SUBS: SubItem[] = [
  { id: "direct", icon: "folder", label: "Folder" },
  { id: "recursive", icon: "folder-tree", label: "Folder with subfolders" },
];

/** Base sub-choices from the Bases view types available (`registrations`). */
export function baseSubs(available: { type: string; name: string; icon?: string }[]): SubItem[] {
  const pick = ["table", "cards", "list", "kanban", "base-graph", "mehrpele-diagram"];
  const icons: Record<string, string> = { table: "table", cards: "layout-grid", list: "list", kanban: "kanban-square", "base-graph": "git-fork", "mehrpele-diagram": "workflow" };
  const subs: SubItem[] = [{ id: "any", icon: "database", label: "Any base (its first view)" }];
  for (const t of pick) {
    const a = available.find((v) => v.type === t);
    if (a) subs.push({ id: t, icon: icons[t] ?? (a.icon ?? "database").replace(/^lucide-/, ""), label: `${a.name} view of a base` });
  }
  return subs;
}

export const CALLOUT_TYPES = ["note", "abstract", "info", "todo", "tip", "success", "question", "warning", "failure", "danger", "bug", "example", "quote"] as const;

// -- builders ----------------------------------------------------------------------

/** `![[target]]` (sole embed of a file, folder or view). */
export function embedOf(linktext: string): string {
  return `![[${linktext}]]`;
}

export function wikilinkOf(linktext: string): string {
  return `[[${linktext}]]`;
}

/** A web page node: `![[https://…]]` (Markdown form when the URL holds `|` or `]`); null when not http(s). */
export function webEmbedOf(input: string): string | null {
  let url = input.trim();
  if (!url) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && /^[\w-]+(\.[\w-]+)+([/?#:]|$)/.test(url)) url = `https://${url}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  // As typed, unless it holds what neither form can carry (spaces, `<` `>`): then the encoded URL.
  const out = /[\s<>"`]/.test(url) ? parsed.href : url;
  return /[|\]]/.test(out) ? `![](<${out}>)` : `![[${out}]]`;
}

export function localGraphOf(depth: number): string {
  return `![[view:localgraph?depth=${Math.min(5, Math.max(1, Math.round(depth) || 1))}]]`;
}

export function filteredGraphOf(search: string): string {
  const q = search.trim();
  return q ? `![[view:graph?search=${encodeParamValue(q)}]]` : "![[view:graph]]";
}

export function viewOf(type: string, params: Record<string, string> = {}): string {
  const qs = Object.entries(params).map(([k, v]) => `${encodeParamValue(k)}=${encodeParamValue(v)}`).join("&");
  return `![[view:${type}${qs ? `?${qs}` : ""}]]`;
}

/** A base embed at a named view (`![[x.base#Kanban]]`). */
export function baseViewOf(linktext: string, viewName?: string): string {
  return viewName ? `![[${linktext}#${viewName}]]` : `![[${linktext}]]`;
}

export function folderEmbedOf(path: string, recursive: boolean): string {
  return formatFolderEmbed({ path, recursive, view: "table" });
}

export function calloutOf(type: string): string {
  return `> [!${type}] ${type[0].toUpperCase()}${type.slice(1)}\n> Text`;
}

export function tableOf(cols = 2, rows = 1): string {
  const head = `| ${Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(" | ")} |`;
  const sep = `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`;
  const body = Array.from({ length: rows }, () => `| ${Array.from({ length: cols }, () => " ").join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

export const LATEX_STUB = "$x^2$";
export const MERMAID_STUB = "~~~mermaid\nflowchart LR\n  A --> B\n~~~";

/** How a choice lands in the label. */
export type Placement = "replace" | "block" | "inline";

export function placementOf(id: ItemId): Placement {
  // A nested diagram is the node's one element (a sole fence nests; text beside it would not).
  if (id === "callout" || id === "table") return "block";
  if (id === "latex" || id === "wikilink") return "inline";
  return "replace";
}

/** Text worth keeping in a label (not a fresh node's placeholder or its bare id). */
export function isPlaceholder(text: string, nodeId?: string): boolean {
  const t = text.trim();
  return !t || t === "New" || (nodeId !== undefined && t === nodeId);
}

/** The label after inserting `inserted` into `current`. */
export function combineLabel(current: string, inserted: string, placement: Placement, nodeId?: string): string {
  if (placement === "replace" || isPlaceholder(current, nodeId)) return inserted;
  const base = current.replace(/\s+$/, "");
  return placement === "block" ? `${base}\n\n${inserted}` : `${base} ${inserted}`;
}

/** Whether the inline editor should open after the insert (text to fill in). */
export function editsAfter(id: ItemId): boolean {
  return id === "callout" || id === "table" || id === "latex" || id === "mermaid";
}
