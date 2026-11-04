/**
 * Allowlist SVG sanitizer for Pele's MountOptions.sanitize.
 *
 * Obsidian's sanitizeHTMLToDom (DOMPurify) could not be verified to keep
 * Pele's SVG (CSS-var fills, markers, a11y <title>/<desc>) intact without a
 * live Obsidian, so this DOMParser-based allowlist is used instead: known
 * SVG elements only, no script/foreignObject, no on* handlers, and hrefs
 * restricted to fragments or safe schemes.
 */

export const ALLOWED_SVG_TAGS: ReadonlySet<string> = new Set([
  "svg", "g", "defs", "title", "desc", "path", "rect", "circle", "ellipse",
  "line", "polyline", "polygon", "text", "tspan", "a", "marker", "clipPath",
  "mask", "pattern", "linearGradient", "radialGradient", "stop", "use",
  "symbol", "switch", "textPath",
]);

const DROP_TAGS = new Set(["script", "style", "iframe", "object", "embed", "link", "meta"]);
const SAFE_HREF_RE = /^(#|https?:|mailto:|obsidian:|\/|\.)/i;

/** An href the sanitizer keeps: a fragment, relative path or safe scheme. */
export function isSafeHref(href: string): boolean {
  const v = href.trim();
  return SAFE_HREF_RE.test(v) && !/^(javascript|data|vbscript):/i.test(v);
}

export function isAllowedSvgTag(tag: string): boolean {
  return ALLOWED_SVG_TAGS.has(tag);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The slice of the DOM Element API the sanitizer uses (kept narrow so it is testable without a DOM). */
export interface SvgElementLike {
  readonly tagName: string;
  readonly namespaceURI: string | null;
  readonly children: ArrayLike<SvgElementLike>;
  readonly attributes: ArrayLike<{ readonly name: string; readonly localName: string; readonly value: string }>;
  remove(): void;
  removeAttribute(name: string): void;
}

/** Strip on* handlers and unsafe hrefs (any namespace prefix) from one element's attributes. */
function cleanAttributes(el: SvgElementLike): void {
  for (const attr of Array.from(el.attributes)) {
    const local = attr.localName.toLowerCase();
    if (local.startsWith("on") || (local === "href" && !isSafeHref(attr.value))) el.removeAttribute(attr.name);
  }
}

/**
 * Clean a parsed SVG tree in place: the root's own attributes too, then every descendant
 * (allowlisted SVG-namespace elements only). False when the root is not an SVG `<svg>`.
 */
export function cleanSvgTree(root: SvgElementLike): boolean {
  if (root.tagName !== "svg" || root.namespaceURI !== SVG_NS) return false;
  const clean = (el: SvgElementLike): void => {
    cleanAttributes(el);
    for (const child of Array.from(el.children)) {
      const tag = child.tagName;
      if (DROP_TAGS.has(tag) || !isAllowedSvgTag(tag) || child.namespaceURI !== SVG_NS) {
        child.remove();
        continue;
      }
      clean(child);
    }
  };
  clean(root);
  return true;
}

export function sanitizeSvg(svg: string): Node {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  if (!cleanSvgTree(root)) return document.createElementNS(SVG_NS, "svg");
  return document.importNode(root, true);
}

/** Pele SVG markup for copy/export/API callers: sanitized and re-serialised when `sanitize` is on. */
export function sanitizedSvgMarkup(svg: string, sanitize: boolean): string {
  if (!sanitize) return svg;
  return new XMLSerializer().serializeToString(sanitizeSvg(svg));
}

/** Parse Pele SVG markup into an element, through `sanitize` when given. */
export function svgElementFromMarkup(
  markup: string,
  sanitize: ((svg: string) => Node) | null,
): SVGElement | null {
  if (sanitize) {
    const node = sanitize(markup);
    const el = node as Element;
    if (el && el.nodeType === 1 && el.localName === "svg") return el as unknown as SVGElement;
    return (el?.querySelector?.("svg")) ?? null;
  }
  return markupFragment(markup).querySelector("svg");
}

/**
 * Parse trusted, plugin-generated markup into live nodes without innerHTML.
 * DOMParser documents are inert (no scripts, no loads) like a <template>; the
 * `<body>` prefix keeps a leading <style> beside the svg instead of in <head>.
 */
export function markupFragment(markup: string): DocumentFragment {
  const body = new DOMParser().parseFromString(`<!doctype html><body>${markup}`, "text/html").body;
  const frag = createFragment();
  for (const node of Array.from(body.childNodes)) frag.appendChild(document.importNode(node, true));
  return frag;
}
