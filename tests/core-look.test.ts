import "./helpers/dom-globals";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LIGHTBOX_HOST_CLASS, PELE_HOST_CLASS, ZOOM_LABELS, bodyMermaidFont, markExternalLinks, zoomOption } from "../src/core-look";
import { cssFonts } from "../src/reflow-frame";

const root = new URL("../", import.meta.url).pathname;
const css = readFileSync(`${root}styles.css`, "utf8");

/** Declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
  const m = new RegExp(`(^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[2] ?? "";
}

// Obsidian 1.15 app.css: `body,.mermaid{--pele-x: var(--mermaid-y)}`.
const CORE_VARS: [string, string][] = [
  ["--pele-bg", "--mermaid-background"],
  ["--pele-fg", "--mermaid-text-color"],
  ["--pele-muted", "--mermaid-muted-color"],
  ["--pele-line", "--mermaid-line-color"],
  ["--pele-surface", "--mermaid-surface"],
  ["--pele-surface-alt", "--mermaid-surface-alt"],
  ["--pele-border", "--mermaid-border-color"],
  ["--pele-accent", "--mermaid-accent"],
  ["--pele-critical", "--mermaid-critical"],
  ["--pele-error", "--mermaid-error"],
  ["--pele-radius", "--mermaid-radius"],
  ["--pele-title-weight", "--mermaid-title-weight"],
  ["--pele-heading-weight", "--mermaid-heading-weight"],
  ["--pele-bold-weight", "--mermaid-bold-weight"],
  ...Array.from({ length: 8 }, (_, i) => [`--pele-series-${i + 1}`, `--mermaid-color-${i + 1}`] as [string, string]),
];

describe("core 1.15 theme hooks (styles.css)", () => {
  const host = ruleBody(".pele-host");

  test("every --pele-* var core maps reads core's --mermaid-* var first, the old value as fallback", () => {
    for (const [pele, mermaid] of CORE_VARS) {
      const m = new RegExp(`${pele}:\\s*var\\(${mermaid},\\s*([^;]+)\\);`).exec(host);
      expect(m, `${pele} -> ${mermaid}`).not.toBeNull();
      expect(m?.[1]?.trim().startsWith("var(--")).toBe(true);
    }
  });

  test("diagram font is core's --font-mermaid, falling back to the text font", () => {
    expect(host).toMatch(/--pele-font:\s*var\(--font-mermaid,\s*var\(--font-text\)\);/);
    expect(host).toMatch(/--pele-font-mono:\s*var\(--font-monospace\);/);
  });

  test("Obsidian ≤1.14's dark-mode inversion of `.mermaid > svg` is cancelled on our hosts", () => {
    expect(ruleBody(".pele-host.mermaid > svg")).toMatch(/filter:\s*none/);
  });
});

describe("host classes", () => {
  test("frame and lightbox hosts carry core's `mermaid` class beside .pele-host", () => {
    for (const cls of [PELE_HOST_CLASS, LIGHTBOX_HOST_CLASS]) {
      const list = cls.split(" ");
      expect(list).toContain("pele-host");
      expect(list).toContain("mermaid");
    }
    expect(PELE_HOST_CLASS.split(" ")).toContain("image-wrapper");
    expect(LIGHTBOX_HOST_CLASS.split(" ")).toContain("media-wrapper");
  });

  test("diagram-frame and the Mehrpele shell build their wrapper from PELE_HOST_CLASS", () => {
    const frame = readFileSync(`${root}src/diagram-frame.ts`, "utf8");
    const main = readFileSync(`${root}main.ts`, "utf8") + readFileSync(`${root}src/mehrpele/shell.ts`, "utf8");
    const lightbox = readFileSync(`${root}src/lightbox.ts`, "utf8");
    expect(frame).toContain("this.wrapper.className = PELE_HOST_CLASS");
    expect(main).toContain("this.wrapper.className = PELE_HOST_CLASS");
    expect(lightbox).toContain("this.mediaWrapper.className = LIGHTBOX_HOST_CLASS");
    expect(frame).not.toContain('"image-wrapper pele-host"');
    expect(main).not.toContain('"image-wrapper pele-host"');
  });
});

describe("diagram font resolution", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { getComputedStyle: g.getComputedStyle, document: g.document };
  afterEach(() => {
    g.getComputedStyle = saved.getComputedStyle;
    g.document = saved.document;
  });

  /** Stub getComputedStyle: per-element custom properties + fontFamily. */
  function stub(styles: Map<object, { vars: Record<string, string>; fontFamily?: string }>, body: object): void {
    g.document = { body };
    g.getComputedStyle = (el: object) => {
      const s = styles.get(el) ?? { vars: {} };
      return { getPropertyValue: (name: string) => s.vars[name] ?? "", fontFamily: s.fontFamily ?? "" };
    };
  }

  test("bodyMermaidFont reads --font-mermaid from document.body, like core", () => {
    const body = {};
    stub(new Map([[body, { vars: { "--font-mermaid": "  Inter, sans-serif " } }]]), body);
    expect(bodyMermaidFont()).toBe("Inter, sans-serif");
  });

  test("bodyMermaidFont is empty without a DOM or the variable", () => {
    g.document = undefined;
    g.getComputedStyle = undefined;
    expect(bodyMermaidFont()).toBe("");
    const body = {};
    stub(new Map(), body);
    expect(bodyMermaidFont()).toBe("");
  });

  test("cssFonts: configured > element --pele-font > body --font-mermaid > element font-family", () => {
    const body = {};
    const el = {} as HTMLElement;
    const styles = new Map<object, { vars: Record<string, string>; fontFamily?: string }>([
      [body, { vars: { "--font-mermaid": "Mermaid Font" } }],
      [el, { vars: { "--pele-font": "Host Font", "--pele-font-mono": "Mono" }, fontFamily: "Inherited" }],
    ]);
    stub(styles, body);
    expect(cssFonts(el, "Configured")).toEqual({ fontFamily: "Configured", fontFamilyMono: "Mono" });
    expect(cssFonts(el)).toEqual({ fontFamily: "Host Font", fontFamilyMono: "Mono" });
    // Outside a .pele-host (no --pele-font): core's diagram font, not the inherited one.
    styles.set(el, { vars: {}, fontFamily: "Inherited" });
    expect(cssFonts(el)).toEqual({ fontFamily: "Mermaid Font" });
    // Obsidian without --font-mermaid: the element's own font, as before.
    styles.set(body, { vars: {} });
    expect(cssFonts(el)).toEqual({ fontFamily: "Inherited" });
  });
});

