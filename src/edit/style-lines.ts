/**
 * Mermaid-native styling edits (pure): `classDef` + `class` lines for the
 * palette presets and text sizes, `style` lines for custom colours, and
 * `linkStyle` lines for edges.
 *
 * Format (see README "Edit toolbar"):
 * - Presets 1–6 are one shared `classDef canvas3 fill:#e0ac001a,stroke:#e0ac00`
 *   plus `class A,B canvas3` — the same class family Canvas ⇄ Mermaid uses
 *   (pele-render/canvas palette), so a toolbar colour survives a round trip
 *   to Canvas. The plugin's CSS maps the classes to the theme palette (the
 *   hex values are the portable fallback mermaid.js, GitHub and exports
 *   see); Mermaid rejects `var(...)` in style values, so the theme can only
 *   come in through the class. The earlier `pele_cN` classes are still read.
 * - Text sizes are `classDef pele_text_s|l|xl font-size:…` the same way.
 * - Custom colours are a node's own `style A fill:…,stroke:…` (one-off).
 * - Edges use `linkStyle N stroke:…` (Mermaid has no edge classes in the
 *   syntax Pele reads). Indices are Pele's edge order.
 * - Class names avoid `-` (Pele's class/state grammars reject it);
 *   class diagrams assign with `cssClass "A,B" name` (`class X` declares a class there).
 *
 * New lines go at the end of the block, before trailing `%% pele-… %%`
 * directive lines, indented like the block's statements.
 */

import { CANVAS_PRESETS, presetClass as canvasPresetClass, presetOfClass, TINT_ALPHA, tintStyles } from "pele-render/canvas";

export type DiagramKind = "flowchart" | "state" | "class" | "mindmap" | "other";

export interface PresetColor {
  /** Obsidian canvas palette index 1–6. */
  n: 1 | 2 | 3 | 4 | 5 | 6;
  /** Portable fallback (Obsidian's light-theme canvas colour). */
  hex: string;
  name: string;
}

export const PRESETS: readonly PresetColor[] = CANVAS_PRESETS.map((p) => ({
  n: Number(p.id) as PresetColor["n"],
  hex: p.hex,
  name: p.name[0].toUpperCase() + p.name.slice(1),
}));

/** Fill alpha (hex byte) for coloured boxes: Canvas's faint tint. */
export const FILL_ALPHA = TINT_ALPHA;

export type TextSize = "s" | "l" | "xl";
export const TEXT_SIZES: Record<TextSize, number> = { s: 12, l: 20, xl: 26 };

export type ColorChoice = { preset: PresetColor["n"] } | { custom: string } | null;

export const presetClass = (n: number) => canvasPresetClass(String(n));
export const sizeClass = (s: TextSize) => `pele_text_${s}`;
/** Either palette family (canvasN, legacy pele_cN). */
const isPresetClass = (c: string) => presetOfClass(c) !== null;
const SIZE_RE = /^pele_text_(s|l|xl)$/;

export function presetDef(n: number): string {
  return tintStyles(PRESETS.find((x) => x.n === n)!.hex).join(",");
}

export function sizeDef(s: TextSize): string {
  return `font-size:${TEXT_SIZES[s]}px`;
}

/** Normalise a colour picker value to `#rrggbb` (null when not a colour). */
export function normalizeHex(v: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.replace(/./g, "$&$&");
  return `#${h}`;
}

// -- lines -------------------------------------------------------------------

interface Line {
  start: number;
  end: number;
  text: string;
}

function lines(src: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (;;) {
    const nl = src.indexOf("\n", start);
    const end = nl < 0 ? src.length : nl;
    out.push({ start, end, text: src.slice(start, end) });
    if (nl < 0) break;
    start = nl + 1;
  }
  return out;
}

/** Statement indentation used by the block (first indented statement after the header). */
function indentOf(src: string): string {
  let header = false;
  for (const l of lines(src)) {
    if (!l.text.trim() || /^\s*%%/.test(l.text)) continue;
    // The first statement is the diagram header (`flowchart LR`, `stateDiagram-v2`, …).
    if (!header) {
      header = true;
      continue;
    }
    return /^[ \t]*/.exec(l.text)![0];
  }
  return "  ";
}

