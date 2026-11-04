/**
 * The sole place that knows Pele's SVG classes/data-ids. Pure:
 * operates on SVG strings so it is fixture-testable headlessly.
 *
 * Pele DOM (pele@1.6.0): nodes are `.pele-node[data-id]` groups (usually with a
 * translate transform), edge labels `.pele-edge-label[data-id="L_A_B_0"]`,
 * clusters `.pele-cluster[data-id]` with a `.pele-cluster-label` title text.
 * If a future Pele renames these, resolution returns no boxes and callers
 * leave the SVG text visible (fail-safe).
 */
import type { MehrpeleLabel, MehrpeleLabelSize } from "./model";

export interface AnchorBox {
  anchorId: string;
  /** SVG user units, in viewBox coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Shape family that produced this box (drives overlay fit). */
  shape: "rect" | "circle" | "polygon" | "text" | "edge" | "cluster";
  /** Resolved Pele data-id when it differs from the anchor id (clusters). */
  svgDataId?: string;
  /**
   * Twins only (sequence header + footer share one data-id): document-order
   * index of this box's `.pele-node[data-id]` group, so the overlay hides
   * the text of the group it covers rather than always the first one.
   */
  twin?: number;
}

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function parseViewBox(svg: string): ViewBox | null {
  const m = /viewBox="([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)"/.exec(svg);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
}

/** Map an SVG user-space box into overlay (client) pixels. */
export function svgBoxToClient(
  box: { x: number; y: number; width: number; height: number },
  viewBox: ViewBox,
  client: { width: number; height: number; offsetX?: number; offsetY?: number },
): { left: number; top: number; width: number; height: number } {
  const sx = client.width / viewBox.width;
  const sy = client.height / viewBox.height;
  return {
    left: (client.offsetX ?? 0) + (box.x - viewBox.x) * sx,
    top: (client.offsetY ?? 0) + (box.y - viewBox.y) * sy,
    width: box.width * sx,
    height: box.height * sy,
  };
}

/** Uniform scale of the SVG (viewBox → client); overlays scale content by it. */
export function svgScale(viewBox: ViewBox, client: { width: number; height: number }): number {
  return client.width / viewBox.width;
}

interface GroupHit {
  dataId: string;
  classes: string;
  transform: string | null;
  inner: string;
  /** Absolute offset of inner content when the group has no transform. */
  index: number;
  /** Summed translate of the enclosing groups (sequence and mindmap wrap
   *  their content in one `<g transform="translate(…)">`). */
  parent: { x: number; y: number };
}

function parseTranslate(transform: string | null | undefined): { x: number; y: number } | null {
  const m = transform ? /translate\(\s*([-\d.eE]+)(?:[ ,]+([-\d.eE]+))?\s*\)/.exec(transform) : null;
  return m ? { x: Number(m[1]), y: m[2] === undefined ? 0 : Number(m[2]) } : null;
}

/**
 * Summed translate of every `<g>` enclosing each offset in `at` (one pass
 * over the group tags). Only translates are composed: Pele emits no other
 * group transforms.
 */
export function ancestorTranslates(svg: string, at: number[]): Map<number, { x: number; y: number }> {
  const wanted = new Set(at);
  const out = new Map<number, { x: number; y: number }>();
  const stack: { x: number; y: number }[] = [];
  let sx = 0;
  let sy = 0;
  const re = /<g\b([^>]*?)(\/?)>|<\/g\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    if (m[0].startsWith("</")) {
      const t = stack.pop();
      if (t) {
        sx -= t.x;
        sy -= t.y;
      }
      continue;
    }
    if (wanted.has(m.index)) out.set(m.index, { x: sx, y: sy });
    if (m[2] === "/") continue; // self-closing: no children
    const t = parseTranslate(/\btransform="([^"]*)"/.exec(m[1])?.[1]) ?? { x: 0, y: 0 };
    stack.push(t);
    sx += t.x;
    sy += t.y;
  }
  return out;
}

function findGroups(svg: string, classToken: string): GroupHit[] {
  const hits: Omit<GroupHit, "parent">[] = [];
  const re = new RegExp(
    `<g class="([^"]*${classToken}[^"]*)"[^>]*?data-id="([^"]*)"[^>]*>([\\s\\S]*?)</g>`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    const openTag = svg.slice(m.index, svg.indexOf(">", m.index) + 1);
    const t = /transform="translate\(([-\d.]+)[ ,]+([-\d.]+)\)"/.exec(openTag);
    hits.push({
      classes: m[1],
      dataId: m[2],
      transform: t ? `translate(${t[1]},${t[2]})` : null,
      inner: m[3],
      index: m.index,
    });
  }
  const parents = ancestorTranslates(svg, hits.map((h) => h.index));
  return hits.map((h) => ({ ...h, parent: parents.get(h.index) ?? { x: 0, y: 0 } }));
}

