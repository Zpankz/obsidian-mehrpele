// Hand-rolled extractor over Pele's machine-generated SVG string.
// Contract (pele 1.13.0, pinned by golden fixtures):
//  .pele-node[data-id] transform=translate(cx,cy), child shapes centred at origin
//  .pele-edge[data-id] first non-marker <path d>, .pele-marker children
//  .pele-cluster[data-id] > rect (absolute), title text inside or .pele-cluster-title
export interface BBox { x: number; y: number; width: number; height: number }
export interface NodeGeometry {
  id: string; cx: number; cy: number; bbox: BBox; shapeClass: string; label: string; fill?: string; stroke?: string; shapeCount: number;
  /** First <polygon>, node-local (centre at origin). */
  polygon?: [number, number][];
  /** <circle r> values in document order (double circle: outer, inner). */
  radii: number[];
  /** ry of the first elliptical arc in the node's paths (cylinder cap). */
  arcRy?: number;
  /** x of each vertical bar subpath (`M x,y V y'`) in unfilled paths (subroutine). */
  barXs: number[];
}
export interface EdgeGeometry { id: string; d: string; dashed: boolean; thick: boolean; markers: number }
export interface ClusterGeometry { id: string; bbox: BBox; title: string }
export interface SvgGeometry { nodes: Map<string, NodeGeometry>; edges: Map<string, EdgeGeometry>; clusters: Map<string, ClusterGeometry>; width: number; height: number }

function num(v: string | undefined, d = 0): number { const n = v === undefined ? NaN : parseFloat(v); return Number.isFinite(n) ? n : d; }
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m?.[1];
}
export function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
}
function textOf(inner: string): string {
  const m = /<text\b[^>]*>([\s\S]*?)<\/text>/.exec(inner);
  if (!m) return "";
  return decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim();
}

function shapeBBox(inner: string): { bbox: BBox; shapeCount: number; fill?: string; stroke?: string } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  let fill: string | undefined, stroke: string | undefined;
  const add = (x0: number, y0: number, x1: number, y1: number) => { minX = Math.min(minX, x0); minY = Math.min(minY, y0); maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1); };
  const tagRe = /<(rect|circle|ellipse|polygon|path|line)\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(inner))) {
    const tag = m[0], kind = m[1];
    count++;
    if (fill === undefined) { const f = attr(tag, "fill"); if (f && !f.startsWith("var(") && f !== "none") fill = f; }
    if (stroke === undefined) { const s = attr(tag, "stroke"); if (s && !s.startsWith("var(") && s !== "none") stroke = s; }
    if (kind === "rect") { const x = num(attr(tag, "x")), y = num(attr(tag, "y")); add(x, y, x + num(attr(tag, "width")), y + num(attr(tag, "height"))); }
    else if (kind === "circle") { const cx = num(attr(tag, "cx")), cy = num(attr(tag, "cy")), r = num(attr(tag, "r")); add(cx - r, cy - r, cx + r, cy + r); }
    else if (kind === "ellipse") { const cx = num(attr(tag, "cx")), cy = num(attr(tag, "cy")), rx = num(attr(tag, "rx")), ry = num(attr(tag, "ry")); add(cx - rx, cy - ry, cx + rx, cy + ry); }
    else if (kind === "line") { add(num(attr(tag, "x1")), num(attr(tag, "y1")), num(attr(tag, "x2")), num(attr(tag, "y2"))); }
    else if (kind === "polygon") { for (const [x, y] of parsePoints(attr(tag, "points") ?? "")) add(x, y, x, y); }
    else { for (const [x, y] of pathToPoints(attr(tag, "d") ?? "")) add(x, y, x, y); }
  }
  if (!Number.isFinite(minX)) { minX = minY = 0; maxX = maxY = 0; }
  return { bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, shapeCount: count, fill, stroke };
}