const TRAILING_DIRECTIVE = /^[ \t]*%%[ \t]*pele-[\w-]+\b.*$/;

/** Insert `newLines` at the end of the block, before trailing `%% pele-… %%` lines. */
export function appendLines(src: string, newLines: string[]): string {
  if (newLines.length === 0) return src;
  const ls = lines(src);
  // Trailing blank lines stay trailing.
  let last = ls.length - 1;
  while (last > 0 && ls[last].text.trim() === "") last--;
  let insertAt = last + 1;
  while (insertAt - 1 > 0 && TRAILING_DIRECTIVE.test(ls[insertAt - 1].text)) insertAt--;
  const ind = indentOf(src);
  const block = newLines.map((l) => ind + l);
  const texts = ls.map((l) => l.text);
  texts.splice(insertAt, 0, ...block);
  return texts.join("\n");
}

function removeLine(src: string, l: Line): string {
  if (l.end < src.length) return src.slice(0, l.start) + src.slice(l.end + 1);
  // Last line: drop the preceding newline instead.
  return src.slice(0, Math.max(0, l.start - 1)) + src.slice(l.end);
}

function replaceLine(src: string, l: Line, text: string): string {
  return src.slice(0, l.start) + text + src.slice(l.end);
}

// -- style property lists -----------------------------------------------------

export function parseProps(s: string): Array<[string, string]> {
  return s
    .replace(/;\s*$/, "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const c = p.indexOf(":");
      return c < 0 ? ([p, ""] as [string, string]) : ([p.slice(0, c).trim(), p.slice(c + 1).trim()] as [string, string]);
    });
}

export function formatProps(props: Array<[string, string]>): string {
  return props.map(([k, v]) => (v ? `${k}:${v}` : k)).join(",");
}

/** Set (value) or remove (null) properties, keeping order and the rest. */
export function mergeProps(props: Array<[string, string]>, set: Record<string, string | null>): Array<[string, string]> {
  const out = props.filter(([k]) => !(k in set) || set[k] !== null);
  for (const [k, v] of Object.entries(set)) {
    if (v === null) continue;
    const at = out.findIndex(([kk]) => kk === k);
    if (at >= 0) out[at] = [k, v];
    else out.push([k, v]);
  }
  return out;
}

// -- statement readers ----------------------------------------------------------

interface StyleLine extends Line {
  id: string;
  props: Array<[string, string]>;
  indent: string;
}

const STYLE_LINE = /^([ \t]*)style[ \t]+(\S+)[ \t]+(.+?)[ \t]*;?[ \t]*$/;

function styleLines(src: string): StyleLine[] {
  const out: StyleLine[] = [];
  for (const l of lines(src)) {
    const m = STYLE_LINE.exec(l.text);
    if (m) out.push({ ...l, indent: m[1], id: m[2], props: parseProps(m[3]) });
  }
  return out;
}

interface ClassAssign extends Line {
  ids: string[];
  names: string[];
  form: "class" | "cssClass";
  indent: string;
}

const CLASS_LINE = /^([ \t]*)class[ \t]+([^\s]+)[ \t]+([^\s;]+)[ \t]*;?[ \t]*$/;
const CSSCLASS_LINE = /^([ \t]*)cssClass[ \t]+"([^"]*)"[ \t]+([^\s;]+)[ \t]*;?[ \t]*$/;

function classAssigns(src: string, kind: DiagramKind): ClassAssign[] {
  const out: ClassAssign[] = [];
  for (const l of lines(src)) {
    if (kind === "class") {
      const m = CSSCLASS_LINE.exec(l.text);
      if (m) out.push({ ...l, indent: m[1], ids: splitList(m[2]), names: splitList(m[3]), form: "cssClass" });
      continue;
    }
    const m = CLASS_LINE.exec(l.text);
    if (m) out.push({ ...l, indent: m[1], ids: splitList(m[2]), names: splitList(m[3]), form: "class" });
  }
  return out;
}

function splitList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

interface ClassDefLine extends Line {
  names: string[];
  props: Array<[string, string]>;
}

