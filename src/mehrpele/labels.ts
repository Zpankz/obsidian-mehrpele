/**
 * MarkdownRenderer orchestration: pre-render each label
 * off-screen under the frame's `.pele-host` so CSS vars/fonts match, measure,
 * and hand the same DOM to the overlay (moved, not cloned — except identical
 * duplicate labels and sequence header/footer twins, which clone).
 */
import { render as peleRender, type RenderOptions } from "pele-render/pele";
import { Component, MarkdownRenderer, Platform, TFile, resolveSubpath, type App } from "obsidian";
import { embedBoxSize, embedMarkdown, embedRenderers, isImageTarget } from "./embeds";
import { clampSize } from "./placeholder";
import type { MehrpeleEmbedTarget, MehrpeleLabel, MehrpeleLabelSize } from "./model";
import type { MehrpeleSettings } from "./settings";
import {
  diagramFileLang,
  embedAlias,
  embedRequestedSize,
  fitContentSize,
  isNoteTarget,
  maxContentSize,
  minContentWidth,
  parseSoleDiagramFence,
  soleDiagramInSection,
  withEmbedSize,
  withFenceBody,
  withFenceSize,
  type FitOptions,
  type NestedDiagram,
} from "./nested";
import { attachNodeResize, fitInBox } from "./node-resize";
import { markdownWebTarget, prefetchWebVerdicts } from "./views/markdown-form"; // view-nodes
import { mountNoteCard } from "./note-card";
import { embedOrigin, inlineOrigin, type NestedOrigin } from "./origin";
import { screenScaleOf, setViewportBox, viewportBoxOf, type ViewportBox } from "./viewport";

export interface MehrpeleHost {
  app: App;
  component: Component;
  sourcePath: string;
  settings: MehrpeleSettings;
  // Typed loosely so this module needs no hard dependency on the host's
  // RenderOptions plumbing; mount.ts narrows it.
  renderOptions(): unknown;
  onLink?(href: string, evt: MouseEvent): void;
  /** Diagram nesting level of this mount (0 = a block in a note). */
  depth?: number;
  /**
   * Render a nested diagram (a sole-diagram label) into `el` as a real
   * diagram frame owned by `component`. Without it, such labels fall back to
   * MarkdownRenderer (which still renders the fence through the code-block
   * processor, without sizing control).
   */
  renderNestedDiagram?(el: HTMLElement, spec: NestedDiagramSpec, component: Component): NestedDiagramHandle | null;
  /**
   * Apply an edited block source (node resizes). The host persists it when
   * the block is writable and re-renders; without it the mount re-renders
   * in memory only.
   */
  persistSource?(next: string): Promise<boolean> | boolean;
  /**
   * Responsive reflow for this mount (null/absent = Pele at renderOptions'
   * maxWidth, CSS-scaled as before). See MehrpeleReflow.
   */
  reflow?(): MehrpeleReflow | null;
  /** A re-layout changed this element's height (Reading view re-measures its section). */
  heightChanged?(el: HTMLElement): void;
  /** Origin of this diagram when it is itself nested (undefined = a block in the note). */
  origin?: NestedOrigin;
  /** Reveal the outer block (inline nested fences open here). */
  revealBlock?(): void;
  /** 0-based line of the outer block's opening fence in sourcePath, when known. */
  blockLine?: number;
  /** Add "open original" affordances to a portal (`.canvas`) embed label. */
  attachOrigin?(el: HTMLElement, origin: NestedOrigin, component: Component): void;
  /** A render finished (the first one included) with this diagram type: companion frame handles hear it. */
  onRender?(diagramType: string): void;
  /** Reflow resized the diagram without a render (its nodes moved): companion frame handles hear it. */
  onLayout?(): void;
}

