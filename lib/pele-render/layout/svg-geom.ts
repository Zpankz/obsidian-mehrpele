import { attr, decodeEntitiesAmpFirst, num } from "../svg/read.js";

export interface BBox { x: number; y: number; width: number; height: number; cx: number; cy: number }
export interface EdgeGeom { sx: number; sy: number; ex: number; ey: number; d: string }
export interface SvgGeometry {
  width: number; height: number;
  nodes: Map<string, BBox>;
  clusters: Map<string, BBox>;
  edges: Map<string, EdgeGeom>;
}


/** Parse path d: return list of absolute points (M/L endpoints, arc endpoints, H/V). */
export function pathPoints(d: string): { x: number; y: number }[] {
  const tokens = d.match(/[MLHVCAZmlhvcaz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const pts: { x: number; y: number }[] = [];
  let i = 0; let cmd = ""; let cx = 0; let cy = 0;
  const read = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z]$/.test(t)) { cmd = t; i++; if (cmd === "Z" || cmd === "z") continue; }
    if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();
    if (c === "M" || c === "L") {
      let x = read(), y = read(); if (rel) { x += cx; y += cy; } cx = x; cy = y; pts.push({ x, y }); if (c === "M") cmd = rel ? "l" : "L";
    } else if (c === "H") { let x = read(); if (rel) x += cx; cx = x; pts.push({ x: cx, y: cy }); }
    else if (c === "V") { let y = read(); if (rel) y += cy; cy = y; pts.push({ x: cx, y: cy }); }
    else if (c === "C") { read(); read(); read(); read(); let x = read(), y = read(); if (rel) { x += cx; y += cy; } cx = x; cy = y; pts.push({ x, y }); }
    else if (c === "A") { read(); read(); read(); read(); read(); let x = read(), y = read(); if (rel) { x += cx; y += cy; } cx = x; cy = y; pts.push({ x, y }); }
    else { i++; }
  }
  return pts;
}

interface GFrame { tx: number; ty: number; nodeId?: string; clusterId?: string; edgeId?: string; nodeBBox?: BBox | null; edgeD?: string }

