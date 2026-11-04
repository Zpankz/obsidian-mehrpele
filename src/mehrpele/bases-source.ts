/**
 * Bases → Pele source generation. Pure and deterministic:
 * node order = entry order, edge order = entry then link order, ids are
 * sanitised deterministically. The Bases view feeds it real entries; tests
 * feed it fakes.
 */
import { escapeLabelMarkdown, markdownToFallback } from "./model";

export interface BaseEntryLike {
  /** Vault path of the entry's file. */
  path: string;
  basename: string;
  /** Display label (label-property value or basename). May be Markdown. */
  label?: string;
  /** Link targets (vault paths or linkpaths) from the link property. */
  links: string[];
  /** Group key for subgraph generation, or null/undefined for ungrouped. */
  group?: string | null;
}

export interface BasesSourceOptions {
  kind: "flowchart" | "mindmap";
  direction: string;
  /** Group entries into subgraphs (flowchart only). */
  groupIntoSubgraphs: boolean;
  maxNodes: number;
  /** Optional node styling (e.g. Extended Graph colours); flowchart only. */
  style?: BasesNodeStyle;
}

export interface BasesNodeStyle {
  /** Class names (Pele `class` statements) for an entry. */
  classesFor(entry: BaseEntryLike): string[];
  /** classDef bodies by class name. */
  classDefs: Record<string, string>;
}

export const DEFAULT_BASES_SOURCE_OPTIONS: BasesSourceOptions = {
  kind: "flowchart",
  direction: "TD",
  groupIntoSubgraphs: true,
  maxNodes: 100,
};

export interface BasesSourceResult {
  source: string;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
  /** path → generated node id (for the view's click/copy affordances). */
  idByPath: Map<string, string>;
}

/** Deterministic Pele-safe id for a vault path. */
export function sanitiseNodeId(path: string, taken: Set<string>): string {
  let id = path.replace(/\.md$/i, "").replace(/[^A-Za-z0-9_]/g, "_");
  if (!id || /^[0-9]/.test(id)) id = `n_${id}`;
  if (!taken.has(id)) {
    taken.add(id);
    return id;
  }
  let n = 2;
  while (taken.has(`${id}_${n}`)) n++;
  const unique = `${id}_${n}`;
  taken.add(unique);
  return unique;
}

function labelFor(entry: BaseEntryLike): string {
  const raw = (entry.label ?? entry.basename).trim() || entry.basename;
  // Generated labels link back to their note when they have no link already.
  return raw;
}

/** Collapse CR/LF (incl. lone `\r`) to spaces: a raw line break in a generated
 *  label would end the statement and let the rest (`click A …`) parse as
 *  diagram source. */
export function singleLineLabel(text: string): string {
  return text.replace(/\r\n|[\r\n\u2028\u2029]/g, " ");
}

function quoted(markdown: string): string {
  return `"${escapeLabelMarkdown(singleLineLabel(markdown))}"`;
}

/** Generate Pele source from Bases entries. */
export function generateBasesSource(
  entries: BaseEntryLike[],
  options: BasesSourceOptions = DEFAULT_BASES_SOURCE_OPTIONS,
): BasesSourceResult {
  const maxNodes = Math.max(1, Math.min(options.maxNodes, 500));
  const truncated = entries.length > maxNodes;
  const kept = entries.slice(0, maxNodes);
  const taken = new Set<string>();
  const idByPath = new Map<string, string>();
  for (const e of kept) idByPath.set(e.path, sanitiseNodeId(e.path, taken));

  return options.kind === "mindmap"
    ? mindmapSource(kept, idByPath, truncated)
    : flowchartSource(kept, idByPath, options, truncated);
}