/** How a Mehrpele mount reflows (reservations are reused across layouts). */
export interface MehrpeleReflow {
  /** Layout width L the diagram must fit. */
  layoutWidth: number;
  /** Planner policy (direction switching, sideways turns, floor). */
  policy: Partial<import("pele-render/reflow").ReflowPolicy>;
  /** Fit a W×H box instead (lightbox): the largest unmagnified layout. */
  box?: { width: number; height: number };
  /**
   * A resized frame's W×H box (fence `width= height=`): the layout that
   * fills it best, scaled to fill (planFill; may exceed 1×).
   */
  frameBox?: { width: number; height: number };
  /** Animate layout changes (FLIP of nodes and overlay items). */
  animate: boolean;
  /** Legacy magnify: display up to this width. */
  magnifyTo?: number;
  /** Explicit user zoom (fence `zoom=`): layoutWidth is already divided by it. */
  zoom?: number;
  /** Plan without hysteresis (a full user zoom: the layout is the one the user picked). */
  fresh?: boolean;
}

export interface NestedDiagramSpec {
  lang: NestedDiagram["lang"];
  code: string;
  sourcePath: string;
  /** Display width (SVG units); undefined = the diagram's natural width. */
  width?: number;
  /** Box height (fence `height=` / embed `|WxH`): the nested frame fills a W×H box. */
  height?: number;
  /** Box height bounds for the nested frame's corner. */
  minHeight?: number;
  maxHeight?: number;
  /** Drag-resize bounds for the nested frame. */
  minWidth: number;
  maxWidth: number;
  /** Nesting level of the nested diagram itself (parent depth + 1). */
  depth: number;
  /** Width committed by the nested frame's resize corner (null = reset). */
  onResize(width: number | null, height?: number | null): void;
  /**
   * The nested diagram edited its own source (a node resized inside a nested
   * Mehrpele). Undefined when the source lives elsewhere (diagram embeds):
   * such edits stay in memory.
   */
  onSourceChange?(nextCode: string): void;
  /** Where the nested diagram's source lives ("Open original", Mod-click). */
  origin: NestedOrigin;
  /** Inline origins: reveal the outer block instead of opening a file. */
  revealOrigin?(): void;
}

export interface NestedDiagramHandle {
  destroy(): void;
}

/**
 * How a label renders: Markdown, an image or nested diagram sized to its
 * content, a note embed that grows with its content (`embed-auto`), a fixed
 * embed box, a link chip, or a lazy placeholder.
 */
export type LabelMode = "markdown" | "image" | "diagram" | "embed" | "embed-auto" | "chip" | "lazy";

/**
 * A media node's content size changed by a handle: the delta and the new
 * content size (SVG units). A `%% pele-size %%` box entry for the node moves
 * by the same delta in the same edit (node-size.ts shiftBoxEntry).
 */
export interface ContentDelta {
  dw: number;
  dh: number;
  content: MehrpeleLabelSize;
  /**
   * The box the handle was dragged to, when larger than the content on an
   * axis (an image dragged against its aspect): the node grows to it.
   */
  box?: MehrpeleLabelSize;
}

/** Rewrites one label's raw quoted text in the block source (node resizes). */
export type LabelRewriter = (anchorId: string, edit: (rawInner: string) => string | null, delta?: ContentDelta) => void;

function contentDelta(size: MehrpeleLabelSize, start: MehrpeleLabelSize): ContentDelta {
  return { dw: size.width - start.width, dh: size.height - start.height, content: { ...size } };
}

export interface RenderedLabel {
  label: MehrpeleLabel;
  /** The pre-rendered element; becomes the overlay content. */
  el: HTMLElement;
  size: MehrpeleLabelSize;
  /** Owning component for this label's rendered children. */
  component: Component;
  mode?: LabelMode;
  /** Per-label size cap (overlay max width, re-measure clamp); settings otherwise. */
  max?: MehrpeleLabelSize;
  /**
   * The content handle set an explicit size (image `|W`, nested `width=`):
   * the content keeps it instead of following an enlarged node box.
   */
  explicitSize?: boolean;
}

/** Labels whose reservation follows their in-place size. */
export function isRemeasurable(r: RenderedLabel): boolean {
  if (r.mode) return r.mode !== "embed" && r.mode !== "lazy";
  return !r.label.embedTarget || isImageTarget(r.label.embedTarget);
}

