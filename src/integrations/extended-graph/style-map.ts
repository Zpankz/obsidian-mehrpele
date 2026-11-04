/**
 * Extended Graph → Pele style map. Pure.
 *
 * Extended Graph is GPLv3: nothing here is copied from it. We only read the
 * *data shape* of its persisted settings object at runtime
 * (`app.plugins.plugins["extended-graph"].settings`):
 *
 *   interactiveSettings: { [key]: { colors: {type, color, recursive?}[], useForNodeColor?, … } }
 *     key ∈ "tag" | "link" | "folder" | <additional frontmatter property names>
 *   shapeQueries: { [shape]: { combinationLogic: "AND"|"OR", index?, rules: {source, property, value, logic}[] } }
 *
 * Only *explicit* user colours (`colors[]`) are mapped; colormap-derived
 * colours are computed inside Extended Graph and are not reproduced. Every
 * mapped colour becomes a theme-safe `classDef` (translucent fill, solid
 * stroke) so labels stay readable in light and dark themes. Shapes are
 * lossy: Extended Graph polygons map to the nearest Pele flowchart shape,
 * stars are left as the default shape.
 */
import type { GeneratorOptions, GraphNode, GraphShape, GraphSpec } from "../graph-to-pele";

export interface EgColor {
  type: string;
  /** Normalised `#rrggbb`. */
  color: string;
  recursive: boolean;
}

export interface EgRule {
  source: string;
  property: string;
  value: string;
  logic: string;
}

export interface EgShapeQuery {
  shape: string;
  combination: "AND" | "OR";
  index: number;
  rules: EgRule[];
}

export interface ExtendedGraphStyle {
  /** Interactive key → explicit colours. */
  colors: Map<string, EgColor[]>;
  /** Keys flagged `useForNodeColor`, in settings order. */
  nodeColorKeys: string[];
  shapes: EgShapeQuery[];
}

export type ParseResult = { ok: true; style: ExtendedGraphStyle } | { ok: false; reason: string };

/** Facts about one node, gathered by the adapter from the metadata cache. */
export interface NodeFacts {
  /** Vault path (folder/file rules). */
  path?: string;
  /** Tags without `#`. */
  tags?: string[];
  /** Frontmatter property → string values (lower-case keys). */
  properties?: Record<string, string[]>;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Normalise a CSS colour to `#rrggbb`, or null when unsupported. */
export function normaliseColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(c);
  if (m) return `#${[...m[1]].map((d) => d + d).join("")}`;
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(c);
  if (m) return `#${m[1]}`;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/.exec(c);
  if (rgb) {
    const hex = rgb.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0"));
    return `#${hex.join("")}`;
  }
  return null;
}

/**
 * Defensive parse of Extended Graph's settings object. Any structural
 * mismatch of the top-level containers fails the whole parse (caller logs
 * once and skips); malformed individual entries are dropped.
 */
export function parseExtendedGraphSettings(raw: unknown): ParseResult {
  if (!isObject(raw)) return { ok: false, reason: "settings is not an object" };
  const interactive = raw.interactiveSettings;
  if (!isObject(interactive)) return { ok: false, reason: "interactiveSettings missing or not an object" };

  const colors = new Map<string, EgColor[]>();
  const nodeColorKeys: string[] = [];
  for (const [key, value] of Object.entries(interactive)) {
    if (!isObject(value)) continue;
    if (!Array.isArray(value.colors)) continue;
    const list: EgColor[] = [];
    for (const entry of value.colors) {
      if (!isObject(entry) || typeof entry.type !== "string" || !entry.type.trim()) continue;
      const color = normaliseColor(entry.color);
      if (!color) continue;
      list.push({ type: entry.type.trim(), color, recursive: entry.recursive === true });
    }
    if (list.length > 0) colors.set(key, list);
    if (value.useForNodeColor === true) nodeColorKeys.push(key);
  }

  const shapes: EgShapeQuery[] = [];
  const rawShapes = raw.shapeQueries;
  if (rawShapes !== undefined && !isObject(rawShapes)) {
    return { ok: false, reason: "shapeQueries is not an object" };
  }
  for (const [shape, q] of Object.entries(rawShapes ?? {})) {
    if (!isObject(q) || !Array.isArray(q.rules)) continue;
    const rules: EgRule[] = [];
    for (const r of q.rules) {
      if (!isObject(r) || typeof r.source !== "string" || !r.source) continue;
      rules.push({
        source: r.source,
        property: typeof r.property === "string" ? r.property : "",
        value: typeof r.value === "string" ? r.value : "",
        logic: typeof r.logic === "string" ? r.logic : "",
      });
    }
    if (rules.length === 0) continue;
    shapes.push({
      shape,
      combination: q.combinationLogic === "OR" ? "OR" : "AND",
      index: typeof q.index === "number" && Number.isFinite(q.index) ? q.index : Number.MAX_SAFE_INTEGER,
      rules,
    });
  }
  shapes.sort((a, b) => a.index - b.index);
  return { ok: true, style: { colors, nodeColorKeys, shapes } };
}

