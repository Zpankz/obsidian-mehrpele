/**
 * Diagram → node/group/edge graph for "Materialise diagram as notes". Pure.
 *
 * Built on pele-render's Mermaid → Canvas conversion (labels, file/embed
 * nodes, groups and edge labels for flowchart and state diagrams), with group
 * membership taken from Pele's parse model rather than geometry. Mehrpele
 * blocks are converted through their render source (labels as fallback
 * text) and take node label Markdown from Mehrpele's label scanner.
 */
import { mermaidToCanvas, type CanvasNode } from "pele-render/canvas";
import { parse, type ParsedDiagramModel } from "pele-render/pele";
import { extractLabels } from "../mehrpele/extract";
import { markdownToFallback } from "../mehrpele/model";
import { mehrpeleRenderSource } from "../mehrpele/validate";

export type MaterialiseType = "flowchart" | "state";

export interface GraphNode {
  /** Diagram node id, as written. */
  id: string;
  /** Label Markdown (what the node shows); the id when the node has no label. */
  label: string;
  /** Innermost group (subgraph / composite state) id. */
  groupId?: string;
}

export interface GraphGroup {
  id: string;
  /** Plain-text title (folder name source). */
  title: string;
  parentId?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** Plain-text edge label; "" when unlabelled. */
  label: string;
  /** An endpoint is a group, not a node. */
  toGroup?: boolean;
  fromGroup?: boolean;
}

export interface DiagramGraph {
  type: MaterialiseType;
  nodes: GraphNode[];
  groups: GraphGroup[];
  edges: GraphEdge[];
  /** Pseudo-states ([*], choice, fork, join) left out, with their edges. */
  skippedPseudo: number;
}

export type GraphResult = { ok: true; graph: DiagramGraph } | { ok: false; reason: string };

type AnyRec = Record<string, unknown>;

const isRec = (v: unknown): v is AnyRec => typeof v === "object" && v !== null;

