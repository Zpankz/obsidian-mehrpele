/**
 * Orthogonal edge routing for the canvas layout: an edge leaves its source
 * from the middle of a side, runs a short stub straight out, then follows a
 * shortest right-angled path (few bends) around the other nodes, and enters
 * the target side the same way. A* over a sparse grid made of the obstacle
 * margins and the stub ends; searched first in a window around the two
 * nodes, then over everything. Pure geometry, no Pele, no DOM.
 */
import type { Side } from "./directive.js";

/** Axis-aligned box, top-left based. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RouteOptions {
  /** Clearance kept around obstacles. */
  margin?: number;
  /** Straight run out of / into a side. */
  stub?: number;
  /** Cost of one bend, in length units. */
  bend?: number;
  /** Shared search budget (A* expansions); when spent, edges fall back to elbows. */
  budget?: { left: number };
}

/** A* expansions one layout may spend on routing (then elbows): keeps renders bounded. */
export const ROUTE_BUDGET = 400_000;

const NORMAL: Record<Side, [number, number]> = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

/** Middle of a side. */
export function sidePoint(r: Rect, side: Side): [number, number] {
  switch (side) {
    case "top":
      return [r.x + r.w / 2, r.y];
    case "bottom":
      return [r.x + r.w / 2, r.y + r.h];
    case "left":
      return [r.x, r.y + r.h / 2];
    default:
      return [r.x + r.w, r.y + r.h / 2];
  }
}

/** Sides facing each other: the axis with the larger gap between the boxes wins. */
export function autoSides(a: Rect, b: Rect): [Side, Side] {
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  const horizontal = gapX > 0 || gapY > 0 ? gapX >= gapY : Math.abs(dx) >= Math.abs(dy);
  if (horizontal) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

/** One side when only the other end is known. */
export function autoSide(from: Rect, to: Rect): Side {
  return autoSides(from, to)[0];
}

const inside = (r: Rect, x: number, y: number) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;
const grow = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });

/** Removes repeated and collinear points (flat [x,y,…]). */
export function simplify(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2] - x) < 0.01 && Math.abs(out[n - 1] - y) < 0.01) continue;
    if (n >= 4) {
      const ax = out[n - 4], ay = out[n - 3], bx = out[n - 2], by = out[n - 1];
      if ((Math.abs(ax - bx) < 0.01 && Math.abs(bx - x) < 0.01) || (Math.abs(ay - by) < 0.01 && Math.abs(by - y) < 0.01)) {
        out[n - 2] = x;
        out[n - 1] = y;
        continue;
      }
    }
    out.push(x, y);
  }
  return out;
}

// Directions: 0 right, 1 down, 2 left, 3 up.
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
function dirOf(side: Side, inward: boolean): number {
  const [nx, ny] = NORMAL[side];
  const d = nx === 1 ? 0 : ny === 1 ? 1 : nx === -1 ? 2 : 3;
  return inward ? (d + 2) & 3 : d;
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.k.length;
  }
  push(key: number, val: number): void {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]!;
      v[i] = v[p]!;
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]!;
        v[i] = v[c]!;
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}

function uniqSorted(a: number[]): number[] {
  const s = [...a].sort((p, q) => p - q);
  const out: number[] = [];
  for (const x of s) if (!out.length || x - out[out.length - 1] > 0.01) out.push(x);
  return out;
}

