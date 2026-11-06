/**
 * mountMehrpele — "measure, reserve, overlay":
 * extract → pre-render + measure off-screen → reserve via placeholders and a
 * wrapped measurer → render with Pele → position the HTML overlay.
 *
 * Fail-safe everywhere: no quoted labels, a failed anchor, or a disabled
 * embed degrades to the plain Pele SVG, never an error.
 */
import { mount as peleMount, render as peleRender, type Mounted, type RenderOptions, type RenderResult } from "pele-render/pele";
import { markExternalLinks } from "../core-look";
import { placeSvg } from "../svg-markup";
import { extractLabels, stripMehrpeleDirective } from "./extract";
import { isRemeasurable, renderLabels, settleLabel, type ContentDelta, type MehrpeleHost, type RenderedLabel } from "./labels";
import { fitBoxEntry, shiftBoxEntry } from "../node-size";
import { fillSvgLabels, innerBox, shapeKind } from "../node-fill";
import { nodeBoxes, nodeBoxMap, nodeSizeCaps, parseSizeDirective, stripSizeDirective, withSizeDirective, type SizeCaps } from "pele-render/node-size";
import { NOTE_EDITING_CLASS } from "./note-card";
import { bleedPlaceholder, isAspectMode, isBleedLabel, withBleedEntries } from "./bleed";
import type { MehrpeleLabelSize } from "./model";
import { rewriteLabel } from "./nested";
import { RESIZING_CLASS } from "./node-resize";
import { releaseRenderedLabels } from "./release";
import type { MehrpeleLabel } from "./model";
import { MehrpeleOverlay } from "./overlay";
import {
  buildPlaceholder,
  makeReservationMeasurer,
  placeholderSource,
  TOKEN_RE,
  type ReservedLabel,
} from "./placeholder";
import { isImageTarget } from "./embeds";
import { clientToSvgSize, decideRemeasure, intrinsicSvgSize, type SizedAnchor } from "./remeasure";
import { isViewportMode, REPOSITION_EVENT, requestReposition } from "./viewport";
import { parseReflowDirective, ReflowPlanner, type ReflowPlan } from "pele-render/reflow";
import { applyBoxDisplay, applyDisplaySize, canAnimate, clearBoxDisplay, cssFonts, withHeightCheck, playFlip, snapshotLayout, type FlipSnapshot } from "../reflow-frame";

export type { MehrpeleHost } from "./labels";

/** The host render options carry pele MountOptions.sanitize (math hydration, optional sanitizer). */
const sanitizeOf = (o: RenderOptions): ((svg: string) => Node) | undefined => (o as { sanitize?: (svg: string) => Node }).sanitize;

export interface MehrpeleMounted {
  update(src: string): Promise<void>;
  refresh(): void;
  /**
   * Re-plan the layout for the host's current width (column change, corner
   * drag): the same labels and reservations, no Markdown re-render. Renders
   * Pele again only when the layout changes; otherwise re-sizes and re-places.
   */
  relayout(): void;
  /** The reflow plan shown (null without reflow). */
  plan(): ReflowPlan | null;
  /** A corner drag ended: restart the layout's hysteresis. */
  endDrag(): void;
  destroy(): void;
  svg(): SVGSVGElement | null;
  /** Current Pele render (plain-text fallback SVG), for export/lightbox. */
  result(): RenderResult | null;
  /** Labels that stayed plain text (over the cap or unanchored). */
  plainLabels(): MehrpeleLabel[];
}

class MountedImpl implements MehrpeleMounted {
  private host: MehrpeleHost;
  private container: HTMLElement;
  private mountEl: HTMLElement;
  private measureHost: HTMLElement;
  private overlay: MehrpeleOverlay;
  private pele: Mounted | null = null;
  private rendered: RenderedLabel[] = [];
  private lastResult: RenderResult | null = null;
  private lastSvgText = "";
  private currentSource: string;
  private resizeObs: ResizeObserver | null = null;
  private lazyObs: IntersectionObserver | null = null;
  private embedsLive = false;
  private destroyed = false;
  private cycle = 0;
  private remeasurePasses = 0;
  private remeasureTimer: number | null = null;
  private labelObs: ResizeObserver | null = null;
  private repositionFrame: number | null = null;
  /** The cycle whose labels are being rendered: a relayout now would see no reservations. */
  private cyclingFor = 0;
  private planner: ReflowPlanner | null = null;
  private plannerSig = "";
  private currentPlan: ReflowPlan | null = null;
  private flipFrom: FlipSnapshot | null = null;
  /** What the last reserved render used (fill targets re-render it without sizes). */
  private lastRender: { src: string; options: RenderOptions; key: string } | null = null;
  /** Natural node boxes (no size entries) for lastRender.key. */
  private naturalBoxes: { key: string; boxes: Map<string, { w: number; h: number }> } | null = null;
  private refitFrame: number | null = null;