function parsePoints(raw: string): [number, number][] {
  const nums = (raw.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}

function gBlocks(svg: string, cls: string): { attrs: string; id: string; inner: string }[] {
  const out: { attrs: string; id: string; inner: string }[] = [];
  const re = /<g\b([^>]*)>|<\/g>/g;
  const stack: { attrs: string; innerStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    if (m[1] !== undefined) { stack.push({ attrs: m[1], innerStart: re.lastIndex }); continue; }
    const open = stack.pop();
    if (!open) continue;
    const classAttr = attr(open.attrs, "class") ?? "";
    if (!classAttr.split(/\s+/).includes(cls)) continue;
    const id = attr(open.attrs, "data-id");
    if (id !== undefined) out.push({ attrs: open.attrs, id, inner: svg.slice(open.innerStart, m.index) });
  }
  return out.reverse();
}

export function extractGeometry(svg: string): SvgGeometry {
  const vb = /viewBox="([-\d.\s]+)"/.exec(svg);
  const parts = vb ? vb[1].trim().split(/\s+/).map(Number) : [0, 0, 0, 0];
  const nodes = new Map<string, NodeGeometry>();
  for (const b of gBlocks(svg, "pele-node")) {
    // flowchart nodes only: must carry translate(); others (sequence actors) skipped here
    const t = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/.exec(b.attrs);
    if (!t) continue;
    const cx = Number(t[1]), cy = Number(t[2]);
    const shape = /pele-shape-([a-z0-9-]+)/.exec(b.attrs)?.[1] ?? "rect";
    const { bbox: local, shapeCount, fill, stroke } = shapeBBox(b.inner);
    const polyTag = /<polygon\b[^>]*>/.exec(b.inner)?.[0];
    const pathTags = [...b.inner.matchAll(/<path\b[^>]*>/g)].map((x) => x[0]);
    const arc = /[Aa]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(pathTags.map((t) => attr(t, "d") ?? "").join(" "));
    const barXs: number[] = [];
    for (const t of pathTags) {
      const d = (attr(t, "d") ?? "").replace(/\s+/g, "");
      if (attr(t, "fill") !== "none" || !/^(M-?[\d.]+,-?[\d.]+V-?[\d.]+)+$/.test(d)) continue;
      for (const m of d.matchAll(/M(-?[\d.]+),/g)) barXs.push(Number(m[1]));
    }
    nodes.set(b.id, { id: b.id, cx, cy, shapeClass: shape, label: textOf(b.inner), fill, stroke, shapeCount,
      bbox: { x: cx + local.x, y: cy + local.y, width: local.width, height: local.height },
      ...(polyTag ? { polygon: parsePoints(attr(polyTag, "points") ?? "") } : {}),
      radii: [...b.inner.matchAll(/<circle\b[^>]*>/g)].map((x) => num(attr(x[0], "r"))),
      ...(arc ? { arcRy: Math.abs(Number(arc[2])) } : {}),
      barXs });
  }
  const edges = new Map<string, EdgeGeometry>();
  for (const b of gBlocks(svg, "pele-edge")) {
    const paths = [...b.inner.matchAll(/<path\b[^>]*>/g)].map((x) => x[0]);
    const main = paths.find((p) => !p.includes("pele-marker")) ?? paths[0] ?? "";
    edges.set(b.id, { id: b.id, d: attr(main, "d") ?? "", dashed: /stroke-dasharray/.test(main), thick: /stroke-width/.test(main), markers: (b.inner.match(/pele-marker/g) ?? []).length });
  }
  const clusters = new Map<string, ClusterGeometry>();
  const titles = new Map<string, string>();
  for (const b of gBlocks(svg, "pele-cluster-title")) titles.set(b.id, textOf(b.inner));
  for (const b of gBlocks(svg, "pele-cluster")) {
    const rect = /<rect\b[^>]*>/.exec(b.inner)?.[0] ?? "";
    clusters.set(b.id, { id: b.id, title: titles.get(b.id) ?? textOf(b.inner),
      bbox: { x: num(attr(rect, "x")), y: num(attr(rect, "y")), width: num(attr(rect, "width")), height: num(attr(rect, "height")) } });
  }
  return { nodes, edges, clusters, width: parts[2] ?? 0, height: parts[3] ?? 0 };
}

/** Sample an SVG elliptical arc (endpoint parameterisation, SVG 1.1 F.6.5) excluding its start point. */
function arcPoints(x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number, large: boolean, sweep: boolean, x2: number, y2: number, segments = 8): [number, number][] {
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [[x2, y2]];
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) { const k = Math.sqrt(lambda); rx *= k; ry *= k; }
  const num0 = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num0 / (rx * rx * yp * yp + ry * ry * xp * xp)));
  const cxp = (coef * rx * yp) / ry, cyp = (-coef * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
  const out: [number, number][] = [];
  for (let i = 1; i <= segments; i++) {
    if (i === segments) { out.push([x2, y2]); break; }
    const t = t1 + (dt * i) / segments;
    out.push([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]);
  }
  return out;
}