/** A* between two stub ends; null when no path exists inside `win`. */
function search(
  s: [number, number],
  sDir: number,
  e: [number, number],
  eDir: number,
  obstacles: Rect[],
  m: number,
  bend: number,
  win: Rect | null,
  budget?: { left: number },
): number[] | null {
  const obs = (win ? obstacles.filter((o) => o.x < win.x + win.w && o.x + o.w > win.x && o.y < win.y + win.h && o.y + o.h > win.y) : obstacles).map((o) => grow(o, m - 0.5));
  const xsRaw = [s[0], e[0], (s[0] + e[0]) / 2];
  const ysRaw = [s[1], e[1], (s[1] + e[1]) / 2];
  for (const o of obs) {
    xsRaw.push(o.x - 0.5, o.x + o.w + 0.5);
    ysRaw.push(o.y - 0.5, o.y + o.h + 0.5);
  }
  if (win) {
    xsRaw.push(win.x, win.x + win.w);
    ysRaw.push(win.y, win.y + win.h);
  }
  let xs = uniqSorted(xsRaw);
  let ys = uniqSorted(ysRaw);
  if (win) {
    xs = xs.filter((x) => x >= win.x - 0.01 && x <= win.x + win.w + 0.01);
    ys = ys.filter((y) => y >= win.y - 0.01 && y <= win.y + win.h + 0.01);
  }
  const W = xs.length, H = ys.length;
  const find = (arr: number[], v: number) => arr.findIndex((a) => Math.abs(a - v) <= 0.01);
  const si = find(xs, s[0]), sj = find(ys, s[1]), ei = find(xs, e[0]), ej = find(ys, e[1]);
  if (si < 0 || sj < 0 || ei < 0 || ej < 0) return null;
  const blocked = (x: number, y: number) => obs.some((o) => inside(o, x, y));
  const N = W * H * 4;
  const g = new Float64Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const heap = new Heap();
  const h = (i: number, j: number) => Math.abs(xs[i] - e[0]) + Math.abs(ys[j] - e[1]);
  const start = (sj * W + si) * 4 + sDir;
  g[start] = 0;
  heap.push(h(si, sj), start);
  let goal = -1;
  let best = Infinity;
  while (heap.size) {
    if (budget && --budget.left <= 0) return null;
    const st = heap.pop();
    const d = st & 3;
    const cell = st >> 2;
    const i = cell % W, j = (cell / W) | 0;
    const cost = g[st];
    if (cost + h(i, j) >= best) break;
    if (i === ei && j === ej) {
      const total = cost + (d === eDir ? 0 : bend * (d === ((eDir + 2) & 3) ? 2 : 1));
      if (total < best) {
        best = total;
        goal = st;
      }
      continue;
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === ((d + 2) & 3)) continue;
      const ni = i + DX[nd], nj = j + DY[nd];
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const mx = (xs[i] + xs[ni]) / 2, my = (ys[j] + ys[nj]) / 2;
      if (blocked(mx, my) || blocked(xs[ni], ys[nj])) continue;
      const nc = cost + Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]) + (nd === d ? 0 : bend);
      const ns = (nj * W + ni) * 4 + nd;
      if (nc < g[ns]) {
        g[ns] = nc;
        from[ns] = st;
        heap.push(nc + h(ni, nj), ns);
      }
    }
  }
  if (goal < 0) return null;
  const pts: number[] = [];
  for (let st = goal; st >= 0; st = from[st]!) {
    const cell = st >> 2;
    pts.push(ys[(cell / W) | 0], xs[cell % W]);
  }
  pts.reverse();
  return pts;
}

/** One attempt: stub ends must be clear; null when A* finds nothing. */
function attempt(a: Rect, as: Side, b: Rect, bs: Side, obstacles: Rect[], m: number, stub: number, bend: number, budget?: { left: number }): number[] | null {
  const p0 = sidePoint(a, as), pn = sidePoint(b, bs);
  const [ax, ay] = NORMAL[as], [bx, by] = NORMAL[bs];
  const s: [number, number] = [p0[0] + ax * stub, p0[1] + ay * stub];
  const e: [number, number] = [pn[0] + bx * stub, pn[1] + by * stub];
  const blockedBy = (pt: [number, number]) => obstacles.some((o) => inside(grow(o, m - 1), pt[0], pt[1]));
  if (blockedBy(s) || blockedBy(e)) return null;
  const sDir = dirOf(as, false), eDir = dirOf(bs, true);
  const pad = 4 * m + 80;
  const x1 = Math.min(s[0], e[0], a.x, b.x) - pad, x2 = Math.max(s[0], e[0], a.x + a.w, b.x + b.w) + pad;
  const y1 = Math.min(s[1], e[1], a.y, b.y) - pad, y2 = Math.max(s[1], e[1], a.y + a.h, b.y + b.h) + pad;
  const mid =
    search(s, sDir, e, eDir, obstacles, m, bend, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, budget) ??
    (budget && budget.left <= 0 ? null : search(s, sDir, e, eDir, obstacles, m, bend, null, budget));
  return mid ? simplify([p0[0], p0[1], ...mid, pn[0], pn[1]]) : null;
}

function pathCost(pts: number[], bend: number): number {
  let c = 0;
  for (let i = 2; i < pts.length; i += 2) c += Math.abs(pts[i] - pts[i - 2]) + Math.abs(pts[i + 1] - pts[i - 1]);
  return c + bend * Math.max(0, pts.length / 2 - 2);
}

