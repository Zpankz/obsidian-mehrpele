/** Datacore publisher (window.peleMermaid) + ```pele-datacore``` block. */
import { MarkdownRenderChild, type MarkdownPostProcessorContext } from "obsidian";
import { getDatacoreApi, unwrapDatacoreResult, type DatacorePageLike } from "../detect";
import { flowchartFromGraph, ganttFromSpec } from "../graph-to-pele";
import { prepareFlowchart } from "../generator-context";
import { debounce, IntegrationSurface, type IntegrationHost } from "../host";
import { parseDatacoreOptions } from "../options";
import { createPeleComponent, type PeleGlobalLike } from "./component";
import { datacoreToGantt, datacoreToGraph } from "./map";

export const PELE_MERMAID_VERSION = "0.1.0";

export interface PeleMermaidGlobal extends PeleGlobalLike {
  mount: (el: HTMLElement, source: string, opts?: { maxWidth?: number }) => { destroy(): void; update?: (s: string) => void };
  render: (source: string, opts?: { maxWidth?: number }) => ReturnType<IntegrationHost["renderPele"]>;
}

/** Publish window.peleMermaid; returns an unregister function for onunload. */
export function publishPeleMermaid(host: IntegrationHost): () => void {
  const api: PeleMermaidGlobal = {
    version: PELE_MERMAID_VERSION,
    mount: (el, source, opts) => host.mountPele(el, source, opts),
    render: (source, opts) => host.renderPele(source, opts),
    component: (dc) => createPeleComponent(dc, api),
  };
  const w = window as unknown as { peleMermaid?: unknown };
  const previous = w.peleMermaid;
  w.peleMermaid = api;
  return () => {
    if (w.peleMermaid === api) {
      if (previous !== undefined) w.peleMermaid = previous;
      else delete w.peleMermaid;
    }
  };
}

export function makeDatacoreHandler(host: IntegrationHost) {
  return (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
    ctx.addChild(new DatacoreChild(el, host, source, ctx));
  };
}

class DatacoreChild extends MarkdownRenderChild {
  private mountEl: HTMLElement;
  private surface: IntegrationSurface;
  private schedule: () => void;
  private lastRevision = -1;
  private coreEvents: { on?: (e: string, cb: (r: number) => void, ctx?: unknown) => unknown; offref?: (r: unknown) => void } | null = null;
  private coreRef: unknown = null;
  private destroyed = false;

  constructor(
    containerEl: HTMLElement,
    private host: IntegrationHost,
    private source: string,
    private ctx: MarkdownPostProcessorContext,
  ) {
    super(containerEl);
    this.mountEl = containerEl.createDiv({ cls: "pele-integration pele-integration-datacore" });
    this.surface = new IntegrationSurface(host, this.mountEl, ctx);
    this.schedule = debounce(() => this.render(), this.host.settings().datacore.debounceMs);
  }

  onload(): void {
    this.render();
    this.subscribe();
  }

  onunload(): void {
    this.destroyed = true;
    this.surface.release();
    try {
      if (this.coreRef !== null && this.coreEvents?.offref) this.coreEvents.offref(this.coreRef);
    } catch { /* already gone */ }
    this.coreRef = null;
  }

  private subscribe(): void {
    const detection = getDatacoreApi(this.host.app);
    const core = detection.api?.core as typeof this.coreEvents & { revision?: number } | undefined;
    if (!core || typeof core.on !== "function") return;
    this.coreEvents = core;
    try {
      // Datacore core.on("update", revision) — datacore.ts:270-271.
      this.coreRef = core.on("update", (revision: number) => {
        if (typeof revision === "number" && revision === this.lastRevision) return;
        this.schedule();
      }, this);
    } catch { /* event shape differs; initial render still works */ }
  }

  private render(): void {
    if (this.destroyed) return;
    const settings = this.host.settings().datacore;
    if (!settings.enabled) {
      this.surface.notice("Pele Datacore integration is off. Enable it under Settings → Mehrpele → Integrations.");
      return;
    }
    const detection = getDatacoreApi(this.host.app);
    if (detection.status !== "ok" || !detection.api) {
      this.surface.notice(`Pele Datacore: ${detection.detail}`);
      return;
    }
    const options = parseDatacoreOptions(this.source);
    const maxNodes = Math.min(options.maxNodes, settings.maxNodes);
    try {
      const result = detection.api.tryQuery(options.query);
      const unwrapped = unwrapDatacoreResult<unknown[]>(result);
      if (!unwrapped.ok) {
        this.surface.notice(`Pele Datacore: query failed — ${unwrapped.error}`);
        return;
      }
      const core = detection.api.core;
      if (core && typeof core.revision === "number") this.lastRevision = core.revision;
      const pages = (unwrapped.value as DatacorePageLike[]).filter((p) => p && typeof p === "object");
      if (pages.length === 0) {
        this.surface.notice(`Pele Datacore: no results for \`${options.query}\` (index may still be building).`);
        return;
      }
      const generated =
        options.diagram === "gantt"
          ? ganttFromSpec(datacoreToGantt(pages, options.title), { maxNodes })
          : (() => {
              const prepared = prepareFlowchart(this.host.app, this.host.settings(), datacoreToGraph(pages, options.title), { maxNodes });
              return flowchartFromGraph(prepared.spec, prepared.options);
            })();
      if (generated.nodeCount === 0) {
        this.surface.notice(`Pele Datacore: results have no renderable ${options.diagram === "gantt" ? "dated tasks" : "pages"}.`);
        return;
      }
      this.surface.show(generated.source);
    } catch (e) {
      this.surface.notice(`Pele Datacore: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
