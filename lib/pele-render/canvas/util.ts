/** Small helpers shared by the Mermaid ⇄ Canvas converters. */
import type { FlowchartModel, MindmapModel, StateModel } from "pele";
import type { Side } from "../layout/directive.js";

export type AnyRec = Record<string, unknown>;

// Pele model shapes the converters read (pele exports the models, not their member types).
type MapVal<M> = M extends Map<unknown, infer V> ? V : never;
export type FlowNode = MapVal<FlowchartModel["nodes"]>;
/** A flowchart edge; `styles` is read as a fallback for `style`. */
export type FlowEdge = FlowchartModel["edges"][number] & { styles?: string[] };
export type FlowModel = Omit<FlowchartModel, "edges"> & { edges: FlowEdge[] };
export type StateStmt = MapVal<StateModel["states"]>;
export type Stmt = StateModel["rootDoc"][number];
export type StateRelation = StateModel["relations"][number];
/** Node of the state graph pele's StateDb builds (`graph` is not on the exported StateModel). */
export interface StateGraphNode { id: string; shape?: string; label?: string; description?: string[]; isGroup?: boolean; parentId?: string }
export type StateModelG = StateModel & { graph?: { nodes?: StateGraphNode[] } };
export type MindmapNode = MindmapModel["nodes"][number];
export type ClassDef = MapVal<FlowchartModel["classes"]> | MapVal<StateModel["classes"]>;
/** `metadata.pele` as mermaidToCanvas writes it (canvases are user files: every key may be missing). */
export interface PeleMeta { type?: string; direction?: string; fidelity?: string; advancedCanvas?: boolean; sourceHash?: string; classDefs?: Record<string, { styles?: string[]; textStyles?: string[] }>; [key: string]: unknown }
/** A Pele model collection: a Map, an array or a plain object (absent counts as empty). */
export type Collection<T> = Map<unknown, T> | T[] | Record<string, T> | null | undefined;
export function mapVals<T>(m: Collection<T>): T[] { if (!m) return []; if (m instanceof Map) return [...m.values()]; if (Array.isArray(m)) return m; return Object.values(m); }
export function mapEntries<T>(m: Collection<T>): [string, T][] { if (!m) return []; if (m instanceof Map) return [...m.entries()].map(([k, v]) => [String(k), v]); if (Array.isArray(m)) return m.map((v, i) => [String(i), v]); return Object.entries(m); }
/** UTF-16 code-unit order, as a bare `.sort()` gives (locale-independent). */
export function cmp(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
/** Append `v` to the list under `k`, starting the list when absent. */
export function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void { const list = m.get(k); if (list) list.push(v); else m.set(k, [v]); }
export function sameUrl(a: string, b: string): boolean { try { return new URL(a).href === new URL(b).href; } catch { return a === b; } }
export function sideFromVector(dx: number, dy: number): Side {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}
export function dirSides(dir: string): { fromSide: Side; toSide: Side } {
  switch (dir) { case "LR": return { fromSide: "right", toSide: "left" }; case "RL": return { fromSide: "left", toSide: "right" }; case "BT": return { fromSide: "top", toSide: "bottom" }; default: return { fromSide: "bottom", toSide: "top" }; }
}
