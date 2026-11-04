/**
 * node-outline.ts is the one source of outline geometry (node handles' hover
 * outline, the edit toolbar's hover/selection outlines, menu placement,
 * marquee, inline editor). Bun has no DOM: a 2D DOMMatrix/DOMPoint/DOMRect
 * and minimal fake SVG elements stand in, enough for the real code to run.
 */
import { beforeAll, describe, expect, test } from "bun:test";

class Matrix {
  constructor(public a = 1, public b = 0, public c = 0, public d = 1, public e = 0, public f = 0) {}
  static fromMatrix(m: Matrix) {
    return new Matrix(m.a, m.b, m.c, m.d, m.e, m.f);
  }
  multiply(o: Matrix) {
    return new Matrix(
      this.a * o.a + this.c * o.b,
      this.b * o.a + this.d * o.b,
      this.a * o.c + this.c * o.d,
      this.b * o.c + this.d * o.d,
      this.a * o.e + this.c * o.f + this.e,
      this.b * o.e + this.d * o.f + this.f,
    );
  }
  translate(x: number, y: number) {
    return this.multiply(new Matrix(1, 0, 0, 1, x, y));
  }
  scale(sx: number, sy = sx) {
    return this.multiply(new Matrix(sx, 0, 0, sy, 0, 0));
  }
}
class Point {
  constructor(public x = 0, public y = 0) {}
  matrixTransform(m: Matrix) {
    return new Point(m.a * this.x + m.c * this.y + m.e, m.b * this.x + m.d * this.y + m.f);
  }
}
class Rect {
  constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
  get left() {
    return this.x;
  }
  get top() {
    return this.y;
  }
  get right() {
    return this.x + this.width;
  }
  get bottom() {
    return this.y + this.height;
  }
}

interface Style {
  fill?: string;
  stroke?: string;
  strokeWidth?: string;
  rx?: string;
}

class FakeEl {
  parent: FakeEl | null = null;
  children: FakeEl[] = [];
  classList: { contains: (c: string) => boolean };
  constructor(
    public tagName: string,
    public attrs: Record<string, string> = {},
    public style: Style = {},
    public ctm: Matrix | null = null,
  ) {
    this.classList = { contains: (c) => (this.attrs.class ?? "").split(/\s+/).includes(c) };
  }
  get localName() {
    return this.tagName;
  }
  add(...kids: FakeEl[]) {
    for (const k of kids) {
      k.parent = this;
      this.children.push(k);
    }
    return this;
  }
  getAttribute(n: string) {
    return this.attrs[n] ?? null;
  }
  matches(sel: string): boolean {
    return sel.split(",").some((one) => {
      const s = one.trim();
      if (s.startsWith(".")) return this.classList.contains(s.slice(1));
      return this.tagName === s;
    });
  }
  closest(sel: string): FakeEl | null {
    for (let e: FakeEl | null = this; e; e = e.parent) if (e.matches(sel)) return e;
    return null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl) => {
      for (const k of e.children) {
        if (k.matches(sel)) out.push(k);
        walk(k);
      }
    };
    walk(this);
    return out;
  }
  getScreenCTM() {
    let m = this.ctm;
    for (let e = this.parent; !m && e; e = e.parent) m = e.ctm;
    return m ?? new Matrix();
  }
  getBBox() {
    const n = (k: string) => Number(this.attrs[k] ?? 0);
    if (this.tagName === "rect") return new Rect(n("x"), n("y"), n("width"), n("height"));
    if (this.tagName === "circle") return new Rect(n("cx") - n("r"), n("cy") - n("r"), 2 * n("r"), 2 * n("r"));
    const nums = (this.attrs.points ?? this.attrs.d ?? "").match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    return new Rect(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  }
  getBoundingClientRect() {
    const b = this.getBBox();
    const m = this.getScreenCTM();
    const p = new Point(b.x, b.y).matrixTransform(m);
    const q = new Point(b.x + b.width, b.y + b.height).matrixTransform(m);
    return new Rect(Math.min(p.x, q.x), Math.min(p.y, q.y), Math.abs(q.x - p.x), Math.abs(q.y - p.y));
  }
}

let outline: typeof import("../src/node-outline");

