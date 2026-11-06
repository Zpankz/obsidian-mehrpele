/** Canvas colours and Advanced Canvas borders/dashes from Pele (Mermaid) styles. */
import { DASH, presetOfClass, presetOfHex, TINT_ALPHA } from "./palette.js";

export const NAMED: Record<string, string> = { red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080", cyan: "#00ffff", magenta: "#ff00ff", black: "#000000", white: "#ffffff", gray: "#808080", grey: "#808080", pink: "#ffc0cb", brown: "#a52a2a", lime: "#00ff00", navy: "#000080", teal: "#008080" };
export function normalizeHex(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) return "#" + s.slice(1).split("").map(c => c + c).join("");
  if (/^#[0-9a-f]{4}$/.test(s)) return "#" + s.slice(1, 4).split("").map(c => c + c).join("");
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{8}$/.test(s)) return s.slice(0, 7);
  return NAMED[s] ?? null;
}
export type ClassDefs = Map<string, { styles?: string[]; textStyles?: string[] }>;
/** Last value of a CSS declaration in Pele style entries. */
export function decl(styles: string[] | undefined, prop: string): string | undefined {
  let v: string | undefined;
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`);
  for (const s of styles ?? []) { const m = re.exec(String(s)); if (m) v = m[1].trim(); }
  return v;
}
export function withoutDecls(styles: string[], props: string[]): string[] {
  return styles.filter(s => !props.some(p => new RegExp(`^\\s*${p}\\s*:`).test(String(s))));
}
/** Canvas colour of a node/group: `canvasN` classes → preset, else the effective hex fill. */
export function colourOf(classes: string[] | undefined, styles: string[] | undefined, classDefs: ClassDefs): { color?: string; raw?: string } {
  let color: string | undefined, raw: string | undefined;
  // A preset's exact tint (`#rrggbb1a` of its fallback hex) reads back as the preset.
  const take = (fill: string | undefined) => { if (!fill) return; const t = fill.trim().toLowerCase(); const tint = t.length === 9 && t.endsWith(TINT_ALPHA) ? presetOfHex(t.slice(0, 7)) : null; const hx = normalizeHex(fill); if (tint) { color = tint; raw = undefined; } else if (hx) { color = hx; raw = undefined; } else { raw = fill; color = undefined; } };
  for (const c of classes ?? []) { const p = presetOfClass(c); if (p) { color = p; raw = undefined; continue; } take(decl(classDefs.get(c)?.styles, "fill")); }
  take(decl(styles, "fill"));
  return color ? { color } : raw ? { raw } : {};
}
/**
 * Canvas colour of an edge: its stroke; a preset's fallback hex is the preset.
 * Flowchart edge classes reach here via an edge id: `A e1@--> B` + `class e1 canvas3`
 * (or a classDef with a stroke). `e1@{ … }` carries no class. `linkStyle N stroke:<preset hex>`
 * always works and is what `canvasToMermaid` writes.
 */
export function edgeColourOf(classes: string[] | undefined, styles: string[] | undefined, classDefs: ClassDefs): string | undefined {
  let stroke: string | undefined;
  for (const c of classes ?? []) { const p = presetOfClass(c); if (p) return p; stroke = decl(classDefs.get(c)?.styles, "stroke") ?? stroke; }
  stroke = decl(styles, "stroke") ?? stroke;
  const hx = stroke ? normalizeHex(stroke) : null;
  return hx ? (presetOfHex(hx) ?? hx) : undefined;
}
/** Advanced Canvas node border from Mermaid styles (canonical dash patterns). */
export function borderOf(styles: string[] | undefined): string | undefined {
  const dash = decl(styles, "stroke-dasharray");
  if (dash) { for (const [k, v] of Object.entries(DASH.node)) if (v === dash.replace(/,/g, " ").replace(/\s+/g, " ")) return k; return "dashed"; }
  if (decl(styles, "stroke") === "none" && decl(styles, "fill") === "none") return "invisible";
  return undefined;
}
export function edgeDashOf(styles: string[] | undefined): string | undefined {
  const dash = decl(styles, "stroke-dasharray");
  if (!dash) return undefined;
  const d = dash.replace(/,/g, " ").replace(/\s+/g, " ");
  for (const [k, v] of Object.entries(DASH.edge)) if (v === d) return k;
  return "short-dashed";
}
