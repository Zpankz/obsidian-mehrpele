import { afterEach, describe, expect, test } from "bun:test";
import { cleanSvgTree, sanitizedSvgMarkup, type SvgElementLike } from "../src/sanitize-svg";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

type Attr = { name: string; localName: string; value: string };

/** A tiny element tree with the DOM surface the sanitizer touches (bun has no DOMParser). */
class FakeEl implements SvgElementLike {
  attrs: Attr[];
  kids: FakeEl[] = [];
  parent: FakeEl | null = null;
  constructor(
    public tagName: string,
    attrs: Record<string, string>,
    public namespaceURI: string | null = SVG_NS,
  ) {
    this.attrs = Object.entries(attrs).map(([name, value]) => ({ name, localName: name.split(":").pop()!, value }));
  }
  get children(): FakeEl[] {
    return this.kids;
  }
  get attributes(): Attr[] {
    return this.attrs;
  }
  remove(): void {
    if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this);
  }
  removeAttribute(name: string): void {
    this.attrs = this.attrs.filter((a) => a.name !== name);
  }
  add(...kids: FakeEl[]): this {
    for (const k of kids) {
      k.parent = this;
      this.kids.push(k);
    }
    return this;
  }
  attrNames(): string[] {
    return this.attrs.map((a) => a.name);
  }
  tags(): string[] {
    return this.kids.map((k) => k.tagName);
  }
}
const el = (tag: string, attrs: Record<string, string> = {}, ns: string | null = SVG_NS) => new FakeEl(tag, attrs, ns);

describe("cleanSvgTree XSS fixtures", () => {
  test("strips event handlers from the root <svg> itself", () => {
    const root = el("svg", { onload: "alert(1)", ONERROR: "alert(2)", viewBox: "0 0 10 10" });
    expect(cleanSvgTree(root)).toBe(true);
    expect(root.attrNames()).toEqual(["viewBox"]);
  });

  test("strips javascript:/data: hrefs under any namespace prefix", () => {
    const a = el("a", { "x:href": "javascript:alert(1)", class: "n" });
    const use = el("use", { "xlink:href": "data:image/svg+xml,<svg onload=alert(1)>" });
    const safe = el("a", { href: "#n1", "xlink:href": "obsidian://open?file=x" });
    const sneaky = el("a", { href: " JaVaScRiPt:alert(1)" });
    const root = el("svg", { "x:href": "javascript:alert(1)" }).add(a, use, safe, sneaky);
    expect(cleanSvgTree(root)).toBe(true);
    expect(root.attrNames()).toEqual([]);
    expect(a.attrNames()).toEqual(["class"]);
    expect(use.attrNames()).toEqual([]);
    expect(safe.attrNames()).toEqual(["href", "xlink:href"]);
    expect(sneaky.attrNames()).toEqual([]);
  });

  test("drops script, foreignObject, animation and non-SVG-namespace elements; cleans nested handlers", () => {
    const inner = el("rect", { onclick: "alert(1)", width: "4" });
    const g = el("g", { onmouseover: "alert(1)" }).add(
      el("script", {}).add(),
      el("foreignObject", {}).add(el("iframe", { src: "javascript:alert(1)" }, XHTML_NS)),
      el("set", { attributeName: "href", to: "javascript:alert(1)" }),
      el("a", {}, XHTML_NS),
      inner,
    );
    const root = el("svg", {}).add(el("style", {}), g);
    expect(cleanSvgTree(root)).toBe(true);
    expect(root.tags()).toEqual(["g"]);
    expect(g.attrNames()).toEqual([]);
    expect(g.tags()).toEqual(["rect"]);
    expect(inner.attrNames()).toEqual(["width"]);
  });

  test("refuses a root that is not an SVG <svg>", () => {
    expect(cleanSvgTree(el("parsererror", {}, XHTML_NS))).toBe(false);
    expect(cleanSvgTree(el("svg", {}, XHTML_NS))).toBe(false);
  });
});

describe("sanitizedSvgMarkup", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { DOMParser: g.DOMParser, XMLSerializer: g.XMLSerializer, document: g.document };
  afterEach(() => Object.assign(g, saved));

  test("returns the markup untouched when Sanitize SVG is off", () => {
    expect(sanitizedSvgMarkup('<svg onload="x"></svg>', false)).toBe('<svg onload="x"></svg>');
  });

  test("parses, cleans and re-serialises when it is on", () => {
    const root = el("svg", { onload: "alert(1)", width: "10" }).add(el("script", {}));
    g.DOMParser = class {
      parseFromString() {
        return { documentElement: root };
      }
    };
    g.document = { importNode: (n: unknown) => n };
    g.XMLSerializer = class {
      serializeToString(n: FakeEl) {
        return `<${n.tagName} ${n.attrNames().join(" ")}>${n.tags().join(",")}</${n.tagName}>`;
      }
    };
    expect(sanitizedSvgMarkup('<svg onload="alert(1)" width="10"><script/></svg>', true)).toBe("<svg width></svg>");
  });
});