/** The group's own translate plus its ancestors': its content's origin in viewBox units. */
function translateOf(hit: GroupHit): { x: number; y: number } {
  const own = parseTranslate(hit.transform) ?? { x: 0, y: 0 };
  return { x: hit.parent.x + own.x, y: hit.parent.y + own.y };
}

function firstRect(inner: string): { x: number; y: number; width: number; height: number } | null {
  const m = /<rect[^>]*x="([-\d.]+)"[^>]*y="([-\d.]+)"[^>]*width="([-\d.]+)"[^>]*height="([-\d.]+)"/.exec(inner)
    ?? /<rect[^>]*width="([-\d.]+)"[^>]*height="([-\d.]+)"[^>]*x="([-\d.]+)"[^>]*y="([-\d.]+)"/.exec(inner);
  if (!m) return null;
  // Distinguish attribute order by re-reading the tag.
  const tag = /<rect[^>]*>/.exec(inner)?.[0] ?? "";
  const ax = /x="([-\d.]+)"/.exec(tag);
  const ay = /y="([-\d.]+)"/.exec(tag);
  const aw = /width="([-\d.]+)"/.exec(tag);
  const ah = /height="([-\d.]+)"/.exec(tag);
  if (!ax || !ay || !aw || !ah) return null;
  return { x: Number(ax[1]), y: Number(ay[1]), width: Number(aw[1]), height: Number(ah[1]) };
}