const CLASSDEF_LINE = /^([ \t]*)classDef[ \t]+(\S+)[ \t]+(.+?)[ \t]*;?[ \t]*$/;

function classDefs(src: string): ClassDefLine[] {
  const out: ClassDefLine[] = [];
  for (const l of lines(src)) {
    const m = CLASSDEF_LINE.exec(l.text);
    if (m) out.push({ ...l, names: splitList(m[2]), props: parseProps(m[3]) });
  }
  return out;
}

// -- class membership -----------------------------------------------------------

/** Classes assigned to `id` by `class`/`cssClass` lines. */
export function classesOf(src: string, kind: DiagramKind, id: string): string[] {
  const out: string[] = [];
  for (const a of classAssigns(src, kind)) if (a.ids.includes(id)) out.push(...a.names);
  return out;
}

function formatAssign(a: { indent: string; form: "class" | "cssClass"; ids: string[]; names: string[] }): string {
  return a.form === "cssClass"
    ? `${a.indent}cssClass "${a.ids.join(",")}" ${a.names.join(",")}`
    : `${a.indent}class ${a.ids.join(",")} ${a.names.join(",")}`;
}

/** Remove `id` from every assignment of a class matching `match` (lines left empty go). */
function unassign(src: string, kind: DiagramKind, id: string, match: (name: string) => boolean): string {
  let out = src;
  // Bottom-up so earlier offsets stay valid.
  for (const a of classAssigns(src, kind).reverse()) {
    if (!a.ids.includes(id) || !a.names.some(match)) continue;
    const keepNames = a.names.filter((n) => !match(n));
    const otherIds = a.ids.filter((x) => x !== id);
    const pieces: string[] = [];
    // Others keep every class; `id` keeps the non-matching ones.
    if (otherIds.length) pieces.push(formatAssign({ ...a, ids: otherIds }));
    if (keepNames.length) pieces.push(formatAssign({ ...a, ids: [id], names: keepNames }));
    out = pieces.length ? replaceLine(out, a, pieces.join("\n")) : removeLine(out, a);
  }
  return out;
}

/** Add `id` to class `name`: joins an existing single-class line for it, else a new line. */
function assign(src: string, kind: DiagramKind, id: string, name: string): string {
  const existing = classAssigns(src, kind).find((a) => a.names.length === 1 && a.names[0] === name);
  if (existing) {
    if (existing.ids.includes(id)) return src;
    return replaceLine(src, existing, formatAssign({ ...existing, ids: [...existing.ids, id] }));
  }
  return appendLines(src, [formatAssign({ indent: "", form: kind === "class" ? "cssClass" : "class", ids: [id], names: [name] })]);
}

/** Ensure `classDef name def` exists (once; appended before the class line that first uses it). */
function ensureClassDef(src: string, name: string, def: string): string {
  if (classDefs(src).some((d) => d.names.includes(name))) return src;
  return appendLines(src, [`classDef ${name} ${def}`]);
}

/** Drop our generated classDefs nobody uses any more. */
function pruneClassDefs(src: string, kind: DiagramKind): string {
  let out = src;
  const used = new Set(classAssigns(src, kind).flatMap((a) => a.names));
  // `A:::pele_c1` inline uses count too.
  for (const m of src.matchAll(/:::([\w-]+)/g)) used.add(m[1]);
  for (const d of classDefs(src).reverse()) {
    if (d.names.length !== 1) continue;
    const n = d.names[0];
    if ((isPresetClass(n) || SIZE_RE.test(n)) && !used.has(n)) out = removeLine(out, d);
  }
  return out;
}

/** Generated classDefs go when their last user does (deduplicated, no dead lines). */
function tidy(src: string, kind: DiagramKind): string {
  return pruneClassDefs(src, kind);
}

// -- `style` lines ----------------------------------------------------------------

