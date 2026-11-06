/**
 * Canvas layout mode for flowcharts: `%% pele-layout canvas %%` renders the
 * nodes at the centres given by `%% pele-pos … %%` instead of Pele's layered
 * layout, so a diagram converted from an Obsidian Canvas looks like it.
 *
 * Pele's flowchart renderer takes an optional layout variant (the hook its
 * swimlane diagram uses): `render(model, config, options, variant)` measures
 * every node and label, then calls `variant.layout(nodes, edges, …)` to place
 * them, and draws shapes, labels, clusters, edge paths and arrowheads from
 * the result. This wrapper supplies that layout:
 *
 * - nodes keep Pele's measured size (so `pele-size` still sizes them) and
 *   sit at their pinned centre;
 * - nodes without an entry are placed next to their pinned neighbours,
 *   offset as in Pele's own layout of the same diagram, then nudged off any
 *   overlap;
 * - subgraphs wrap their members (Pele's cluster padding), at least as large
 *   as a pinned `x,y,w,h` box;
 * - edges leave and enter the pinned sides (`A>B=right,left`), or the sides
 *   facing each other, and are routed orthogonally around other nodes
 *   (route.ts); labels sit on the longest segment.
 *
 * Without the directive, or for other diagram types, rendering is unchanged.
 * Any failure falls back to Pele's own layout.
 */
import type { Diagram } from "pele";
import { directiveMeta, wrapDiagram, type RenderArgs } from "../directive/wrap.js";
import { edgeKey, parseLayoutDirective, type CanvasLayout } from "./directive.js";
import { labelAnchor, ROUTE_BUDGET, routeEdge, type Rect } from "./route.js";
import { parseSvgGeometry } from "./svg-geom.js";

const LAYOUT = Symbol.for("pele-render.canvas-layout");

/** Pele's compound-layout node (pele/dist/layout/compound.d.ts). */
interface CNode {
  w: number;
  h: number;
  parent: number;
  isGroup: boolean;
  padX: number;
  padTop: number;
  padBottom: number;
  minW: number;
  x: number;
  y: number;
}
interface CEdge {
  src: number;
  dst: number;
  labelW: number;
  labelH: number;
  route: number[];
  labelX: number;
  labelY: number;
}
interface FlowGraphNode {
  id: string;
  isGroup?: boolean;
  parentId?: string;
}
interface FlowVariant {
  type: string;
  prepare(graph: { nodes: FlowGraphNode[] }): void;
  layout(nodes: CNode[], edges: CEdge[], dir: string, opt: unknown, tight: boolean): { width: number; height: number };
}

const GAP = 24;

const rectOf = (n: CNode): Rect => ({ x: n.x - n.w / 2, y: n.y - n.h / 2, w: n.w, h: n.h });
/** Smallest rect holding both. */
const unionRect = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const overlaps = (a: Rect, b: Rect, gap = 0) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** Node centres of Pele's own layout (for placing unpinned nodes). */
function autoCentres<M>(d: Diagram<M>, model: M, config: RenderArgs<M>[1], options: RenderArgs<M>[2]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  try {
    const geom = parseSvgGeometry(d.render(model, config, options).svg);
    for (const [id, b] of geom.nodes) out.set(id, { x: b.cx, y: b.cy });
  } catch {
    /* no hints */
  }
  return out;
}

