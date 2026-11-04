/**
 * View-node syntax (pure, no Obsidian imports).
 *
 * A Mehrpele label that is a single embed can host a live view instead of a
 * note/Base: a web page, a PDF in Obsidian's native viewer, or any workspace
 * view (local graph, graph, backlinks, outline, … and community views):
 *
 *   A["![[https://example.com]]"]          web page (also `![](https://…)`)
 *   B["![[paper.pdf#page=3|480x600]]"]     PDF at a page
 *   C["![[view:localgraph?depth=2]]"]      local graph of this note
 *   D["![[view:graph?search=path:Projects tag:#x]]"]
 *   E["![[view:backlink?file=Some Note]]"]
 *   F["![[view:kanban?file=Board.md]]"]    any registered view type
 *   G["![[view:my-view?state={\"mode\":\"week\"}]]"]
 *
 * Query grammar after `view:<type>`: `?k=v&k=v…`. Values are taken
 * verbatim except percent escapes (`%26` &, `%3D` =, `%7C` |, `%5D` ],
 * `%25` %); a key without `=` is a flag (`true`). `state=` must come last
 * and takes the rest of the query (raw JSON, or percent-encoded JSON).
 * `#` may be written raw (Obsidian splits it off as a subpath; it is joined
 * back here). `|` starts the node size (`|WxH`), as for every embed.
 * Inside a quoted diagram label, `"` is written `\"` (label escaping).
 */
import { parseSoleEmbed, unescapeLabelMarkdown, type MehrpeleEmbedTarget } from "../model";
import { folderSpecFromEmbed, folderSpecFromParams, type FolderSpec } from "pele-render/canvas";

export interface WebNodeSpec {
  kind: "web";
  url: string;
}

export interface PdfNodeSpec {
  kind: "pdf";
  /** Linkpath as written (resolved against the note later). */
  file: string;
  /** `#page=3` etc., or "". */
  subpath: string;
}

export interface ViewNodeSpec {
  kind: "view";
  /** Canonical view type (aliases resolved), e.g. `localgraph`. */
  type: string;
  /** Query parameters (decoded), excluding `state`. */
  params: Record<string, string>;
  /** Parsed `state=` JSON object, if given. */
  state?: Record<string, unknown>;
}

/** A folder's files as an interactive Bases view (`![[Projects/]]`, `view:folder?path=…`). */
export interface FolderNodeSpec {
  kind: "folder";
  folder: FolderSpec;
}

export type NodeViewSpec = WebNodeSpec | PdfNodeSpec | ViewNodeSpec | FolderNodeSpec;

export interface SpecError {
  error: string;
}

export function isSpecError(v: NodeViewSpec | SpecError | null | undefined): v is SpecError {
  return !!v && "error" in v && !("kind" in v);
}

export const VIEW_PREFIX = "view:";

/** Friendly names → registered view types. */
export const VIEW_ALIASES: Record<string, string> = {
  local: "localgraph",
  "local-graph": "localgraph",
  localgraph: "localgraph",
  graph: "graph",
  "global-graph": "graph",
  backlinks: "backlink",
  backlink: "backlink",
  outgoing: "outgoing-link",
  outlinks: "outgoing-link",
  "outgoing-links": "outgoing-link",
  "outgoing-link": "outgoing-link",
  outline: "outline",
  tags: "tag",
  tag: "tag",
  files: "file-explorer",
  explorer: "file-explorer",
  "file-explorer": "file-explorer",
  search: "search",
  bookmarks: "bookmarks",
  properties: "file-properties",
  "file-properties": "file-properties",
  "all-properties": "all-properties",
  web: "webviewer",
  webviewer: "webviewer",
};

