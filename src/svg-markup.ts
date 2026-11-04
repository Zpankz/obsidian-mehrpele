/**
 * Pele SVG markup in and out of the DOM, shared by DiagramFrame and Mehrpele
 * mounts (no `obsidian` import, so it is unit-testable).
 */
import { mathPlaceholdersToText } from "./math-resolver";
import { markupFragment, sanitizedSvgMarkup } from "./sanitize-svg";

/**
 * Standalone export markup (copy/save SVG, PNG): math placeholders become
 * their TeX text, then the sanitizer runs when `sanitize` is on, and `names`'
 * computed values on `el` are inlined last (paste-safe; the sanitizer drops `<style>`).
 */
export function flattenSvg(raw: string, el: Element | null, names: readonly string[], sanitize = false): string {
  const text = mathPlaceholdersToText(raw);
  const svg = text ? sanitizedSvgMarkup(text, sanitize) : text;
  if (!svg || !el) return svg;
  let vars = "";
  try {
    const cs = getComputedStyle(el);
    for (const v of names) {
      const value = cs.getPropertyValue(v).trim();
      if (value) vars += `${v}:${value};`;
    }
  } catch {
    /* no layout (tests) */
  }
  if (!vars) return svg;
  return svg.replace(/<svg([^>]*)>/, `<svg$1><style>svg.pele{${vars}}</style>`);
}

/**
 * Put Pele markup into `el` the way pele's mount would: through the mount's
 * `sanitize` hook when given (math hydration, optional sanitizer), else as-is.
 * Pele markup is plugin-generated (no user HTML).
 */
export function placeSvg(el: Element, svg: string, sanitize?: ((svg: string) => Node) | null): void {
  if (sanitize) el.replaceChildren(sanitize(svg));
  else el.replaceChildren(markupFragment(svg));
}
