/**
 * `%% pele-canvas: {…} %%` — what canvasToMermaid knew about the canvas, so
 * mermaidToCanvas can rebuild it exactly for everything the Mermaid text did
 * not change. One compact JSON line, sorted keys.
 *
 * Schema 2 (written now):
 *   { schema: 2, type, direction, scale, layout?, sourceHash?, meta?,
 *     nodes:  { <mermaid id>: { canvasId, x, y, w, h, sig?, keep? } },
 *     groups: { <subgraph id>: { canvasId, x, y, w, h, keep? } },
 *     edges:  { <from>><to>[#n]: { id, fromSide?, toSide?, t?, e?, keep? } } }
 * - x/y/w/h: the card in canvas px.
 * - sig: hash of the node's label, shape and size entry as written; when the
 *   source still says the same, the card keeps its exact size.
 * - t: the edge's Pele type/stroke as written; `keep` style keys that the
 *   Mermaid arrow expresses only apply while it is unchanged.
 * - e: canvas ends left implicit ("f", "t", "ft"), kept implicit on return.
 * - keep: card/edge keys Mermaid cannot express (Advanced Canvas styles,
 *   background, portal data, …), merged back verbatim.
 * - meta: the canvas `metadata` (minus `pele`), e.g. frontmatter.
 * Schema 1 (older files) has nodes/groups with x/y/w/h/canvasId only.
 */
import type { Side } from "./layout-directive.js";

export interface ProvBox {
  canvasId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  sig?: string;
  keep?: Record<string, unknown>;
}

export interface ProvEdge {
  id: string;
  fromSide?: Side;
  toSide?: Side;
  t?: string;
  /** Ends the canvas left implicit: "f" (fromEnd), "t" (toEnd), "ft". */
  e?: string;
  keep?: Record<string, unknown>;
}

export interface Provenance {
  schema: number;
  type?: string;
  direction?: string;
  scale?: number;
  layout?: string;
  sourceHash?: string;
  meta?: Record<string, unknown>;
  nodes: Map<string, ProvBox>;
  groups: Map<string, ProvBox>;
  edges: Map<string, ProvEdge>;
}

const LINE_RE = /%%\s*pele-canvas:\s*(\{.*\})\s*%%/;

/** Card/group entry as read from the JSON line (unvalidated). */
interface RawBox {
  canvasId?: string | number | null;
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
  width?: unknown;
  height?: unknown;
  sig?: unknown;
  keep?: Record<string, unknown> | null;
}

/** Edge entry as read from the JSON line (unvalidated). */
interface RawEdge {
  id?: unknown;
  fromSide?: unknown;
  toSide?: unknown;
  t?: unknown;
  e?: unknown;
  keep?: Record<string, unknown> | null;
}

/** The JSON line as parsed (unvalidated). */
interface RawProvenance {
  schema?: unknown;
  type?: unknown;
  direction?: unknown;
  scale?: unknown;
  layout?: unknown;
  sourceHash?: unknown;
  meta?: Record<string, unknown> | null;
  nodes?: Record<string, RawBox | null> | null;
  groups?: Record<string, RawBox | null> | null;
  edges?: Record<string, RawEdge | null> | null;
}

function box(v: RawBox | null): ProvBox | null {
  if (!v || typeof v !== "object") return null;
  const x = Number(v.x), y = Number(v.y), w = Number(v.w ?? v.width), h = Number(v.h ?? v.height);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  const out: ProvBox = { canvasId: String(v.canvasId ?? ""), x, y, w, h };
  if (typeof v.sig === "string") out.sig = v.sig;
  if (v.keep && typeof v.keep === "object") out.keep = v.keep;
  return out;
}

export function parseProvenance(source: string): Provenance | null {
  const m = LINE_RE.exec(source);
  if (!m) return null;
  let j: RawProvenance | null;
  try {
    j = JSON.parse(m[1]) as RawProvenance | null;
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const p: Provenance = { schema: Number(j.schema) || 1, nodes: new Map(), groups: new Map(), edges: new Map() };
  if (typeof j.type === "string") p.type = j.type;
  if (typeof j.direction === "string") p.direction = j.direction;
  if (Number(j.scale) > 0) p.scale = Number(j.scale);
  if (typeof j.layout === "string") p.layout = j.layout;
  if (typeof j.sourceHash === "string") p.sourceHash = j.sourceHash;
  if (j.meta && typeof j.meta === "object") p.meta = j.meta;
  for (const [k, v] of Object.entries(j.nodes ?? {})) {
    const b = box(v);
    if (b) p.nodes.set(k, b);
  }
  for (const [k, v] of Object.entries(j.groups ?? {})) {
    const b = box(v);
    if (b) p.groups.set(k, b);
  }
  for (const [k, v] of Object.entries(j.edges ?? {})) {
    const e = v;
    if (!e || typeof e !== "object" || typeof e.id !== "string") continue;
    const out: ProvEdge = { id: e.id };
    if (typeof e.fromSide === "string") out.fromSide = e.fromSide as Side;
    if (typeof e.toSide === "string") out.toSide = e.toSide as Side;
    if (typeof e.t === "string") out.t = e.t;
    if (typeof e.e === "string") out.e = e.e;
    if (e.keep && typeof e.keep === "object") out.keep = e.keep;
    p.edges.set(k, out);
  }
  return p;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export function formatProvenance(p: Provenance): string {
  const obj: Record<string, unknown> = {
    schema: 2,
    type: p.type,
    direction: p.direction,
    scale: p.scale,
    layout: p.layout,
    sourceHash: p.sourceHash,
    meta: p.meta && Object.keys(p.meta).length ? p.meta : undefined,
    nodes: Object.fromEntries(p.nodes),
    groups: Object.fromEntries(p.groups),
    edges: p.edges.size ? Object.fromEntries(p.edges) : undefined,
  };
  return `%% pele-canvas: ${JSON.stringify(sortKeys(obj))} %%`;
}

/** The source without its provenance line (unchanged when there is none). */
export function stripProvenance(source: string): string {
  const lines = source.split("\n");
  const kept = lines.filter((l) => !/%%\s*pele-canvas:/.test(l));
  return kept.length === lines.length ? source : kept.join("\n");
}
