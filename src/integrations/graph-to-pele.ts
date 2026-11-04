/**
 * Shared graph -> Pele source generator (DOM-free, deterministic).
 *
 * One module reused by Breadcrumbs, Datacore and TaskNotes mappings.
 * No `app`/`window` imports: adapters inject plain data, this module only
 * produces Mermaid/Pele source text. Node/edge order = caller order, ids are
 * sanitised deterministically, so identical input gives identical output.
 *
 * Label quoting reimplements the minimal rule from pele-render's repair
 * "quote-labels" fix (special characters force double quotes, `"` becomes
 * `#quot;`) without importing CLI code.
 *
 * Colour rule: generated `classDef` lines never hard-code colours. They only
 * carry non-colour strokes (width/dash) so the source stays theme-neutral;
 * actual colours come from `integrations.css`, which styles Pele's rendered
 * `.<class>` node classes with `--pele-*` variables. The only exception is an
 * explicit caller-supplied `classColors` map (user-configured colours) and
 * `classDefOverrides` (Extended Graph style map, theme-safe translucent fills).
 *
 * Deep links: nodes with a `heading`/`block` emit an Advanced URI
 * (`obsidian://adv-uri?…`) when `advancedUriVault` is set (Advanced URI
 * enabled), else the internal-link form `path#heading` / `path#^block`.
 */
import { advancedUri } from "../diagram-link";

// -- Graph IR ---------------------------------------------------------------

export interface GraphNode {
  /** Caller key (vault path, task path, ...). Sanitised into a Pele id. */
  id: string;
  label: string;
  /** Internal vault path (or URL) for a `click` line, if any. */
  href?: string;
  /** Heading inside `href` to deep-link to (Advanced URI `heading=`). */
  heading?: string;
  /** Block id (without `^`) inside `href` to deep-link to (`block=`). */
  block?: string;
  /** Subgraph label this node belongs to. */
  group?: string;
  /** Semantic classes, e.g. "done", "blocked", "up". Become `pele-*` classes. */
  classes?: string[];
  shape?: GraphShape;
}

export type GraphShape =
  | "rect"
  | "diamond"
  | "stadium"
  | "cylinder"
  | "database"
  | "subroutine"
  | "hexagon"
  | "circle"
  | "round";

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  /** Typed-edge kind, e.g. Breadcrumbs field ("up"/"same"/...) or "blocks". */
  kind?: string;
  style?: "solid" | "dashed" | "dotted" | "thick";
  /** Breadcrumbs implied/transitive edge: rendered dimmed unless kept solid. */
  implied?: boolean;
}

export interface GraphGroup {
  id: string;
  label: string;
}

export interface GraphSpec {
  nodes: GraphNode[];
  edges: GraphEdge[];
  direction?: "TD" | "TB" | "LR" | "RL" | "BT";
  groups?: GraphGroup[];
  title?: string;
}

export interface GeneratorOptions {
  /** Hard node cap; excess nodes collapse into one "…N more" node. */
  maxNodes?: number;
  /** User-configured colours per semantic class (the only colour source). */
  classColors?: Record<string, string>;
  /** Full classDef bodies per semantic class (wins over classColors). */
  classDefOverrides?: Record<string, string>;
  /** Edge colour per edge `kind` (emitted as `linkStyle N stroke:…`). */
  edgeColors?: Record<string, string>;
  /**
   * Vault name when Advanced URI is enabled: heading/block nodes then link
   * via `obsidian://adv-uri`. Unset = internal `path#heading` links.
   */
  advancedUriVault?: string;
}

/**
 * Click target for a node: Advanced URI deep link when possible, else the
 * internal-link form. Returns the *intended* href (before Pele escaping).
 */
