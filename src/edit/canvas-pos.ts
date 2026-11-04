/**
 * Canvas layout mode (`%% pele-layout canvas %%` + `%% pele-pos … %%`, see
 * pele-render/canvas layout-directive): nodes the edit toolbar adds are
 * pinned beside their anchor on the side the user clicked, and deleted nodes
 * lose their pins. Other `pele-pos` entries are left byte for byte. Pure.
 */
import { parseLayoutDirective, type PinnedBox } from "pele-render/canvas";
import type { Side } from "./concept-edit";

const POS_LINE = /^([ \t]*%%[ \t]*pele-pos\b)(.*?)(%%[ \t]*)$/gm;
const ID = String.raw`"(?:[^"\\]|\\.)*"|[^\s=>#"]+`;
const ENTRY = new RegExp(String.raw`\s*(${ID})(?:>(${ID})(?:#\d+)?)?=\S*`, "g");
const BARE_ID = /^[\p{L}\p{N}_.:-]+$/u;

/** Default box for a node the layout has no size for (SVG units). */
export const DEFAULT_BOX = { w: 160, h: 60 };
/** Space between a node and one added beside it (SVG units). */
export const PIN_GAP = 60;

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const quote = (id: string) => (BARE_ID.test(id) ? id : JSON.stringify(id));
const unquote = (raw: string) => {
  if (!raw.startsWith('"')) return raw;
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw;
  }
};

export function isCanvasLayout(src: string): boolean {
  return src.includes("pele-layout") && parseLayoutDirective(src).mode === "canvas";
}

/** Where a node goes on `side` of `anchor` (same size as the anchor, PIN_GAP apart). */
export function besideBox(anchor: PinnedBox, side: Side, gap = PIN_GAP): PinnedBox {
  const w = anchor.w ?? DEFAULT_BOX.w;
  const h = anchor.h ?? DEFAULT_BOX.h;
  const dx = side === "right" ? w + gap : side === "left" ? -(w + gap) : 0;
  const dy = side === "bottom" ? h + gap : side === "top" ? -(h + gap) : 0;
  return { x: anchor.x + dx, y: anchor.y + dy };
}

/** Add `id=x,y` to the last `pele-pos` line (or a new one after the layout lines). */
export function addPin(src: string, id: string, box: PinnedBox): string {
  return addEntry(src, `${quote(id)}=${fmt(box.x)},${fmt(box.y)}`);
}

/** In canvas layout, the edge `from → to` leaves `from` on `side` (a `from>to=side,auto` port). */
export function addPort(src: string, from: string, to: string, side: Side): string {
  return isCanvasLayout(src) ? addEntry(src, `${quote(from)}>${quote(to)}=${side},auto`) : src;
}

/**
 * The pin for a node of `size` (SVG units; default the anchor's) dropped
 * with its centre at `drop` (SVG units), placed by an anchor whose pin and
 * drawn box (SVG units) are known: the anchor's offset between the two
 * carries over. Null when the anchor is not pinned.
 */
export function pinAtDrop(
  src: string,
  anchor: string,
  anchorDrawn: { x: number; y: number },
  drop: { x: number; y: number },
  size?: { w: number; h: number } | null,
): PinnedBox | null {
  const a = parseLayoutDirective(src).pos.get(anchor);
  if (!a) return null;
  const w = size?.w ?? a.w ?? DEFAULT_BOX.w;
  const h = size?.h ?? a.h ?? DEFAULT_BOX.h;
  return { x: drop.x - w / 2 + (a.x - anchorDrawn.x), y: drop.y - h / 2 + (a.y - anchorDrawn.y) };
}

/** Append one entry to the last `pele-pos` line (or a new one after the layout lines). */
function addEntry(src: string, entry: string): string {
  const lines = [...src.matchAll(POS_LINE)];
  const last = lines[lines.length - 1];
  if (last) {
    const at = last.index + last[1].length + last[2].trimEnd().length;
    return `${src.slice(0, at)} ${entry}${src.slice(at)}`;
  }
  const layout = /^[ \t]*%%[ \t]*pele-layout\b.*$/m.exec(src);
  if (!layout) return src;
  const end = layout.index + layout[0].length;
  return `${src.slice(0, end)}\n%% pele-pos ${entry} %%${src.slice(end)}`;
}

/** Pin `id` beside `anchor` on `side`, when the block uses canvas layout and the anchor is pinned. */
export function pinBeside(src: string, id: string, anchor: string, side: Side): string {
  if (!isCanvasLayout(src)) return src;
  const a = parseLayoutDirective(src).pos.get(anchor);
  return a ? addPin(src, id, besideBox(a, side)) : src;
}

/** Pin `id` past the centre of several pinned nodes, on `side` (a shared child). */
export function pinBeyond(src: string, id: string, anchors: string[], side: Side): string {
  if (!isCanvasLayout(src)) return src;
  const pos = parseLayoutDirective(src).pos;
  const boxes = anchors.map((a) => pos.get(a)).filter((b): b is PinnedBox => !!b);
  if (!boxes.length) return src;
  const xs = boxes.map((b) => b.x);
  const ys = boxes.map((b) => b.y);
  const w = Math.max(...boxes.map((b) => b.w ?? DEFAULT_BOX.w));
  const h = Math.max(...boxes.map((b) => b.h ?? DEFAULT_BOX.h));
  const centre: PinnedBox = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, w, h };
  if (side === "bottom" || side === "top") centre.y = side === "bottom" ? Math.max(...ys) : Math.min(...ys);
  else centre.x = side === "right" ? Math.max(...xs) : Math.min(...xs);
  return addPin(src, id, besideBox(centre, side));
}

/** Remove `id`'s pin and its edges' port entries; lines left empty go. */
export function dropPins(src: string, id: string): string {
  if (!src.includes("pele-pos")) return src;
  const pruned = src.replace(POS_LINE, (whole, head: string, body: string, tail: string) => {
    const kept = body.replace(ENTRY, (e: string, a: string, b?: string) => (unquote(a) === id || (b !== undefined && unquote(b) === id) ? "" : e));
    if (kept === body) return whole;
    return kept.trim() ? `${head}${kept.replace(/\s+$/, "")} ${tail}` : "\u0000";
  });
  // eslint-disable-next-line no-control-regex -- NUL marks an emptied line; it never occurs in note text
  return pruned.replace(/\n?\u0000/g, "");
}
