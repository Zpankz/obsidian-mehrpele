/**
 * Low-level readers shared by the hand-rolled parsers of Pele's SVG output
 * (layout/svg-geom.ts, excalidraw/svg-geometry.ts, node-size/svgbox.ts and
 * node-size/solve.ts). Internal: not exported from any public entry point.
 * Pure string functions, so browser-safe.
 *
 * Pele (1.13) escapes attribute values and text with exactly four entities:
 * `&amp;`, `&lt;`, `&gt;`, `&quot;` (`'` stays literal). Label text can also
 * carry decimal references (`&#NN;`) restored from Mermaid `#NN;` codes.
 */

/**
 * Raw value of attribute `name` in one tag's markup, or undefined. The `\b`
 * anchor means `x` also matches inside `data-x="…"`: callers read Pele's own
 * shape tags, which never carry such attributes.
 */
export function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

/** A numeric attribute value; `d` when missing, empty or not finite. */
export function num(v: string | undefined, d = 0): number {
  const n = v === undefined ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Decode XML entities once: the four Pele emits plus `&apos;` and decimal
 * references. `&amp;` goes last, so `&amp;lt;` decodes to `&lt;`, not `<`.
 * Hex references and named HTML entities (`&nbsp;`) are left as they are.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
}

/**
 * The canvas parser's id decoder, kept apart from decodeEntities because it
 * gives different results on real Pele output: it decodes `&amp;` before
 * `&lt;`/`&gt;`/`&#39;`, so an escaped literal entity is decoded twice
 * (Pele's `a &amp;lt; b`, the text `a &lt; b`, becomes `a < b`, where
 * decodeEntities gives `a &lt; b`). Canvas node, edge and cluster ids depend
 * on it; unifying is a behaviour change, not a refactor.
 */
export function decodeEntitiesAmpFirst(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
}