function canvasVariant(layout: CanvasLayout, auto: () => Map<string, { x: number; y: number }>): FlowVariant {
  let graph: { nodes: FlowGraphNode[] } = { nodes: [] };
  return {
    type: "flowchart",
    prepare(g) {
      graph = g;
    },
    layout(nodes, edges, dir) {
      const ids = graph.nodes.map((n) => n.id);
      const leaves = nodes.map((_, i) => i).filter((i) => !nodes[i].isGroup);
      const placed = new Set<number>();
      // 1. pinned leaves
      for (const i of leaves) {
        const p = layout.pos.get(ids[i]);
        if (p) {
          nodes[i].x = p.x;
          nodes[i].y = p.y;
          placed.add(i);
        }
      }
      // 2. unpinned leaves: next to placed neighbours, as Pele would offset them
      const pending = leaves.filter((i) => !placed.has(i));
      if (pending.length) {
        const a = auto();
        const deltaOf = (set: Iterable<number>) => {
          let sx = 0, sy = 0, k = 0;
          for (const j of set) {
            const q = a.get(ids[j]);
            if (!q) continue;
            sx += nodes[j].x - q.x;
            sy += nodes[j].y - q.y;
            k++;
          }
          return k ? { x: sx / k, y: sy / k } : null;
        };
        const global = deltaOf(placed) ?? { x: 0, y: 0 };
        const neighbours = (i: number) => {
          const out: number[] = [];
          for (const e of edges) {
            if (e.src === i && placed.has(e.dst)) out.push(e.dst);
            else if (e.dst === i && placed.has(e.src)) out.push(e.src);
          }
          return out;
        };
        const vertical = dir === "TB" || dir === "BT";
        const queue = [...pending];
        // Nodes with placed neighbours first, repeatedly (chains of new nodes).
        for (let guard = 0; queue.length && guard < 4 * pending.length + 4; guard++) {
          const idx = queue.findIndex((i) => neighbours(i).length > 0);
          const i = idx >= 0 ? queue.splice(idx, 1)[0] : queue.shift()!;
          const q = a.get(ids[i]) ?? { x: 0, y: 0 };
          const near = neighbours(i);
          const delta = (near.length ? deltaOf(near) : null) ?? global;
          const n = nodes[i];
          n.x = q.x + delta.x;
          n.y = q.y + delta.y;
          for (let step = 0; step < 200; step++) {
            const r = rectOf(n);
            const hit = [...placed].find((j) => overlaps(r, rectOf(nodes[j]), GAP));
            if (hit === undefined) break;
            const o = rectOf(nodes[hit]);
            if (vertical) n.y = o.y + o.h + GAP + n.h / 2;
            else n.x = o.x + o.w + GAP + n.w / 2;
          }
          placed.add(i);
        }
      }
      // 3. groups, innermost first: wrap the members, at least the pinned box
      const depth = (i: number) => {
        let d = 0;
        for (let p = nodes[i].parent; p >= 0 && d < 1000; p = nodes[p].parent) d++;
        return d;
      };
      const groups = nodes.map((_, i) => i).filter((i) => nodes[i].isGroup).sort((p, q) => depth(q) - depth(p));
      for (const gi of groups) {
        const g = nodes[gi];
        const kids = nodes.map((_, i) => i).filter((i) => nodes[i].parent === gi && i !== gi);
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const k of kids) {
          const r = rectOf(nodes[k]);
          x1 = Math.min(x1, r.x);
          y1 = Math.min(y1, r.y);
          x2 = Math.max(x2, r.x + r.w);
          y2 = Math.max(y2, r.y + r.h);
        }
        const pin = layout.pos.get(ids[gi]);
        let rect: Rect | null = kids.length ? { x: x1 - g.padX, y: y1 - g.padTop, w: x2 - x1 + 2 * g.padX, h: y2 - y1 + g.padTop + g.padBottom } : null;
        if (pin && pin.w !== undefined && pin.h !== undefined) {
          const pr = { x: pin.x - pin.w / 2, y: pin.y - pin.h / 2, w: pin.w, h: pin.h };
          rect = rect ? unionRect(rect, pr) : pr;
        }
        if (!rect) {
          const c = pin ?? { x: 0, y: 0 };
          const w = Math.max(g.minW, 2 * g.padX), h = g.padTop + g.padBottom;
          rect = { x: c.x - w / 2, y: c.y - h / 2, w, h };
        }
        if (rect.w < g.minW) {
          rect.x -= (g.minW - rect.w) / 2;
          rect.w = g.minW;
        }
        g.w = rect.w;
        g.h = rect.h;
        g.x = rect.x + rect.w / 2;
        g.y = rect.y + rect.h / 2;
      }
      // 4. edges: pinned or facing sides, orthogonal routes around the other leaves
      const pairs = new Map<string, number>();
      const leafRects = leaves.map((i) => ({ i, r: rectOf(nodes[i]) }));
      const budget = { left: ROUTE_BUDGET };
      for (const e of edges) {
        const pk = `${e.src}\u0000${e.dst}`;
        const n = (pairs.get(pk) ?? 0) + 1;
        pairs.set(pk, n);
        e.route = [];
        if (e.src === e.dst) continue;
        const A = rectOf(nodes[e.src]), B = rectOf(nodes[e.dst]);
        const ports = layout.ports.get(edgeKey(ids[e.src], ids[e.dst], n)) ?? {};
        // A subgraph endpoint is entered at its border: its members are not in the way.
        const within = (i: number, gi: number) => {
          for (let p = nodes[i].parent, k = 0; p >= 0 && k < 1000; p = nodes[p].parent, k++) if (p === gi) return true;
          return false;
        };
        const obstacles = leafRects
          .filter(({ i }) => i !== e.src && i !== e.dst && !(nodes[e.src].isGroup && within(i, e.src)) && !(nodes[e.dst].isGroup && within(i, e.dst)))
          .map(({ r }) => r);
        const { pts } = routeEdge(A, B, ports, obstacles, { budget });
        for (let k = 0; k < pts.length; k += 2) {
          const horizontal = k === 0 ? Math.abs(pts[3] - pts[1]) < 0.01 : Math.abs(pts[k + 1] - pts[k - 1]) < 0.01;
          e.route.push(pts[k], pts[k + 1], horizontal ? 1 : 0);
        }
        if (e.labelW > 0) [e.labelX, e.labelY] = labelAnchor(pts);
      }
      // 5. origin at 0,0 (Pele adds its padding and title offset)
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      const add = (x: number, y: number, w = 0, h = 0) => {
        x1 = Math.min(x1, x - w / 2);
        y1 = Math.min(y1, y - h / 2);
        x2 = Math.max(x2, x + w / 2);
        y2 = Math.max(y2, y + h / 2);
      };
      for (const n of nodes) add(n.x, n.y, n.w, n.h);
      for (const e of edges) {
        for (let k = 0; k < e.route.length; k += 3) add(e.route[k], e.route[k + 1]);
        if (e.labelW > 0) add(e.labelX, e.labelY, e.labelW, e.labelH);
      }
      if (!Number.isFinite(x1)) return { width: 0, height: 0 };
      for (const n of nodes) {
        n.x -= x1;
        n.y -= y1;
      }
      for (const e of edges) {
        for (let k = 0; k < e.route.length; k += 3) {
          e.route[k] -= x1;
          e.route[k + 1] -= y1;
        }
        e.labelX -= x1;
        e.labelY -= y1;
      }
      return { width: x2 - x1, height: y2 - y1 };
    },
  };
}