export function parseSvgGeometry(svg: string): SvgGeometry {
  const nodes = new Map<string, BBox>();
  const clusters = new Map<string, BBox>();
  const edges = new Map<string, EdgeGeom>();
  let width = 0, height = 0;
  const vb = svg.match(/viewBox="([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)"/);
  if (vb) { width = parseFloat(vb[3]); height = parseFloat(vb[4]); }

  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g;
  const stack: GFrame[] = [];
  let m: RegExpExecArray | null;
  const cum = () => stack.reduce((a, f) => ({ x: a.x + f.tx, y: a.y + f.ty }), { x: 0, y: 0 });

  /** Translate of `frame` in SVG coordinates (its ancestors' and its own). */
  const originOf = (frame: GFrame) => { let x = 0, y = 0; for (const f of stack) { x += f.tx; y += f.ty; if (f === frame) break; } return { x, y }; };

  while ((m = tagRe.exec(svg)) !== null) {
    const closing = m[1] === "/";
    const tagName = m[2];
    const tag = m[0];
    const selfClosing = tag.endsWith("/>");
    if (tagName === "g") {
      if (closing) {
        const frame = stack.pop();
        if (frame) {
          if (frame.nodeId) {
            // The box of the node's first shape (already absolute); without one, a
            // default box around the node's translate (the stack now holds its ancestors).
            if (frame.nodeBBox) nodes.set(frame.nodeId, frame.nodeBBox);
            else {
              const c = cum();
              const cx = c.x + frame.tx, cy = c.y + frame.ty;
              nodes.set(frame.nodeId, { x: cx - 40, y: cy - 15, width: 80, height: 30, cx, cy });
            }
          }
          if (frame.edgeId && frame.edgeD && !edges.has(frame.edgeId)) {
            const pts = pathPoints(frame.edgeD);
            if (pts.length >= 2) edges.set(frame.edgeId, { sx: pts[0].x, sy: pts[0].y, ex: pts[pts.length - 1].x, ey: pts[pts.length - 1].y, d: frame.edgeD });
            else if (pts.length === 1) edges.set(frame.edgeId, { sx: pts[0].x, sy: pts[0].y, ex: pts[0].x, ey: pts[0].y, d: frame.edgeD });
          }
        }
        continue;
      }
      const cls = attr(tag, "class") ?? "";
      const dataId = attr(tag, "data-id");
      const tr = tag.match(/transform="translate\(([^,]+),([^)]+)\)"/);
      const frame: GFrame = { tx: tr ? num(tr[1]) : 0, ty: tr ? num(tr[2]) : 0 };
      if (cls.includes("pele-node") && dataId) frame.nodeId = decodeEntitiesAmpFirst(dataId);
      if (cls.includes("pele-cluster") && dataId) frame.clusterId = decodeEntitiesAmpFirst(dataId);
      if (cls.includes("pele-edge") && dataId) frame.edgeId = decodeEntitiesAmpFirst(dataId);
      stack.push(frame);
      if (selfClosing) stack.pop();
      continue;
    }
    if (closing) continue;
    // Shape elements: the first shape in a node frame is its box (a stateEnd's
    // outer circle comes first). Find the nearest enclosing node/cluster/edge frame.
    let nodeFrame: GFrame | undefined, clusterFrame: GFrame | undefined, edgeFrame: GFrame | undefined;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (!nodeFrame && stack[i].nodeId) nodeFrame = stack[i];
      if (!clusterFrame && stack[i].clusterId) clusterFrame = stack[i];
      if (!edgeFrame && stack[i].edgeId) edgeFrame = stack[i];
    }
    const clusterId = clusterFrame?.clusterId;
    if (tagName === "rect" && clusterId && !nodeFrame) {
      // Cluster rects are usually absolute (no translate on the cluster's ancestors).
      const x = num(attr(tag, "x")), y = num(attr(tag, "y")), w = num(attr(tag, "width")), h = num(attr(tag, "height"));
      const c = cum();
      const bx = x + c.x, by = y + c.y;
      clusters.set(clusterId, { x: bx, y: by, width: w, height: h, cx: bx + w / 2, cy: by + h / 2 });
      continue;
    }
    if (tagName === "path" && edgeFrame && !edgeFrame.edgeD) { edgeFrame.edgeD = attr(tag, "d") ?? ""; continue; }
    if (!nodeFrame || nodeFrame.nodeBBox) continue;
    // The node's centre is its translate, not the middle of its shape.
    const { x: cx, y: cy } = originOf(nodeFrame);
    const box = nodeShapeBox(tagName, tag, edgeFrame !== undefined, cx, cy);
    if (box) nodeFrame.nodeBBox = box;
  }
  return { width, height, nodes, clusters, edges };
}

/**
 * Absolute box of one shape tag in a node centred at (cx, cy), or null when
 * the tag doesn't give the node a box (not a shape, an edge marker circle, a
 * mindmap's id-less `.pele-edge` path, no points).
 */
function nodeShapeBox(tagName: string, tag: string, inEdge: boolean, cx: number, cy: number): BBox | null {
  if (tagName === "rect") {
    const x = num(attr(tag, "x")), y = num(attr(tag, "y")), w = num(attr(tag, "width")), h = num(attr(tag, "height"));
    return { x: cx + x, y: cy + y, width: w, height: h, cx, cy };
  }
  if (tagName === "circle") {
    if (inEdge && isMarkerTag(tag)) return null;
    const r = num(attr(tag, "r")), ccx = num(attr(tag, "cx")), ccy = num(attr(tag, "cy"));
    return { x: cx + ccx - r, y: cy + ccy - r, width: 2 * r, height: 2 * r, cx, cy };
  }
  if (tagName === "polygon") {
    const nums = (attr(tag, "points") ?? "").trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    if (nums.length < 2) return null;
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) { xs.push(nums[i]); ys.push(nums[i + 1]); }
    return spanBox(xs, ys, cx, cy);
  }
  if (tagName === "path") {
    if ((attr(tag, "class") ?? "").includes("pele-edge")) return null;
    const d = attr(tag, "d") ?? "";
    const pts = d ? pathPoints(d) : [];
    return pts.length ? spanBox(pts.map(p => p.x), pts.map(p => p.y), cx, cy) : null;
  }
  return null;
}

/** Box spanning node-local coordinates, placed at the node centre (cx, cy). */
function spanBox(xs: number[], ys: number[], cx: number, cy: number): BBox {
  const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
  return { x: cx + x1, y: cy + y1, width: x2 - x1, height: y2 - y1, cx, cy };
}
/** Whether a tag is an edge marker (`class` includes `pele-marker`). */
function isMarkerTag(tag: string): boolean { return (attr(tag, "class") ?? "").includes("pele-marker"); }
