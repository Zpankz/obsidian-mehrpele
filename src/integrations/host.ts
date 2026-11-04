/**
 * Narrow host surface the integrations need from main.ts.
 * main.ts implements this once (wrapping DiagramFrame/pele mount); the
 * integrations never import main.ts or diagram-frame.ts directly.
 */
import type { App, Component, MarkdownPostProcessorContext } from "obsidian";
import type { IntegrationSettings } from "./settings";

export interface PeleMountHandle {
  destroy(): void;
  update?(source: string): void;
  refresh?(): void;
}

export interface PeleRenderResultLike {
  svg: string;
  type: string;
  width: number;
  height: number;
}

export interface IntegrationHost {
  app: App;
  /** Owning component for event/ref registration (the plugin). */
  component: Component;
  settings(): IntegrationSettings;
  /**
   * Render Pele `source` into `el` with the full DiagramFrame UX
   * (lightbox, resize, links, hover previews). Implemented by main.ts by
   * delegating to its existing code-block handler path.
   */
  renderSource(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void;
  /**
   * Destroy the frame last rendered into `el` by renderSource (each mount
   * target owns at most one live frame; re-rendering replaces it).
   */
  releaseSource?(el: HTMLElement): void;
  /** Headless Pele render (Datacore publisher `render`). */
  renderPele(source: string, opts?: { maxWidth?: number }): PeleRenderResultLike;
  /** Mount Pele into an element owned by the caller (Datacore component). */
  mountPele(el: HTMLElement, source: string, opts?: { maxWidth?: number }): PeleMountHandle;
}

/** Debounce helper (250 ms default). */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): (...args: A) => void {
  let timer: number | undefined;
  return (...args: A) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, waitMs);
  };
}

/** Render a one-line inline notice (disabled / partner missing) into `el`. */
export function renderNotice(el: HTMLElement, message: string): void {
  el.empty();
  const div = el.createDiv({ cls: "pele-integration-notice" });
  div.textContent = message;
}

/**
 * One integration block's render target. `show()` replaces the previous
 * frame (renderSource destroys it per target) and skips work when the
 * generated source equals what is already on screen (Datacore fires `update`
 * on every vault change); `notice()` releases the frame before replacing it
 * with a notice; `release()` on unload.
 */
export class IntegrationSurface {
  private last: string | null = null;

  constructor(
    private host: Pick<IntegrationHost, "renderSource" | "releaseSource">,
    readonly el: HTMLElement,
    private ctx: MarkdownPostProcessorContext,
    private notify: (el: HTMLElement, message: string) => void = renderNotice,
  ) {}

  /** Render generated source; false when it is unchanged (nothing re-rendered). */
  show(source: string): boolean {
    const key = `source:${source}`;
    if (key === this.last) return false;
    this.last = key;
    this.host.renderSource(source, this.el, this.ctx);
    return true;
  }

  notice(message: string): void {
    const key = `notice:${message}`;
    if (key === this.last) return;
    this.release();
    this.last = key;
    this.notify(this.el, message);
  }

  release(): void {
    this.last = null;
    try {
      this.host.releaseSource?.(this.el);
    } catch {
      /* host gone */
    }
  }
}
