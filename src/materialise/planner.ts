/**
 * Materialise planner: diagram graph + vault lookups + options → a plan of
 * folders, notes, property writes and the rewritten block. Pure and
 * deterministic; it never writes. See docs/materialise.md (DESIGN).
 */
import { markdownToFallback, parseSoleEmbed } from "../mehrpele/model";
import { diagramGraph, type DiagramGraph, type GraphNode } from "./graph";
import { rewriteBlock } from "./rewrite";
import {
  DEFAULT_EDGE_KEY, NODE_KEY, PROVENANCE_KEY,
  type KeyStyle, type MaterialisePlan,
  type PlannedFolder, type PlannedNote, type PlanInput, type PlanResult, type PropertyLink, type PropertyWrite, type VaultView,
} from "./plan";

export * from "./plan";

// -- names ---------------------------------------------------------------------

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME = 120;

/** A filename-safe title (no extension) for a label, per Obsidian's and the OS's rules. */
export function safeName(text: string, fallback = "Untitled"): string {
  let s = text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/[^\P{Cc}\u0080-\u009f]/gu, " ") // C0 controls and DEL (Cc minus the C1 range)
    .replace(/[\\/:]/g, "-")
    .replace(/[*"<>|?#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim();
  if ([...s].length > MAX_NAME) s = [...s].slice(0, MAX_NAME).join("").replace(/[. ]+$/, "").trim();
  if (WINDOWS_RESERVED.test(s)) s += "_";
  if (!s) return fallback === "Untitled" ? fallback : safeName(fallback);
  return s;
}

/** Plain text of a label (Markdown stripped, line breaks as spaces). */
export function plainLabel(markdown: string): string {
  return markdownToFallback(markdown.replace(/<br\s*\/?>/gi, " ").replace(/\n+/g, " ")).replace(/\s+/g, " ").trim();
}

const RESERVED_KEYS = new Set(["tags", "tag", "aliases", "alias", "cssclasses", "cssclass", "publish", "permalink", PROVENANCE_KEY, NODE_KEY]);

/** Frontmatter key for an edge label (`defaultKey` when unlabelled or empty). */
export function propertyKey(label: string, style: KeyStyle, defaultKey: string): string {
  const fallbackKey = defaultKey.trim() || DEFAULT_EDGE_KEY;
  const plain = plainLabel(label);
  let key =
    style === "slug"
      ? plain.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}_]+/gu, "-").replace(/^-+|-+$/g, "")
      : plain.replace(/:/g, " ").replace(/\s+/g, " ").trim();
  if (!key) key = fallbackKey;
  if (RESERVED_KEYS.has(key.toLowerCase())) key = `${key}-link`;
  return key;
}

/** Vault path without the `.md` extension (the linktext used in links and embeds). */
export function linktextOf(path: string): string {
  return path.replace(/\.md$/i, "");
}

function join(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

/** Normalise a root folder: vault-relative, no `.`/`..`, no surrounding slashes. */
export function normaliseRoot(raw: string): string {
  return raw
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
}

/** Expand `{{folder}}` / `{{note}}` in the root setting for a source note. */
export function expandRoot(template: string, notePath: string): string {
  const slash = notePath.lastIndexOf("/");
  const folder = slash >= 0 ? notePath.slice(0, slash) : "";
  const note = (slash >= 0 ? notePath.slice(slash + 1) : notePath).replace(/\.md$/i, "");
  return normaliseRoot((template.trim() || "{{folder}}/{{note}}").replace(/\{\{\s*folder\s*\}\}/g, folder).replace(/\{\{\s*note\s*\}\}/g, note));
}

// -- links and properties --------------------------------------------------------

const WIKILINK_RE = /^\s*!?\[\[([^\]]+)\]\]\s*$/;

/** Normalised identity of a link target: resolved path when known, else the linkpath. */
export function targetKey(value: unknown, sourcePath: string, resolve: VaultView["resolve"]): string | null {
  if (typeof value !== "string") return null;
  const m = WIKILINK_RE.exec(value);
  const inner = m ? m[1] : value.trim();
  const linkpath = inner.split("|")[0].split("#")[0].trim();
  if (!linkpath) return null;
  const resolved = resolve(linkpath, sourcePath);
  return (resolved ?? linkpath).replace(/\.md$/i, "").toLowerCase();
}

/**
 * Merge links into an existing property value: absent → the link (one) or a
 * list; a scalar link → a list; a list → appended. Links already present (by
 * target) are not repeated. Returns `undefined` when the value can't hold
 * links (a number, object or non-link text) — the write is then skipped.
 */
