/**
 * Resize handle for node content (image and embed labels). Nested diagrams
 * use DiagramFrame's own corner instead.
 *
 * Sizes are SVG units (what `|W` / `|WxH` persist). The caller supplies the
 * live on-screen scale (client px per SVG unit) and the current size, so the
 * drag is right for labels laid out 1:1 (images) and for viewport labels
 * (embeds, laid out at s/k) alike. Content is centred in its node, so its
 * right edge moves half as far as its width grows: the drag applies twice
 * the pointer delta (same as frames).
 * Only a genuine drag on the corner commits (see drag-move.ts).
 */
import { isGenuineHandleClick, isGenuineHandlePress, trackHandleDrag } from "../drag-move";

export interface NodeResizeOptions {
  /** Element whose box the drag resizes (live preview while dragging). */
  target: HTMLElement;
  /** Client px per SVG unit right now (pointer deltas → SVG units). */
  scale(): number;
  /** Current content size in SVG units (drag start). */
  size(): { width: number; height: number };
  /** Locked width/height ratio (images); free WxH when omitted. */
  aspect?: number;
  min: { width: number; height: number };
  max: { width: number; height: number };
  onPreview(size: { width: number; height: number }): void;
  /** Click / cancelled drag: undo the preview (default: preview the start size). */
  onCancel?(): void;
  /** Genuine drag released at a new size; `start` is the size at the press. */
  onCommit(size: { width: number; height: number }, start: { width: number; height: number }): void;
  /** Double-click: back to automatic size. */
  onReset(): void;
}

export const RESIZING_CLASS = "mehrpele-resizing";

function sameSize(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  return Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height);
}

export function clampResize(
  start: { width: number; height: number },
  delta: { x: number; y: number },
  o: Pick<NodeResizeOptions, "aspect" | "min" | "max">,
): { width: number; height: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  let width = clamp(start.width + 2 * delta.x, o.min.width, o.max.width);
  if (o.aspect && o.aspect > 0) {
    // Height follows width; re-clamp width so height stays inside its bounds.
    let height = width / o.aspect;
    if (height > o.max.height) width = o.max.height * o.aspect;
    if (height < o.min.height) width = Math.min(o.max.width, o.min.height * o.aspect);
    height = width / o.aspect;
    return { width: Math.round(width), height: Math.round(height) };
  }
  const height = clamp(start.height + delta.y, o.min.height, o.max.height);
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Content of a fixed aspect (an image) inside a dragged box: as large as
 * fits both sides (contain), within the content bounds. A drag against the
 * aspect (straight down on a wide image) leaves the image as wide as it was
 * and only the box grows: the image never shrinks because a side grew.
 */
export function fitInBox(
  box: { width: number; height: number },
  aspect: number,
  min: { width: number },
  max: { width: number },
): { width: number; height: number } {
  const a = aspect > 0 ? aspect : 1;
  const want = Math.min(box.width, box.height * a);
  const width = Math.round(Math.min(Math.max(want, min.width), Math.max(min.width, max.width)));
  return { width, height: Math.round(width / a) };
}

/** Attach a bottom-right resize corner to `host`; returns a detach function. */
export function attachNodeResize(host: HTMLElement, o: NodeResizeOptions): () => void {
  const corner = createDiv();
  corner.className = "mehrpele-node-resize";
  corner.setAttribute("aria-label", "Drag to resize, double-click to reset");
  host.appendChild(corner);
  // Scrolling hosts (note embeds): keep the corner on the visible box corner.
  // Translating by the scroll offset never extends the scrollable area. The
  // `translate` property (not `transform`) composes after the CSS `scale`
  // that keeps the corner a constant on-screen size (mehrpele.css).
  const follow = (): void => {
    corner.style.translate = host.scrollLeft || host.scrollTop ? `${host.scrollLeft}px ${host.scrollTop}px` : "";
  };
  host.addEventListener("scroll", follow, { passive: true });

  const onDblClick = (e: MouseEvent): void => {
    if (!isGenuineHandleClick(e, corner)) return;
    e.preventDefault();
    e.stopPropagation();
    o.onReset();
  };
  const swallow = (e: Event): void => {
    e.stopPropagation();
  };
  const onDown = (e: PointerEvent): void => {
    // Only a genuine press on the corner itself: embedded views (Bases,
    // base-graph) sit right under it and must never start a resize.
    if (!isGenuineHandlePress(e, corner)) return;
    e.preventDefault();
    e.stopPropagation();
    const scale = o.scale();
    const start = o.size();
    let current = start;
    let raf = 0;
    host.classList.add(RESIZING_CLASS);
    trackHandleDrag(corner, e, {
      onMove: (dx, dy) => {
        current = clampResize(start, { x: dx / (scale || 1), y: dy / (scale || 1) }, o);
        if (!raf) {
          raf = window.requestAnimationFrame(() => {
            raf = 0;
            o.onPreview(current);
          });
        }
      },
      onEnd: (commit) => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        host.classList.remove(RESIZING_CLASS);
        if (!commit || sameSize(current, start)) {
          if (o.onCancel) o.onCancel();
          else o.onPreview(start);
          return;
        }
        o.onPreview(current);
        o.onCommit(current, start);
      },
    });
  };
  corner.addEventListener("pointerdown", onDown);
  corner.addEventListener("dblclick", onDblClick);
  corner.addEventListener("click", swallow);
  return () => {
    host.removeEventListener("scroll", follow);
    corner.removeEventListener("pointerdown", onDown);
    corner.removeEventListener("dblclick", onDblClick);
    corner.removeEventListener("click", swallow);
    corner.remove();
  };
}