function polygonBBox(inner: string): { x: number; y: number; width: number; height: number } | null {
  const m = /<polygon[^>]*points="([^"]+)"/.exec(inner) ?? /<path[^>]*d="([^"]+)"/.exec(inner);
  if (!m) return null;
  const nums = m[1].match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (nums.length < 4) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    xs.push(nums[i]);
    ys.push(nums[i + 1]);
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

function circleOf(inner: string): { cx: number; cy: number; r: number } | null {
  const m = /<circle[^>]*r="([-\d.]+)"/.exec(inner);
  if (!m) return null;
  const tag = /<circle[^>]*>/.exec(inner)?.[0] ?? "";
  const cx = /cx="([-\d.]+)"/.exec(tag);
  const cy = /cy="([-\d.]+)"/.exec(tag);
  return { r: Number(m[1]), cx: cx ? Number(cx[1]) : 0, cy: cy ? Number(cy[1]) : 0 };
}

function textPos(inner: string): { x: number; y: number } | null {
  const m = /<text[^>]*x="([-\d.]+)"[^>]*y="([-\d.]+)"/.exec(inner)
    ?? /<tspan[^>]*x="([-\d.]+)"[^>]*y="([-\d.]+)"/.exec(inner);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

function isFooter(hit: GroupHit): boolean {
  return /(^|\s)pele-actor-footer(\s|$)/.test(hit.classes);
}

/** Pele's SVG data-id for an edge label: `L_<start>_<end>_<index>`. */
export function edgeSvgId(anchorId: string): string | null {
  const m = /^(.+)->(.+)#(\d+)$/.exec(anchorId);
  if (!m) return null;
  return `L_${m[1]}_${m[2]}_${m[3]}`;
}

/** Pele's SVG data-id for a cluster label (the subgraph id). */
export function clusterSvgId(anchorId: string): string | null {
  return anchorId.startsWith("subgraph:") ? anchorId.slice("subgraph:".length) : null;
}

function centred(
  anchorId: string,
  cx: number,
  cy: number,
  size: MehrpeleLabelSize | undefined,
  shape: AnchorBox["shape"],
  fallbackW = 48,
  fallbackH = 24,
): AnchorBox {
  const w = size?.width ?? fallbackW;
  const h = size?.height ?? fallbackH;
  return { anchorId, x: cx - w / 2, y: cy - h / 2, width: w, height: h, shape };
}

/**
 * Resolve every label to its SVG boxes. Sequence participants produce two
 * boxes (header + footer) for one anchor; callers overlay the first and may
 * clone onto the rest. Labels with no matching anchor are omitted.
 */
export function resolveAnchors(
  svg: string,
  labels: MehrpeleLabel[],
  sizes: Map<string, MehrpeleLabelSize>,
): AnchorBox[] {
  const boxes: AnchorBox[] = [];
  const nodes = findGroups(svg, "pele-node");
  const edgeLabels = findGroups(svg, "pele-edge-label");
  const clusters = findGroups(svg, "pele-cluster");

  for (const label of labels) {
    const size = sizes.get(label.anchorId);
    if (label.kind === "node") {
      const hits = nodes.filter((n) => n.dataId === label.anchorId);
      // Twins: Pele emits sequence footers before headers. The first box
      // takes the live label (embeds and nested diagrams are never cloned),
      // so order the header first.
      const ordered = hits
        .map((hit, twin) => ({ hit, twin }))
        .sort((a, b) => Number(isFooter(a.hit)) - Number(isFooter(b.hit)));
      for (const { hit, twin } of ordered) {
        const t = translateOf(hit);
        // Sequence `actor` stick figures label below the figure: anchor on
        // that text, not on the head circle.
        const figure = /(^|\s)pele-actor-actor(\s|$)/.test(hit.classes);
        const rect = figure ? null : firstRect(hit.inner);
        const circle = figure ? null : circleOf(hit.inner);
        const poly = rect || circle || figure ? null : polygonBBox(hit.inner);
        let box: AnchorBox | null = null;
        if (rect) {
          box = {
            anchorId: label.anchorId,
            x: t.x + rect.x, y: t.y + rect.y,
            width: rect.width, height: rect.height, shape: "rect",
          };
        } else if (circle) {
          // Inscribed label area of a circle: overlay the reserved size.
          box = centred(label.anchorId, t.x + circle.cx, t.y + circle.cy, size, "circle");
        } else if (poly) {
          // Diamonds inscribe the label: centre the reserved box, do not
          // stretch the overlay over the (larger) shape bbox.
          box = centred(label.anchorId, t.x + poly.x + poly.width / 2, t.y + poly.y + poly.height / 2, size, "polygon");
        } else {
          const pos = textPos(hit.inner);
          if (pos) box = centred(label.anchorId, t.x + pos.x, t.y + pos.y, size, "text");
        }
        if (box) boxes.push(hits.length > 1 ? { ...box, twin } : box);
      }
    } else if (label.kind === "edge") {
      const svgId = edgeSvgId(label.anchorId);
      const hit = svgId ? edgeLabels.find((e) => e.dataId === svgId) : undefined;
      const fallback = edgeLabels.find((e) => e.inner.includes(label.fallbackText.split("\n")[0] ?? " "));
      const use = hit ?? fallback;
      if (use) {
        const t = translateOf(use);
        const rect = firstRect(use.inner);
        if (rect) {
          boxes.push({ anchorId: label.anchorId, x: t.x + rect.x, y: t.y + rect.y, width: rect.width, height: rect.height, shape: "edge" });
        } else {
          const pos = textPos(use.inner);
          if (pos) boxes.push(centred(label.anchorId, t.x + pos.x, t.y + pos.y, size, "edge"));
        }
      }
    } else {
      const svgId = clusterSvgId(label.anchorId);
      // Pele ids unnamed subgraphs `subGraph<n>` (source order), so fall back
      // to the label's ordinal among cluster labels when the id doesn't match.
      const ordinal = labels.filter((l) => l.kind === "cluster").indexOf(label);
      const hit =
        (svgId ? clusters.find((c) => c.dataId === svgId) : undefined) ??
        clusters[ordinal] ??
        clusters.find((c) => c.inner.includes(label.fallbackText.split("\n")[0] ?? "\u0000"));
      if (hit) {
        const t = translateOf(hit);
        const labelTag = /<text[^>]*class="[^"]*pele-cluster-label[^"]*"[^>]*x="([-\d.]+)"[^>]*y="([-\d.]+)"/.exec(hit.inner);
        const rect = firstRect(hit.inner);
        if (labelTag) {
          const w = size?.width ?? 160;
          const h = size?.height ?? 28;
          boxes.push({
            anchorId: label.anchorId,
            x: t.x + Number(labelTag[1]) - w / 2,
            y: t.y + Number(labelTag[2]) - h * 0.7,
            width: w, height: h, shape: "cluster", svgDataId: hit.dataId,
          });
        } else if (rect) {
          boxes.push({ anchorId: label.anchorId, x: t.x + rect.x, y: t.y + rect.y, width: rect.width, height: 28, shape: "cluster", svgDataId: hit.dataId });
        }
      }
    }
  }
  return boxes;
}

/**
 * The SVG group whose `<text>` a box's overlay replaces: a selector plus the
 * index into its `querySelectorAll` matches (twins pick their own group).
 */
export function anchorScope(box: AnchorBox): { selector: string; index: number } | null {
  if (box.shape === "edge") {
    const svgId = edgeSvgId(box.anchorId);
    return svgId ? { selector: `.pele-edge-label[data-id="${cssAttr(svgId)}"]`, index: 0 } : null;
  }
  if (box.shape === "cluster") {
    const svgId = box.svgDataId ?? clusterSvgId(box.anchorId);
    return svgId ? { selector: `.pele-cluster[data-id="${cssAttr(svgId)}"]`, index: 0 } : null;
  }
  return { selector: `.pele-node[data-id="${cssAttr(box.anchorId)}"]`, index: box.twin ?? 0 };
}

function cssAttr(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

/** Anchor ids present in an SVG string (for fixture/coverage checks). */
export function svgAnchorIds(svg: string): { nodes: string[]; edges: string[]; clusters: string[] } {
  return {
    nodes: findGroups(svg, "pele-node").map((g) => g.dataId),
    edges: findGroups(svg, "pele-edge-label").map((g) => g.dataId),
    clusters: findGroups(svg, "pele-cluster").map((g) => g.dataId),
  };
}