/** Bounded settle: wait for images/math/embeds without ever looping forever. */
export async function settleLabel(el: HTMLElement, maxPasses = 3): Promise<void> {
  for (let pass = 0; pass < maxPasses; pass++) {
    const pending: Promise<unknown>[] = [];
    el.querySelectorAll("img").forEach((img) => {
      const im = img;
      if (!im.complete) {
        pending.push(
          new Promise((resolve) => {
            const done = () => resolve(undefined);
            im.addEventListener("load", done, { once: true });
            im.addEventListener("error", done, { once: true });
            window.setTimeout(done, 400);
          }),
        );
        if (typeof im.decode === "function") pending.push(im.decode().catch(() => undefined));
      }
    });
    if (pending.length === 0) return;
    await Promise.race([
      Promise.all(pending),
      new Promise((resolve) => window.setTimeout(resolve, 500)),
    ]);
    // One short frame so MathJax/embeds can lay out before re-measuring.
    await new Promise((resolve) => window.setTimeout(resolve, 16));
  }
}

/**
 * Render + measure all labels. The measurement host must already be attached
 * under an element carrying the note's CSS (mount.ts places it in the frame).
 * Identical Markdown renders once; extra anchors clone the DOM (embeds are
 * never cloned — they render per node).
 */
export async function renderLabels(
  host: MehrpeleHost,
  labels: MehrpeleLabel[],
  measureHost: HTMLElement,
  opts?: { deferEmbeds?: boolean; rewrite?: LabelRewriter },
): Promise<RenderedLabel[]> {
  const { app, settings } = host;
  const out: RenderedLabel[] = [];
  const cache = new Map<string, RenderedLabel>();
  const rewrite: LabelRewriter = opts?.rewrite ?? (() => undefined);
  let count = 0;
  const canNest = settings.nestedDiagrams && !!host.renderNestedDiagram;
  const depthLeft = (host.depth ?? 0) < settings.maxNestingDepth;

  prefetchWebVerdicts(labels.filter((l) => !l.embedTarget).map((l) => l.markdown), settings); // view-nodes
  for (let label of labels) {
    if (count >= settings.maxLabels) break;
    count++;
    // view-nodes: a sole `![…](https://…)` that is a web page (not an image) is a web-view embed.
    if (!label.embedTarget) {
      const web = await markdownWebTarget(label.markdown, settings);
      if (web) label = { ...label, embedTarget: web };
    }
    if (label.embedTarget) {
      if (!settings.allowEmbeds) {
        out.push(await renderFallbackChip(host, label, measureHost));
        continue;
      }
      if (isImageTarget(label.embedTarget)) {
        out.push(await renderImageLabel(host, label, measureHost, rewrite));
        continue;
      }
      if (canNest) {
        const diagram = await resolveDiagramEmbed(app, label.embedTarget, host.sourcePath);
        if (diagram) {
          // `![[t|W]]` wins; else the embedded fence's own `width=N`.
          const asked = embedRequestedSize(label.embedTarget);
          const requested = asked.width ?? diagram.width;
          const requestedHeight = asked.width !== undefined ? asked.height : diagram.height;
          out.push(
            depthLeft
              ? await renderDiagramLabel(
                  host,
                  label,
                  measureHost,
                  diagram,
                  { width: requested, height: requestedHeight },
                  { origin: embedOrigin(label.embedTarget, host.sourcePath) },
                  (w, h, d) =>
                    rewrite(label.anchorId, (raw) => withEmbedSize(raw, w === null ? null : { width: w, ...((h ?? requestedHeight) ? { height: (h ?? requestedHeight)! } : {}) }), d),
                )
              : await renderFallbackChip(host, label, measureHost),
          );
          continue;
        }
      }
      if (opts?.deferEmbeds) {
        out.push(deferredEmbed(host, label, measureHost));
        continue;
      }
      out.push(await renderEmbedLabel(host, label, measureHost, rewrite));
      continue;
    }
    if (canNest) {
      const diagram = parseSoleDiagramFence(label.markdown);
      if (diagram) {
        out.push(
          depthLeft
            ? await renderDiagramLabel(
                host,
                label,
                measureHost,
                diagram,
                { width: diagram.width, height: diagram.height },
                {
                  origin: inlineOrigin(host.origin, host.sourcePath, host.blockLine),
                  ...(host.revealBlock ? { reveal: () => host.revealBlock?.() } : {}),
                },
                (w, h, d) => rewrite(label.anchorId, (raw) => withFenceSize(raw, { width: w, ...(w === null ? { height: null } : h !== undefined ? { height: h } : {}) }), d),
                (next) => rewrite(label.anchorId, (raw) => withFenceBody(raw, next)),
              )
            : await renderFallbackChip(host, label, measureHost),
        );
        continue;
      }
    }
    const hit = cache.get(label.markdown);
    if (hit) {
      const clone = hit.el.cloneNode(true) as HTMLElement;
      measureHost.appendChild(clone);
      out.push({ label, el: clone, size: { ...hit.size }, component: hit.component, mode: "markdown" });
      continue;
    }
    const component = new Component();
    host.component.addChild(component);
    const el = createDiv();
    el.className = "mehrpele-label";
    el.dataset.anchorId = label.anchorId;
    measureHost.appendChild(el);
    await MarkdownRenderer.render(app, label.markdown, el, host.sourcePath, component);
    await settleLabel(el);
    const size = measureLabel(el, settings);
    el.classList.toggle("mehrpele-scroll", size.height >= settings.maxLabelHeight);
    const rendered: RenderedLabel = { label, el, size, component, mode: "markdown" };
    cache.set(label.markdown, rendered);
    out.push(rendered);
  }
  return out;
}

