/**
 * Headless node boxes from Pele SVG markup: the union bounding box of the
 * shapes inside each `.pele-node[data-id]` group, in SVG user units, with
 * nested `translate()` transforms applied. Text is ignored (it never extends
 * a node box). Pure string parsing, so it works in the CLI and the plugin.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NodeBox {
  id: string;
  classes: string;
  box: Box | null;
}

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function pathPoints(d: string): number[][] {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const pts: number[][] = [];
  let i = 0;
  let cmd = "M";
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++]!;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    if (C === "Z") {
      cx = sx;
      cy = sy;
      continue;
    }
    if (i >= toks.length) break;
    if (C === "H") {
      cx = num() + (rel ? cx : 0);
      pts.push([cx, cy]);
      continue;
    }
    if (C === "V") {
      cy = num() + (rel ? cy : 0);
      pts.push([cx, cy]);
      continue;
    }
    if (C === "A") {
      const rx = num();
      const ry = num();
      num();
      num();
      num();
      const x = num() + ox;
      const y = num() + oy;
      // Endpoints plus the radii around the chord midpoint: a conservative
      // hull for the half/quarter arcs Pele draws (circles, cylinders).
      pts.push([x, y]);
      if (Math.abs(x - cx) < 1e-6 && Math.abs(y - cy) < 1e-6) {
        cx = x;
        cy = y;
        continue;
      }
      const mx = (cx + x) / 2;
      const my = (cy + y) / 2;
      const chord = Math.hypot(x - cx, y - cy);
      if (Math.abs(chord - 2 * rx) < 1 && Math.abs(rx - ry) < 1e-6) {
        // Semicircle: its extreme point lies one radius off the chord.
        const nx = -(y - cy) / chord;
        const ny = (x - cx) / chord;
        pts.push([mx + nx * rx, my + ny * rx], [mx - nx * rx, my - ny * rx]);
      }
      cx = x;
      cy = y;
      continue;
    }
    const n = C === "C" ? 3 : C === "S" || C === "Q" ? 2 : 1;
    let x = 0;
    let y = 0;
    for (let k = 0; k < n; k++) {
      x = num() + ox;
      y = num() + oy;
      pts.push([x, y]);
    }
    cx = x;
    cy = y;
    if (C === "M") {
      sx = x;
      sy = y;
      cmd = rel ? "l" : "L";
    }
  }
  return pts.filter((p) => p.every(Number.isFinite));
}

function attr(attrs: string, name: string): number | undefined {
  const m = new RegExp(`\\s${name}="([-\\d.e+]+)"`).exec(attrs);
  return m ? Number(m[1]) : undefined;
}

function translate(attrs: string): [number, number] {
  const m = /transform="translate\(([-\d.e+]+)(?:[ ,]+([-\d.e+]+))?\)"/.exec(attrs);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : [0, 0];
}

/** Balanced `<g>…</g>` starting at `start`. */
function groupAt(svg: string, start: number): string {
  const re = /<g\b[^>]*?(\/?)>|<\/g>/g;
  re.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    if (m[0] === "</g>") depth--;
    else if (!m[1]) depth++;
    if (depth === 0) return svg.slice(start, m.index + m[0].length);
  }
  return svg.slice(start);
}

