import "./helpers/dom-globals";
import { describe, expect, test } from "bun:test";
import { createDiagramMath, mathPlaceholdersToText, type MathJaxDeps } from "../src/math-resolver";
import { flattenSvg, placeSvg } from "../src/svg-markup";

// ── Minimal DOM: enough for MathJax output, pele's math wrapper and hydrate. ──
class El {
  attrs = new Map<string, string>();
  children: El[] = [];
  parentElement: El | null = null;
  style: Record<string, string> = {};
  classes = new Set<string>();
  classList = { add: (...c: string[]) => c.forEach((x) => this.classes.add(x)), contains: (c: string) => this.classes.has(c) };
  constructor(public localName: string, public ns = "html") {}
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  get childNodes() {
    return [...this.children];
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, v);
  }
  getAttribute(n: string) {
    return this.attrs.get(n) ?? null;
  }
  appendChild<T extends El>(c: T): T {
    c.remove();
    c.parentElement = this;
    this.children.push(c);
    return c;
  }
  append(...cs: El[]) {
    for (const c of cs) this.appendChild(c);
  }
  remove() {
    const p = this.parentElement;
    if (p) p.children = p.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  replaceWith(...ns: El[]) {
    const p = this.parentElement!;
    const i = p.children.indexOf(this);
    this.parentElement = null;
    for (const n of ns) n.remove();
    p.children.splice(i, 1, ...ns);
    for (const n of ns) n.parentElement = p;
  }
  cloneNode(): El {
    const c = new El(this.localName, this.ns);
    for (const [k, v] of this.attrs) c.attrs.set(k, v);
    c.style = { ...this.style };
    c.classes = new Set(this.classes);
    for (const k of this.children) c.appendChild(k.cloneNode());
    return c;
  }
  private walk(): El[] {
    return this.children.flatMap((c) => [c, ...c.walk()]);
  }
  querySelectorAll(sel: string): El[] {
    if (sel === "a") return this.walk().filter((e) => e.localName === "a");
    if (sel === "g[data-diagram-math]") return this.walk().filter((e) => e.localName === "g" && e.attrs.has("data-diagram-math"));
    throw new Error(`unsupported selector ${sel}`);
  }
}

const doc = {
  createElement: (t: string) => new El(t),
  createElementNS: (ns: string, t: string) => new El(t, ns),
};

/** Fake MathJax via Obsidian's API surface. */
function fakeDeps(over: Partial<MathJaxDeps> = {}) {
  const calls = { render: [] as string[], finish: 0, load: 0 };
  let loaded = true;
  let release: () => void = () => {};
  const deps: MathJaxDeps = {
    isLoaded: () => loaded,
    loadMathJax: () => {
      calls.load++;
      return new Promise<void>((r) => (release = () => ((loaded = true), r())));
    },
    renderMath: (tex: string, display: boolean) => {
      calls.render.push(`${display ? "D" : "I"}:${tex}`);
      const el = new El("mjx-container");
      el.setAttribute("data-tex", tex);
      if (tex.includes("\\href")) {
        const a = new El("a");
        a.setAttribute("href", /\\href\{([^}]*)\}/.exec(tex)?.[1] || "https://example.com");
        a.appendChild(new El("mjx-mi"));
        el.appendChild(a);
      }
      return el as unknown as HTMLElement;
    },
    finishRenderMath: () => {
      calls.finish++;
      return Promise.resolve();
    },
    ...over,
  };
  return {
    deps,
    calls,
    setLoaded: (v: boolean) => (loaded = v),
    release: () => release(),
  };
}

const measureBy = (w: number, h: number) => (el: HTMLElement, size: number) => ({ width: w * (size / 10) + (el ? 0 : 0), height: h });

/** pele's wrapper around an `{svg}` math result: `<svg class="pele-math" x y w h>…</svg>`. */
function peleWrapped(svgMarkup: string, attrs: Record<string, string>) {
  const root = new El("svg", "svg");
  const wrap = new El("svg", "svg");
  for (const [k, v] of Object.entries(attrs)) wrap.setAttribute(k, v);
  const m = /data-diagram-math="([^"]+)"/.exec(svgMarkup);
  const g = new El("g", "svg");
  g.setAttribute("data-diagram-math", m![1]!);
  wrap.appendChild(g);
  root.appendChild(wrap);
  return root;
}