/** Fixed-box placeholder for a lazy embed (renders live on intersection). */
function deferredEmbed(
  host: MehrpeleHost,
  label: MehrpeleLabel,
  measureHost: HTMLElement,
): RenderedLabel {
  const target = label.embedTarget;
  const component = new Component();
  host.component.addChild(component);
  const el = createDiv();
  el.className = "mehrpele-label mehrpele-embed mehrpele-embed-lazy";
  el.dataset.anchorId = label.anchorId;
  const box = target ? embedBoxSize(target, host.settings) : { width: 160, height: 100 };
  // A viewport label (viewport.ts): the overlay scales this SVG-unit box.
  setViewportBox(el, box);
  el.textContent = label.fallbackText;
  measureHost.appendChild(el);
  return { label, el, size: { ...box }, component, mode: "lazy" };
}

function measure(el: HTMLElement): MehrpeleLabelSize {
  return {
    width: Math.max(1, Math.ceil(el.offsetWidth || el.scrollWidth || 1)),
    height: Math.max(1, Math.ceil(el.offsetHeight || el.scrollHeight || 1)),
  };
}

/**
 * Natural-size measurement in the (markdown-rendered) measure host: size the
 * element at max-content capped by the max label width, let it wrap there,
 * and read the box. Unbreakable tokens (tags/links, keep-all in CSS) report
 * their full scrollWidth instead of splitting mid-token.
 */
export function measureLabel(
  el: HTMLElement,
  settings: { maxLabelWidth: number; maxLabelHeight: number },
): MehrpeleLabelSize {
  const prevWidth = el.style.width;
  const prevMax = el.style.maxWidth;
  // Natural width: no inline width, `width: max-content` from the class (styles.css).
  el.style.removeProperty("width");
  el.classList.add("mehrpele-measuring");
  el.style.maxWidth = `${settings.maxLabelWidth}px`;
  const natural = Math.max(el.offsetWidth || 0, el.scrollWidth || 0);
  const width = Math.max(1, Math.min(Math.ceil(natural), settings.maxLabelWidth));
  el.style.width = `${width}px`;
  el.style.removeProperty("max-width");
  const height = Math.max(
    1,
    Math.min(Math.ceil(el.scrollHeight || el.offsetHeight || 1), settings.maxLabelHeight),
  );
  el.classList.remove("mehrpele-measuring");
  el.style.width = prevWidth;
  el.style.maxWidth = prevMax;
  return { width, height };
}

async function renderFallbackChip(
  host: MehrpeleHost,
  label: MehrpeleLabel,
  measureHost: HTMLElement,
): Promise<RenderedLabel> {
  const component = new Component();
  host.component.addChild(component);
  const el = createDiv();
  el.className = "mehrpele-label mehrpele-embed-chip";
  el.dataset.anchorId = label.anchorId;
  const target = label.embedTarget;
  el.textContent = target ? target.linkpath + target.subpath : label.fallbackText || label.anchorId;
  measureHost.appendChild(el);
  const size = clampSize(measure(el), {
    width: host.settings.maxLabelWidth,
    height: host.settings.maxLabelHeight,
  });
  return { label, el, size, component, mode: "chip" };
}

