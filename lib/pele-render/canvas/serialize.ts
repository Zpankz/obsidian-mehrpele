import type { CanvasData } from "./types.js";
import { cmp, type AnyRec } from "./util.js";

// deterministic stringify
export const NODE_ORDER = ["id", "type", "x", "y", "width", "height", "color", "text", "file", "subpath", "url", "label", "background", "backgroundStyle", "styleAttributes", "portal", "interdimensionalEdges", "collapsed"];
export const EDGE_ORDER = ["id", "fromNode", "toNode", "fromSide", "toSide", "fromEnd", "toEnd", "color", "label", "styleAttributes"];
export const META_ORDER = ["version", "frontmatter", "startNode", "pele"];
export const PELE_ORDER = ["schema", "type", "direction", "sourceHash", "peleVersion", "scale", "layout", "fidelity", "classDefs", "dropped", "nodeSizes"];
export function ordered(obj: unknown, preferred: string[]): unknown {
  if (Array.isArray(obj)) return obj.map(v => ordered(v, []));
  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of preferred) if (k in rec) out[k] = ordered(rec[k], k === "metadata" ? META_ORDER : k === "pele" ? PELE_ORDER : []);
    for (const k of Object.keys(rec).sort(cmp)) if (!(k in out)) out[k] = ordered(rec[k], []);
    return out;
  }
  return obj;
}
export function orderCanvas(c: CanvasData): Record<string, unknown> {
  const nodes = (c.nodes ?? []).map(n => ordered(n, NODE_ORDER));
  const edges = (c.edges ?? []).map(e => ordered(e, EDGE_ORDER));
  const meta = c.metadata ? ordered(c.metadata, META_ORDER) : undefined;
  const out: Record<string, unknown> = {};
  if (meta !== undefined) out.metadata = meta;
  out.nodes = nodes; out.edges = edges;
  for (const k of Object.keys(c).sort(cmp)) if (!(k in out) && k !== "nodes" && k !== "edges" && k !== "metadata") out[k] = ordered((c as AnyRec)[k], []);
  return out;
}
export function stringifyCanvas(c: CanvasData): string { return JSON.stringify(orderCanvas(c), null, 2) + "\n"; }
