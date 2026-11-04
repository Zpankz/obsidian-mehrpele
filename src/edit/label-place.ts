/**
 * Where a label is drawn and how it looks, so the inline editor can sit on
 * it seamlessly: the area inscribed in the node's shape (or the Mehrpele
 * label's own box), the label's font, size, colour and alignment, and the
 * node's fill behind it. Also hides the rendered label while it is edited.
 */
import type { LabelPlacement } from "./inline-editor";
import { outlineShapes } from "../node-outline";
import { labelArea, screenScale, type ClientBox } from "./node-geometry";
import type { EditTarget } from "./ops";

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

export function targetElement(svg: SVGSVGElement, t: EditTarget): Element | null {
  const sel = t.kind === "node" ? ".pele-node" : t.kind === "edge" ? ".pele-edge" : ".pele-cluster";
  return svg.querySelector(`${sel}[data-id="${cssEscape(t.id)}"]`);
}

function overlayItem(wrapper: HTMLElement, id: string): HTMLElement | null {
  return wrapper.querySelector(`.mehrpele-overlay-item[data-anchor="${cssEscape(id)}"]`);
}

function fillOf(el: Element | null | undefined): string {
  if (!el) return "";
  const f = getComputedStyle(el).fill;
  return !f || f === "none" ? "" : f;
}

/** Style of an SVG `<text>` label in screen px. */
function svgTextStyle(text: SVGGraphicsElement | null): Pick<LabelPlacement, "font" | "fontSize" | "color"> {
  if (!text) return { font: "var(--font-text)", fontSize: 14, color: "var(--text-normal)" };
  const cs = getComputedStyle(text);
  const size = Number.parseFloat(cs.fontSize) || 16;
  return { font: cs.fontFamily || "var(--font-text)", fontSize: size * screenScale(text), color: cs.fill && cs.fill !== "none" ? cs.fill : cs.color };
}

function box(r: DOMRect | ClientBox, minW = 0, minH = 0): ClientBox {
  const width = Math.max(r.width, minW);
  const height = Math.max(r.height, minH);
  return { left: r.left + r.width / 2 - width / 2, top: r.top + r.height / 2 - height / 2, width, height };
}

export function labelPlacement(wrapper: HTMLElement, svg: SVGSVGElement, t: EditTarget): LabelPlacement | null {
  const el = targetElement(svg, t);
  if (!el) return null;
  if (t.kind === "node") {
    const area = labelArea(el);
    if (!area) return null;
    const shape = outlineShapes(el)[0];
    const item = overlayItem(wrapper, t.id);
    const md = item?.querySelector(".mehrpele-label") as HTMLElement | null;
    if (item && md) {
      // Mehrpele: the Markdown label is HTML; edit where (and as) it is drawn.
      const cs = getComputedStyle(md);
      const r = item.getBoundingClientRect();
      const b = box(r, Math.min(area.width, 120), 24);
      return {
        ...b,
        radius: area.radius,
        font: cs.fontFamily,
        fontSize: (Number.parseFloat(cs.fontSize) || 16) * (r.width / Math.max(1, item.offsetWidth || r.width)),
        color: cs.color,
        background: fillOf(shape),
        // Mehrpele centres the label block in the node.
        align: "center",
      };
    }
    return { ...area, ...svgTextStyle(el.querySelector(".pele-label")), background: fillOf(shape), align: "center" };
  }
  if (t.kind === "edge") {
    const lbl = svg.querySelector(`.pele-edge-label[data-id="${cssEscape(t.id)}"]`);
    const style = svgTextStyle((lbl?.querySelector("text") as SVGGraphicsElement | null) ?? null);
    const item = overlayItem(wrapper, Array.from(wrapper.querySelectorAll<HTMLElement>(".mehrpele-overlay-item[data-anchor*='->']")).find((i) => lbl && overlaps(i.getBoundingClientRect(), lbl.getBoundingClientRect()))?.dataset.anchor ?? "\u0000");
    const rectEl = lbl?.querySelector("rect");
    if (lbl) {
      const r = (item ?? rectEl ?? lbl).getBoundingClientRect();
      return { ...box(r, 72, style.fontSize * 1.6), radius: 4, ...style, background: fillOf(rectEl) || "var(--background-primary)", align: "center" };
    }
    // No label yet: centre on the path's midpoint.
    const path = el.querySelector<SVGPathElement>("path:not(.pele-marker):not(.pele-edit-hit)");
    const m = path?.getScreenCTM();
    if (!path || !m) return null;
    const p = path.getPointAtLength(path.getTotalLength() / 2);
    const x = m.a * p.x + m.c * p.y + m.e;
    const y = m.b * p.x + m.d * p.y + m.f;
    const h = style.fontSize * 1.6;
    return { left: x - 40, top: y - h / 2, width: 80, height: h, radius: 4, ...style, background: "var(--background-primary)", align: "center" };
  }
  const label = el.querySelector<SVGGraphicsElement>(".pele-cluster-label");
  const shape = outlineShapes(el)[0];
  const r = (label ?? el).getBoundingClientRect();
  const style = svgTextStyle(label);
  return { ...box(r, 120, style.fontSize * 1.6), radius: 4, ...style, background: fillOf(shape), align: "center" };
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Hide the rendered label of `t` (SVG text and Mehrpele overlay); returns the restorer. */
export function hideLabel(wrapper: HTMLElement, svg: SVGSVGElement, t: EditTarget): () => void {
  const el = targetElement(svg, t);
  const hidden: Array<HTMLElement | SVGElement> = [];
  if (el) {
    const texts =
      t.kind === "edge"
        ? Array.from(svg.querySelectorAll<SVGElement>(`.pele-edge-label[data-id="${cssEscape(t.id)}"] text`))
        : t.kind === "subgraph"
          ? Array.from(el.querySelectorAll<SVGElement>(".pele-cluster-label"))
          : Array.from(el.querySelectorAll<SVGElement>("text, .pele-label"));
    hidden.push(...texts);
  }
  if (t.kind === "node") {
    const item = overlayItem(wrapper, t.id);
    if (item) hidden.push(item);
  }
  for (const h of hidden) h.classList.add("pele-edit-hidden");
  return () => hidden.forEach((h) => h.classList.remove("pele-edit-hidden"));
}