function fitOptions(settings: MehrpeleSettings): FitOptions {
  return {
    cap: { width: settings.maxEmbedWidth, height: settings.maxEmbedHeight },
    mode: settings.embedSizing,
    minScale: settings.minEmbedScale,
  };
}

/** Give an image label an explicit, aspect-correct box (no clipping, no max-height squeeze). */
/** Largest node box a content handle drags to (SVG units; node-size.ts bounds). */
const MAX_NODE_BOX = 1600;

/**
 * Live preview of an image content drag: the label shows the dragged box
 * (dashed) with the image fitted and centred in it; null box: back to the
 * image alone at `image`.
 */
function previewImageBox(el: HTMLElement, img: HTMLImageElement, box: MehrpeleLabelSize | null, image: MehrpeleLabelSize): void {
  if (!box) {
    applyImageSize(el, img, image);
    el.classList.remove("mehrpele-image-box");
    return;
  }
  el.style.width = `${Math.max(box.width, image.width)}px`;
  el.style.height = `${Math.max(box.height, image.height)}px`;
  // Dashed box with the image centred in it (flex; styles.css).
  el.classList.add("mehrpele-image-box");
  img.classList.remove("mehrpele-image-fill");
  img.style.width = `${image.width}px`;
  img.style.height = `${image.height}px`;
  img.removeAttribute("width");
  img.removeAttribute("height");
}

function applyImageSize(el: HTMLElement, img: HTMLImageElement, size: MehrpeleLabelSize): void {
  el.style.width = `${size.width}px`;
  el.style.height = `${size.height}px`;
  // The image fills the label box (width/height 100%, styles.css); a drag
  // preview's inline pixel size is dropped so the class applies.
  img.style.removeProperty("width");
  img.style.removeProperty("height");
  img.classList.add("mehrpele-image-fill");
  img.removeAttribute("width");
  img.removeAttribute("height");
}

/**
 * Image embed: rendered by Obsidian's own embed machinery, then sized from
 * the image's natural size — fitted to the embed maxima with its aspect
 * ratio (never clipped), and in legible mode never shrunk below
 * `minEmbedScale` by an explicit `|W`. A corner handle resizes it in place
 * and writes `|W` back to the label.
 */
