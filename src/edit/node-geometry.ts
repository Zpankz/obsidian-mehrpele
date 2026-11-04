/**
 * Geometry the edit toolbar needs beyond the outline itself: the shapes'
 * client box (menu placement, marquee) and where label text can sit inside
 * a shape (the inline editor). Built on node-outline.ts, the one source of
 * outline geometry, so everything lines up with the drawn outlines.
 */
import { elementOutline, outlineShapes } from "../node-outline";

export interface ClientBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Client box of what the element draws (shapes incl. their stroke; text-only nodes: layout box). */
export function shapeClientBox(target: Element): ClientBox | null {
  const o = elementOutline(target as SVGGraphicsElement, 0);
  if (!o) return null;
  return { left: o.bounds.x, top: o.bounds.y, width: o.bounds.width, height: o.bounds.height };
}

/** Screen px per SVG user unit at `el` (uniform scale assumed). */
export function screenScale(el: SVGGraphicsElement): number {
  const m = el.getScreenCTM();
  return m ? Math.hypot(m.a, m.b) || 1 : 1;
}

export type ShapeKind = "rect" | "rounded" | "stadium" | "diamond" | "circle" | "hexagon" | "slanted" | "cylinder" | "other";

/** Shape kind from Pele's classes (flowchart `pele-shape-*`, mindmap, state, class). */
export function shapeKind(node: Element): ShapeKind {
  const cls = node.getAttribute("class") ?? "";
  const m = /pele-shape-([\w-]+)/.exec(cls);
  const k = m?.[1] ?? "";
  if (/^(diam|diamond|question|decision)$/.test(k)) return "diamond";
  if (/^(circle|circ|dbl-circ|doublecircle|sm-circ|fr-circ)$/.test(k)) return "circle";
  if (/^(hex|hexagon|bang|cloud)$/.test(k)) return "hexagon";
  if (/^(stadium|pill|terminal)$/.test(k)) return "stadium";
  if (/^(lean|trap|odd|asym)/.test(k) || /lean|trap|parallel/.test(k)) return "slanted";
  if (/^(cyl|cylinder|db|database)/.test(k)) return "cylinder";
  if (/^(rounded|round)$/.test(k)) return "rounded";
  if (/^(rect|square|subroutine|fr-rect)$/.test(k) || /pele-(state|class)\b/.test(cls)) return "rect";
  return "other";
}

/** Where label text can sit inside a node: an inscribed box and its corner radius (client px). */
export function labelArea(node: Element): (ClientBox & { radius: number }) | null {
  const box = shapeClientBox(node);
  if (!box) return null;
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const at = (w: number, h: number, radius: number) => ({ left: cx - w / 2, top: cy - h / 2, width: w, height: h, radius });
  const inset = 4;
  switch (shapeKind(node)) {
    case "diamond":
      return at(box.width / 2, box.height / 2, 6);
    case "circle": {
      const s = Math.min(box.width, box.height) / Math.SQRT2;
      return at(s, s, 6);
    }
    case "hexagon":
      return at(box.width - box.height / 2, box.height - 2 * inset, 6);
    case "stadium":
      return at(box.width - box.height / 2, box.height - 2 * inset, (box.height - 2 * inset) / 2);
    case "slanted":
      return at(box.width - box.height / 2, box.height - 2 * inset, 4);
    case "cylinder":
      return at(box.width - 2 * inset, box.height * 0.7, 4);
    default: {
      const shape = outlineShapes(node)[0];
      let r = 4;
      if (shape?.localName === "rect") {
        const rx = Number.parseFloat(getComputedStyle(shape).getPropertyValue("rx")) || Number(shape.getAttribute("rx")) || 0;
        r = Math.max(2, rx * screenScale(shape) - inset / 2);
      }
      return at(box.width - 2 * inset, box.height - 2 * inset, r);
    }
  }
}