describe("diagram math resolver (core 1.15 WB parity)", () => {
  test("not loaded: returns null, kicks MathJax loading once, rerenders when it lands", async () => {
    const f = fakeDeps();
    f.setLoaded(false);
    let rerenders = 0;
    const dm = createDiagramMath({ deps: f.deps, links: () => true, rerender: () => rerenders++, measure: measureBy(20, 12), doc });
    expect(dm.math("x^2", 14)).toBeNull();
    expect(dm.math("y", 14)).toBeNull();
    expect(f.calls.load).toBe(1);
    expect(rerenders).toBe(0);
    f.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(rerenders).toBe(1);
    expect(dm.math("x^2", 14)).not.toBeNull();
  });

  test("loaded: renders display TeX once, measures at the label size and returns a placeholder", () => {
    const f = fakeDeps();
    const sizes: number[] = [];
    const dm = createDiagramMath({
      deps: f.deps,
      links: () => true,
      rerender: () => {},
      measure: (_el, size) => (sizes.push(size), { width: 30, height: 12 }),
      doc,
    });
    const r = dm.math("\\frac{a}{b}", 16);
    expect(r).toEqual({ svg: `<g data-diagram-math="${encodeURIComponent("16 \\frac{a}{b}")}"/>`, width: 30, height: 12 });
    expect(f.calls.render).toEqual(["D:\\frac{a}{b}"]);
    expect(f.calls.finish).toBe(1);
    expect(sizes).toEqual([16]);
    // Cached: no second typeset or measure.
    expect(dm.math("\\frac{a}{b}", 16)).toEqual(r);
    expect(f.calls.render.length).toBe(1);
    expect(sizes.length).toBe(1);
    // Size is part of the key.
    dm.math("\\frac{a}{b}", 12);
    expect(f.calls.render.length).toBe(2);
  });

  test("zero-size measurement (detached / not laid out) yields null so pele falls back to text", () => {
    const f = fakeDeps();
    const dm = createDiagramMath({ deps: f.deps, links: () => true, rerender: () => {}, measure: () => ({ width: 0, height: 0 }), doc });
    expect(dm.math("x", 14)).toBeNull();
  });

  test("while web fonts load the size is returned but not cached", () => {
    const f = fakeDeps();
    let loading = true;
    let n = 0;
    const dm = createDiagramMath({
      deps: f.deps,
      links: () => true,
      rerender: () => {},
      measure: () => (n++, { width: 10, height: 10 }),
      fontsLoading: () => loading,
      doc,
    });
    expect(dm.math("x", 14)?.width).toBe(10);
    dm.math("x", 14);
    expect(n).toBe(2);
    loading = false;
    dm.math("x", 14);
    dm.math("x", 14);
    expect(n).toBe(3);
    expect(f.calls.render.length).toBe(1);
  });

  test("a throwing typesetter yields null", () => {
    const f = fakeDeps({
      renderMath: () => {
        throw new Error("bad tex");
      },
    });
    const dm = createDiagramMath({ deps: f.deps, links: () => true, rerender: () => {}, measure: measureBy(1, 1), doc });
    expect(dm.math("\\bad", 14)).toBeNull();
  });

  test("hydrate swaps pele's math wrapper for a foreignObject holding the typeset math", () => {
    const f = fakeDeps();
    const dm = createDiagramMath({ deps: f.deps, links: () => true, rerender: () => {}, measure: measureBy(30, 12), doc });
    const r = dm.math("e^{i\\pi}", 14)!;
    const root = peleWrapped((r as { svg: string }).svg, { class: "pele-math", x: "5", y: "6", width: "30", height: "12" });
    dm.hydrate(root as unknown as ParentNode);
    const fo = root.children[0]!;
    expect(fo.localName).toBe("foreignObject");
    expect(fo.ns).toBe("http://www.w3.org/2000/svg");
    expect(Object.fromEntries(fo.attrs)).toEqual({ class: "pele-math", x: "5", y: "6", width: "30", height: "12" });
    const div = fo.children[0]!;
    expect(div.localName).toBe("div");
    expect(div.getAttribute("style")).toContain("font-size: 14px");
    expect(div.getAttribute("style")).toContain("justify-content: center");
    const math = div.children[0]!;
    expect(math.getAttribute("data-tex")).toBe("e^{i\\pi}");
    expect(math.classList.contains("pele-math-tight")).toBe(true); // was inline line-height: 0
  });

  test("hydrate re-typesets an evicted or unseen key instead of dropping the formula", () => {
    const f = fakeDeps();
    const dm = createDiagramMath({ deps: f.deps, links: () => true, rerender: () => {}, measure: measureBy(1, 1), doc });
    const root = peleWrapped(`<g data-diagram-math="${encodeURIComponent("12 z")}"/>`, { x: "0" });
    dm.hydrate(root as unknown as ParentNode);
    expect(f.calls.render).toEqual(["D:z"]);
    expect(root.children[0]!.localName).toBe("foreignObject");
  });

  test("entries unused by the latest hydrated render are evicted", () => {
    const f = fakeDeps();
    const dm = createDiagramMath({ deps: f.deps, links: () => true, rerender: () => {}, measure: measureBy(1, 1), doc });
    const a = dm.math("a", 14) as { svg: string };
    dm.math("b", 14);
    dm.hydrate(peleWrapped(a.svg, {}) as unknown as ParentNode); // render 1 used a and b
    const a2 = dm.math("a", 14) as { svg: string }; // render 2 uses only a
    dm.hydrate(peleWrapped(a2.svg, {}) as unknown as ParentNode);
    const before = f.calls.render.length;
    dm.math("a", 14);
    expect(f.calls.render.length).toBe(before);
    dm.math("b", 14);
    expect(f.calls.render.length).toBe(before + 1);
  });

  test("links on: MathJax anchors open externally; off: unwrapped to their content", () => {
    for (const links of [true, false]) {
      const f = fakeDeps();
      const dm = createDiagramMath({ deps: f.deps, links: () => links, rerender: () => {}, measure: measureBy(1, 1), doc });
      const r = dm.math("\\href{x}{y}", 14) as { svg: string };
      const root = peleWrapped(r.svg, {});
      dm.hydrate(root as unknown as ParentNode);
      const math = root.children[0]!.children[0]!.children[0]!;
      const anchors = math.querySelectorAll("a");
      if (links) {
        expect(anchors.length).toBe(1);
        expect(anchors[0]!.getAttribute("target")).toBe("_blank");
        expect(anchors[0]!.getAttribute("rel")).toBe("noopener nofollow");
      } else {
        expect(anchors.length).toBe(0);
        expect(math.children[0]!.localName).toBe("mjx-mi");
      }
    }
  });

  test("sanitize parses through the base sanitizer, then hydrates", () => {
    const f = fakeDeps();
    const dm = createDiagramMath({ deps: f.deps, links: () => true, rerender: () => {}, measure: measureBy(1, 1), doc });
    const r = dm.math("q", 14) as { svg: string };
    const seen: string[] = [];
    const out = dm.sanitize("<svg>markup</svg>", (svg) => {
      seen.push(svg);
      return peleWrapped(r.svg, { x: "1" }) as unknown as Node;
    }) as unknown as El;
    expect(seen).toEqual(["<svg>markup</svg>"]);
    expect(out.children[0]!.localName).toBe("foreignObject");
  });
});