/** Union box of the shapes in one group's markup (its own transform excluded). */
export function shapeBox(inner: string): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const stack: [number, number][] = [[0, 0]];
  const re = /<(\/?)(g|rect|circle|ellipse|polygon|polyline|path|line|text|foreignObject)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let first = true;
  let skipDepth = 0;
  while ((m = re.exec(inner))) {
    const [, close, tag, attrs = "", selfClose] = m;
    const [ox, oy] = stack[stack.length - 1];
    if (tag === "text" || tag === "foreignObject") {
      // Labels never extend the box; skip their content.
      if (close) skipDepth = Math.max(0, skipDepth - 1);
      else if (!selfClose) skipDepth++;
      continue;
    }
    if (skipDepth > 0) continue;
    if (tag === "g") {
      if (close) stack.pop();
      else if (!selfClose) {
        const [tx, ty] = first ? [0, 0] : translate(attrs);
        stack.push([ox + tx, oy + ty]);
      }
      first = false;
      continue;
    }
    if (close) continue;
    if (/class="[^"]*pele-marker/.test(attrs)) continue;
    const add = (x: number, y: number): void => {
      x0 = Math.min(x0, x + ox);
      y0 = Math.min(y0, y + oy);
      x1 = Math.max(x1, x + ox);
      y1 = Math.max(y1, y + oy);
    };
    if (tag === "rect") {
      const x = attr(attrs, "x") ?? 0;
      const y = attr(attrs, "y") ?? 0;
      add(x, y);
      add(x + (attr(attrs, "width") ?? 0), y + (attr(attrs, "height") ?? 0));
    } else if (tag === "circle") {
      const cx = attr(attrs, "cx") ?? 0;
      const cy = attr(attrs, "cy") ?? 0;
      const r = attr(attrs, "r") ?? 0;
      add(cx - r, cy - r);
      add(cx + r, cy + r);
    } else if (tag === "ellipse") {
      const cx = attr(attrs, "cx") ?? 0;
      const cy = attr(attrs, "cy") ?? 0;
      const rx = attr(attrs, "rx") ?? 0;
      const ry = attr(attrs, "ry") ?? 0;
      add(cx - rx, cy - ry);
      add(cx + rx, cy + ry);
    } else if (tag === "polygon" || tag === "polyline") {
      const p = /points="([^"]+)"/.exec(attrs)?.[1] ?? "";
      const n = p.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g)?.map(Number) ?? [];
      for (let i = 0; i + 1 < n.length; i += 2) add(n[i], n[i + 1]);
    } else if (tag === "path") {
      const d = /\sd="([^"]+)"/.exec(attrs)?.[1] ?? "";
      for (const [x, y] of pathPoints(d)) add(x, y);
    } else if (tag === "line") {
      add(attr(attrs, "x1") ?? 0, attr(attrs, "y1") ?? 0);
      add(attr(attrs, "x2") ?? 0, attr(attrs, "y2") ?? 0);
    }
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Every `.pele-node[data-id]` group with its box (sequence actors appear twice). */
export function nodeBoxes(svg: string): NodeBox[] {
  const out: NodeBox[] = [];
  const re = /<g\b[^>]*\bclass="([^"]*\bpele-node\b[^"]*)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const id = /\sdata-id="([^"]*)"/.exec(m[0])?.[1];
    if (id === undefined) continue;
    const g = groupAt(svg, m.index);
    const [tx, ty] = translate(m[0]);
    const b = shapeBox(g);
    out.push({ id: decode(id), classes: m[1], box: b ? { x: b.x + tx, y: b.y + ty, w: b.w, h: b.h } : null });
  }
  // Plain mindmap leaves draw text only: their box comes from the layout.
  if (out.some((n) => !n.box && /\bpele-shape-text\b/.test(n.classes)) && /<svg\b[^>]*\bpele-mindmap\b/.test(svg)) {
    const boxes = mindmapTextBoxes(svg);
    for (const n of out) if (!n.box) n.box = boxes.get(n.id) ?? null;
  }
  return out;
}

/** End point x of a path: the last coordinate pair, or a closing `H x`. */
function pathEndX(d: string): number | null {
  const h = /H\s*(-?\d*\.?\d+(?:e[-+]?\d+)?)\s*$/i.exec(d);
  if (h) return Number(h[1]);
  const pts = pathPoints(d);
  return pts.length ? pts[pts.length - 1][0] : null;
}

/**
 * Boxes of plain (borderless) mindmap leaves, which Pele draws as text only.
 * Within each `.pele-branch` group Pele emits one edge per node, in node
 * order, and every edge ends on the near side of its node's layout box
 * (horizontal tree: the last point; vertical tree: the closing `H x`), so
 * the half width is the distance from the node centre to that end. The
 * height is the label's line block (at least one line).
 */
export function mindmapTextBoxes(svg: string): Map<string, Box> {
  const out = new Map<string, Box>();
  const branchRe = /<g\b[^>]*\bclass="pele-branch\b[^"]*"[^>]*>/g;
  let b: RegExpExecArray | null;
  while ((b = branchRe.exec(svg))) {
    const branch = groupAt(svg, b.index);
    const edgesStart = branch.search(/<g\b[^>]*\bclass="pele-edges\b/);
    const edges = edgesStart >= 0 ? groupAt(branch, edgesStart) : "";
    const ends = [...edges.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((p) => pathEndX(p[1]));
    const nodeRe = /<g\b[^>]*\bclass="([^"]*\bpele-node\b[^"]*)"[^>]*>/g;
    nodeRe.lastIndex = edgesStart >= 0 ? edgesStart + edges.length : 0;
    let n: RegExpExecArray | null;
    let i = 0;
    while ((n = nodeRe.exec(branch))) {
      const k = i++;
      if (!/\bpele-shape-text\b/.test(n[1])) continue;
      const id = /\sdata-id="([^"]*)"/.exec(n[0])?.[1];
      const end = ends[k];
      if (id === undefined || end === null || end === undefined) continue;
      const [tx, ty] = translate(n[0]);
      const half = Math.abs(tx - end);
      if (!(half > 0)) continue;
      const ys = [...groupAt(branch, n.index).matchAll(/<(?:tspan|text)\b[^>]*\sy="([-\d.e+]+)"/g)].map((y) => Number(y[1]));
      // Baselines sit 0.35 em below each line's centre; lines are 1.5 em apart.
      const step = ys.length > 1 ? (ys[ys.length - 1] - ys[0]) / (ys.length - 1) : ys.length === 1 && ys[0] > 0 ? (ys[0] / 0.35) * 1.5 : 24;
      const h = Math.max(1, ys.length) * step;
      out.set(decode(id), { x: tx - half, y: ty - h / 2, w: 2 * half, h });
    }
  }
  return out;
}

/** First box per id. */
export function nodeBoxMap(svg: string): Map<string, Box> {
  const map = new Map<string, Box>();
  for (const n of nodeBoxes(svg)) if (n.box && !map.has(n.id)) map.set(n.id, n.box);
  return map;
}
