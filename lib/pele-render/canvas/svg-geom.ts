export interface BBox { x: number; y: number; width: number; height: number; cx: number; cy: number }
export interface EdgeGeom { sx: number; sy: number; ex: number; ey: number; d: string }
export interface SvgGeometry {
  width: number; height: number;
  nodes: Map<string, BBox>;
  clusters: Map<string, BBox>;
  edges: Map<string, EdgeGeom>;
}

function num(v: string | undefined, d = 0): number { const n = v ? parseFloat(v) : NaN; return Number.isFinite(n) ? n : d; }
function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}
function decodeId(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
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
            const c = cum(); // after pop, cum excludes this frame; recompute centre below
            // node centre was cumulative including frame: store during open via nodeBBox already absolute?
            // nodeBBox stored absolute at shape time; if none, fallback
            if (frame.nodeBBox) nodes.set(frame.nodeId, frame.nodeBBox);
            else {
              // fallback: centre = frame translate + ancestors (stack now ancestors)
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
      if (cls.includes("pele-node") && dataId) frame.nodeId = decodeId(dataId);
      if (cls.includes("pele-cluster") && dataId) frame.clusterId = decodeId(dataId);
      if (cls.includes("pele-edge") && dataId) frame.edgeId = decodeId(dataId);
      stack.push(frame);
      if (selfClosing) stack.pop();
      continue;
    }
    if (closing) continue;
    // shape elements
    // find enclosing node/cluster/edge frame (nearest)
    let nodeFrame: GFrame | undefined, clusterFrame: GFrame | undefined, edgeFrame: GFrame | undefined;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (!nodeFrame && stack[i].nodeId) nodeFrame = stack[i];
      if (!clusterFrame && stack[i].clusterId) clusterFrame = stack[i];
      if (!edgeFrame && stack[i].edgeId) edgeFrame = stack[i];
    }
    if (tagName === "rect") {
      const x = num(attr(tag, "x")), y = num(attr(tag, "y")), w = num(attr(tag, "width")), h = num(attr(tag, "height"));
      if (clusterFrame && !nodeFrame) {
        const c = cum();
        // cluster rect coords are absolute in Pele output (cluster g has no translate usually); if cum is 0 use as-is, else add
        const bx = c.x === 0 && c.y === 0 ? x : x + c.x;
        const by = c.x === 0 && c.y === 0 ? y : y + c.y;
        clusters.set(clusterFrame.clusterId!, { x: bx, y: by, width: w, height: h, cx: bx + w / 2, cy: by + h / 2 });
      } else if (nodeFrame && !nodeFrame.nodeBBox) {
        // centre = cumulative translate including node frame
        // compute cumulative up to nodeFrame
        let cx = 0, cy = 0; for (const f of stack) { cx += f.tx; cy += f.ty; if (f === nodeFrame) break; }
        nodeFrame.nodeBBox = { x: cx + x, y: cy + y, width: w, height: h, cx: cx + x + w / 2, cy: cy + y + h / 2 };
        // store actual centre as node centre (translate point)
        nodeFrame.nodeBBox.cx = cx; nodeFrame.nodeBBox.cy = cy;
        // recompute x/y from centre? Keep bbox x/y, but cx/cy should be translate centre:
        nodeFrame.nodeBBox = { x: cx + x, y: cy + y, width: w, height: h, cx, cy };
      }
    } else if (tagName === "circle") {
      const r = num(attr(tag, "r")); const ccx = num(attr(tag, "cx")), ccy = num(attr(tag, "cy"));
      if (edgeFrame && cls0(tag)) { /* marker circle, ignore */ }
      else if (nodeFrame && !nodeFrame.nodeBBox) {
        let cx = 0, cy = 0; for (const f of stack) { cx += f.tx; cy += f.ty; if (f === nodeFrame) break; }
        nodeFrame.nodeBBox = { x: cx + ccx - r, y: cy + ccy - r, width: 2 * r, height: 2 * r, cx, cy };
      }
    } else if (tagName === "polygon") {
      const ptsStr = attr(tag, "points") ?? "";
      const nums = ptsStr.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
      if (nodeFrame && !nodeFrame.nodeBBox && nums.length >= 2) {
        let cx = 0, cy = 0; for (const f of stack) { cx += f.tx; cy += f.ty; if (f === nodeFrame) break; }
        const xs: number[] = [], ys: number[] = [];
        for (let i = 0; i + 1 < nums.length; i += 2) { xs.push(nums[i]); ys.push(nums[i + 1]); }
        const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
        nodeFrame.nodeBBox = { x: cx + x1, y: cy + y1, width: x2 - x1, height: y2 - y1, cx, cy };
      }
    } else if (tagName === "path") {
      const d = attr(tag, "d") ?? "";
      const clsA = attr(tag, "class") ?? "";
      if (edgeFrame && !edgeFrame.edgeD) { edgeFrame.edgeD = d; }
      else if (clsA.includes("pele-edge") ) {
        // mindmap direct path edge, no id: ignore geometry
      } else if (nodeFrame && !nodeFrame.nodeBBox && d) {
        let cx = 0, cy = 0; for (const f of stack) { cx += f.tx; cy += f.ty; if (f === nodeFrame) break; }
        const pts = pathPoints(d);
        if (pts.length) {
          const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
          const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
          nodeFrame.nodeBBox = { x: cx + x1, y: cy + y1, width: x2 - x1, height: y2 - y1, cx, cy };
        }
      }
    }
  }
  return { width, height, nodes, clusters, edges };
}
function cls0(tag: string): boolean { return (attr(tag, "class") ?? "").includes("pele-marker"); }