async function renderImageLabel(
  host: MehrpeleHost,
  label: MehrpeleLabel,
  measureHost: HTMLElement,
  rewrite: LabelRewriter,
): Promise<RenderedLabel> {
  const target = label.embedTarget!;
  const component = new Component();
  host.component.addChild(component);
  const el = createDiv();
  el.className = "mehrpele-label mehrpele-embed-image";
  el.dataset.anchorId = label.anchorId;
  const fit = fitOptions(host.settings);
  el.style.maxWidth = `${fit.cap.width}px`;
  el.style.maxHeight = `${fit.cap.height}px`;
  measureHost.appendChild(el);
  // Render without the size segment: the size is applied below from the
  // natural image size (Obsidian would otherwise pin `width=` on the img).
  const alias = embedAlias(target);
  await MarkdownRenderer.render(
    host.app,
    `![[${target.linkpath}${target.subpath}${alias ? `|${alias}` : ""}]]`,
    el,
    host.sourcePath,
    component,
  );
  await settleLabel(el);
  const requested = embedRequestedSize(target);
  const img = el.querySelector("img");

  const sizeFromImage = (im: HTMLImageElement): MehrpeleLabelSize | null => {
    if (!(im.naturalWidth > 0 && im.naturalHeight > 0)) return null;
    const natural = { width: im.naturalWidth, height: im.naturalHeight };
    const size = fitContentSize(natural, requested, fit);
    applyImageSize(el, im, size);
    el.style.removeProperty("max-width");
    el.style.removeProperty("max-height");
    if (!Platform.isMobile && !el.querySelector(".mehrpele-node-resize")) {
      // Small images may be enlarged up to the embed maxima, large ones up
      // to their natural size.
      const maxW = maxContentSize(natural, fit.cap).width;
      const minW = minContentWidth(natural, fit);
      const aspect = natural.width / natural.height;
      // The corner drags a box (each axis follows the pointer); the image is
      // fitted inside it with its aspect. Against the aspect (straight down on
      // a wide image) the image keeps its width and the node grows instead.
      const fitted = (box: MehrpeleLabelSize) => fitInBox(box, aspect, { width: minW }, { width: maxW });
      const detach = attachNodeResize(el, {
        target: el,
        // Images are laid out 1:1 in SVG units and scale with the diagram.
        scale: () => screenScaleOf(el),
        size: () => ({ width: el.offsetWidth || 1, height: el.offsetHeight || 1 }),
        min: { width: minW, height: Math.round(minW / aspect) },
        max: { width: MAX_NODE_BOX, height: MAX_NODE_BOX },
        onPreview: (box) => previewImageBox(el, im, box, fitted(box)),
        onCancel: () => previewImageBox(el, im, null, size),
        onCommit: (box, start) => {
          const s = fitted(box);
          const startImg = fitted(start);
          const grown = box.width > s.width + 0.5 || box.height > s.height + 0.5;
          // The image keeps its size when only the box grew (no |W rewrite).
          const same = Math.abs(s.width - startImg.width) < 1;
          rewrite(label.anchorId, (raw) => (same ? raw : withEmbedSize(raw, { width: s.width })), {
            ...contentDelta(s, startImg),
            ...(grown ? { box: { width: Math.max(box.width, s.width), height: Math.max(box.height, s.height) } } : {}),
          });
        },
        onReset: () => rewrite(label.anchorId, (raw) => withEmbedSize(raw, null)),
      });
      component.register(detach);
    }
    return size;
  };

  const explicitSize = requested.width !== undefined || requested.height !== undefined;
  if (img) {
    const size = sizeFromImage(img);
    if (size) {
      const max = maxContentSize({ width: img.naturalWidth, height: img.naturalHeight }, fit.cap);
      return { label, el, size, component, mode: "image", max, ...(explicitSize ? { explicitSize } : {}) };
    }
  }
  const size = measureLabel(el, { maxLabelWidth: fit.cap.width, maxLabelHeight: fit.cap.height });
  const rendered: RenderedLabel = { label, el, size, component, mode: "image", max: { ...fit.cap }, ...(explicitSize ? { explicitSize } : {}) };
  if (img) {
    // Not decoded yet (slow disk, lazy loading): size it when it loads; the
    // label ResizeObserver then re-measures the node (with the image's max).
    img.addEventListener(
      "load",
      () => {
        if (!sizeFromImage(img)) return;
        rendered.max = maxContentSize({ width: img.naturalWidth, height: img.naturalHeight }, fit.cap);
      },
      { once: true },
    );
  }
  return rendered;
}

/**
 * The single diagram a sole-embed target holds, or null: a diagram file
 * (`.mmd` / `.mermaid` / `.pele`), or a note / `#heading` / `#^block`
 * section that is exactly one diagram fence.
 */
export async function resolveDiagramEmbed(
  app: App,
  target: MehrpeleEmbedTarget,
  sourcePath: string,
): Promise<NestedDiagram | null> {
  try {
    const file = app.metadataCache.getFirstLinkpathDest(target.linkpath, sourcePath);
    if (!(file instanceof TFile)) return null;
    const fileLang = diagramFileLang({ linkpath: file.path, subpath: "" });
    if (fileLang) {
      const code = (await app.vault.cachedRead(file)).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
      return code.trim() ? { lang: fileLang, code } : null;
    }
    if (file.extension !== "md" || !isNoteTarget({ linkpath: file.path, subpath: "" })) return null;
    const text = await app.vault.cachedRead(file);
    if (!target.subpath) return soleDiagramInSection(text);
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) return null;
    const hit = resolveSubpath(cache, target.subpath);
    if (!hit) return null;
    const start = hit.start.offset;
    const end = hit.end ? hit.end.offset : text.length;
    return soleDiagramInSection(text.slice(start, end));
  } catch {
    return null;
  }
}

/** Natural size of a plain diagram (headless render), null when unknown. */
function naturalDiagramSize(host: MehrpeleHost, diagram: NestedDiagram): MehrpeleLabelSize | null {
  if (diagram.lang === "mehrpele") return null; // Markdown labels size only once mounted
  try {
    // Unconstrained: the parent's layout width must not squeeze the child.
    const { maxWidth: _parentWidth, ...opts } = host.renderOptions() as RenderOptions;
    void _parentWidth;
    const r = peleRender(diagram.code, opts);
    return r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : null;
  } catch {
    return null;
  }
}