export function nodeHref(
  node: Pick<GraphNode, "href" | "heading" | "block">,
  options: Pick<GeneratorOptions, "advancedUriVault"> = {},
): string | undefined {
  const href = node.href?.trim();
  if (!href) return undefined;
  const isVaultPath = !/^[a-z][a-z0-9+.-]*:/i.test(href);
  const block = node.block?.trim().replace(/^\^/, "");
  const heading = node.heading?.trim();
  if (!isVaultPath || (!block && !heading)) return href;
  if (options.advancedUriVault) {
    return advancedUri({ vault: options.advancedUriVault, filepath: href, block, heading: block ? undefined : heading });
  }
  return block ? `${href}#^${block}` : `${href}#${heading}`;
}

export interface GeneratedSource {
  source: string;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
  omittedCount: number;
  /** Caller key -> generated Pele id. */
  idByKey: Map<string, string>;
}

export const DEFAULT_MAX_NODES = 200;

// -- id + label helpers -------------------------------------------------------

const RESERVED_IDS = new Set(["end", "graph", "subgraph", "flowchart", "click", "class", "classdef", "style", "linkstyle"]);

/** Deterministic Pele-safe id for a caller key. Mirrors bases-source sanitising. */
export function sanitiseId(key: string, taken: Set<string>): string {
  let id = key
    .replace(/\.md$/i, "")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!id || /^[0-9]/.test(id)) id = `n_${id || "node"}`;
  if (RESERVED_IDS.has(id.toLowerCase())) id = `${id}_`;
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

