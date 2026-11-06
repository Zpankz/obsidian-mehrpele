import type { AnyRec } from "./util.js";

// ---------- what Mermaid expresses (everything else travels in provenance `keep`) ----------
export const NODE_CORE = new Set(["id", "type", "x", "y", "width", "height", "color", "text", "file", "subpath", "url", "label"]);
export const EDGE_CORE = new Set(["id", "fromNode", "toNode", "fromSide", "toSide", "fromEnd", "toEnd", "color", "label"]);
export const AC_SHAPES = new Set(["pill", "diamond", "database", "predefined-process", "circle", "parallelogram"]);
/** styleAttributes keys a Mermaid node expresses (shape syntax, border dash). */
export function nodeOwnedStyle(k: string, v: string | null): boolean { return (k === "shape" && v !== null && AC_SHAPES.has(v)) || (k === "border" && (v === "dashed" || v === "dotted" || v === "invisible")); }
export function edgeOwnedStyle(k: string, v: string | null): boolean { return (k === "path" && (v === "dotted" || v === "short-dashed" || v === "long-dashed")) || (k === "arrow" && (v === "circle" || v === "blunt")); }
export function keepOf(o: AnyRec, core: Set<string>, owned: (k: string, v: string | null) => boolean): Record<string, unknown> | undefined {
  const keep: AnyRec = {};
  for (const [k, v] of Object.entries(o)) {
    if (core.has(k) || k.startsWith("pele") || v === undefined) continue;
    if (k === "styleAttributes" && v && typeof v === "object") {
      const sa: AnyRec = {};
      for (const [sk, sv] of Object.entries(v as AnyRec)) if (!owned(sk, sv as string | null) && sv !== null) sa[sk] = sv;
      if (Object.keys(sa).length) keep.styleAttributes = sa;
      continue;
    }
    keep[k] = v;
  }
  return Object.keys(keep).length ? keep : undefined;
}
export function ownedKeys(keep: Record<string, unknown>, owned: (k: string, v: string | null) => boolean): string[] {
  return Object.entries(((keep.styleAttributes as AnyRec) ?? {})).filter(([k, v]) => owned(k, v as string | null)).map(([k]) => k);
}
/** Merge provenance `keep` under the derived card; `drop` removes style keys that no longer apply. */
export function mergeKeep<T extends AnyRec>(card: T, keep: Record<string, unknown> | undefined, drop: string[] = []): T {
  if (!keep) return card;
  const out: AnyRec = { ...keep, ...card };
  const ksa = { ...((keep.styleAttributes as AnyRec) ?? {}) };
  for (const d of drop) delete ksa[d];
  const sa = { ...ksa, ...((card.styleAttributes as AnyRec) ?? {}) };
  if (Object.keys(sa).length) out.styleAttributes = sa; else delete out.styleAttributes;
  return out as T;
}