describe("exports (copy SVG / PNG)", () => {
  test("placeholders become centred TeX text, so exported diagrams keep the formula", () => {
    const key = encodeURIComponent("14 a<b & c");
    const svg = `<svg class="pele"><svg class="pele-math" x="10" y="20" width="30" height="8" overflow="visible" color="red"><g data-diagram-math="${key}"/></svg><text>keep</text></svg>`;
    expect(mathPlaceholdersToText(svg)).toBe(
      '<svg class="pele"><text class="pele-math" x="25" y="24" text-anchor="middle" dominant-baseline="central" font-size="14" fill="currentColor" color="red">a&lt;b &amp; c</text><text>keep</text></svg>',
    );
  });
  test("markup without math is returned unchanged", () => {
    const svg = '<svg class="pele"><svg class="pele-math" x="1"><foreignObject/></svg></svg>';
    expect(mathPlaceholdersToText(svg)).toBe(svg);
  });
});

describe("link policy follows the current settings, not the typeset cache", () => {
  const anchorsAfterHydrate = (dm: ReturnType<typeof createDiagramMath>, tex: string, strict = false) => {
    const r = dm.math(tex, 14) as { svg: string };
    const root = peleWrapped(r.svg, {});
    dm.hydrate(root as unknown as ParentNode, strict);
    return root.children[0]!.children[0]!.children[0]!.querySelectorAll("a");
  };
  test("toggling Allow links re-applies to cached math (no stale live \\href)", () => {
    const f = fakeDeps();
    let links = true;
    const dm = createDiagramMath({ deps: f.deps, links: () => links, rerender: () => {}, measure: measureBy(1, 1), doc });
    expect(anchorsAfterHydrate(dm, "\\href{https://a.example}{y}").length).toBe(1);
    links = false;
    expect(anchorsAfterHydrate(dm, "\\href{https://a.example}{y}").length).toBe(0);
    links = true;
    expect(anchorsAfterHydrate(dm, "\\href{https://a.example}{y}").length).toBe(1);
    expect(f.calls.render.length).toBe(1);
  });
  test("strict (Sanitize SVG on): MathJax anchors with unsafe hrefs are unwrapped, safe ones kept", () => {
    const f = fakeDeps();
    const dm = createDiagramMath({ deps: f.deps, links: () => true, rerender: () => {}, measure: measureBy(1, 1), doc });
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc"]) {
      expect(anchorsAfterHydrate(dm, `\\href{${bad}}{y}`, true).length, bad).toBe(0);
    }
    expect(anchorsAfterHydrate(dm, "\\href{https://ok.example}{y}", true).length).toBe(1);
    // Sanitize off: the user's own links are left alone.
    expect(anchorsAfterHydrate(dm, "\\href{javascript:alert(1)}{y}", false).length).toBe(1);
  });
  test("sanitize with a base sanitizer hydrates strictly; without one, not", () => {
    const f = fakeDeps();
    const dm = createDiagramMath({ deps: f.deps, links: () => true, rerender: () => {}, measure: measureBy(1, 1), doc });
    const r = dm.math("\\href{javascript:alert(1)}{y}", 14) as { svg: string };
    const out = dm.sanitize("<svg/>", () => peleWrapped(r.svg, {}) as unknown as Node) as unknown as El;
    expect(out.querySelectorAll("a").length).toBe(0);
  });
});