describe("zoom parity (core 1.15)", () => {
  const at = (inCanvas: boolean) => ({
    closest: (sel: string) => (inCanvas && sel.split(",").map((s) => s.trim()).includes(".canvas-wrapper") ? {} : null),
  });

  test("off stays off; no labels object is built", () => {
    expect(zoomOption(false, at(false))).toBe(false);
    expect(zoomOption(false, at(true))).toBe(false);
  });

  test("auto and always carry core's control labels", () => {
    const auto = zoomOption("auto", at(false));
    const always = zoomOption(true, at(false));
    expect(auto).toEqual({ labels: { zoomIn: "Zoom in", zoomOut: "Zoom out", reset: "Reset zoom" } });
    expect(always).toEqual({ always: true, labels: { zoomIn: "Zoom in", zoomOut: "Zoom out", reset: "Reset zoom" } });
    expect(ZOOM_LABELS).toEqual({ zoomIn: "Zoom in", zoomOut: "Zoom out", reset: "Reset zoom" });
  });

  test("stable objects: pele compares zoom by identity, so updates must not rebuild the controls", () => {
    expect(zoomOption("auto", at(false))).toBe(zoomOption("auto", at(false)));
    expect(zoomOption(true, at(false))).toBe(zoomOption(true, at(false)));
    expect(Object.isFrozen(zoomOption(true, at(false)))).toBe(true);
  });

  test("forced off inside Canvas, like core (the canvas pans/zooms itself)", () => {
    expect(zoomOption("auto", at(true))).toBe(false);
    expect(zoomOption(true, at(true))).toBe(false);
  });

  test("frames route their mount zoom through zoomOption", () => {
    const frame = readFileSync(`${root}src/diagram-frame.ts`, "utf8");
    expect(frame).toContain("zoom: zoomOption(base.zoom, this.root)");
  });

  test("Live Preview offsets the zoom controls clear of the code-block edit button", () => {
    const body = ruleBody(".markdown-source-view.mod-cm6 .cm-preview-code-block .pele-host.mermaid");
    expect(body).toMatch(/--pele-zoom-top:\s*var\(--size-2-2\);/);
    expect(body).toMatch(/--pele-zoom-right:\s*var\(--size-4-10\);/);
  });
});

describe("external link styling (core 1.15 onRender)", () => {
  /** Minimal DOM: anchors with class sets; supports `a`, `a:not(.x)`. */
  function fakeRoot(classes: string[][]) {
    const anchors = classes.map((c) => {
      const set = new Set(c);
      return { set, classList: { add: (n: string) => void set.add(n), contains: (n: string) => set.has(n) } };
    });
    const queries: string[] = [];
    return {
      anchors,
      queries,
      querySelectorAll(sel: string) {
        queries.push(sel);
        const m = /^a:not\(\.([\w-]+)\)$/.exec(sel);
        if (!m) throw new Error(`unsupported selector ${sel}`);
        return anchors.filter((a) => !a.set.has(m[1]!));
      },
    };
  }

  test("every non-internal anchor gets external-link; internal links are left alone", () => {
    const root = fakeRoot([["internal-link"], [], ["pele-link"], ["internal-link", "is-unresolved"]]);
    markExternalLinks(root);
    expect(root.queries).toEqual(["a:not(.internal-link)"]);
    expect(root.anchors.map((a) => [...a.set].sort())).toEqual([
      ["internal-link"],
      ["external-link"],
      ["external-link", "pele-link"],
      ["internal-link", "is-unresolved"],
    ]);
  });

  test("idempotent across re-renders", () => {
    const root = fakeRoot([[]]);
    markExternalLinks(root);
    markExternalLinks(root);
    expect([...root.anchors[0]!.set]).toEqual(["external-link"]);
  });

  test("diagram frames and Mehrpele shells mark links on render", () => {
    const frame = readFileSync(`${root}src/diagram-frame.ts`, "utf8");
    const mehr = readFileSync(`${root}src/mehrpele/mount.ts`, "utf8");
    expect(frame).toContain("markExternalLinks(this.mountEl)");
    expect(mehr).toContain("markExternalLinks(svg)");
  });

  test("internal links take the theme link colour inside our hosts on every Obsidian", () => {
    expect(ruleBody(".pele-host .pele a.internal-link")).toMatch(/fill:\s*var\(--link-color\)/);
  });
});
