import { setIcon } from "obsidian";
import { asButton, FocusTrap, modalKeyRoute } from "./a11y";
import { LIGHTBOX_HOST_CLASS } from "./core-look";
import type { DiagramFrame } from "./diagram-frame";
import { mehrpeleViewport } from "./features/lazy";
import { REFLOW_HEIGHT_CLASS, REFLOW_SIZED_CLASS } from "./reflow-frame";

/**
 * Lightbox reusing Obsidian's native `.lightbox` DOM/classes (styled by
 * app.css): wheel/pinch zoom, drag pan, double-click toggle, keyboard
 * (+/-/0/Esc, arrows cycle diagrams in the same note), bg-click close.
 * A modal dialog for assistive tech: named by its title, focus moves to the
 * close button on open, Tab stays inside, and focus returns to the opener.
 */
let lightboxSeq = 0;

export class PeleLightbox {
  private frames: DiagramFrame[];
  private index: number;
  private rootEl: HTMLElement;
  private mediaWrapper: HTMLElement;
  private titleEl: HTMLElement;
  private closeBtn: HTMLElement;
  private trap: FocusTrap;
  private scale = 1;
  private panX = 0;
  private panY = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private dragLast: { x: number; y: number } | null = null;
  private closed = false;
  /** Smallest zoom (below 1 when the laid-out diagram overflows the lightbox). */
  private minScale = 1;
  /** The diagram is larger than the lightbox at zoom 1: drag pans it. */
  private overflows = false;

  private constructor(frames: DiagramFrame[], index: number) {
    this.frames = frames;
    this.index = index;
    this.rootEl = createDiv();
    this.rootEl.className = "lightbox";
    this.rootEl.setAttribute("role", "dialog");
    this.rootEl.setAttribute("aria-modal", "true");
    const bg = createDiv();
    bg.className = "lightbox-bg";
    bg.addEventListener("click", () => this.close());
    const content = createDiv();
    content.className = "lightbox-content";
    const media = createDiv();
    media.className = "lightbox-media";
    this.mediaWrapper = createDiv();
    this.mediaWrapper.className = LIGHTBOX_HOST_CLASS;
    media.appendChild(this.mediaWrapper);
    const controls = createDiv();
    controls.className = "lightbox-controls";
    content.append(media, controls);
    const titlebar = createDiv();
    titlebar.className = "lightbox-titlebar";
    this.titleEl = createDiv();
    this.titleEl.className = "lightbox-titlebar-text";
    this.titleEl.id = `pele-lightbox-title-${++lightboxSeq}`;
    this.rootEl.setAttribute("aria-labelledby", this.titleEl.id);
    titlebar.appendChild(this.titleEl);
    // Core's div.modal-close-button, operable from the keyboard like a button.
    const closeBtn = (this.closeBtn = asButton(createDiv()));
    closeBtn.className = "modal-close-button mod-raised clickable-icon";
    setIcon(closeBtn, "x");
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", () => this.close());
    this.rootEl.append(bg, content, titlebar, closeBtn);
    this.trap = new FocusTrap(this.rootEl);

    content.addEventListener("wheel", this.onWheel, { passive: false });
    content.addEventListener("dblclick", this.onDblClick);
    content.addEventListener("pointerdown", this.onPointerDown);
    content.addEventListener("pointermove", this.onPointerMove);
    content.addEventListener("pointerup", this.onPointerUp);
    content.addEventListener("pointercancel", this.onPointerUp);
    document.addEventListener("keydown", this.onKeyDown, true);
    this.renderCurrent();
  }

  private static current: PeleLightbox | null = null;

  static open(frames: DiagramFrame[], index: number): PeleLightbox {
    PeleLightbox.current?.close(); // single instance: never stack
    const lb = new PeleLightbox(frames, Math.max(0, index));
    PeleLightbox.current = lb;
    document.body.appendChild(lb.rootEl);
    lb.trap.activate(lb.closeBtn);
    return lb;
  }

  static closeCurrent(): void {
    PeleLightbox.current?.close();
  }

  private customCleanup: (() => void) | null = null;

  /** Lightbox hosting live HTML (Mehrpele overlay parity), populated by the caller. */
  static openCustom(
    title: string,
    populate: (wrapper: HTMLElement) => (() => void) | void,
  ): PeleLightbox {
    PeleLightbox.current?.close();
    const lb = new PeleLightbox([], 0);
    lb.titleEl.textContent = title;
    try {
      const cleanup = populate(lb.mediaWrapper);
      if (typeof cleanup === "function") lb.customCleanup = cleanup;
    } catch {
      /* caller renders fallback */
    }
    PeleLightbox.current = lb;
    document.body.appendChild(lb.rootEl);
    lb.trap.activate(lb.closeBtn);
    return lb;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (PeleLightbox.current === this) PeleLightbox.current = null;
    document.removeEventListener("keydown", this.onKeyDown, true);
    try {
      this.customCleanup?.();
    } catch {
      /* ignore */
    }
    this.customCleanup = null;
    this.rootEl.remove();
    this.trap.release();
  }