describe("MathJax that fails to load", () => {
  test("a load that leaves MathJax unavailable neither rerenders nor reloads (no render loop)", async () => {
    const f = fakeDeps({ loadMathJax: () => (f.calls.load++, Promise.resolve()) });
    f.setLoaded(false);
    let rerenders = 0;
    const dm = createDiagramMath({ deps: f.deps, links: () => true, rerender: () => rerenders++, measure: measureBy(1, 1), doc });
    expect(dm.math("x", 14)).toBeNull();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(rerenders).toBe(0);
    expect(dm.math("x", 14)).toBeNull();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(f.calls.load).toBe(1);
    expect(rerenders).toBe(0);
  });
  test("a rejected load is not retried on every render either", async () => {
    const f = fakeDeps({ loadMathJax: () => (f.calls.load++, Promise.reject(new Error("offline"))) });
    f.setLoaded(false);
    const dm = createDiagramMath({ deps: f.deps, links: () => true, rerender: () => {}, measure: measureBy(1, 1), doc });
    dm.math("x", 14);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    dm.math("x", 14);
    expect(f.calls.load).toBe(1);
  });
});

describe("plain Mehrpele mounts (placeSvg)", () => {
  test("markup goes through the mount's sanitize hook, so math is hydrated, not left an empty box", () => {
    const f = fakeDeps();
    const dm = createDiagramMath({ deps: f.deps, links: () => true, rerender: () => {}, measure: measureBy(1, 1), doc });
    const r = dm.math("x^2", 14) as { svg: string };
    const placed: unknown[] = [];
    const target = {
      set innerHTML(_v: string) {
        throw new Error("innerHTML must not bypass sanitize");
      },
      replaceChildren: (...n: unknown[]) => placed.push(...n),
    };
    placeSvg(target as unknown as Element, "<svg/>", (svg) => dm.sanitize(svg, () => peleWrapped(r.svg, {}) as unknown as Node));
    expect(placed.length).toBe(1);
    const fo = (placed[0] as El).children[0]!;
    expect(fo.localName).toBe("foreignObject");
    expect(fo.children[0]!.children[0]!.getAttribute("data-tex")).toBe("x^2");
  });
  test("without a sanitize hook the markup is parsed as-is (no innerHTML)", () => {
    const g = globalThis as Record<string, unknown>;
    const prev = { DOMParser: g.DOMParser, document: g.document };
    const parsed: string[] = [];
    g.DOMParser = class {
      parseFromString(markup: string) {
        parsed.push(markup);
        return { body: { childNodes: [{ localName: "svg" }] } };
      }
    };
    g.document = {
      importNode: (n: object) => n,
      createDocumentFragment: () => ({ kids: [] as object[], appendChild(n: object) { this.kids.push(n); } }),
    };
    try {
      let placed: unknown;
      const target = { replaceChildren: (n: unknown) => (placed = n) } as unknown as Element;
      placeSvg(target, "<svg>a</svg>", null);
      expect(parsed).toEqual(["<!doctype html><body><svg>a</svg>"]);
      expect((placed as { kids: object[] }).kids).toEqual([{ localName: "svg" }]);
    } finally {
      g.DOMParser = prev.DOMParser;
      g.document = prev.document;
    }
  });
});