/**
 * Route from `a` to `b` around `obstacles` (which must not include `a` or
 * `b`). Pinned sides are kept; a free side (undefined) is chosen from the
 * facing sides first, then the others when that is blocked. Tries a normal
 * then a tight clearance; if every attempt fails, a plain elbow through the
 * stubs. Returns a flat [x,y,…] polyline from side middle to side middle,
 * and the sides used.
 */
export function routeEdge(
  a: Rect,
  b: Rect,
  pinned: { from?: Side; to?: Side },
  obstacles: Rect[],
  opts: RouteOptions = {},
): { pts: number[]; from: Side; to: Side } {
  const m = opts.margin ?? 10;
  const bend = opts.bend ?? 40;
  const stub = opts.stub ?? 16;
  const [fa, ta] = autoSides(a, b);
  const all: Side[] = ["top", "right", "bottom", "left"];
  const fromC = pinned.from ? [pinned.from] : [fa, ...all.filter((x) => x !== fa)];
  const toC = pinned.to ? [pinned.to] : [ta, ...all.filter((x) => x !== ta)];
  const pref = (f: Side, t: Side) => (f === fa ? 0 : 1) + (t === ta ? 0 : 1);
  const pairs: [Side, Side][] = [];
  for (const f of fromC) for (const t of toC) pairs.push([f, t]);
  pairs.sort((p, q) => pref(p[0], p[1]) - pref(q[0], q[1]));
  // The facing pair and those one side away from it (≤ 7), never all 16.
  for (let i = pairs.length - 1; i >= 0; i--) if (pref(pairs[i][0], pairs[i][1]) > 1) pairs.splice(i, 1);
  const budget = opts.budget;
  for (const [mm, st] of [[m, stub], [Math.min(m, 3), Math.min(stub, 8)]] as const) {
    let best: { pts: number[]; from: Side; to: Side; cost: number } | null = null;
    for (const [f, t] of pairs) {
      if (budget && budget.left <= 0) break;
      // The preferred pair is taken when it routes; other pairs compete on cost.
      const pts = attempt(a, f, b, t, obstacles, mm, st, bend, budget);
      if (!pts) continue;
      const cost = pathCost(pts, bend) + 60 * pref(f, t);
      if (!best || cost < best.cost) best = { pts, from: f, to: t, cost };
      if (pref(f, t) === 0) break;
    }
    if (best) return { pts: best.pts, from: best.from, to: best.to };
  }
  const f = fromC[0], t = toC[0];
  return { pts: elbow(a, f, b, t, stub), from: f, to: t };
}

function elbow(a: Rect, as: Side, b: Rect, bs: Side, stub: number): number[] {
  const p0 = sidePoint(a, as), pn = sidePoint(b, bs);
  const [ax, ay] = NORMAL[as], [bx, by] = NORMAL[bs];
  const s = [p0[0] + ax * stub, p0[1] + ay * stub], e = [pn[0] + bx * stub, pn[1] + by * stub];
  const mid = ax !== 0 ? [s[0], s[1], (s[0] + e[0]) / 2, s[1], (s[0] + e[0]) / 2, e[1], e[0], e[1]] : [s[0], s[1], s[0], (s[1] + e[1]) / 2, e[0], (s[1] + e[1]) / 2, e[0], e[1]];
  return simplify([p0[0], p0[1], ...mid, pn[0], pn[1]]);
}

/** Route with fixed sides (see routeEdge). */
export function routeOrthogonal(a: Rect, as: Side, b: Rect, bs: Side, obstacles: Rect[], opts: RouteOptions = {}): number[] {
  return routeEdge(a, b, { from: as, to: bs }, obstacles, opts).pts;
}

/** Midpoint of the longest segment (edge label anchor). */
export function labelAnchor(pts: number[]): [number, number] {
  let best = -1;
  let at: [number, number] = [pts[0] ?? 0, pts[1] ?? 0];
  for (let i = 2; i < pts.length; i += 2) {
    const len = Math.abs(pts[i] - pts[i - 2]) + Math.abs(pts[i + 1] - pts[i - 1]);
    if (len > best) {
      best = len;
      at = [(pts[i] + pts[i - 2]) / 2, (pts[i + 1] + pts[i - 1]) / 2];
    }
  }
  return at;
}