interface LayoutMeta {
  layout: CanvasLayout;
}

/** Wrap Pele's flowchart so `%% pele-layout canvas %%` pins node positions. */
export function withCanvasLayout<M>(d: Diagram<M>): Diagram<M> {
  if (d.type !== "flowchart") return d;
  return wrapDiagram<M, LayoutMeta>(d, LAYOUT, {
    marker: "pele-layout",
    read(source) {
      const layout = parseLayoutDirective(source);
      return layout.mode === "canvas" ? { layout } : undefined;
    },
    render(model, meta, config, options) {
      let auto: Map<string, { x: number; y: number }> | null = null;
      const variant = canvasVariant(meta.layout, () => (auto ??= autoCentres(d, model, config, options)));
      // Orthogonal routes: Pele's step curves round each corner with a small
      // radius (other curves smooth whole segments). A configured curve wins.
      const fc = config?.flowchart;
      const cfg = { ...config, flowchart: { curve: "step", ...(fc && typeof fc === "object" ? fc : {}) } };
      try {
        return (d.render as (m: M, c: unknown, o: unknown, v: FlowVariant) => ReturnType<Diagram<M>["render"]>)(model, cfg, options, variant);
      } catch {
        return d.render(model, config, options);
      }
    },
  });
}

/** Whether a parsed model renders in canvas layout mode. */
export function usesCanvasLayout(model: unknown): boolean {
  return !!directiveMeta(model, LAYOUT);
}