describe("export markup (flattenSvg: copy/save SVG, PNG)", () => {
  const key = encodeURIComponent("14 x^2");
  const raw = `<svg class="pele"><svg class="pele-math" x="0" y="0" width="10" height="10"><g data-diagram-math="${key}"/></svg></svg>`;
  test("math placeholders become TeX text (Mehrpele shells and frames alike)", () => {
    const out = flattenSvg(raw, null, []);
    expect(out).not.toContain("data-diagram-math");
    expect(out).toContain(">x^2</text>");
  });
  test("computed theme vars are inlined after the math is flattened", () => {
    const prev = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (() => ({ getPropertyValue: (v: string) => (v === "--pele-a" ? " red " : "") })) as unknown as typeof getComputedStyle;
    try {
      const out = flattenSvg(raw, {} as Element, ["--pele-a", "--pele-b"]);
      expect(out.startsWith('<svg class="pele"><style>svg.pele{--pele-a:red;}</style>')).toBe(true);
      expect(out).toContain(">x^2</text>");
    } finally {
      globalThis.getComputedStyle = prev;
    }
  });
  test("empty markup stays empty", () => {
    expect(flattenSvg("", null, ["--pele-a"])).toBe("");
  });
  test("Sanitize SVG on: cleaned after the math is flattened, before theme vars are inlined", () => {
    const g = globalThis as Record<string, unknown>;
    const prev = { DOMParser: g.DOMParser, XMLSerializer: g.XMLSerializer, document: g.document, gcs: g.getComputedStyle };
    let parsed = "";
    const root = { tagName: "svg", namespaceURI: "http://www.w3.org/2000/svg", children: [], attributes: [], remove() {}, removeAttribute() {} };
    g.DOMParser = class {
      parseFromString(s: string) {
        parsed = s;
        return { documentElement: root };
      }
    };
    g.document = { importNode: (n: unknown) => n };
    g.XMLSerializer = class {
      serializeToString() {
        return '<svg class="pele">clean</svg>';
      }
    };
    g.getComputedStyle = () => ({ getPropertyValue: (v: string) => (v === "--pele-a" ? "red" : "") });
    try {
      const out = flattenSvg(raw, {} as Element, ["--pele-a"], true);
      expect(parsed).toContain(">x^2</text>");
      expect(out).toBe('<svg class="pele"><style>svg.pele{--pele-a:red;}</style>clean</svg>');
      expect(flattenSvg(raw, null, [], false)).toContain(">x^2</text>");
    } finally {
      Object.assign(g, { DOMParser: prev.DOMParser, XMLSerializer: prev.XMLSerializer, document: prev.document, getComputedStyle: prev.gcs });
    }
  });
});