/**
 * A nested diagram: rendered by the host as a real diagram frame inside the
 * node (zoom, code reveal, resize corner), sized to the inner diagram's
 * natural size and fitted to the embed maxima like an image.
 */
async function renderDiagramLabel(
  host: MehrpeleHost,
  label: MehrpeleLabel,
  measureHost: HTMLElement,
  diagram: NestedDiagram,
  requested: { width?: number | undefined; height?: number | undefined },
  source: { origin: NestedOrigin; reveal?: () => void },
  onResize: (width: number | null, height: number | null | undefined, delta?: ContentDelta) => void,
  onSourceChange?: (nextCode: string) => void,
): Promise<RenderedLabel> {
  const component = new Component();
  host.component.addChild(component);
  const el = createDiv();
  el.className = "mehrpele-label mehrpele-diagram";
  el.dataset.anchorId = label.anchorId;
  const fit = fitOptions(host.settings);
  // Shrink-wrap the frame (the measure host is narrower than the cap): width max-content (styles.css).
  el.classList.add("mehrpele-shrink-wrap");
  measureHost.appendChild(el);

  const requestedWidth = requested.width;
  const natural = naturalDiagramSize(host, diagram);
  let width: number | undefined;
  let minWidth = 48;
  let maxWidth = fit.cap.width;
  let max = { ...fit.cap };
  if (natural) {
    const fitted = fitContentSize(natural, requestedWidth !== undefined ? { width: requestedWidth } : {}, fit);
    // Natural size that already fits needs no explicit width.
    width = requestedWidth !== undefined || fitted.width !== natural.width ? fitted.width : undefined;
    minWidth = minContentWidth(natural, fit);
    max = maxContentSize(natural, fit.cap);
    maxWidth = Math.max(minWidth, max.width);
  } else if (requestedWidth !== undefined) {
    width = Math.min(requestedWidth, fit.cap.width);
  }
  el.style.maxWidth = `${Math.max(maxWidth, fit.cap.width)}px`;

  const handle = host.renderNestedDiagram?.(
    el,
    {
      lang: diagram.lang,
      code: diagram.code,
      sourcePath: host.sourcePath,
      width,
      ...(requested.height !== undefined ? { height: requested.height } : {}),
      minWidth,
      maxWidth,
      minHeight: 40,
      maxHeight: Math.max(40, max.height + 200),
      depth: (host.depth ?? 0) + 1,
      // A commit (not a reset) moves a box entry by the content delta: the
      // new box, against the box shown (its height, else the aspect's).
      onResize: (w: number | null, h?: number | null) => {
        const shown = width ?? natural?.width;
        if (w === null || !natural || !shown || natural.width <= 0) {
          onResize(w, null);
          return;
        }
        const ratio = natural.height / natural.width;
        const shownH = requested.height ?? shown * ratio;
        onResize(w, h, contentDelta({ width: w, height: h ?? w * ratio }, { width: shown, height: shownH }));
      },
      ...(onSourceChange ? { onSourceChange } : {}),
      origin: source.origin,
      ...(source.reveal ? { revealOrigin: source.reveal } : {}),
    },
    component,
  );
  if (!handle) {
    el.remove();
    try {
      host.component.removeChild(component);
    } catch {
      component.unload();
    }
    return renderFallbackChip(host, label, measureHost);
  }
  component.register(() => handle.destroy());
  // One frame so the frame lays out (nested Mehrpele settles later; the
  // label ResizeObserver re-measures it in place).
  await new Promise((resolve) => window.setTimeout(resolve, 16));
  const size = measure(el);
  return {
    label,
    el,
    size,
    component,
    mode: "diagram",
    // Error panes / nested chrome may add height beyond the diagram itself.
    max: { width: max.width, height: max.height + 200 },
    ...(requestedWidth !== undefined ? { explicitSize: true } : {}),
  };
}

/**
 * Note / .base / .canvas embed node. Changes for node sizing are confined to
 * the box setup before the embed renders (auto height for notes) and the
 * resize corner after it; the embed rendering in between is unchanged.
 * Scrolling inside the box is plain `overflow: auto` (mehrpele.css).
 */