/** Edit `id`'s own `style` line (merged into one line; empty → removed). */
export function editStyle(src: string, id: string, set: Record<string, string | null>): string {
  const mine = styleLines(src).filter((s) => s.id === id);
  if (mine.length === 0) {
    const props = mergeProps([], set);
    return props.length ? appendLines(src, [`style ${id} ${formatProps(props)}`]) : src;
  }
  // Fold several lines into the last one (Mermaid applies them in order).
  const merged = mergeProps(
    mine.flatMap((s) => s.props),
    {},
  );
  const props = mergeProps(dedupeProps(merged), set);
  let out = src;
  const last = mine[mine.length - 1];
  out = props.length ? replaceLine(out, last, `${last.indent}style ${id} ${formatProps(props)}`) : removeLine(out, last);
  for (const s of mine.slice(0, -1).reverse()) out = removeLine(out, s);
  return out;
}

function dedupeProps(props: Array<[string, string]>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of props) {
    const at = out.findIndex(([kk]) => kk === k);
    if (at >= 0) out[at] = [k, v];
    else out.push([k, v]);
  }
  return out;
}

/** The style properties set on `id` by its own `style` lines. */
export function styleOf(src: string, id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of styleLines(src)) if (s.id === id) for (const [k, v] of s.props) out[k] = v;
  return out;
}

// -- node / subgraph colour and text size ------------------------------------------

/** The colour the toolbar shows as active for a node or subgraph. */
export function currentColor(src: string, kind: DiagramKind, id: string): ColorChoice {
  const st = styleOf(src, id);
  if (st.stroke || st.fill) {
    const hex = normalizeHex(st.stroke ?? (st.fill ?? "").slice(0, 7));
    if (hex) return { custom: hex };
  }
  const cls = classesOf(src, kind, id).find((c) => isPresetClass(c));
  if (cls) return { preset: Number(presetOfClass(cls)) as PresetColor["n"] };
  return null;
}

export function currentTextSize(src: string, kind: DiagramKind, id: string): TextSize | null {
  const cls = classesOf(src, kind, id).find((c) => SIZE_RE.test(c));
  return cls ? (cls.slice(10) as TextSize) : null;
}

/**
 * Colour a node or subgraph. Preset: shared classDef + class line (custom
 * fill/stroke removed from its style line). Custom: its style line (preset
 * class removed). null: both removed.
 */
export function setColor(src: string, kind: DiagramKind, id: string, choice: ColorChoice): string {
  let out = unassign(src, kind, id, (n) => isPresetClass(n));
  if (choice && "custom" in choice) {
    const hex = normalizeHex(choice.custom);
    if (!hex) return src;
    out = editStyle(out, id, { fill: `${hex}${FILL_ALPHA}`, stroke: hex });
  } else {
    out = editStyle(out, id, { fill: null, stroke: null });
    if (choice) {
      out = ensureClassDef(out, presetClass(choice.preset), presetDef(choice.preset));
      out = assign(out, kind, id, presetClass(choice.preset));
    }
  }
  return tidy(out, kind);
}

/** Text size via the shared `pele_text_*` classes; null resets (M). */
export function setTextSize(src: string, kind: DiagramKind, id: string, size: TextSize | null): string {
  let out = unassign(src, kind, id, (n) => SIZE_RE.test(n));
  out = editStyle(out, id, { "font-size": null });
  if (size) {
    out = ensureClassDef(out, sizeClass(size), sizeDef(size));
    out = assign(out, kind, id, sizeClass(size));
  }
  return tidy(out, kind);
}

/** Remove every styling reference to `id` (node deletion). */
export function dropStyling(src: string, kind: DiagramKind, id: string): string {
  let out = unassign(src, kind, id, () => true);
  for (const s of styleLines(out).reverse()) if (s.id === id) out = removeLine(out, s);
  for (const l of lines(out).reverse()) {
    const m = /^[ \t]*click[ \t]+(\S+)/.exec(l.text);
    if (m && m[1] === id) out = removeLine(out, l);
  }
  return tidy(out, kind);
}

// -- linkStyle ------------------------------------------------------------------------

interface LinkStyleLine extends Line {
  indices: Array<number | "default">;
  props: Array<[string, string]>;
  indent: string;
}

const LINKSTYLE_LINE = /^([ \t]*)linkStyle[ \t]+([\d,\s]+?|default)[ \t]+(.+?)[ \t]*;?[ \t]*$/;

