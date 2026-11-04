/**
 * Canvas colours ⇄ Mermaid styles.
 *
 * Obsidian Canvas has six theme-defined presets ("1"…"6": red, orange,
 * yellow, green, cyan, purple) and free hex colours. A card shows its colour
 * as a border plus a faint tint of the same colour, so the Mermaid form is a
 * tinted fill and a solid stroke.
 *
 * Presets become the classes `canvas1`…`canvas6` — the one palette class
 * family, shared with the Obsidian plugin's edit toolbar (which wrote
 * `pele_c1`…`pele_c6` before; those are still read and themed). Each class carries a static
 * fallback (Obsidian's light-theme palette) for mermaid.js, the CLI and
 * GitHub; the Obsidian plugin overrides the classes with the theme's
 * `--color-<name>-rgb` variables, so presets follow the theme like Canvas
 * does. Edges can't carry a CSS class in Pele, so an edge preset is written
 * as its fallback stroke and recognised by that exact value on the way back.
 * Pure: no Pele, no DOM.
 */

export interface PresetColour {
  /** Canvas preset id ("1"…"6"). */
  id: string;
  /** Obsidian colour name (`--color-<name>-rgb`). */
  name: string;
  /** Fallback hex (Obsidian light theme). */
  hex: string;
}

export const CANVAS_PRESETS: readonly PresetColour[] = [
  { id: "1", name: "red", hex: "#e93147" },
  { id: "2", name: "orange", hex: "#ec7500" },
  { id: "3", name: "yellow", hex: "#e0ac00" },
  { id: "4", name: "green", hex: "#08b94e" },
  { id: "5", name: "cyan", hex: "#00bfbc" },
  { id: "6", name: "purple", hex: "#7852ee" },
];

/** Alpha of the tinted fill (hex byte): Canvas cards tint at about 10 %. */
export const TINT_ALPHA = "1a";

/** Canonical dash patterns written for Advanced Canvas line styles. */
export const DASH = {
  edge: { "short-dashed": "6 4", "long-dashed": "12 6" } as Record<string, string>,
  node: { dashed: "6 4", dotted: "2 3" } as Record<string, string>,
};

export function isPreset(c: string | undefined): boolean {
  return !!c && /^[1-6]$/.test(c);
}

export function presetClass(id: string): string {
  return `canvas${id}`;
}

/** The edit toolbar's earlier class family, read for compatibility. */
export function legacyPresetClass(id: string): string {
  return `pele_c${id}`;
}

/** Preset id for a `canvasN` (or legacy `pele_cN`) class name, else null. */
export function presetOfClass(cls: string): string | null {
  const m = /^(?:canvas|pele_c)([1-6])$/.exec(cls);
  return m ? m[1] : null;
}

export function presetHex(id: string): string | undefined {
  return CANVAS_PRESETS.find((p) => p.id === id)?.hex;
}

/** Preset id whose fallback hex is exactly `hex` (edges), else null. */
export function presetOfHex(hex: string): string | null {
  const h = hex.toLowerCase();
  return CANVAS_PRESETS.find((p) => p.hex === h)?.id ?? null;
}

/** `fill:…,stroke:…` declarations for a hex colour (Canvas look: tint + border). */
export function tintStyles(hex: string): string[] {
  return [`fill:${hex}${TINT_ALPHA}`, `stroke:${hex}`];
}

/** classDef lines for the presets in use (sorted). */
export function presetClassDefs(ids: Iterable<string>): string[] {
  return [...new Set(ids)]
    .filter(isPreset)
    .sort()
    .map((id) => `classDef ${presetClass(id)} ${tintStyles(presetHex(id)!).join(",")}`);
}

/**
 * CSS for the Obsidian plugin: the preset classes follow the theme palette.
 * `!important` because Pele writes class styles as inline `style`.
 */
export function presetThemeCss(): string {
  const shapes = ":is(rect,polygon,path,circle,ellipse):not(.pele-marker)";
  return CANVAS_PRESETS.map((p) => {
    const rgb = `var(--color-${p.name}-rgb)`;
    const cls = [presetClass(p.id), legacyPresetClass(p.id)];
    const boxes = cls.flatMap((c) => [`.pele-node.${c} > ${shapes}`, `.pele-node.${c} > a > ${shapes}`, `.pele-cluster.${c} > rect`]).join(", ");
    // Edges carry no class: a preset edge is its fallback stroke (linkStyle).
    const edge = `.pele-edge[style*="stroke:${p.hex}"]`;
    return [
      `${boxes} { fill: rgba(${rgb}, 0.1) !important; stroke: rgb(${rgb}) !important; }`,
      `${edge} { stroke: rgb(${rgb}) !important; }`,
      `${edge} .pele-marker { fill: rgb(${rgb}) !important; }`,
      `.pele-edge-label text[style*="fill:${p.hex}"] { fill: rgb(${rgb}) !important; }`,
    ].join("\n");
  }).join("\n");
}