/** Escape a label for a double-quoted Pele label (repair quote-labels rule). */
export function escapeQuotedLabel(text: string): string {
  return text.replace(/\r\n|[\r\n\u2028\u2029]/g, " ").replace(/"/g, "#quot;").trim();
}

/** Always-quoted label body (without the surrounding quotes). */
export function quotedLabel(text: string): string {
  return `"${escapeQuotedLabel(text)}"`;
}

function shapeWrap(shape: GraphShape | undefined, quoted: string): string {
  switch (shape) {
    case "diamond":
      return `{${quoted}}`;
    case "stadium":
      return `([${quoted}])`;
    case "cylinder":
    case "database":
      return `[(${quoted})]`;
    case "subroutine":
      return `[[${quoted}]]`;
    case "hexagon":
      return `{{${quoted}}}`;
    case "circle":
      return `((${quoted}))`;
    case "round":
      return `(${quoted})`;
    default:
      return `[${quoted}]`;
  }
}

function classNameFor(semantic: string): string {
  const clean = semantic.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `pele-${clean || "node"}`;
}

/** Non-colour classDef body per semantic class (colours live in CSS). */
function classDefBody(semantic: string, color: string | undefined, override?: string): string {
  if (override) return override;
  if (color) return `fill:${color},stroke:${color}`;
  switch (semantic) {
    case "done":
    case "completed":
      return "stroke-width:2px";
    case "blocked":
    case "crit":
    case "critical":
      return "stroke-width:2px,stroke-dasharray:5 5";
    case "implied":
    case "muted":
      return "stroke-dasharray:4 4";
    case "active":
      return "stroke-width:2px";
    default:
      return "stroke-width:1px";
  }
}

function arrowFor(edge: GraphEdge): string {
  if (edge.style === "thick") return "==>";
  if (edge.style === "dashed" || edge.style === "dotted") return "-.->";
  if (edge.style === "solid") return "-->";
  if (edge.implied) return "-.->";
  switch (edge.kind) {
    case "same":
      return "-.->";
    case "blocks":
    case "blocking":
      return "==>";
    default:
      return "-->";
  }
}

// -- Flowchart ----------------------------------------------------------------

export function flowchartFromGraph(spec: GraphSpec, options: GeneratorOptions = {}): GeneratedSource {
  const maxNodes = clampMax(options.maxNodes);
  const truncated = spec.nodes.length > maxNodes;
  const kept = truncated ? spec.nodes.slice(0, maxNodes) : [...spec.nodes];
  const omittedCount = spec.nodes.length - kept.length;

  const taken = new Set<string>();
  const idByKey = new Map<string, string>();
  for (const node of kept) idByKey.set(node.id, sanitiseId(node.id, taken));
  let moreId: string | undefined;
  if (truncated) {
    moreId = sanitiseId("__more__", taken);
    idByKey.set("__more__", moreId);
  }

  const direction = spec.direction ?? "TD";
  const lines: string[] = [`flowchart ${direction}`];
  if (spec.title?.trim()) lines.push(`  accTitle: ${spec.title.trim().replace(/\r?\n/g, " ")}`);

  const groupLabel = new Map<string, string>();
  for (const g of spec.groups ?? []) groupLabel.set(g.id, g.label);
  for (const node of kept) {
    if (node.group && !groupLabel.has(node.group)) groupLabel.set(node.group, node.group);
  }

  const emitNode = (node: GraphNode, indent: string): void => {
    const id = idByKey.get(node.id)!;
    lines.push(`${indent}${id}${shapeWrap(node.shape, quotedLabel(node.label))}`);
  };

  const grouped = new Map<string, GraphNode[]>();
  const ungrouped: GraphNode[] = [];
  for (const node of kept) {
    if (node.group) {
      const list = grouped.get(node.group) ?? [];
      list.push(node);
      grouped.set(node.group, list);
    } else {
      ungrouped.push(node);
    }
  }
  for (const node of ungrouped) emitNode(node, "  ");
  for (const [groupId, list] of grouped) {
    lines.push(`  subgraph ${quotedLabel(groupLabel.get(groupId) ?? groupId)}`);
    for (const node of list) emitNode(node, "    ");
    lines.push("  end");
  }
  if (moreId) lines.push(`  ${moreId}[${quotedLabel(`…${omittedCount} more`)}]`);

  // Edges: only between kept nodes; stable caller order defines linkStyle ids.
  let edgeCount = 0;
  const linkStyles: string[] = [];
  for (const edge of spec.edges) {
    const from = idByKey.get(edge.from);
    const to = idByKey.get(edge.to);
    if (!from || !to || edge.from === "__more__" || edge.to === "__more__") continue;
    const arrow = arrowFor(edge);
    const label = edge.label?.trim() ? `|${quotedLabel(edge.label)}|` : "";
    lines.push(`  ${from} ${arrow}${label} ${to}`);
    const edgeColor = edge.kind ? options.edgeColors?.[edge.kind] : undefined;
    const styles = [
      ...(edgeColor ? [`stroke:${edgeColor}`] : []),
      ...(edge.implied ? ["stroke-dasharray:4 4"] : []),
    ];
    if (styles.length > 0) linkStyles.push(`  linkStyle ${edgeCount} ${styles.join(",")}`);
    edgeCount++;
  }
  lines.push(...linkStyles);

  // classDef + class, grouped deterministically by first use.
  const classOfNode = new Map<string, string[]>();
  const classOrder: string[] = [];
  for (const node of kept) {
    for (const c of node.classes ?? []) {
      const name = classNameFor(c);
      if (!classOrder.includes(name)) classOrder.push(name);
      const list = classOfNode.get(name) ?? [];
      list.push(idByKey.get(node.id)!);
      classOfNode.set(name, list);
    }
  }
  for (const name of classOrder) {
    const semantic = name.slice("pele-".length);
    lines.push(
      `  classDef ${name} ${classDefBody(semantic, options.classColors?.[semantic], options.classDefOverrides?.[semantic])}`,
    );
  }
  for (const name of classOrder) {
    lines.push(`  class ${classOfNode.get(name)!.join(",")} ${name}`);
  }

  // Click-through: internal links so DiagramFrame routing/hover previews work.
  for (const node of kept) {
    const href = nodeHref(node, options);
    if (!href) continue;
    const id = idByKey.get(node.id)!;
    lines.push(`  click ${id} ${quotedLabel(href)} ${quotedLabel(node.label)}`);
  }

  return {
    source: lines.join("\n"),
    nodeCount: kept.length + (moreId ? 1 : 0),
    edgeCount,
    truncated,
    omittedCount,
    idByKey,
  };
}

// -- Gantt --------------------------------------------------------------------

export interface GanttTask {
  id: string;
  label: string;
  section?: string;
  start?: string;
  end?: string;
  /** Mermaid duration, e.g. "5d". Used when `end` is absent. */
  duration?: string;
  after?: string[];
  status?: "done" | "active" | "crit" | "milestone";
  href?: string;
}

export interface GanttSpec {
  title?: string;
  dateFormat?: string;
  sections?: { label: string; tasks: GanttTask[] }[];
  tasks?: GanttTask[];
}

export function ganttFromSpec(spec: GanttSpec, options: GeneratorOptions = {}): GeneratedSource {
  const maxNodes = clampMax(options.maxNodes);
  const flat: GanttTask[] = spec.tasks ? [...spec.tasks] : (spec.sections ?? []).flatMap((s) => s.tasks.map((t) => ({ ...t, section: t.section ?? s.label })));
  const truncated = flat.length > maxNodes;
  const kept = truncated ? flat.slice(0, maxNodes) : flat;
  const omittedCount = flat.length - kept.length;

  const taken = new Set<string>();
  const idByKey = new Map<string, string>();
  for (const task of kept) idByKey.set(task.id, sanitiseId(task.id, taken));

  const lines: string[] = ["gantt"];
  if (spec.title?.trim()) lines.push(`  title ${spec.title.trim().replace(/\r?\n/g, " ")}`);
  lines.push(`  dateFormat ${spec.dateFormat?.trim() || "YYYY-MM-DD"}`);

  const bySection = new Map<string, GanttTask[]>();
  for (const task of kept) {
    const section = (task.section ?? "Tasks").trim() || "Tasks";
    const list = bySection.get(section) ?? [];
    list.push(task);
    bySection.set(section, list);
  }
  for (const [section, tasks] of bySection) {
    lines.push(`  section ${ganttText(section)}`);
    for (const task of tasks) lines.push(`  ${ganttTaskLine(task, idByKey)}`);
  }
  if (truncated) {
    lines.push("  section More");
    lines.push(`  ${ganttText(`…${omittedCount} more tasks`)} :${sanitiseId("__more__", taken)}, 2000-01-01, 1d`);
  }
  for (const task of kept) {
    if (!task.href?.trim()) continue;
    lines.push(`  click ${idByKey.get(task.id)} href ${quotedLabel(task.href.trim())}`);
  }
  return { source: lines.join("\n"), nodeCount: kept.length, edgeCount: 0, truncated, omittedCount, idByKey };
}

function ganttText(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/:/g, "-").trim();
}