/** Id/label text of an untyped model field: strings as is, numbers as digits, anything else "". */
function idText(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** Nodes of the layout graph Pele attaches to a state model at runtime (untyped in its model types). */
function stateGraphNodes(model: object): AnyRec[] {
  if (!("graph" in model) || !isRec(model.graph)) return [];
  const nodes = model.graph.nodes;
  return Array.isArray(nodes) ? nodes.filter(isRec) : [];
}

const PSEUDO_STATE = new Set(["stateStart", "stateEnd", "choice", "fork", "join"]);

/** Human name for a refused type. */
function refuseReason(type: string): string {
  if (type === "class") {
    return "Pele: class diagrams can't be materialised yet (there is no Canvas node conversion for them). Flowcharts and state diagrams can.";
  }
  return `Pele: only flowcharts and state diagrams can be materialised as notes; this is a ${type} diagram.`;
}

/** Group membership from the parse model: node → innermost group, group → parent group. */
function membership(model: ParsedDiagramModel): { nodeGroup: Map<string, string>; groupParent: Map<string, string>; groupIds: Set<string> } {
  const nodeGroup = new Map<string, string>();
  const groupParent = new Map<string, string>();
  const groupIds = new Set<string>();
  if (model.type === "flowchart") {
    const subs = model.subgraphs ?? [];
    for (const sg of subs) groupIds.add(String(sg.id));
    // Pele lists inner subgraphs first; the first claim is the innermost.
    for (const sg of subs) {
      for (const m of sg.nodes ?? []) {
        if (groupIds.has(m)) {
          if (!groupParent.has(m) && m !== sg.id) groupParent.set(m, String(sg.id));
        } else if (!nodeGroup.has(m)) nodeGroup.set(m, String(sg.id));
      }
    }
  } else {
    for (const gn of stateGraphNodes(model)) {
      if (gn.isGroup) groupIds.add(String(gn.id));
    }
    for (const gn of stateGraphNodes(model)) {
      const parentId = idText(gn.parentId);
      if (!parentId) continue;
      if (groupIds.has(String(gn.id))) groupParent.set(String(gn.id), parentId);
      else nodeGroup.set(String(gn.id), parentId);
    }
  }
  return { nodeGroup, groupParent, groupIds };
}

/** Label Markdown of a Canvas card (file cards come back as their link). */
function cardLabel(n: CanvasNode): string {
  const r = n as AnyRec;
  if (n.type === "file") {
    const peleLabel = idText(r.peleLabel);
    const inner = `${n.file ?? ""}${n.subpath ?? ""}${peleLabel ? `|${peleLabel}` : ""}`;
    return r.peleEmbed ? `![[${inner}]]` : `[[${inner}]]`;
  }
  if (n.type === "link") return n.url ?? "";
  return (n.text ?? "").trim();
}

/**
 * Build the graph of a flowchart or state diagram. `mehrpele`: the block
 * renders as Mehrpele (quoted labels are Markdown).
 */
export function diagramGraph(source: string, opts: { mehrpele: boolean }): GraphResult {
  const renderSrc = opts.mehrpele ? mehrpeleRenderSource(source) : source;
  let model: ParsedDiagramModel;
  try {
    model = parse(renderSrc);
  } catch (e) {
    return { ok: false, reason: `Pele: the diagram doesn't parse, fix it first (${e instanceof Error ? e.message : String(e)}).` };
  }
  if (model.type !== "flowchart" && model.type !== "state") return { ok: false, reason: refuseReason(model.type) };
  const type: MaterialiseType = model.type;

  let canvasNodes: CanvasNode[];
  let canvasEdges: { fromNode: string; toNode: string; label?: string }[];
  try {
    const c = mermaidToCanvas(renderSrc).canvas;
    canvasNodes = c.nodes;
    canvasEdges = c.edges;
  } catch (e) {
    return { ok: false, reason: `Pele: could not convert the diagram (${e instanceof Error ? e.message : String(e)}).` };
  }

  const { nodeGroup, groupParent, groupIds } = membership(model);
  const mehrLabels = new Map<string, string>();
  const clusterTitles = new Map<string, string>();
  if (opts.mehrpele) {
    for (const l of extractLabels(source)) {
      if (l.kind === "node") mehrLabels.set(l.anchorId, l.markdown);
      else if (l.kind === "cluster") clusterTitles.set(l.anchorId.replace(/^subgraph:/, ""), l.fallbackText);
    }
  }
  const pseudo = new Set<string>();
  if (type === "state") {
    for (const gn of stateGraphNodes(model)) if (PSEUDO_STATE.has(String(gn.shape))) pseudo.add(String(gn.id));
  }

  const peleOf = new Map<string, string>(); // canvas id → pele id
  const groups: GraphGroup[] = [];
  const nodes: GraphNode[] = [];
  for (const n of canvasNodes) {
    const pid = idText((n as AnyRec).peleId) || n.id;
    peleOf.set(n.id, pid);
    if (n.type === "group") {
      const title = clusterTitles.get(pid) ?? markdownToFallback(String(n.label ?? pid));
      groups.push({ id: pid, title: title || pid, ...(groupParent.has(pid) ? { parentId: groupParent.get(pid)! } : {}) });
    }
  }
  for (const n of canvasNodes) {
    if (n.type === "group") continue;
    const pid = peleOf.get(n.id)!;
    // An edge to a subgraph id gives Pele a node of that id: it is the group.
    if (groupIds.has(pid) || pseudo.has(pid)) continue;
    const label = mehrLabels.get(pid) ?? cardLabel(n);
    const g = nodeGroup.get(pid);
    nodes.push({ id: pid, label: label || pid, ...(g ? { groupId: g } : {}) });
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  let skippedPseudo = pseudo.size;
  for (const e of canvasEdges) {
    const from = peleOf.get(e.fromNode);
    const to = peleOf.get(e.toNode);
    if (!from || !to) continue;
    if (pseudo.has(from) || pseudo.has(to)) continue;
    const fromGroup = groupIds.has(from) && !nodeIds.has(from);
    const toGroup = groupIds.has(to) && !nodeIds.has(to);
    edges.push({ from, to, label: (e.label ?? "").trim(), ...(fromGroup ? { fromGroup } : {}), ...(toGroup ? { toGroup } : {}) });
  }
  if (!pseudo.size) skippedPseudo = 0;
  return { ok: true, graph: { type, nodes, groups, edges, skippedPseudo } };
}
