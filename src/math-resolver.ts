/**
 * Diagram math (`$…$` labels) via Obsidian's MathJax, mirroring core 1.15's
 * resolver: pele gets a measured placeholder (`<g data-diagram-math>`), and
 * after the SVG is parsed (and sanitized) the placeholder's `pele-math` wrapper
 * becomes a foreignObject holding the typeset math. The sanitizer never sees
 * MathJax HTML; with "Sanitize SVG" on, hydrate applies its href rule to
 * MathJax's `\href` anchors itself (unsafe ones are unwrapped).
 *
 * No `obsidian` import: callers pass Obsidian's loadMathJax/renderMath/
 * finishRenderMath (see obsidianMathDeps in diagram-frame.ts).
 */
import type { MathMarkup, MathResolver } from "pele";
import { markupFragment } from "./sanitize-svg";
import { isSafeHref } from "./sanitize-svg";

export interface MathJaxDeps {
  /** MathJax is ready to typeset (Obsidian loads it lazily). */
  isLoaded(): boolean;
  loadMathJax(): Promise<unknown>;
  renderMath(tex: string, display: boolean): HTMLElement;
  /** Installs/refreshes MathJax's stylesheet. */
  finishRenderMath(): unknown;
}

interface MathDoc {
  createElement(tag: string): unknown;
  createElementNS(ns: string, tag: string): unknown;
}

export interface DiagramMathOptions {
  deps: MathJaxDeps;
  /** Diagram links enabled: MathJax `\href`s open externally, else they are unwrapped. */
  links: () => boolean;
  /** Called once MathJax finishes loading (the first render showed TeX as text). */
  rerender: () => void;
  /** Size of typeset `el` at `size` px in the diagram font; default: a hidden body probe like core's. */
  measure?: (el: HTMLElement, size: number) => { width: number; height: number };
  /** Web fonts still loading (sizes are then not cached); default: document.fonts.status. */
  fontsLoading?: () => boolean;
  doc?: MathDoc;
}