beforeAll(async () => {
  Object.assign(globalThis, {
    DOMMatrix: Matrix,
    DOMPoint: Point,
    DOMRect: Rect,
    getComputedStyle: (el: FakeEl) => ({
      fill: el.style.fill ?? "#222",
      stroke: el.style.stroke ?? "#888",
      strokeWidth: el.style.strokeWidth ?? "1",
      display: "inline",
      visibility: "visible",
      getPropertyValue: (k: string) => (k === "rx" ? (el.style.rx ?? "") : ""),
    }),
  });
  outline = await import("../src/node-outline");
});

/** A node at (tx, ty) in a diagram drawn at `scale` client px per unit, offset (ox, oy). */
function node(cls: string, shapes: FakeEl[], at: { tx: number; ty: number; scale?: number; ox?: number; oy?: number } = { tx: 100, ty: 50 }) {
  const s = at.scale ?? 1;
  const g = new FakeEl("g", { class: `pele-node ${cls}`, "data-id": "N", transform: `translate(${at.tx},${at.ty})` }, {}, new Matrix(s, 0, 0, s, (at.ox ?? 0) + s * at.tx, (at.oy ?? 0) + s * at.ty));
  return g.add(...shapes);
}

const GAP = 1.5;

describe("one outline for hover and selection", () => {
  test("rect: grown by half the stroke plus the gap, at any scale", () => {
    for (const scale of [1, 0.6, 2.13]) {
      const n = node("pele-shape-rect", [new FakeEl("rect", { x: "-40", y: "-20", width: "80", height: "40" })], { tx: 100, ty: 50, scale, ox: 10, oy: 5 });
      const o = outline.elementOutline(n as unknown as SVGGraphicsElement)!;
      const grow = 0.5 * scale + GAP; // half stroke (units → px) + gap (px)
      expect(o.bounds.x).toBeCloseTo(10 + scale * 60 - grow, 6);
      expect(o.bounds.width).toBeCloseTo(scale * 80 + 2 * grow, 6);
      expect(o.bounds.height).toBeCloseTo(scale * 40 + 2 * grow, 6);
    }
  });

  test("rect with CSS rx (rounded, stadium) keeps its corners", () => {
    const n = node("pele-shape-stadium", [new FakeEl("rect", { x: "-50", y: "-20", width: "100", height: "40" }, { rx: "20" })]);
    const o = outline.elementOutline(n as unknown as SVGGraphicsElement)!;
    expect(o.pieces[0]!.d).toContain("A22,22"); // rx 20 + half stroke 0.5 + gap 1.5 (units at scale 1)
  });

  test("diamond and hexagon: the polygon itself, scaled about its centre", () => {
    const diamond = node("pele-shape-diam", [new FakeEl("polygon", { points: "0,-30 50,0 0,30 -50,0" })]);
    const od = outline.elementOutline(diamond as unknown as SVGGraphicsElement)!;
    expect(od.pieces[0]!.d.startsWith("M0,-30")).toBe(true);
    expect(od.bounds.width).toBeCloseTo(100 + 4, 6);
    expect(od.corner).toEqual({ x: od.bounds.right, y: od.bounds.bottom }); // no vertex near the corner
    const hex = node("pele-shape-hex", [new FakeEl("polygon", { points: "-40,-20 40,-20 50,0 40,20 -40,20 -50,0" })]);
    const oh = outline.elementOutline(hex as unknown as SVGGraphicsElement)!;
    expect(oh.corner.x).toBeLessThan(oh.bounds.right); // handle on the lower-right vertex
  });

  test("circle, cylinder (body only), state/class (dividers ignored)", () => {
    const c = outline.elementOutline(node("pele-shape-circle", [new FakeEl("circle", { cx: "0", cy: "0", r: "20" })]) as unknown as SVGGraphicsElement)!;
    expect(c.bounds.width).toBeCloseTo(44, 6);
    const cyl = outline.elementOutline(
      node("pele-shape-cyl", [
        new FakeEl("path", { d: "M-30,-24 L30,-24 L30,24 L-30,24 Z" }),
        new FakeEl("path", { d: "M-30,-24 L30,-24" }, { fill: "none" }),
      ]) as unknown as SVGGraphicsElement,
    )!;
    expect(cyl.pieces).toHaveLength(1);
    const cls = outline.elementOutline(
      node("pele-class", [new FakeEl("rect", { x: "-40", y: "-30", width: "80", height: "60" }), new FakeEl("path", { class: "pele-divider", d: "M-40,10 L40,10" }, { fill: "none" })]) as unknown as SVGGraphicsElement,
    )!;
    expect(cls.pieces).toHaveLength(1);
  });

  test("a pinned Mehrpele node: hidden fallback text never widens the outline", () => {
    const rect = new FakeEl("rect", { x: "-141", y: "-168", width: "282", height: "336" });
    const text = new FakeEl("text", { class: "pele-label", x: "-200", y: "0", width: "600", height: "20" });
    const o = outline.elementOutline(node("pele-shape-rect", [rect, text]) as unknown as SVGGraphicsElement)!;
    expect(o.bounds.width).toBeCloseTo(282 + 4, 6);
  });

  test("linked nodes (`a > rect`) count; a cluster outlines only itself", () => {
    const a = new FakeEl("a").add(new FakeEl("rect", { x: "-10", y: "-10", width: "20", height: "20" }));
    expect(outline.elementOutline(node("pele-shape-rect", [a]) as unknown as SVGGraphicsElement)!.pieces).toHaveLength(1);
    const cluster = new FakeEl("g", { class: "pele-cluster", "data-id": "S" }, {}, new Matrix()).add(
      new FakeEl("rect", { x: "0", y: "0", width: "300", height: "200" }),
      new FakeEl("text", { class: "pele-cluster-label" }),
      node("pele-shape-rect", [new FakeEl("rect", { x: "-10", y: "-10", width: "20", height: "20" })]),
    );
    const oc = outline.elementOutline(cluster as unknown as SVGGraphicsElement)!;
    expect(oc.pieces).toHaveLength(1);
    expect(oc.bounds.width).toBeCloseTo(304, 6);
  });

  test("text-only nodes (plain mindmap leaves) use their box", () => {
    const o = outline.nodeOutlineGeometry(node("pele-shape-text", []) as unknown as SVGGraphicsElement, new Rect(10, 20, 60, 30) as unknown as DOMRect)!;
    expect([o.bounds.x, o.bounds.width]).toEqual([10 - GAP, 60 + 2 * GAP]);
  });

  test("edges: their line paths only (no arrowheads, no hit paths)", () => {
    const edge = new FakeEl("g", { class: "pele-edge", "data-id": "L_A_B_0" }, {}, new Matrix()).add(
      new FakeEl("path", { d: "M0,0 L100,0" }, { fill: "none" }),
      new FakeEl("path", { class: "pele-marker", d: "M100,0 L92,4 L92,-4 Z" }),
      new FakeEl("path", { class: "pele-edit-hit", d: "M0,0 L100,0" }),
    );
    const o = outline.elementOutline(edge as unknown as SVGGraphicsElement)!;
    expect(o.pieces.map((p) => p.line)).toEqual([true]);
  });

  test("hover layer and selection layer draw identical client geometry", () => {
    const n = node("pele-shape-diam", [new FakeEl("polygon", { points: "0,-30 50,0 0,30 -50,0" })], { tx: 400, ty: 300, scale: 0.68, ox: 120, oy: 80 });
    const o = outline.elementOutline(n as unknown as SVGGraphicsElement)!;
    // Hover: wrapper-local layer at (120, 80), CSS-scaled 0.5; selection: fixed full-window layer.
    const k = 0.5;
    const toLayer = new Matrix().scale(1 / k).translate(-120, -80);
    const hover = outline.outlinePaths(o, toLayer as unknown as DOMMatrix)[0]!;
    const sel = outline.outlinePaths(o)[0]!;
    expect(hover.d).toBe(sel.d);
    const parse = (t: string) => t.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g)!.map(Number);
    const [a, b, c, d, e, f] = parse(hover.transform);
    const back = new Matrix(1, 0, 0, 1, 120, 80).scale(k).multiply(new Matrix(a, b, c, d, e, f));
    const s = parse(sel.transform);
    for (const [i, v] of [back.a, back.b, back.c, back.d, back.e, back.f].entries()) expect(v).toBeCloseTo(s[i]!, 3);
  });
});
