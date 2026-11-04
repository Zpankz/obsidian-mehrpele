/**
 * Icons for the toolbar's popovers (pure). Shapes are drawn by Pele itself, a
 * one-node diagram per shape, so each glyph is exactly the outline the node
 * will get; line styles and arrowheads are small fixed SVGs in Pele's style.
 */
import { parse, render } from "pele-render/pele";
import { FLOW_SHAPES } from "./flow-edit";
import { MIND_SHAPES } from "./other-edit";

/** Shape groups, laid out as rows (each keeps this order; keys a diagram lacks are skipped). */
export const SHAPE_GROUPS: ReadonlyArray<{ name: string; keys: readonly string[] }> = [
  { name: "Boxes", keys: ["default", "rect", "rounded", "stadium", "subroutine"] },
  { name: "Round", keys: ["circle", "doublecircle", "cloud"] },
  { name: "Angular", keys: ["diamond", "hexagon", "parallelogram", "parallelogram-alt", "trapezoid", "trapezoid-alt"] },
  { name: "Special", keys: ["cylinder", "asymmetric", "bang"] },
];

/**
 * `options` (what the diagram offers) in SHAPE_GROUPS rows; unknown keys form
 * a last row. A lone shape shares the next short row (a mindmap's hexagon and
 * bang) rather than taking a row of its own.
 */
export function groupShapes<T extends { key: string }>(options: readonly T[]): T[][] {
  const groups = SHAPE_GROUPS.map((g) => g.keys.map((k) => options.find((o) => o.key === k)).filter((o): o is T => !!o));
  const known = new Set(SHAPE_GROUPS.flatMap((g) => g.keys));
  groups.push(options.filter((o) => !known.has(o.key)));
  const rows: T[][] = [];
  for (const g of groups.filter((r) => r.length > 0)) {
    const last = rows.at(-1);
    if (last && last.length === 1 && g.length <= 2) last.push(...g);
    else rows.push(g);
  }
  return rows;
}

/**
 * Lay grouped shapes out on one grid: a single column count for every row
 * (`maxCols`, or the widest group when none is that wide), each group wrapping
 * at it in order. `rows` is the flat row list for keyboard navigation;
 * `groupStart[i]` marks the first row of each group (spaced from the last).
 */
export function shapeGrid<T>(groups: readonly (readonly T[])[], maxCols = 4): { cols: number; groups: T[][][]; rows: T[][]; groupStart: boolean[] } {
  const cols = Math.max(1, Math.min(maxCols, Math.max(0, ...groups.map((g) => g.length))));
  const out = groups.filter((g) => g.length > 0).map((g) => {
    const rows: T[][] = [];
    for (let i = 0; i < g.length; i += cols) rows.push(g.slice(i, i + cols));
    return rows;
  });
  return { cols, groups: out, rows: out.flat(), groupStart: out.flatMap((rows) => rows.map((_, i) => i === 0)) };
}

const cache = new Map<string, string | null>();

/**
 * The SVG elements Pele draws for shape `key` (flowchart, or mindmap when
 * `mind`), centred on 0,0, label removed; null when Pele can't draw it.
 */
export function shapeGlyph(key: string, mind: boolean): string | null {
  const id = `${mind ? "m" : "f"}:${key}`;
  if (cache.has(id)) return cache.get(id)!;
  let out: string | null = null;
  const s = mind ? MIND_SHAPES.find((m) => m.key === key) : FLOW_SHAPES.find((f) => f.key === key);
  if (s) {
    // A short label gives each shape its usual proportions.
    const src = mind ? `mindmap\n  n${s.open}Abc${s.close}` : `flowchart LR\n  n${s.open}"Abc"${s.close}`;
    try {
      const r = render(parse(src)) as unknown;
      const svg = String(typeof r === "string" ? r : (r as { svg?: string }).svg ?? "");
      const g = /<g class="pele-node(?: [^"]*)?"[^>]*>([\s\S]*?)<\/g>/.exec(svg)?.[1] ?? "";
      const shape = g
        .replace(/<text[\s\S]*?<\/text>/g, "")
        .replace(/<foreignObject[\s\S]*?<\/foreignObject>/g, "")
        .trim();
      out = shape || null;
    } catch {
      out = null;
    }
  }
  cache.set(id, out);
  return out;
}

const LINE = 'M3 8H21';

/** Line-style glyphs (24×16): Pele's solid, dotted and thick strokes. */
export const STROKE_GLYPHS = {
  normal: `<path d="${LINE}" stroke-width="1.5"/>`,
  dotted: `<path d="${LINE}" stroke-width="1.5" stroke-dasharray="1.5 3"/>`,
  thick: `<path d="${LINE}" stroke-width="3.5"/>`,
} as const;

const ARROW_END = '<path d="M16 4.5L21 8L16 11.5" stroke-linejoin="round"/>';
const ARROW_START = '<path d="M8 4.5L3 8L8 11.5" stroke-linejoin="round"/>';

/** Arrowhead glyphs (24×16): what each choice draws at the line's ends. */
export const HEAD_GLYPHS = {
  none: `<path d="${LINE}"/>`,
  one: `<path d="${LINE}"/>${ARROW_END}`,
  both: `<path d="${LINE}"/>${ARROW_START}${ARROW_END}`,
  circle: `<path d="M3 8H17"/><circle cx="19" cy="8" r="2.5" fill="currentColor" stroke="none"/>`,
  cross: `<path d="M3 8H18"/><path d="M15.5 5.5L20.5 10.5M20.5 5.5L15.5 10.5"/>`,
} as const;