function linkStyleLines(src: string): LinkStyleLine[] {
  const out: LinkStyleLine[] = [];
  for (const l of lines(src)) {
    const m = LINKSTYLE_LINE.exec(l.text);
    if (!m) continue;
    const idx = m[2].trim() === "default" ? ["default" as const] : splitList(m[2].replace(/\s+/g, "")).map(Number);
    out.push({ ...l, indent: m[1], indices: idx, props: parseProps(m[3]) });
  }
  return out;
}

function formatLinkStyle(indent: string, indices: Array<number | "default">, props: Array<[string, string]>): string {
  return `${indent}linkStyle ${indices.join(",")} ${formatProps(props)}`;
}

/** Effective linkStyle props of edge `index` (its own lines; `default` not included). */
export function linkStyleOf(src: string, index: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of linkStyleLines(src)) if (l.indices.includes(index)) for (const [k, v] of l.props) out[k] = v;
  return out;
}

/**
 * Edit edge `index`'s style. Its single-index line is updated in place; an
 * index shared with others (`linkStyle 1,2 …`) is split out first so the
 * other edges keep theirs.
 */
export function editLinkStyle(src: string, index: number, set: Record<string, string | null>): string {
  let out = src;
  let inherited: Array<[string, string]> = [];
  for (const l of linkStyleLines(out).reverse()) {
    if (!l.indices.includes(index) || l.indices.length === 1) continue;
    inherited = [...l.props, ...inherited];
    const rest = l.indices.filter((x) => x !== index);
    out = replaceLine(out, l, formatLinkStyle(l.indent, rest, l.props));
  }
  const own = linkStyleLines(out).filter((l) => l.indices.length === 1 && l.indices[0] === index);
  const base = dedupeProps([...inherited, ...own.flatMap((l) => l.props)]);
  const props = mergeProps(base, set);
  if (own.length === 0) return props.length ? appendLines(out, [`linkStyle ${index} ${formatProps(props)}`]) : out;
  const last = own[own.length - 1];
  out = props.length ? replaceLine(out, last, formatLinkStyle(last.indent, [index], props)) : removeLine(out, last);
  for (const l of own.slice(0, -1).reverse()) out = removeLine(out, l);
  return out;
}

export function setEdgeColor(src: string, index: number, hex: string | null): string {
  const h = hex === null ? null : normalizeHex(hex);
  if (hex !== null && !h) return src;
  return editLinkStyle(src, index, { stroke: h, color: h });
}

export function setEdgeTextSize(src: string, index: number, size: TextSize | null): string {
  return editLinkStyle(src, index, { "font-size": size ? `${TEXT_SIZES[size]}px` : null });
}

/** The edge colour the toolbar shows as active. */
export function currentEdgeColor(src: string, index: number): ColorChoice {
  const hex = normalizeHex(linkStyleOf(src, index).stroke ?? "");
  if (!hex) return null;
  const p = PRESETS.find((x) => x.hex === hex);
  return p ? { preset: p.n } : { custom: hex };
}

/**
 * Edge `removed` was deleted: drop it from linkStyle lines and shift the
 * later indices down by one so every other edge keeps its style.
 */
/**
 * An edge was inserted at Pele index `inserted`: every linkStyle index at or
 * above it moves up by one, so existing edges keep their styles.
 */
export function shiftLinkStylesForInsert(src: string, inserted: number): string {
  let out = src;
  for (const l of linkStyleLines(src).reverse()) {
    if (l.indices[0] === "default") continue;
    const next = (l.indices as number[]).map((i) => (i >= inserted ? i + 1 : i));
    if (next.join(",") !== l.indices.join(",")) out = replaceLine(out, l, formatLinkStyle(l.indent, next, l.props));
  }
  return out;
}

export function reindexLinkStyles(src: string, removed: number): string {
  let out = src;
  for (const l of linkStyleLines(src).reverse()) {
    if (l.indices[0] === "default") continue;
    const next = (l.indices as number[]).filter((i) => i !== removed).map((i) => (i > removed ? i - 1 : i));
    if (next.length === 0) out = removeLine(out, l);
    else if (next.join(",") !== l.indices.join(",")) out = replaceLine(out, l, formatLinkStyle(l.indent, next, l.props));
  }
  return out;
}
