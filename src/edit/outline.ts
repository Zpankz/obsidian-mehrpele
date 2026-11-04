/**
 * Hover / selection outlines: one fixed, full-window `<svg>` (never part of
 * the diagram, so exports and re-renders are untouched) drawing each
 * element's outline from node-outline.ts — the same geometry and serialiser
 * as the node handles' hover outline, so the two coincide. Re-synced on
 * pointer moves, scroll, resize and re-renders by the owner; a short
 * animation-frame loop follows layout transitions (reflow FLIP).
 */
import { elementOutline, outlinePaths } from "../node-outline";

const SVG_NS = "http://www.w3.org/2000/svg";

export type OutlineKind = "hover" | "selected";

export class OutlineOverlay {
  private svg: SVGSVGElement | null = null;
  private items = new Map<string, { target: Element; kind: OutlineKind }>();
  private follow = 0;
  private followUntil = 0;

  /** `docOf`: the document the outlined diagram is in now (a frame built before it was placed may move to a popout). */
  constructor(private readonly docOf: () => Document) {}

  private get doc(): Document {
    return this.docOf();
  }

  set(key: string, target: Element | null, kind: OutlineKind): void {
    if (target) this.items.set(key, { target, kind });
    else this.items.delete(key);
    this.sync();
  }

  /** Replace all outlines of one kind. */
  setAll(kind: OutlineKind, targets: Array<[string, Element]>): void {
    for (const [k, v] of [...this.items]) if (v.kind === kind) this.items.delete(k);
    for (const [k, el] of targets) this.items.set(k, { target: el, kind });
    this.sync();
  }

  has(kind: OutlineKind): boolean {
    return [...this.items.values()].some((v) => v.kind === kind);
  }

  /** Redraw from the elements' current geometry. */
  sync(): void {
    for (const [k, v] of [...this.items]) if (!v.target.isConnected) this.items.delete(k);
    if (!this.items.size) {
      this.svg?.remove();
      this.svg = null;
      return;
    }
    if (this.svg && this.svg.ownerDocument !== this.doc) {
      this.svg.remove();
      this.svg = null;
    }
    if (!this.svg) {
      this.svg = this.doc.createElementNS(SVG_NS, "svg");
      this.svg.setAttribute("class", "pele-edit-outlines");
      this.svg.setAttribute("aria-hidden", "true");
      this.doc.body.appendChild(this.svg);
    }
    const frag = createFragment();
    for (const { target, kind } of this.items.values()) {
      const g = this.doc.createElementNS(SVG_NS, "g");
      g.setAttribute("class", `pele-edit-outline is-${kind}${target.classList.contains("pele-edge") ? " is-edge" : ""}`);
      const outline = elementOutline(target as SVGGraphicsElement);
      if (outline) {
        for (const p of outlinePaths(outline)) {
          const path = this.doc.createElementNS(SVG_NS, "path");
          path.setAttribute("d", p.d);
          path.setAttribute("transform", p.transform);
          if (p.line) path.setAttribute("class", "is-line");
          g.appendChild(path);
        }
      }
      frag.appendChild(g);
    }
    this.svg.replaceChildren(frag);
  }

  /** Keep re-syncing for `ms` (layout animations after a re-render). */
  followFor(ms = 450): void {
    this.followUntil = performance.now() + ms;
    if (this.follow) return;
    const tick = () => {
      this.sync();
      this.follow = performance.now() < this.followUntil && this.items.size ? window.requestAnimationFrame(tick) : 0;
    };
    this.follow = window.requestAnimationFrame(tick);
  }

  clear(kind?: OutlineKind): void {
    if (!kind) this.items.clear();
    else for (const [k, v] of [...this.items]) if (v.kind === kind) this.items.delete(k);
    this.sync();
  }

  destroy(): void {
    if (this.follow) cancelAnimationFrame(this.follow);
    this.follow = 0;
    this.items.clear();
    this.svg?.remove();
    this.svg = null;
  }
}