/** Tokenise an SVG path (M/L/C/Q/H/V/A, abs+rel) into absolute polyline points. */
export function pathToPoints(d: string): [number, number][] {
  const tokens = d.match(/[MLCQSTAHVZmlcqstahvz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const pts: [number, number][] = [];
  let i = 0, cmd = "", cx = 0, cy = 0, sx = 0, sy = 0;
  const isCmd = (t: string) => /^[A-Za-z]$/.test(t);
  const nextNum = () => Number(tokens[i++]);
  const push = (x: number, y: number) => { const l = pts[pts.length - 1]; if (!l || Math.abs(l[0] - x) > 1e-9 || Math.abs(l[1] - y) > 1e-9) pts.push([x, y]); };
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++]!;
    if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    if (up === "Z") { push(sx, sy); cmd = ""; continue; }
    if (up === "M" || up === "L") {
      let x = nextNum(), y = nextNum(); if (rel) { x += cx; y += cy; }
      cx = x; cy = y; if (up === "M") { sx = x; sy = y; cmd = rel ? "l" : "L"; } push(x, y);
    } else if (up === "H") { let x = nextNum(); if (rel) x += cx; cx = x; push(cx, cy); }
    else if (up === "V") { let y = nextNum(); if (rel) y += cy; cy = y; push(cx, cy); }
    else if (up === "C") {
      let x1 = nextNum(), y1 = nextNum(), x2 = nextNum(), y2 = nextNum(), x = nextNum(), y = nextNum();
      if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
      const x0 = cx, y0 = cy;
      for (const t of [0.25, 0.5, 0.75, 1]) { const u = 1 - t; push(u*u*u*x0 + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x, u*u*u*y0 + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y); }
      cx = x; cy = y;
    } else if (up === "Q") {
      let x1 = nextNum(), y1 = nextNum(), x = nextNum(), y = nextNum();
      if (rel) { x1 += cx; y1 += cy; x += cx; y += cy; }
      const x0 = cx, y0 = cy;
      for (const t of [0.33, 0.66, 1]) { const u = 1 - t; push(u*u*x0 + 2*u*t*x1 + t*t*x, u*u*y0 + 2*u*t*y1 + t*t*y); }
      cx = x; cy = y;
    } else if (up === "A") {
      const rx = nextNum(), ry = nextNum(), rot = nextNum(), large = nextNum() !== 0, sweep = nextNum() !== 0;
      let x = nextNum(), y = nextNum(); if (rel) { x += cx; y += cy; }
      for (const [px, py] of arcPoints(cx, cy, rx, ry, rot, large, sweep, x, y)) push(px, py);
      cx = x; cy = y;
    } else { // S/T and anything else: consume to next command conservatively
      while (i < tokens.length && !isCmd(tokens[i])) i++;
    }
  }
  return pts;
}