const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/\S+$/i;
const IMAGE_URL_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)(?:[?#].*)?$/i;

/** The embed target as written (`#…` was split off as a subpath; join it back). */
export function targetText(target: MehrpeleEmbedTarget): string {
  return `${target.linkpath}${target.subpath}`.trim();
}

/** `scheme://…` (any scheme; the renderer enforces the allowed ones). */
export function isUrlText(text: string): boolean {
  return URL_RE.test(text.trim());
}

/** Scheme of a URL (lower case, no colon), or null. */
export function urlScheme(text: string): string | null {
  const m = URL_RE.exec(text.trim());
  return m ? m[1].toLowerCase() : null;
}

/** A URL that points at an image (rendered as an image, never a web view). */
export function isImageUrl(text: string): boolean {
  return IMAGE_URL_RE.test(text.trim());
}

export function isPdfPath(linkpath: string): boolean {
  return /\.pdf$/i.test(linkpath.trim());
}

/** Labels this module renders as a live view (web, `view:`, `folder/`); PDFs are files. */
export function isViewTarget(target: MehrpeleEmbedTarget): boolean {
  const text = targetText(target);
  if (text.toLowerCase().startsWith(VIEW_PREFIX)) return true;
  if (target.linkpath.trim().endsWith("/")) return true;
  return isUrlText(text) && !isImageUrl(text);
}

/** Is this embed target one of ours (web, PDF or `view:`)? */
export function isNodeViewTarget(target: MehrpeleEmbedTarget): boolean {
  return isViewTarget(target) || isPdfPath(target.linkpath);
}

/** Percent-decode, keeping malformed escapes literally (never throws). */
export function safeDecode(s: string): string {
  return s.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** Encode the characters the query grammar reserves inside a value. */
export function encodeParamValue(v: string): string {
  return v.replace(/[%&=|\][\n]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** Parse `k=v&k&state=…` (see the module comment). */
export function parseQuery(query: string): { params: Record<string, string>; state?: string } {
  const params: Record<string, string> = {};
  let rest = query;
  let state: string | undefined;
  // `state=` takes the rest of the query (JSON may hold `&` and `=`).
  const si = /(^|&)state=/.exec(rest);
  if (si) {
    state = rest.slice(si.index + si[0].length);
    rest = rest.slice(0, si.index);
  }
  for (const part of rest.split("&")) {
    if (!part.trim()) continue;
    const eq = part.indexOf("=");
    const key = safeDecode((eq >= 0 ? part.slice(0, eq) : part).trim()).toLowerCase();
    if (!key) continue;
    params[key] = eq >= 0 ? safeDecode(part.slice(eq + 1)) : "true";
  }
  return state !== undefined ? { params, state } : { params };
}

/** Longest `state=` value accepted (view state is a few options, not data). */
const STATE_MAX_CHARS = 8192;
/** Keys that reach an object's prototype when merged with Object.assign. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Nesting depth is bounded by STATE_MAX_CHARS.
function forbiddenKey(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  for (const k of Object.keys(v)) {
    if (FORBIDDEN_KEYS.has(k)) return k;
    const inner = forbiddenKey((v as Record<string, unknown>)[k]);
    if (inner) return inner;
  }
  return null;
}

/** JSON object from a raw or percent-encoded `state=` value. */
export function parseStateJson(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw.length > STATE_MAX_CHARS) return { ok: false, error: "state= is too large" };
  const candidates = [raw, safeDecode(raw)];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c.trim()) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "state= must be a JSON object" };
      const bad = forbiddenKey(v);
      if (bad) return { ok: false, error: `state= can't set ${bad}` };
      return { ok: true, value: v as Record<string, unknown> };
    } catch {
      /* try the next form */
    }
  }
  return { ok: false, error: "state= is not valid JSON" };
}

/** Canonical view type for a written name (aliases, case-insensitive for core names). */
export function canonicalViewType(name: string): string {
  const n = name.trim();
  return VIEW_ALIASES[n.toLowerCase()] ?? n;
}

/** Parse `view:<type>?query` text. */
export function parseViewText(text: string): ViewNodeSpec | SpecError {
  const t = text.trim();
  if (!t.toLowerCase().startsWith(VIEW_PREFIX)) return { error: "not a view: target" };
  const body = t.slice(VIEW_PREFIX.length);
  const q = body.indexOf("?");
  const name = safeDecode(q >= 0 ? body.slice(0, q) : body).trim();
  if (!name) return { error: "view: needs a view type, e.g. view:localgraph" };
  if (!/^[\w.:-]+$/.test(name)) return { error: `"${name}" is not a valid view type` };
  const { params, state } = parseQuery(q >= 0 ? body.slice(q + 1) : "");
  const spec: ViewNodeSpec = { kind: "view", type: canonicalViewType(name), params };
  if (state !== undefined) {
    const parsed = parseStateJson(state);
    if (!parsed.ok) return { error: parsed.error };
    spec.state = parsed.value;
  }
  return spec;
}

/**
 * The view a sole-embed target asks for: null when the target is not ours
 * (notes, Bases, images, canvases …).
 */
export function parseNodeViewTarget(target: MehrpeleEmbedTarget): NodeViewSpec | SpecError | null {
  const text = targetText(target);
  if (text.toLowerCase().startsWith(VIEW_PREFIX)) {
    const v = parseViewText(text);
    if (!isSpecError(v) && v.type === "folder") {
      const f = folderSpecFromParams(v.params);
      return "error" in f ? { error: f.error } : { kind: "folder", folder: f };
    }
    return v;
  }
  const folder = folderSpecFromEmbed(target.linkpath, target.aliasOrSize);
  if (folder) return { kind: "folder", folder };
  if (isUrlText(text)) return isImageUrl(text) ? null : { kind: "web", url: text };
  if (isPdfPath(target.linkpath)) return { kind: "pdf", file: target.linkpath.trim(), subpath: target.subpath };
  return null;
}