async function renderEmbedLabel(
  host: MehrpeleHost,
  label: MehrpeleLabel,
  measureHost: HTMLElement,
  rewrite: LabelRewriter,
): Promise<RenderedLabel> {
  const target = label.embedTarget;
  if (!target) return renderFallbackChip(host, label, measureHost);
  const component = new Component();
  host.component.addChild(component);
  const el = createDiv();
  el.className = "mehrpele-label mehrpele-embed";
  el.dataset.anchorId = label.anchorId;
  const box = embedBoxSize(target, host.settings);
  const requested = embedRequestedSize(target);
  const cap = { width: host.settings.maxEmbedWidth, height: host.settings.maxEmbedHeight };
  // Notes without an explicit height grow with their content (up to the
  // cap, then scroll) instead of sitting in a fixed, mostly empty box.
  const auto = isNoteTarget(target) && requested.height === undefined;
  // A viewport label (viewport.ts): this box is in SVG units; the overlay
  // lays it out at s/k so the embed's controls keep their native size.
  if (auto) el.classList.add("mehrpele-embed-auto");
  setViewportBox(el, auto ? { width: box.width, maxHeight: cap.height } : box);
  measureHost.appendChild(el);

  // Extension seam first (Canvas portals), then Obsidian's own embed
  // machinery via MarkdownRenderer — never an error when unhandled.
  const origin = embedOrigin(target, host.sourcePath);
  let handled = false;
  for (const entry of embedRenderers()) {
    if (!entry.match(target)) continue;
    try {
      handled = (await entry.render(target, el, {
        sourcePath: host.sourcePath,
        settings: host.settings,
        origin,
        component, // view-nodes: slots release their live view with the label
      })) === true;
    } catch (e) {
      console.warn("[mehrpele] embed renderer failed", e);
    }
    if (handled) break;
  }
  // A Markdown note (heading, block) is the node itself, as a Canvas file card (note-card.ts).
  if (!handled && isNoteTarget(target)) {
    const file = host.app.metadataCache.getFirstLinkpathDest(target.linkpath, host.sourcePath);
    if (file?.extension === "md") {
      const card = await mountNoteCard(host.app, file, target.subpath ?? "", el, host.sourcePath, component, (host.depth ?? 0) + 1);
      if (card) {
        handled = true;
        el.classList.add("mehrpele-note");
        el.dataset.cardLabel = card.title;
      }
    }
  }
  if (!handled) {
    await MarkdownRenderer.render(
      host.app,
      embedMarkdown(target),
      el,
      host.sourcePath,
      component,
    );
  }
  await settleLabel(el);
  if (origin.kind === "portal") host.attachOrigin?.(el, origin, component);
  // Node sizing: free W×H corner, committed as `![[t|WxH]]` (dbl-click resets).
  if (!Platform.isMobile) {
    let pressBox: ViewportBox | null = null;
    const detach = attachNodeResize(el, {
      target: el,
      scale: () => screenScaleOf(el),
      // SVG units: the viewport box (auto-height notes: on-screen height / scale).
      size: () => {
        const vb = viewportBoxOf(el);
        pressBox = vb;
        const scale = screenScaleOf(el);
        const height = vb?.height ?? Math.max(1, Math.round(el.getBoundingClientRect().height / scale));
        return { width: vb?.width ?? box.width, height };
      },
      min: { width: 80, height: 40 },
      max: cap,
      onPreview: (s) => setViewportBox(el, { width: s.width, height: s.height }),
      // An auto-height note keeps growing with its content after a click.
      onCancel: () => {
        if (pressBox) setViewportBox(el, pressBox);
      },
      onCommit: (s, start) => rewrite(label.anchorId, (raw) => withEmbedSize(raw, s), contentDelta(s, start)),
      onReset: () => rewrite(label.anchorId, (raw) => withEmbedSize(raw, null)),
    });
    component.register(detach);
  }
  if (auto) {
    const size = { width: box.width, height: Math.max(1, Math.min(measure(el).height, cap.height)) };
    return { label, el, size, component, mode: "embed-auto", max: { ...cap } };
  }
  return { label, el, size: { ...box }, component, mode: "embed" };
}