export interface DiagramMath {
  /** pele `RenderOptions.math`. */
  math: MathResolver;
  /**
   * Swap math placeholders in a parsed diagram for the typeset math; returns
   * `root`. `strict` ("Sanitize SVG" on): MathJax anchors whose href the
   * sanitizer would drop are unwrapped.
   */
  hydrate<T>(root: T, strict?: boolean): T;
  /** pele `MountOptions.sanitize`: parse via `base` (or plainly), then hydrate (strictly when `base` is given). */
  sanitize(svg: string, base?: ((svg: string) => Node) | null): Node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ATTR = "data-diagram-math";

interface Entry {
  el: HTMLElement;
  width: number;
  height: number;
}

let probe: HTMLElement | null = null;

/** Core's measurer: a hidden, laid-out div in the diagram font. */
function measureInBody(el: HTMLElement, size: number): { width: number; height: number } {
  if (!probe?.isConnected) {
    probe = createDiv({ cls: "pele-math-probe" });
    document.body.appendChild(probe);
  }
  probe.style.fontSize = `${size}px`;
  probe.replaceChildren(el);
  const { width, height } = el.getBoundingClientRect();
  el.remove();
  return { width, height };
}

function parsePlain(svg: string): Node {
  const frag = markupFragment(svg);
  return frag.querySelector("svg") ?? frag;
}

export function createDiagramMath(opts: DiagramMathOptions): DiagramMath {
  const { deps } = opts;
  const measure = opts.measure ?? measureInBody;
  const fontsLoading = opts.fontsLoading ?? (() => window.document?.fonts?.status === "loading");
  const doc = (): MathDoc => opts.doc ?? document;
  const cache = new Map<string, Entry>();
  const used = new Set<string>();
  let loading = false;
  /** A load settled without MathJax (offline, failed): labels stay TeX text, no retry loop. */
  let unavailable = false;

  /**
   * Typeset `key` ("<size> <tex>") and cache it unmeasured. Anchors are left
   * as MathJax made them: the link policy is applied per hydrate (settings
   * can change while the typeset is cached).
   */
  const typeset = (key: string): Entry => {
    const el = deps.renderMath(key.slice(key.indexOf(" ") + 1), true);
    el.classList.add("pele-math-tight");
    void deps.finishRenderMath();
    const entry: Entry = { el, width: 0, height: 0 };
    cache.set(key, entry);
    return entry;
  };

  const math: MathResolver = (tex, size): MathMarkup | null => {
    if (!deps.isLoaded()) {
      if (!loading && !unavailable) {
        loading = true;
        const settle = () => {
          loading = false;
          if (deps.isLoaded()) opts.rerender();
          else unavailable = true;
        };
        deps.loadMathJax().then(settle, settle);
      }
      return null;
    }
    const key = `${size} ${tex}`;
    used.add(key);
    const svg = `<g ${ATTR}="${encodeURIComponent(key)}"/>`;
    let entry = cache.get(key);
    if (entry?.width) return { svg, width: entry.width, height: entry.height };
    try {
      entry ??= typeset(key);
    } catch {
      return null;
    }
    const { width, height } = measure(entry.el, size);
    if (!(width > 0 && height > 0)) return null;
    if (!fontsLoading()) {
      entry.width = width;
      entry.height = height;
    }
    return { svg, width, height };
  };

  /** Apply the current link policy to a hydrated copy of the math. */
  const linkPolicy = (el: Element, strict: boolean): void => {
    const links = opts.links();
    for (const a of Array.from(el.querySelectorAll("a"))) {
      if (links && (!strict || isSafeHref(a.getAttribute("href") ?? ""))) {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener nofollow");
      } else {
        a.replaceWith(...Array.from(a.childNodes));
      }
    }
  };

  const hydrate = <T,>(root: T, strict = false): T => {
    const d = doc();
    const holders = (root as unknown as ParentNode).querySelectorAll?.(`g[${ATTR}]`);
    for (const g of Array.from(holders ?? [])) {
      const wrapper = g.parentElement;
      const key = decodeURIComponent(g.getAttribute(ATTR) ?? "");
      if (!wrapper || !key) continue;
      used.add(key);
      let entry: Entry;
      try {
        entry = cache.get(key) ?? typeset(key);
      } catch {
        continue;
      }
      const fo = d.createElementNS(SVG_NS, "foreignObject") as Element;
      for (const attr of Array.from(wrapper.attributes)) fo.setAttribute(attr.name, attr.value);
      const div = d.createElement("div") as HTMLElement;
      div.setAttribute(
        "style",
        `display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; font-size: ${parseFloat(key)}px; line-height: normal; white-space: nowrap`,
      );
      const copy = entry.el.cloneNode(true) as Element;
      linkPolicy(copy, strict);
      div.appendChild(copy);
      fo.appendChild(div);
      wrapper.replaceWith(fo);
    }
    for (const key of [...cache.keys()]) if (!used.has(key)) cache.delete(key);
    used.clear();
    return root;
  };

  return {
    math,
    hydrate,
    sanitize: (svg, base) => (base ? hydrate(base(svg), true) : hydrate(parsePlain(svg))),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PLACEHOLDER_RE = /<svg class="pele-math"([^>]*)><g data-diagram-math="([^"]*)"\/><\/svg>/g;

/**
 * Standalone markup (copy SVG, PNG export): MathJax output lives only in the
 * live DOM, so each placeholder becomes its TeX source, centred in the box.
 */
export function mathPlaceholdersToText(svg: string): string {
  if (!svg.includes(ATTR)) return svg;
  return svg.replace(PLACEHOLDER_RE, (_m, attrs: string, enc: string) => {
    let key: string;
    try {
      key = decodeURIComponent(enc);
    } catch {
      return "";
    }
    const num = (name: string) => Number(new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1] ?? 0) || 0;
    const color = /\scolor="[^"]*"/.exec(attrs)?.[0] ?? "";
    const cx = num("x") + num("width") / 2;
    const cy = num("y") + num("height") / 2;
    const size = parseFloat(key);
    return `<text class="pele-math" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"${size > 0 ? ` font-size="${size}"` : ""} fill="currentColor"${color}>${esc(key.slice(key.indexOf(" ") + 1))}</text>`;
  });
}