  constructor(container: HTMLElement, source: string, host: MehrpeleHost) {
    this.container = container;
    this.host = host;
    this.currentSource = source;
    container.classList.add("mehrpele-frame");
    this.mountEl = createDiv();
    this.mountEl.className = "mehrpele-mount";
    container.appendChild(this.mountEl);
    this.measureHost = createDiv();
    this.measureHost.className = "mehrpele-measure-host markdown-rendered";
    container.appendChild(this.measureHost);
    this.overlay = new MehrpeleOverlay(container);
  }

  async start(): Promise<void> {
    this.container.addEventListener("click", this.onOverlayClick);
    await this.renderCycle(this.currentSource);
    // Reposition on the next frame, never inside the observer callback:
    // changing overlay geometry synchronously there is what produces
    // "ResizeObserver loop completed with undelivered notifications".
    this.resizeObs = new ResizeObserver(() => this.scheduleReposition(true));
    this.resizeObs.observe(this.container);
    this.container.addEventListener(REPOSITION_EVENT, this.onRepositionRequest);
    if (this.host.settings.lazyEmbeds && !this.embedsLive && this.rendered.some((r) => r.mode === "lazy")) {
      this.lazyObs = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          this.embedsLive = true;
          this.lazyObs?.disconnect();
          this.lazyObs = null;
          void this.renderCycle(this.currentSource);
        },
        { rootMargin: "200px" },
      );
      this.lazyObs.observe(this.container);
    }
  }

  private cascadeReposition = false;

  /**
   * Re-place the overlay on the next frame. Nested mounts sit inside this
   * overlay's scaled labels, where no ResizeObserver sees the scale change:
   * a cascading reposition re-places them too (embed UI scale, handle sizes).
   */
  private scheduleReposition(cascade: boolean): void {
    this.cascadeReposition ||= cascade;
    if (this.repositionFrame !== null || this.destroyed) return;
    this.repositionFrame = window.requestAnimationFrame(() => {
      this.repositionFrame = null;
      const cascadeNow = this.cascadeReposition;
      this.cascadeReposition = false;
      const svg = this.svg();
      if (!svg || !this.lastSvgText || this.destroyed) return;
      this.overlay.reposition(svg, this.lastSvgText);
      if (!cascadeNow) return;
      // Every nested mount at any depth, each without re-cascading.
      this.overlay.el.querySelectorAll(".mehrpele-frame").forEach((f) => requestReposition(f, false));
    });
  }

  private onRepositionRequest = (e: Event): void => {
    if (e.target !== this.container) return;
    this.scheduleReposition((e as CustomEvent<{ cascade?: boolean }>).detail?.cascade !== false);
  };

  /** Internal-link clicks inside overlays: Obsidian's own handlers
   *  also apply; the host hook lets DiagramFrame route/mod-key consistently. */
  private onOverlayClick = (evt: MouseEvent): void => {
    if (!this.host.onLink) return;
    const anchor = (evt.target as Element | null)?.closest?.("a");
    const href = anchor?.getAttribute("data-href") ?? anchor?.getAttribute("href");
    if (href && anchor?.classList.contains("internal-link")) {
      // We open it: stop the default and Obsidian's delegated handlers on
      // ancestors so the note doesn't open twice.
      evt.preventDefault();
      evt.stopPropagation();
      this.host.onLink(href, evt);
    }
  };

  private async renderCycle(source: string): Promise<void> {
    if (this.destroyed) return;
    const myCycle = ++this.cycle;
    this.currentSource = source;
    this.teardownLabels();

    const labels = extractLabels(source);
    if (labels.length === 0) {
      this.mountPlain(source);
      return;
    }

    // Steps 2–3: pre-render + measure (bounded settle inside renderLabels).
    // Lazy embeds start as fixed-box placeholders and render live when the
    // frame first approaches the viewport (one-shot).
    const deferEmbeds =
      this.host.settings.lazyEmbeds &&
      !this.embedsLive &&
      labels.some((l) => l.embedTarget && !isImageTarget(l.embedTarget));
    this.cyclingFor = myCycle;
    let rendered: RenderedLabel[];
    try {
      rendered = await renderLabels(this.host, labels, this.measureHost, {
        deferEmbeds,
        rewrite: this.rewriteLabel,
      });
    } finally {
      if (this.cyclingFor === myCycle) this.cyclingFor = 0;
    }
    if (this.destroyed || myCycle !== this.cycle) {
      // Superseded (or destroyed) while rendering: these labels never reach
      // the overlay, so release them now instead of leaking their components.
      releaseRenderedLabels(this.host.component, rendered);
      return;
    }
    this.rendered = rendered;

    // Step 4: reserve + render. The in-place re-measure pass runs from
    // onRender once the overlays sit at their final position.
    this.remeasurePasses = 0;
    this.mountReserved(source, rendered);
  }

  /**
   * In-place measure pass: pre-measurement is only an estimate (MathJax,
   * images and callouts settle late, and the measure host's styles are an
   * approximation). Measure each placed overlay's actual content box; if any
   * differs from its reservation by >2px, re-render Pele with corrected
   * reservations (max 2 extra passes per cycle; ResizeObserver on the labels
   * re-triggers it, debounced, when late content changes size).
   */
  private scheduleRemeasure(): void {
    if (this.destroyed || this.remeasureTimer !== null) return;
    this.remeasureTimer = window.setTimeout(() => {
      this.remeasureTimer = null;
      void this.runRemeasure();
    }, 120);
  }

  private remeasureRunning = false;
  private applyingRemeasure = false;

  /**
   * Node resize committed: rewrite that label's size in the block source.
   * The host persists + re-renders when the block is writable; otherwise
   * (lightbox, embeds) the diagram re-renders without saving.
   */
  private rewriteLabel = (anchorId: string, edit: (rawInner: string) => string | null, delta?: ContentDelta): void => {
    if (this.destroyed) return;
    // A label edit that changes nothing (null) still lets a dragged box grow the node.
    let next = rewriteLabel(this.currentSource, anchorId, edit) ?? (delta?.box ? this.currentSource : null);
    if (next === null) return;
    // The node's box entry (if any) keeps its margin around the content; a
    // box dragged past the content grows the node by that excess: one edit.
    if (delta) {
      const node = delta.box ? nodeBoxMap(this.lastSvgText).get(anchorId) : undefined;
      next = delta.box
        ? fitBoxEntry(next, anchorId, delta, delta.content, delta.box, undefined, node ? { w: node.w, h: node.h } : undefined)
        : shiftBoxEntry(next, anchorId, delta, delta.content);
    }
    if (next === this.currentSource) return; // unchanged: never write
    if (this.host.persistSource) {
      void Promise.resolve(this.host.persistSource(next)).catch(() => undefined);
    } else {
      void this.renderCycle(next);
    }
  };

  /** A node is mid-drag: re-rendering now would yank it from under the pointer. */
  private isResizing(): boolean {
    // A note card being edited (note-card.ts) is not re-laid out under the caret.
    return !!this.container.querySelector(`.${RESIZING_CLASS}, .is-resizing, .${NOTE_EDITING_CLASS}`);
  }

  private async runRemeasure(): Promise<void> {
    if (this.destroyed || this.remeasureRunning || this.remeasurePasses >= 2) return;
    if (this.isResizing()) {
      this.scheduleRemeasure();
      return;
    }
    const svg = this.svg();
    if (!svg || !this.lastSvgText) return;
    this.remeasureRunning = true;
    try {
      // Wait (bounded) for images to decode and MathJax to typeset before
      // the first measurement of each label.
      for (const r of this.rendered) {
        if (!isRemeasurable(r)) continue;
        const el = this.overlay.labelElement(r.label.anchorId);
        if (el) await settleLabel(el, 1);
      }
      await this.waitForMath();
      if (this.destroyed) return;
      const svgNow = this.svg();
      if (!svgNow) return;
      // Overlay labels are laid out 1:1 and CSS-scaled with the SVG, so the
      // intrinsic layout box is already in SVG units at any diagram scale
      // (except viewport labels, converted from their on-screen size).
      const scale = this.overlay.scaleFor(svgNow, this.lastSvgText);
      const measured: SizedAnchor[] = [];
      for (const r of this.rendered) {
        if (!isRemeasurable(r)) continue; // fixed embed boxes keep their size
        // Intrinsic wrapper only: the overlay item is stretched to the
        // reserved box, so measuring it can never shrink a reservation.
        const el = this.overlay.intrinsicElement(r.label.anchorId);
        if (!el) continue;
        measured.push({
          anchorId: r.label.anchorId,
          // Viewport labels (note embeds) are not laid out in SVG units:
          // only their on-screen size over the on-screen scale is.
          size: isViewportMode(r.mode)
            ? clientToSvgSize(el.getBoundingClientRect(), scale)
            : intrinsicSvgSize(el, el.getBoundingClientRect(), scale),
        });
      }
      if (measured.length === 0) return;
      const current: SizedAnchor[] = this.rendered
        .filter(isRemeasurable)
        .map((r) => ({ anchorId: r.label.anchorId, size: r.size, ...(r.max ? { max: r.max } : {}) }));
      const decision = decideRemeasure(current, measured, this.remeasurePasses, {
        maxWidth: this.host.settings.maxLabelWidth,
        maxHeight: this.host.settings.maxLabelHeight,
      });
      if (!decision.changed) {
        this.remeasurePasses = 0; // stable: future triggers get a fresh budget
        return;
      }
      this.remeasurePasses++;
      const nextById = new Map(decision.next.map((n) => [n.anchorId, n.size]));
      for (const r of this.rendered) {
        const next = nextById.get(r.label.anchorId);
        if (next) r.size = { ...next };
      }
      this.applyingRemeasure = true;
      try {
        this.mountReserved(this.currentSource, this.rendered);
      } finally {
        // Our own reposition must not retrigger the pass via the observer.
        window.setTimeout(() => {
          this.applyingRemeasure = false;
        }, 0);
      }
    } finally {
      this.remeasureRunning = false;
    }
  }

  /** Bounded wait for MathJax output inside placed labels. */
  private async waitForMath(): Promise<void> {
    const hasPendingMath = (): boolean =>
      this.rendered.some((r) => {
        const el = this.overlay.labelElement(r.label.anchorId);
        return !!el?.querySelector(".math:not(.is-loaded)") && !el.querySelector("mjx-container");
      });
    for (let i = 0; i < 12 && hasPendingMath() && !this.destroyed; i++) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
  }

  private observeLabels(): void {
    this.labelObs?.disconnect();
    if (typeof ResizeObserver === "undefined") return;
    this.labelObs = new ResizeObserver(() => {
      if (this.applyingRemeasure) return; // ignore resizes we caused
      this.scheduleRefit();
      this.scheduleRemeasure();
    });
    // Observe only the intrinsic wrappers (never the stretched items).
    for (const r of this.rendered) {
      const el = this.overlay.intrinsicElement(r.label.anchorId);
      if (el) this.labelObs.observe(el);
    }
  }

  /** Nodes laid out full bleed in the current render. */
  private bleedIds = new Set<string>();
  /** Bleed nodes whose height the user set (bleed.ts bleedPlaceholder `held`). */
  private heldIds = new Set<string>();
  private capsCache: { source: string; caps: Map<string, SizeCaps> | null } | null = null;

  private capsFor(source: string): Map<string, SizeCaps> | null {
    if (this.capsCache?.source !== source) {
      let caps: Map<string, SizeCaps> | null = null;
      try {
        caps = nodeSizeCaps(stripMehrpeleDirective(source));
      } catch {
        caps = null;
      }
      this.capsCache = { source, caps };
    }
    return this.capsCache.caps;
  }

  /** Placeholder source and render options for the current reservations. */
  private prepare(source: string, rendered: RenderedLabel[]): { src: string; options: RenderOptions; sizesKey: string } {
    // Full bleed (bleed.ts): one-element labels reserve a minimal placeholder
    // and the render (only) sizes their node to the element exactly.
    const caps = this.capsFor(source);
    const bleeds = new Map<string, MehrpeleLabelSize>();
    const bleedIds = new Set<string>();
    const heldIds = new Set<string>();
    const userSizes = parseSizeDirective(source);
    const reserved: ReservedLabel[] = rendered.map((r, i) => {
      const c = caps?.get(r.label.anchorId);
      if (!isBleedLabel(r, c)) return buildPlaceholder(r.label, r.size, fontSizeOf(this.host), i);
      bleedIds.add(r.label.anchorId);
      const plan = bleedPlaceholder(r.size, c, userSizes.get(r.label.anchorId));
      if (plan.box) bleeds.set(r.label.anchorId, r.size);
      if (plan.held) heldIds.add(r.label.anchorId);
      return buildPlaceholder(r.label, plan.size, fontSizeOf(this.host), i);
    });
    this.bleedIds = bleedIds;
    this.heldIds = heldIds;
    let src = placeholderSource(source, reserved);
    const aspect = new Set(rendered.filter((r) => bleeds.has(r.label.anchorId) && isAspectMode(r.mode)).map((r) => r.label.anchorId));
    const entries = bleeds.size
      ? withBleedEntries(userSizes, bleeds, { aspect: (id) => aspect.has(id), lineHeight: fontSizeOf(this.host) * 1.5 })
      : null;
    if (entries) src = withSizeDirective(src, entries);
    const baseOptions = this.host.renderOptions() as RenderOptions;
    const measurer = makeReservationMeasurer(reserved, baseOptions.measurer);
    const sizesKey = JSON.stringify(rendered.map((r) => [r.label.anchorId, r.size.width, r.size.height]));
    return { src, options: { ...baseOptions, measurer }, sizesKey };
  }

  /**
   * The reflow plan for a prepared render (null without reflow). The planner
   * is rebuilt when the reservations, fonts or policy change, seeded with the
   * layout shown so a re-measure pass never flips the direction by itself.
   */
  private planFor(source: string, prepared: { src: string; options: RenderOptions; sizesKey: string }): ReflowPlan | null {
    const rf = this.host.reflow?.() ?? null;
    if (!rf || !(rf.layoutWidth > 0)) {
      this.planner = null;
      return null;
    }
    const { measurer: _m, maxWidth: _w, autoDirection: _a, ...rest } = prepared.options;
    const fonts = this.container.isConnected ? cssFonts(this.mountEl, rest.fontFamily) : {};
    const base: RenderOptions = { ...prepared.options, ...fonts };
    delete base.maxWidth;
    delete base.autoDirection;
    const sig = JSON.stringify([prepared.src, prepared.sizesKey, rf.policy, fonts, rest.fontSize, rest.config]);
    if (!this.planner || sig !== this.plannerSig) {
      // Reserved labels are unbreakable lines: the wrap steps cannot narrow them.
      const planner = new ReflowPlanner(prepared.src, base, peleRender, { ...rf.policy, wraps: [] }, {
        directive: parseReflowDirective(source),
        cacheKey: null,
      });
      planner.seed(this.currentPlan);
      this.planner = planner;
      this.plannerSig = sig;
    }
    if (rf.fresh) this.planner.reset();
    if (rf.box) return { ...this.planner.planBox(rf.box.width, rf.box.height), layoutWidth: rf.layoutWidth };
    if (rf.frameBox) return this.planner.planFill(rf.frameBox.width, rf.frameBox.height);
    return this.planner.plan(rf.layoutWidth);
  }

  private mountReserved(source: string, rendered: RenderedLabel[]): void {
    const prepared = this.prepare(source, rendered);
    const plan = this.planFor(source, prepared);
    this.currentPlan = plan;
    const src = plan ? plan.source : prepared.src;
    const options: RenderOptions = plan ? { ...prepared.options, ...plan.options } : prepared.options;
    this.lastRender = { src, options, key: `${src}\u0000${prepared.sizesKey}\u0000${plan?.key ?? ""}` };
    try {
      if (this.pele) {
        this.pele.update(src, { ...options, onRender: (r) => this.onRender(r) });
      } else {
        this.pele = peleMount(this.mountEl, src, {
          ...options,
          onRender: (r) => this.onRender(r),
          onError: () => this.mountPlainFallback(source),
        });
        if (this.pele.result) this.onRender(this.pele.result);
        else if (this.pele.error) this.mountPlainFallback(source);
      }
    } catch {
      this.mountPlainFallback(source);
    }
  }

  private mountPlain(source: string): void {
    const baseOptions = this.host.renderOptions() as RenderOptions;
    try {
      const plain = stripMehrpeleDirective(source);
      const plan = this.planFor(source, { src: plain, options: baseOptions, sizesKey: "" });
      this.currentPlan = plan;
      const result = peleRender(plan ? plan.source : plain, plan ? { ...baseOptions, ...plan.options } : baseOptions);
      this.lastResult = result;
      this.lastSvgText = result.svg;
      // Through the mount's sanitize hook, as pele's mount does (math is hydrated there).
      placeSvg(this.mountEl, result.svg, sanitizeOf(baseOptions));
      this.applyDisplay(result);
      const svg = this.svg();
      if (svg) this.fillPlainLabels(svg, result);
      this.finishFlip();
      this.host.onRender?.(result.type);
    } catch {
      this.mountEl.textContent = "";
    }
  }

  /** Display size for the plan shown: never magnified, floor then scroll (the container scrolls). */
  private applyDisplay(result: RenderResult): void {
    const svg = this.svg();
    const rf = this.host.reflow?.() ?? null;
    const plan = this.currentPlan;
    if (!svg || !rf || !plan || !(result.width > 0)) {
      this.container.classList.remove("is-scrolling");
      return;
    }
    if (plan.boxHeight !== undefined && !rf.box) {
      const shownBox = applyBoxDisplay(svg, result.width, this.container, plan, plan.boxHeight);
      this.container.dataset.reflow = `${plan.key} L=${rf.layoutWidth} box=${rf.layoutWidth}x${plan.boxHeight} s=${shownBox.scale.toFixed(3)}${shownBox.scroll ? " scroll" : ""}`;
      return;
    }
    clearBoxDisplay(this.container);
    const floor = this.planner?.minTextScale ?? rf.policy.minTextScale ?? 0.8;
    const box = rf.box;
    const fit = box && result.height > 0 ? Math.min(1, box.width / result.width, box.height / result.height) : null;
    const shown = applyDisplaySize(svg, result.width, this.container, {
      layoutWidth: fit !== null ? result.width * Math.max(fit, floor) : rf.layoutWidth,
      floor,
      ...(rf.magnifyTo !== undefined ? { magnifyTo: rf.magnifyTo } : {}),
      ...(rf.zoom !== undefined && rf.zoom > 1 && !box ? { zoom: rf.zoom } : {}),
    });
    this.container.dataset.reflow = `${plan.key} L=${rf.layoutWidth}${rf.zoom && rf.zoom > 1 ? ` z=${rf.zoom}` : ""} s=${shown.scale.toFixed(3)}${shown.scroll ? " scroll" : ""}`;
  }

  private finishFlip(): void {
    const from = this.flipFrom;
    this.flipFrom = null;
    const svg = this.svg();
    if (from && svg) playFlip(from, svg, this.container, this.container);
  }

  relayout(): void {
    if (this.destroyed) return;
    const rf = this.host.reflow?.() ?? null;
    if (!rf) {
      this.refresh();
      return;
    }
    // A render cycle in flight plans for the current width when it lands.
    if (this.cyclingFor !== 0 && this.cyclingFor === this.cycle) return;
    const prev = this.currentPlan;
    if (this.rendered.length === 0) {
      if (extractLabels(this.currentSource).length > 0) return; // labels pending: never render them plain
      // No overlay labels: a plain Pele render is cheap.
      if (prev) this.flipFrom = this.snapshot();
      const frame = this.container.closest<HTMLElement>(".pele-embed") ?? this.container;
      withHeightCheck(frame, () => this.mountPlain(this.currentSource), this.hostHeightChanged());
      return;
    }
    const prepared = this.prepare(this.currentSource, this.rendered);
    const plan = this.planFor(this.currentSource, prepared);
    if (plan && prev && plan.key === prev.key && plan.source === prev.source && this.lastResult) {
      // Same layout: only the display size (the overlay follows on the next frame).
      this.currentPlan = plan;
      const shown = this.container.dataset.reflow;
      this.applyDisplay(this.lastResult);
      this.scheduleReposition(true);
      if (this.container.dataset.reflow !== shown) this.host.onLayout?.();
      return;
    }
    if (prev && plan && plan.key !== prev.key && rf.animate) this.flipFrom = this.snapshot();
    // Same labels, same reservations: only Pele renders again.
    const frame = this.container.closest<HTMLElement>(".pele-embed") ?? this.container;
    withHeightCheck(frame, () => this.mountReserved(this.currentSource, this.rendered), this.hostHeightChanged());
  }

  /** The host's height callback as a plain function (undefined when the host has none). */
  private hostHeightChanged(): ((el: HTMLElement) => void) | undefined {
    const host = this.host;
    return host.heightChanged ? (el) => host.heightChanged?.(el) : undefined;
  }

  private snapshot(): FlipSnapshot | null {
    const rf = this.host.reflow?.();
    if (!rf?.animate || !canAnimate(this.container, true)) return null;
    return snapshotLayout(this.svg(), this.container, this.container);
  }

  plan(): ReflowPlan | null {
    return this.currentPlan;
  }

  endDrag(): void {
    this.planner?.reset();
  }

  private mountPlainFallback(source: string): void {
    // Pele rejected the placeholder source: retry once with the raw source.
    try {
      const baseOptions = this.host.renderOptions() as RenderOptions;
      const result = peleRender(stripMehrpeleDirective(source), baseOptions);
      this.lastResult = result;
      this.lastSvgText = result.svg;
      placeSvg(this.mountEl, result.svg, sanitizeOf(baseOptions));
      this.host.onRender?.(result.type);
    } catch {
      /* host's own error UI owns this case */
    }
  }

  private onRender(result: RenderResult): void {
    this.lastResult = result;
    this.lastSvgText = result.svg;
    const svg = this.svg();
    if (svg) {
      // Strip the measurer tokens from the live SVG (exports keep the
      // readable fallback text; the token is a private-use prefix).
      svg.querySelectorAll("text, tspan").forEach((t) => {
        if (t.textContent?.includes("\uE000")) {
          t.textContent = t.textContent.replace(TOKEN_RE, "");
        }
      });
      markExternalLinks(svg);
      this.applyDisplay(result);
      const st = this.host.settings;
      const fills = this.fillTargets(result);
      this.overlay.place(svg, result.svg, this.rendered, {
        bleeds: this.bleedIds,
        held: this.heldIds,
        cardLabels: this.host.settings.noteCardLabels,
        maxLabelWidth: st.maxLabelWidth,
        minEmbedUiScale: st.minEmbedUiScale,
        embedScaling: st.embedScaling,
        ...(fills.size ? { fills } : {}),
      });
      this.fillPlainLabels(svg, result);
      this.container.dataset.fill = [...this.overlay.fillScales(), ...this.plainFills].map(([id, k]) => `${id}=${k}`).join(" ");
      this.finishFlip();
      this.observeLabels();
      this.scheduleRemeasure();
    }
    this.host.onRender?.(result.type);
  }

  private plainFills = new Map<string, number>();

  /** Sized nodes without an overlay label: their SVG text fills the box (node-fill.ts). */
  private fillPlainLabels(svg: SVGSVGElement, result: RenderResult): void {
    const sizes = (result as RenderResult & { nodeSizes?: Record<string, unknown> }).nodeSizes;
    const overlaid = new Set(this.overlay.placedAnchors);
    const ids = sizes ? Object.keys(sizes).filter((id) => !overlaid.has(id)) : [];
    this.plainFills = ids.length ? fillSvgLabels(svg, ids, fontSizeOf(this.host)) : new Map<string, number>();
  }

  /**
   * Inner box (SVG units) each user-sized label may fill: the size entry
   * less Pele's padding around the reservation, read from a render of the
   * same layout without size entries. Never more than the entry allows, so
   * the reservation the fit reports can never grow the node (no loop).
   */
  private fillTargets(result: RenderResult): Map<string, MehrpeleLabelSize> {
    const out = new Map<string, MehrpeleLabelSize>();
    const last = this.lastRender;
    // Full-bleed labels fill their shape (overlay.ts, bleedArea); not here.
    if (!last || !this.currentSource.includes("pele-size")) return out;
    const sizes = parseSizeDirective(this.currentSource);
    const sized = this.rendered.filter((r) => r.label.kind === "node" && sizes.has(r.label.anchorId) && !r.explicitSize && r.mode !== "embed" && r.mode !== "embed-auto" && r.mode !== "lazy" && !this.bleedIds.has(r.label.anchorId));
    if (sized.length === 0) return out;
    if (this.naturalBoxes?.key !== last.key) {
      try {
        const plain = peleRender(stripSizeDirective(last.src), last.options);
        this.naturalBoxes = { key: last.key, boxes: nodeBoxMap(plain.svg) };
      } catch {
        this.naturalBoxes = { key: last.key, boxes: new Map() };
      }
    }
    const natural = this.naturalBoxes.boxes;
    const actual = new Map(nodeBoxes(result.svg).map((n) => [n.id, n] as const));
    for (const r of sized) {
      const id = r.label.anchorId;
      if (this.bleedIds.has(id)) continue; // filled above (the node's whole box)
      const n = natural.get(id);
      const a = actual.get(id);
      const e = sizes.get(id)!;
      if (!n || !a?.box || !(n.w > 0) || !(n.h > 0)) continue;
      const T = { x: 0, y: 0, w: e.w ?? a.box.w, h: e.h ?? a.box.h };
      const kind = shapeKind(a.classes);
      let width: number;
      let height: number;
      if (kind === "rect" || kind === "text") {
        // Box = reservation + Pele's padding: the entry less that padding.
        width = T.w - (n.w - r.size.width);
        height = T.h - (n.h - r.size.height);
      } else {
        // Circles, diamonds, other polygons: the inscribed area.
        const inner = innerBox(T, kind, fontSizeOf(this.host));
        width = inner.w;
        height = inner.h;
      }
      width = Math.floor(width) - 2;
      height = Math.floor(height) - 2;
      if (width > 0 && height > 0) out.set(id, { width, height });
    }
    return out;
  }

  /** A filling label's content changed size: re-choose its fit next frame. */
  private scheduleRefit(): void {
    if (this.refitFrame !== null || this.destroyed) return;
    this.refitFrame = window.requestAnimationFrame(() => {
      this.refitFrame = null;
      if (!this.destroyed) this.overlay.refit();
    });
  }

  private teardownLabels(): void {
    releaseRenderedLabels(this.host.component, this.rendered);
    this.rendered = [];
    this.overlay.clear();
  }

  async update(src: string): Promise<void> {
    await this.renderCycle(src);
  }

  refresh(): void {
    // Theme/font change: measurements may be stale — full re-cycle.
    void this.renderCycle(this.currentSource);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cycle++;
    this.container.removeEventListener("click", this.onOverlayClick);
    this.container.removeEventListener(REPOSITION_EVENT, this.onRepositionRequest);
    this.lazyObs?.disconnect();
    this.lazyObs = null;
    if (this.remeasureTimer !== null) window.clearTimeout(this.remeasureTimer);
    this.remeasureTimer = null;
    if (this.repositionFrame !== null) window.cancelAnimationFrame(this.repositionFrame);
    this.repositionFrame = null;
    if (this.refitFrame !== null) window.cancelAnimationFrame(this.refitFrame);
    this.refitFrame = null;
    this.labelObs?.disconnect();
    this.labelObs = null;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    try {
      this.pele?.destroy();
    } catch {
      /* already gone */
    }
    this.pele = null;
    this.teardownLabels();
    this.overlay.destroy();
    this.measureHost.remove();
    this.mountEl.remove();
  }

  svg(): SVGSVGElement | null {
    return this.mountEl.querySelector("svg");
  }

  result(): RenderResult | null {
    if (!this.lastResult) return null;
    // Export/lightbox SVG should read as the fallback text, token-free.
    return this.lastResult.svg.includes("\uE000")
      ? { ...this.lastResult, svg: this.lastResult.svg.replace(TOKEN_RE, "") }
      : this.lastResult;
  }

  plainLabels(): MehrpeleLabel[] {
    const placed = new Set(this.overlay.placedAnchors);
    return extractLabels(this.currentSource).filter((l) => !placed.has(l.anchorId));
  }
}

function fontSizeOf(host: MehrpeleHost): number {
  const opts = host.renderOptions() as RenderOptions;
  return typeof opts.fontSize === "number" && opts.fontSize > 0 ? opts.fontSize : 16;
}

/** Mount a Mehrpele diagram into `container`. */
export async function mountMehrpele(
  container: HTMLElement,
  source: string,
  host: MehrpeleHost,
): Promise<MehrpeleMounted> {
  const mounted = new MountedImpl(container, source, host);
  await mounted.start();
  return mounted;
}