  private renderCurrent(): void {
    const frame = this.frames[this.index];
    this.mediaWrapper.replaceChildren();
    this.minScale = 1;
    this.overflows = false;
    // Fresh render with its own idPrefix (cloning would share a11y ids).
    let svg: SVGElement | null = null;
    const W = Math.floor(window.innerWidth * 0.92);
    const H = Math.floor(window.innerHeight * 0.85);
    let boxed: ReturnType<DiagramFrame["boxSvgElement"]> = null;
    try {
      // Reflow: laid out for the whole lightbox, shown at ≤ 1× (zoom magnifies).
      boxed = frame?.reflowEnabled ? frame.boxSvgElement(W, H) : null;
      svg = boxed?.svg ?? frame?.freshSvgElement() ?? null;
    } catch {
      svg = frame?.cloneSvg() ?? null;
    }
    if (svg && boxed) {
      const floor = frame?.reflowFloor ?? 0.8;
      const shown = Math.min(1, Math.max(boxed.scale, floor));
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.style.width = `${Math.round(boxed.width * shown)}px`;
      // height auto, no max-width/max-height (styles.css): the inline width rules.
      for (const p of ["height", "max-width", "max-height"]) svg.style.removeProperty(p);
      svg.classList.add("pele-lightbox-reflow");
      // Zoom out down to the whole diagram; drag pans while it overflows.
      this.minScale = Math.min(1, boxed.scale / shown);
      this.overflows = boxed.scale < shown - 1e-3;
      this.rootEl.dataset.reflow = `scale=${shown.toFixed(3)} fit=${boxed.scale.toFixed(3)}`;
    } else if (svg) {
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      // Fit like the native image lightbox (object-fit: contain): fill the
      // media box and let the viewBox's default xMidYMid meet scale it
      // (width/height/max-width/max-height 100%, styles.css). A clone of a
      // reflowed SVG drops its inline width and frame sizing classes first.
      for (const p of ["width", "height", "max-width", "max-height"]) svg.style.removeProperty(p);
      svg.classList.remove(REFLOW_SIZED_CLASS, REFLOW_HEIGHT_CLASS);
      svg.classList.add("pele-lightbox-fit");
    }
    if (svg) {
      svg.classList.add("pele-lightbox-pad");
      // The reflow width is the drawing's own size: padding goes outside it.
      svg.style.boxSizing = boxed ? "content-box" : "border-box";
      // Links in the fresh SVG route through the source frame's handling.
      const owner = frame;
      svg.querySelectorAll("a").forEach((a) => {
        a.addEventListener("click", (ev) => {
          const href = a.getAttribute("href");
          // Refused links must not fall through to default navigation.
          ev.preventDefault();
          ev.stopPropagation();
          if (href) owner?.activateLink(href, ev);
        });
      });
      this.mediaWrapper.appendChild(svg);
    }
    this.titleEl.textContent = frame ? (frame.accTitle ?? frame.diagramType ?? frame.lang) : "";
    this.scale = 1;
    this.panX = 0;
    this.panY = 0;
    this.apply();
  }

  private apply(): void {
    this.mediaWrapper.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
    // Mehrpele mounts inside: a zoom changes their on-screen scale without
    // a resize (embed controls stay native size, handles constant). Each
    // mount coalesces requests into one re-place per frame.
    this.mediaWrapper.querySelectorAll(".mehrpele-frame").forEach((f) => mehrpeleViewport().requestReposition(f, false));
    this.rootEl.classList.toggle("is-zoomed", this.scale > 1);
  }

  private setScale(next: number): void {
    this.scale = Math.min(10, Math.max(this.minScale, next));
    if (this.scale <= 1 && !this.overflows) {
      this.panX = 0;
      this.panY = 0;
    }
    this.apply();
  }

  private onWheel = (e: WheelEvent): void => {
    // Interactive embeds inside Mehrpele nodes scroll themselves (a large
    // lightbox is a large viewport); Ctrl/⌘ + wheel still zooms.
    if (!e.ctrlKey && !e.metaKey && (e.target as Element | null)?.closest?.(".mehrpele-viewport-item")) return;
    e.preventDefault();
    this.setScale(this.scale * Math.exp(-e.deltaY * 0.0015));
  };

  private onDblClick = (): void => {
    this.setScale(this.scale > 1 ? 1 : 2.5);
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    } else if (this.pointers.size === 1) {
      this.dragLast = { x: e.clientX, y: e.clientY };
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0) this.setScale(this.scale * (dist / this.pinchDist));
      this.pinchDist = dist;
    } else if (this.pointers.size === 1 && this.dragLast && (this.scale > 1 || this.overflows)) {
      this.panX += e.clientX - this.dragLast.x;
      this.panY += e.clientY - this.dragLast.y;
      this.dragLast = { x: e.clientX, y: e.clientY };
      this.apply();
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = 0;
    if (this.pointers.size === 0) this.dragLast = null;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    // Editors in live views own their keys, Tab (indent) included; form controls keep typing keys, not Tab.
    const route = modalKeyRoute(e.key, e.target);
    if (route === "own") return;
    if (route === "trap") {
      // Modal: Tab and Shift-Tab cycle inside the lightbox, never to the page behind.
      this.trap.onTab(e);
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape") this.close();
    else if (e.key === "+" || e.key === "=") this.setScale(this.scale * 1.2);
    else if (e.key === "-") this.setScale(this.scale / 1.2);
    else if (e.key === "0") this.setScale(1);
    else if (e.key === "ArrowRight" && this.frames.length > 1) {
      this.index = (this.index + 1) % this.frames.length;
      this.renderCurrent();
    } else if (e.key === "ArrowLeft" && this.frames.length > 1) {
      this.index = (this.index - 1 + this.frames.length) % this.frames.length;
      this.renderCurrent();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
}