export function mergeLinks(
  before: unknown,
  add: readonly PropertyLink[],
  sourcePath: string,
  resolve: VaultView["resolve"],
): { value: unknown; changed: boolean } | undefined {
  const isEmpty = before === undefined || before === null || before === "" || (Array.isArray(before) && before.length === 0);
  const existing: unknown[] = isEmpty ? [] : Array.isArray(before) ? [...(before as unknown[])] : [before];
  if (existing.some((v) => typeof v !== "string")) return undefined;
  if (!Array.isArray(before) && !isEmpty && targetKey(before, sourcePath, resolve) === null) return undefined;
  const seen = new Set(existing.map((v) => targetKey(v, sourcePath, resolve)).filter((k): k is string => !!k));
  const fresh: string[] = [];
  for (const l of add) {
    if (seen.has(l.target)) continue;
    seen.add(l.target);
    fresh.push(l.link);
  }
  if (!fresh.length) return { value: before, changed: false };
  const all = [...existing, ...fresh];
  return { value: all.length === 1 && !Array.isArray(before) ? all[0] : all, changed: true };
}

// -- YAML ---------------------------------------------------------------------

function yamlKey(key: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_ -]*$/.test(key) && !/ $/.test(key) ? key : JSON.stringify(key);
}

/** Frontmatter block for string / string-list values (double-quoted, JSON-escaped scalars are valid YAML). */
export function yamlFrontmatter(fm: Record<string, string | string[]>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      lines.push(`${yamlKey(k)}:`);
      for (const item of v) lines.push(`  - ${JSON.stringify(item)}`);
    } else lines.push(`${yamlKey(k)}: ${JSON.stringify(v)}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

// -- planning -------------------------------------------------------------------

const SOLE_LINK_RE = /^\s*\[\[([^\]]+)\]\]\s*$/;

/** Sole embed `![[X]]` or wikilink `[[X]]` label: link path plus display text. */
function soleLink(label: string): { linkpath: string; display: string; embed: boolean } | null {
  const e = parseSoleEmbed(label);
  if (e) {
    const alias = e.aliasOrSize && !/^\d*(x\d+)?$/.test(e.aliasOrSize) ? e.aliasOrSize : "";
    return { linkpath: e.linkpath, display: alias || e.linkpath.split("/").pop()!, embed: true };
  }
  const m = SOLE_LINK_RE.exec(label);
  if (!m) return null;
  const [target, alias] = m[1].split("|");
  const linkpath = target.split("#")[0].trim();
  return linkpath ? { linkpath, display: (alias ?? "").trim() || linkpath.split("/").pop()!, embed: false } : null;
}

function isOurs(fm: Record<string, unknown> | null, blockId: string, nodeId: string): boolean {
  if (!fm) return false;
  const prov = fm[PROVENANCE_KEY];
  const m = typeof prov === "string" ? /#\^([A-Za-z0-9-]+)\]\]\s*$/.exec(prov) : null;
  return !!m && m[1] === blockId && scalarText(fm[NODE_KEY]) === nodeId;
}

/**
 * Text of a frontmatter scalar: strings as is, numbers/booleans as YAML
 * would show them (a node id like `1` parses back as a number), else "".
 */
export function scalarText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return "";
}

function sameLower(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Plan from a graph (see planFromSource for the whole pipeline). */
export function planMaterialise(graph: DiagramGraph, input: PlanInput): MaterialisePlan {
  const { vault, options, notePath, blockId } = input;
  const root = normaliseRoot(options.root);
  const provenance = `[[${linktextOf(notePath)}#^${blockId}]]`;
  const warnings: string[] = [];

  // Folders: groups → nested folders under the root, sibling names unique.
  const groupById = new Map(graph.groups.map((g) => [g.id, g]));
  const folderOf = new Map<string, string>();
  const folders: PlannedFolder[] = [];
  const claimedFolders = new Set<string>();
  const folderPath = (id: string, depth = 0): string => {
    const known = folderOf.get(id);
    if (known !== undefined) return known;
    const g = groupById.get(id)!;
    const parentId = g.parentId && groupById.has(g.parentId) && depth < 64 ? g.parentId : undefined;
    const parent = parentId ? folderPath(parentId, depth + 1) : root;
    const base = safeName(plainLabel(g.title), g.id);
    let path = "";
    for (let n = 1; ; n++) {
      path = join(parent, n === 1 ? base : `${base} ${n}`);
      if (claimedFolders.has(path.toLowerCase())) continue;
      const hit = vault.lookup(path);
      if (hit && hit.kind !== "folder") continue; // a file without extension: never shadow it
      break;
    }
    claimedFolders.add(path.toLowerCase());
    folderOf.set(id, path);
    folders.push({ path, groupId: id, status: vault.lookup(path)?.kind === "folder" ? "exists" : "create" });
    return path;
  };
  for (const g of graph.groups) folderPath(g.id);
  // Parents of the root and the root itself are created as needed (status from the vault).
  const rootFolders: PlannedFolder[] = [];
  if (root) {
    const parts = root.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      const hit = vault.lookup(p);
      if (hit && hit.kind !== "folder") {
        return {
          type: graph.type, notePath, blockId, provenance, root, folders: [], notes: [], properties: [], rewrite: null,
          warnings: [`Root folder ${p} is a file; choose another root.`], empty: true,
        };
      }
      rootFolders.push({ path: p, groupId: "", status: hit ? "exists" : "create" });
    }
  }

  // Notes.
  const claimed = new Set<string>();
  const notes: PlannedNote[] = [];
  const noteByNode = new Map<string, PlannedNote>();
  const hitBase = (folder: string, title: string): boolean => vault.lookup(join(folder, `${title}.md`))?.kind === "note";
  const planNode = (node: GraphNode): PlannedNote => {
    const folder = node.groupId && folderOf.has(node.groupId) ? folderOf.get(node.groupId)! : root;
    const link = soleLink(node.label);
    let title = safeName(plainLabel(node.label), node.id);
    if (link) {
      const resolved = vault.resolve(link.linkpath, notePath);
      if (resolved) {
        const hit = vault.lookup(resolved);
        if (!/\.md$/i.test(resolved)) return { nodeId: node.id, label: node.label, path: resolved, action: "media", reason: "embeds a file that is not a note; left as is" };
        claimed.add(resolved.toLowerCase());
        if (hit?.kind === "note" && isOurs(hit.frontmatter, blockId, node.id)) return { nodeId: node.id, label: node.label, path: resolved, action: "reuse", reason: "already materialised" };
        return { nodeId: node.id, label: node.label, path: resolved, action: "link", reason: link.embed ? "already embeds this note" : "links this note" };
      }
      title = safeName(link.display, node.id);
    }
    for (let n = 1; ; n++) {
      const path = join(folder, `${n === 1 ? title : `${title} ${n}`}.md`);
      if (claimed.has(path.toLowerCase())) continue;
      const hit = vault.lookup(path);
      if (!hit) {
        claimed.add(path.toLowerCase());
        return { nodeId: node.id, label: node.label, path, action: "create", ...(n > 1 && hitBase(folder, title) ? { reason: `${title}.md exists; created with a suffix` } : {}) };
      }
      if (hit.kind === "note" && isOurs(hit.frontmatter, blockId, node.id)) {
        claimed.add(path.toLowerCase());
        return { nodeId: node.id, label: node.label, path, action: "reuse", reason: "already materialised" };
      }
      if (hit.kind !== "note") continue;
      if (options.onExisting === "link") {
        claimed.add(path.toLowerCase());
        return { nodeId: node.id, label: node.label, path, action: "link", reason: "a note with this name exists; linked, not overwritten" };
      }
      if (options.onExisting === "skip") return { nodeId: node.id, label: node.label, path, action: "skip", reason: "a note with this name exists; skipped" };
    }
  };
  for (const node of graph.nodes) {
    const p = planNode(node);
    notes.push(p);
    noteByNode.set(node.id, p);
  }

  // Edges → properties on the source note.
  const propsByPath = new Map<string, Map<string, PropertyLink[]>>();
  let groupEdges = 0;
  for (const e of graph.edges) {
    if (e.fromGroup || e.toGroup) {
      groupEdges++;
      continue;
    }
    const from = noteByNode.get(e.from);
    const to = noteByNode.get(e.to);
    if (!from || !to) continue;
    if (from.action === "skip" || from.action === "media") {
      warnings.push(`Edge ${e.from} → ${e.to}: ${e.from} is ${from.action === "media" ? "a media node" : "skipped"}, so it gets no property.`);
      continue;
    }
    if (to.action === "skip") {
      warnings.push(`Edge ${e.from} → ${e.to}: ${e.to} is skipped, so there is no note to link.`);
      continue;
    }
    const key = propertyKey(e.label, options.keyStyle, options.defaultKey);
    const linktext = to.action === "media" ? to.path : linktextOf(to.path);
    const pl: PropertyLink = { link: `[[${linktext}]]`, target: linktextOf(to.path).toLowerCase() };
    const byKey = propsByPath.get(from.path) ?? propsByPath.set(from.path, new Map()).get(from.path)!;
    const list = byKey.get(key) ?? byKey.set(key, []).get(key)!;
    if (!list.some((x) => x.target === pl.target)) list.push(pl);
  }
  if (groupEdges) warnings.push(`${groupEdges} edge(s) to or from a subgraph skipped: folders can't hold properties.`);
  if (graph.skippedPseudo) warnings.push(`${graph.skippedPseudo} pseudo-state(s) ([*], choice, fork, join) and their edges skipped.`);

  const properties: PropertyWrite[] = [];
  for (const n of notes) {
    const byKey = propsByPath.get(n.path);
    if (!byKey || n.path === "") continue;
    if (n.action === "create") {
      n.properties = Object.fromEntries([...byKey].map(([k, v]) => [k, v.map((x) => x.link)]));
      continue;
    }
    if (n.action !== "reuse" && n.action !== "link") continue;
    // A note several nodes map to gets one write per key.
    if (properties.some((p) => p.path === n.path)) continue;
    const hit = vault.lookup(n.path);
    const fm = hit?.kind === "note" ? hit.frontmatter ?? {} : {};
    for (const [key, add] of byKey) {
      const merged = mergeLinks(fm[key], add, n.path, (linkpath, source) => vault.resolve(linkpath, source));
      if (!merged) {
        warnings.push(`${n.path}: property "${key}" holds a value that isn't a link; left alone.`);
        continue;
      }
      if (merged.changed) properties.push({ path: n.path, key, add, before: fm[key], after: merged.value });
    }
  }

  // Created notes' content.
  for (const n of notes) {
    if (n.action !== "create") continue;
    const fm: Record<string, string | string[]> = { [PROVENANCE_KEY]: provenance, [NODE_KEY]: n.nodeId };
    // Obsidian titles every note embed with the file name, so the title is the
    // node's visible label. The body adds only what the title can't show (text
    // the filename rules changed); the original label is kept as an alias.
    const title = n.path.split("/").pop()!.replace(/\.md$/i, "");
    const link = soleLink(n.label);
    const shown = (link ? link.display : n.label).trim();
    const plain = plainLabel(shown);
    const titleBase = title.replace(/ \d+$/, "");
    if (shown && shown !== title) fm.aliases = [shown];
    for (const [k, v] of Object.entries(n.properties ?? {})) fm[k] = v.length === 1 ? v[0] : v;
    const titleSays = !plain || sameLower(plain, title) || sameLower(plain, titleBase);
    n.content = yamlFrontmatter(fm) + (titleSays ? "" : `${shown}\n`);
  }

  // Block rewrite: every note-backed node not already embedding its note.
  let rewrite: MaterialisePlan["rewrite"] = null;
  if (options.rewrite) {
    const targets = new Map<string, string>();
    for (const n of notes) {
      if (n.action !== "create" && n.action !== "reuse" && n.action !== "link") continue;
      const link = parseSoleEmbed(n.label);
      if (link && vault.resolve(link.linkpath, notePath)?.toLowerCase() === n.path.toLowerCase()) continue;
      targets.set(n.nodeId, linktextOf(n.path));
    }
    const after = rewriteBlock(input.source, graph.type, targets, { addDirective: !input.isMehrpele });
    if (after !== input.source) rewrite = { before: input.source, after };
  }

  // Root chain first (only when something lands in it), then group folders, parents first.
  const creates = notes.some((n) => n.action === "create");
  const groupFolders = folders.sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  const planned = creates || groupFolders.some((f) => f.status === "create") ? [...rootFolders, ...groupFolders] : groupFolders;
  const empty = !planned.some((f) => f.status === "create") && !creates && !properties.length && !rewrite;
  return { type: graph.type, notePath, blockId, provenance, root, folders: planned, notes, properties, rewrite, warnings, empty };
}

/** The whole pipeline: parse/convert the block, then plan. */
export function planFromSource(input: PlanInput): PlanResult {
  const g = diagramGraph(input.source, { mehrpele: input.isMehrpele });
  if (!g.ok) return g;
  if (!g.graph.nodes.length) return { ok: false, reason: "Pele: this diagram has no nodes to materialise." };
  return { ok: true, plan: planMaterialise(g.graph, input) };
}
