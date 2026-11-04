/**
 * Breadcrumbs neighbours -> GraphSpec (pure).
 *
 * Mirrors BCAPI.get_neighbours (breadcrumbs/src/api/index.ts:65),
 * which returns outgoing edges only. Self-loops (self_is_sibling, builders
 * index.ts:124) are always dropped; implied edges (source "implied") are
 * dropped unless `implied: true`.
 */
import type { GraphEdge, GraphNode, GraphSpec } from "../graph-to-pele";
import type { BcEdgeLike } from "../detect";

export interface BreadcrumbsMapOptions {
  fields: string[];
  depth: number;
  implied: boolean;
  maxNodes: number;
  direction?: GraphSpec["direction"];
}

export type NeighbourFetcher = (path: string) => BcEdgeLike[] | undefined;

export function basenameLabel(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "") || path;
}

/** Breadth-first expansion from `start` over outgoing Breadcrumbs edges. */
export function breadcrumbsToGraph(
  start: string,
  fetchNeighbours: NeighbourFetcher,
  options: BreadcrumbsMapOptions,
): GraphSpec {
  const wantedFields = new Set(options.fields.map((f) => f.toLowerCase()));
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();

  const addNode = (path: string): void => {
    if (!nodes.has(path)) {
      nodes.set(path, { id: path, label: basenameLabel(path), href: path });
    }
  };
  addNode(start);

  let frontier = [start];
  for (let level = 0; level < options.depth && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const current of frontier) {
      if (nodes.size >= options.maxNodes && level > 0) break;
      const neighbours = fetchNeighbours(current) ?? [];
      for (const edge of neighbours) {
        if (edge.source !== current) continue;
        if (edge.target === edge.source) continue; // self-loop
        if (edge.implied && !options.implied) continue;
        if (wantedFields.size > 0 && !wantedFields.has(edge.field.toLowerCase())) continue;
        const isNew = !nodes.has(edge.target);
        if (isNew && nodes.size >= options.maxNodes) continue;
        addNode(edge.target);
        const key = `${edge.source}\u0000${edge.target}\u0000${edge.field}\u0000${edge.implied ? "i" : "e"}`;
        if (!seenEdge.has(key)) {
          seenEdge.add(key);
          edges.push({
            from: edge.source,
            to: edge.target,
            label: edge.field || undefined,
            kind: edge.field || undefined,
            implied: edge.implied === true,
          });
        }
        if (isNew) next.push(edge.target);
      }
    }
    frontier = [...new Set(next)];
  }

  // Start node gets a distinct class so themes can highlight it.
  const startNode = nodes.get(start);
  if (startNode) startNode.classes = ["start"];

  return {
    nodes: [...nodes.values()],
    edges,
    direction: options.direction ?? "LR",
  };
}