function ganttTaskLine(task: GanttTask, idByKey: Map<string, string>): string {
  const id = idByKey.get(task.id)!;
  const parts: string[] = [];
  if (task.status) parts.push(task.status === "milestone" ? "milestone" : task.status);
  parts.push(id);
  const after = (task.after ?? []).map((a) => idByKey.get(a)).filter((v): v is string => !!v);
  if (after.length > 0) {
    parts.push(`after ${after.join(" ")}`);
  } else if (task.start?.trim()) {
    parts.push(task.start.trim());
  }
  if (task.status === "milestone") {
    if (!task.end?.trim() && !task.duration?.trim()) parts.push("0d");
    else if (task.end?.trim()) parts.push(task.end.trim());
    else parts.push(task.duration!.trim());
  } else if (task.end?.trim()) {
    parts.push(task.end.trim());
  } else if (task.duration?.trim()) {
    parts.push(task.duration.trim());
  } else if (task.start?.trim()) {
    parts.push("1d");
  }
  return `${ganttText(task.label)} :${parts.join(", ")}`;
}

// -- Mindmap / tree -------------------------------------------------------------

export interface TreeNode {
  label: string;
  href?: string;
  shape?: GraphShape;
  children?: TreeNode[];
}

export interface MindmapSpec {
  root: TreeNode;
}