function flowchartSource(
  kept: BaseEntryLike[],
  idByPath: Map<string, string>,
  options: BasesSourceOptions,
  truncated: boolean,
): BasesSourceResult {
  const lines: string[] = [`flowchart ${options.direction}`];
  let edgeCount = 0;
  const emitNodes = (list: BaseEntryLike[], indent: string) => {
    for (const e of list) {
      lines.push(`${indent}${idByPath.get(e.path)}[${quoted(labelFor(e))}]`);
    }
  };
  const groups = new Map<string, BaseEntryLike[]>();
  const ungrouped: BaseEntryLike[] = [];
  if (options.groupIntoSubgraphs) {
    for (const e of kept) {
      const g = e.group?.trim();
      if (g) {
        const list = groups.get(g) ?? [];
        list.push(e);
        groups.set(g, list);
      } else ungrouped.push(e);
    }
  } else {
    ungrouped.push(...kept);
  }
  emitNodes(ungrouped, "  ");
  for (const [group, list] of groups) {
    const gid = `subgraph:${group}`;
    void gid;
    lines.push(`  subgraph ${quoted(group)}`);
    emitNodes(list, "    ");
    lines.push("  end");
  }
  for (const e of kept) {
    const from = idByPath.get(e.path);
    if (!from) continue;
    for (const link of e.links) {
      const to = idByPath.get(link) ?? idByPath.get(resolveLinkGuess(link, kept));
      if (!to || to === from) continue;
      lines.push(`  ${from} --> ${to}`);
      edgeCount++;
    }
  }
  if (options.style) lines.push(...styleLines(kept, idByPath, options.style));
  return { source: lines.join("\n"), nodeCount: kept.length, edgeCount, truncated, idByPath };
}

const CLASS_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** `classDef` + `class` lines, deterministic (first-use order). */
function styleLines(kept: BaseEntryLike[], idByPath: Map<string, string>, style: BasesNodeStyle): string[] {
  const members = new Map<string, string[]>();
  for (const e of kept) {
    const id = idByPath.get(e.path);
    if (!id) continue;
    for (const cls of style.classesFor(e)) {
      if (!CLASS_NAME_RE.test(cls) || !style.classDefs[cls]) continue;
      const list = members.get(cls) ?? [];
      list.push(id);
      members.set(cls, list);
    }
  }
  const out: string[] = [];
  for (const cls of members.keys()) out.push(`  classDef ${cls} ${style.classDefs[cls]}`);
  for (const [cls, ids] of members) out.push(`  class ${ids.join(",")} ${cls}`);
  return out;
}

/** Link targets may be linkpaths (`Note`, `folder/Note#H`); match by basename/path suffix. */
function resolveLinkGuess(link: string, kept: BaseEntryLike[]): string {
  const clean = link.split("#")[0].split("|")[0].trim();
  const withExt = clean.toLowerCase().endsWith(".md") ? clean : `${clean}.md`;
  const hit = kept.find((e) => e.path === withExt || e.path.endsWith(`/${withExt}`) || e.basename === clean);
  return hit?.path ?? clean;
}

function mindmapSource(
  kept: BaseEntryLike[],
  idByPath: Map<string, string>,
  truncated: boolean,
): BasesSourceResult {
  // Parent = first link target that is also an entry; roots attach to a
  // synthetic root so the mindmap stays a single tree.
  void idByPath;
  const pathSet = new Set(kept.map((e) => e.path));
  const children = new Map<string, BaseEntryLike[]>();
  const roots: BaseEntryLike[] = [];
  for (const e of kept) {
    const parent = e.links.map((l) => resolveLinkGuess(l, kept)).find((p) => pathSet.has(p) && p !== e.path);
    if (parent) {
      const list = children.get(parent) ?? [];
      list.push(e);
      children.set(parent, list);
    } else {
      roots.push(e);
    }
  }
  const lines: string[] = ["mindmap", `  root[${quoted("Base")}]`];
  let edgeCount = 0;
  const emit = (e: BaseEntryLike, depth: number, seen: Set<string>) => {
    if (seen.has(e.path)) return;
    seen.add(e.path);
    lines.push(`${"  ".repeat(depth)}${quotedMindmapLabel(e)}`);
    for (const kid of children.get(e.path) ?? []) {
      edgeCount++;
      emit(kid, depth + 1, seen);
    }
  };
  const seen = new Set<string>();
  for (const r of roots) emit(r, 2, seen);
  // Entries trapped in link cycles never reached a root: emit them flat.
  for (const e of kept) if (!seen.has(e.path)) emit(e, 2, seen);
  return { source: lines.join("\n"), nodeCount: kept.length, edgeCount, truncated, idByPath: new Map() };
}

function quotedMindmapLabel(e: BaseEntryLike): string {
  // Mindmap node text: plain fallback reads best; keep it single-line.
  return singleLineLabel(markdownToFallback(labelFor(e)).split(/\r\n|[\r\n]/)[0] ?? "").trim() || e.basename;
}