/** Text form of a view spec (`view:type?k=v…`), the inverse of parseViewText. */
export function formatViewText(spec: ViewNodeSpec): string {
  const pairs = Object.keys(spec.params)
    .filter((k) => k !== "state")
    .map((k) => (spec.params[k] === "true" ? encodeParamValue(k) : `${encodeParamValue(k)}=${encodeParamValue(spec.params[k])}`));
  if (spec.state) pairs.push(`state=${JSON.stringify(spec.state)}`);
  return `${VIEW_PREFIX}${spec.type}${pairs.length ? `?${pairs.join("&")}` : ""}`;
}

/** Stable identity of a spec (live views are reused across re-renders by it; size excluded). */
export function viewSpecKey(spec: NodeViewSpec): string {
  switch (spec.kind) {
    case "web":
      return `web\u0000${spec.url}`;
    case "pdf":
      return `pdf\u0000${spec.file}\u0000${spec.subpath}`;
    case "folder":
      return `folder\u0000${spec.folder.path}\u0000${spec.folder.recursive}\u0000${spec.folder.view}`;
    default: {
      const keys = Object.keys(spec.params).sort();
      return `view\u0000${spec.type}\u0000${keys.map((k) => `${k}=${spec.params[k]}`).join("&")}\u0000${spec.state ? JSON.stringify(spec.state) : ""}`;
    }
  }
}

// -- `![](url)` web embeds -------------------------------------------------

const MD_EMBED_RE = /^!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^\s)]+)\s*\)$/;

/**
 * `![](https://…)` / `![Title|400x300](<https://…>)` as a sole label: a web
 * view target like `![[https://…]]`. Image URLs stay images (null).
 */
export function parseSoleWebEmbed(markdown: string): MehrpeleEmbedTarget | undefined {
  const m = MD_EMBED_RE.exec(markdown.trim());
  if (!m) return undefined;
  const url = m[2].replace(/^<|>$/g, "").trim();
  if (!isUrlText(url) || isImageUrl(url)) return undefined;
  const alt = m[1].trim();
  return alt ? { linkpath: url, subpath: "", aliasOrSize: alt } : { linkpath: url, subpath: "" };
}

const SIZE_SEG_RE = /^\d*(?:x\d+)?$/;

/**
 * Rewrite the size of a `![alt|WxH](url)` label (null size = remove it);
 * null when the label is not of that form (wikilink embeds use withEmbedSize).
 */
export function withWebEmbedSize(rawInner: string, size: { width: number; height?: number } | null): string | null {
  const m = /^(\s*)!\[([^\]\n]*)\]\((\s*(?:<[^>\n]+>|[^\s)]+)\s*)\)(\s*)$/.exec(rawInner);
  if (!m) return null;
  const parts = m[2] ? m[2].split("|") : [];
  if (parts.length && SIZE_SEG_RE.test(parts[parts.length - 1].trim()) && parts[parts.length - 1].trim()) parts.pop();
  if (size) {
    const w = Math.max(1, Math.round(size.width));
    parts.push(size.height !== undefined ? `${w}x${Math.max(1, Math.round(size.height))}` : `${w}`);
  }
  return `${m[1]}![${parts.join("|")}](${m[3]})${m[4]}`;
}

// -- helpers ---------------------------------------------------------------

/** Boolean query value: 1/true/yes/on, 0/false/no/off; undefined otherwise. */
export function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on", ""].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined;
}

/** First wikilink / note embed target in label Markdown (the node's linked note). */
export function linkedNoteOf(markdown: string): string | null {
  const m = /!?\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/.exec(markdown);
  if (m) {
    const target = m[1].trim();
    if (target && !isUrlText(target) && !target.toLowerCase().startsWith(VIEW_PREFIX)) {
      const base = target.slice(target.lastIndexOf("/") + 1);
      // Notes only (no extension or .md): images/PDFs/Bases are not "the node's note".
      if (/\.md$/i.test(base) || !base.includes(".")) return target;
    }
  }
  return null;
}

/**
 * A raw quoted node label (as written in the block) that is a view node:
 * `"![[https://…]]"`, `"![[x.pdf…]]"`, `"![[view:…]]"`. The Markdown form
 * `![…](https://…)` is decided at render time (it may be an image) and is
 * not counted here. `isFolder` recognises `![[Projects]]` naming a folder
 * (needs the vault).
 */
export function isViewNodeLabel(raw: string | null | undefined, isFolder?: (target: MehrpeleEmbedTarget) => boolean): boolean {
  const t = raw?.trim();
  if (!t || !t.startsWith('"') || !t.endsWith('"') || t.length < 2) return false;
  const target = parseSoleEmbed(unescapeLabelMarkdown(t.slice(1, -1)));
  return !!target && (isNodeViewTarget(target) || !!isFolder?.(target));
}