export function mindmapFromTree(spec: MindmapSpec, options: GeneratorOptions = {}): GeneratedSource {
  const maxNodes = clampMax(options.maxNodes);
  const lines: string[] = ["mindmap"];
  const taken = new Set<string>();
  const idByKey = new Map<string, string>();
  let count = 0;
  let truncated = false;
  let omittedCount = 0;

  const countTree = (n: TreeNode): number => 1 + (n.children ?? []).reduce((a, c) => a + countTree(c), 0);
  const total = countTree(spec.root);

  const emit = (node: TreeNode, depth: number, isRoot: boolean): void => {
    if (count >= maxNodes) {
      truncated = true;
      return;
    }
    count++;
    const indent = "  ".repeat(depth + 1);
    const label = escapeQuotedLabel(node.label);
    if (isRoot) {
      lines.push(`${indent}root((${label}))`);
    } else if (node.shape === "circle") {
      lines.push(`${indent}${label ? `((${label}))` : "(())"}`);
    } else if (node.shape === "diamond" || node.shape === "hexagon") {
      lines.push(`${indent}{{${label}}}`);
    } else if (node.shape) {
      lines.push(`${indent}[${label}]`);
    } else {
      // Plain mindmap text cannot contain brackets/parens safely; bracket it.
      lines.push(`${indent}[${label.replace(/[[\]]/g, "")}]`);
    }
    for (const child of node.children ?? []) emit(child, depth + 1, false);
  };
  emit(spec.root, 0, true);
  if (total > count) {
    truncated = true;
    omittedCount = total - count;
    lines.push(`    [${escapeQuotedLabel(`…${omittedCount} more`)}]`);
  }
  void taken;
  void idByKey;
  return { source: lines.join("\n"), nodeCount: count, edgeCount: 0, truncated, omittedCount, idByKey };
}

// -- Kanban ---------------------------------------------------------------------

export interface KanbanColumn {
  label: string;
  tasks: { id: string; label: string; href?: string }[];
}

export interface KanbanSpec {
  columns: KanbanColumn[];
}

export function kanbanFromSpec(spec: KanbanSpec, options: GeneratorOptions = {}): GeneratedSource {
  const maxNodes = clampMax(options.maxNodes);
  const taken = new Set<string>();
  const idByKey = new Map<string, string>();
  const lines: string[] = ["kanban"];
  let count = 0;
  let truncated = false;
  let omittedCount = 0;
  for (const column of spec.columns) {
    lines.push(`  ${kanbanColumnId(column.label)}`);
    // Column header is the id line itself in Pele kanban; label via section
    // header text is the id, so use a readable id and keep tasks under it.
    for (const task of column.tasks) {
      if (count >= maxNodes) {
        truncated = true;
        omittedCount++;
        continue;
      }
      count++;
      const id = sanitiseId(task.id, taken);
      idByKey.set(task.id, id);
      // Mermaid kanban has no `click` statement (Pele would parse it as a column).
      lines.push(`    ${id}[${escapeQuotedLabel(task.label).replace(/[[\]]/g, "")}]`);
    }
  }
  if (truncated) lines.push(`    ${sanitiseId("__more__", taken)}[${escapeQuotedLabel(`…${omittedCount} more`)}]`);
  return { source: lines.join("\n"), nodeCount: count, edgeCount: 0, truncated, omittedCount, idByKey };
}

function kanbanColumnId(label: string): string {
  const clean = label.trim().replace(/\s+/g, "-");
  return clean || "Column";
}

function clampMax(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_NODES;
  return Math.max(1, Math.min(Math.floor(value), 1000));
}