// -- matching -------------------------------------------------------------------

function folderOf(path: string | undefined): string {
  if (!path || !path.includes("/")) return "/";
  return path.split("/").slice(0, -1).join("/");
}

function basenameOf(path: string | undefined): string {
  const base = (path ?? "").split("/").pop() ?? "";
  return base.replace(/\.[^.]+$/, "");
}

function tagMatches(tag: string, type: string): boolean {
  const t = tag.replace(/^#/, "").toLowerCase();
  const want = type.replace(/^#/, "").toLowerCase();
  return t === want || t.startsWith(`${want}/`);
}

function folderMatches(folder: string, entry: EgColor): boolean {
  const want = entry.type.replace(/\/+$/, "") || "/";
  if (folder === want) return true;
  return entry.recursive && want !== "/" && folder.startsWith(`${want}/`);
}

/** First explicit colour for a node, by key priority. */
export function nodeColorFor(
  style: ExtendedGraphStyle,
  facts: NodeFacts,
): { key: string; type: string; color: string } | null {
  const order = [
    ...style.nodeColorKeys,
    "tag",
    ...[...style.colors.keys()].filter((k) => k !== "tag" && k !== "link" && k !== "folder"),
    "folder",
  ];
  const seen = new Set<string>();
  for (const key of order) {
    if (seen.has(key) || key === "link") continue;
    seen.add(key);
    const list = style.colors.get(key);
    if (!list) continue;
    if (key === "tag") {
      // Exact tag beats a parent-tag match.
      const tags = facts.tags ?? [];
      const exact = list.find((c) => tags.some((t) => t.replace(/^#/, "").toLowerCase() === c.type.replace(/^#/, "").toLowerCase()));
      const hit = exact ?? list.find((c) => tags.some((t) => tagMatches(t, c.type)));
      if (hit) return { key, type: hit.type, color: hit.color };
    } else if (key === "folder") {
      const folder = folderOf(facts.path);
      const hit = list.find((c) => folderMatches(folder, c));
      if (hit) return { key, type: hit.type, color: hit.color };
    } else {
      const values = facts.properties?.[key.toLowerCase()] ?? [];
      const hit = list.find((c) => values.some((v) => v.toLowerCase() === c.type.toLowerCase()));
      if (hit) return { key, type: hit.type, color: hit.color };
    }
  }
  return null;
}

/** Explicit link-type colour (link types are frontmatter property names). */
export function edgeColorFor(style: ExtendedGraphStyle, kind: string | undefined): string | null {
  if (!kind) return null;
  const hit = style.colors.get("link")?.find((c) => c.type.toLowerCase() === kind.toLowerCase());
  return hit?.color ?? null;
}

function valuesFor(rule: EgRule, facts: NodeFacts): string[] | null {
  switch (rule.source) {
    case "all":
      return ["*"];
    case "tag":
      return (facts.tags ?? []).map((t) => t.replace(/^#/, ""));
    case "property":
      return facts.properties?.[rule.property.toLowerCase()] ?? [];
    case "file":
      return [basenameOf(facts.path)];
    case "path":
      return facts.path ? [facts.path] : [];
    case "folder":
      return [folderOf(facts.path)];
    case "folderRec": {
      const folder = folderOf(facts.path);
      const parts = folder === "/" ? [] : folder.split("/");
      return ["/", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
    }
    default:
      return null; // e.g. "link": no facts available — rule cannot match
  }
}

function safeRegex(pattern: string): RegExp | null {
  if (pattern.length > 200) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/** Evaluate one Extended Graph rule against node facts (unknown logic = no match). */
export function ruleMatches(rule: EgRule, facts: NodeFacts): boolean {
  const values = valuesFor(rule, facts);
  if (values === null) return false;
  if (rule.source === "all") return true;
  const want = rule.value.toLowerCase();
  const lower = values.map((v) => v.toLowerCase());
  switch (rule.logic) {
    case "is":
      return lower.some((v) => v === want);
    case "isNot":
      return !lower.some((v) => v === want);
    case "contains":
      return lower.some((v) => v.includes(want));
    case "containsNot":
      return !lower.some((v) => v.includes(want));
    case "matchesRegex":
    case "matchesRegexNot": {
      const re = safeRegex(`^(?:${rule.value})$`);
      if (!re) return false;
      const any = values.some((v) => re.test(v));
      return rule.logic === "matchesRegex" ? any : !any;
    }
    case "containsRegex":
    case "containsRegexNot": {
      const re = safeRegex(rule.value);
      if (!re) return false;
      const any = values.some((v) => re.test(v));
      return rule.logic === "containsRegex" ? any : !any;
    }
    case "isEmpty":
      return values.length === 0 || values.every((v) => !v.trim());
    case "isEmptyNot":
      return values.some((v) => !!v.trim());
    default:
      return false;
  }
}

/** Nearest Pele flowchart shape for an Extended Graph shape name (lossy). */
export function peleShapeFor(egShape: string): GraphShape | undefined {
  switch (egShape) {
    case "circle":
      return "circle";
    case "square":
      return "rect";
    case "diamond":
      return "diamond";
    case "triangle":
    case "pentagon":
    case "hexagon":
    case "octagon":
    case "decagon":
      return "hexagon";
    default:
      return undefined; // stars: no Pele analogue, keep the default shape
  }
}

/** First (lowest index) matching shape query, mapped to a Pele shape. */
export function nodeShapeFor(style: ExtendedGraphStyle, facts: NodeFacts): GraphShape | undefined {
  for (const q of style.shapes) {
    const results = q.rules.map((r) => ruleMatches(r, facts));
    const hit = q.combination === "OR" ? results.some(Boolean) : results.every(Boolean);
    if (!hit) continue;
    const shape = peleShapeFor(q.shape);
    if (shape) return shape;
  }
  return undefined;
}

// -- GraphSpec decoration -----------------------------------------------------------

/** Semantic class (rendered as `pele-eg-…`) for an Extended Graph colour. */
export function egClassName(key: string, type: string): string {
  const slug = `${key}-${type}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `eg-${slug || "node"}`;
}

/** Theme-safe classDef body: translucent fill, solid stroke. */
export function themeSafeClassDef(color: string): string {
  return `fill:${color}33,stroke:${color},stroke-width:2px`;
}

export interface StyledGraph {
  spec: GraphSpec;
  options: Pick<GeneratorOptions, "classDefOverrides" | "edgeColors">;
}

/**
 * Apply an Extended Graph style to a GraphSpec: node classes + theme-safe
 * classDefs from colours, node shapes from shape queries (only where the
 * generator left the default shape), and edge colours by link type.
 */
export function applyExtendedGraphStyle(
  spec: GraphSpec,
  style: ExtendedGraphStyle,
  factsFor: (node: GraphNode) => NodeFacts | undefined,
): StyledGraph {
  const classDefOverrides: Record<string, string> = {};
  const edgeColors: Record<string, string> = {};
  const nodes = spec.nodes.map((node) => {
    const facts = factsFor(node);
    if (!facts) return node;
    const color = nodeColorFor(style, facts);
    const shape = node.shape ? undefined : nodeShapeFor(style, facts);
    if (!color && !shape) return node;
    const next = { ...node };
    if (color) {
      const cls = egClassName(color.key, color.type);
      classDefOverrides[cls] = themeSafeClassDef(color.color);
      next.classes = [...(node.classes ?? []), cls];
    }
    if (shape) next.shape = shape;
    return next;
  });
  for (const edge of spec.edges) {
    const c = edgeColorFor(style, edge.kind);
    if (c && edge.kind) edgeColors[edge.kind] = c;
  }
  return { spec: { ...spec, nodes }, options: { classDefOverrides, edgeColors } };
}
