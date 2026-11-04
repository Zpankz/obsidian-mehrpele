/** ```pele-breadcrumbs``` block. Obsidian-only; mapping stays pure. */
import { MarkdownRenderChild, type MarkdownPostProcessorContext } from "obsidian";
import { getBcApi, normaliseBcEdges, type BcApiLike } from "../detect";
import { flowchartFromGraph } from "../graph-to-pele";
import { prepareFlowchart } from "../generator-context";
import { debounce, IntegrationSurface, type IntegrationHost } from "../host";
import { parseBreadcrumbsOptions } from "../options";
import { breadcrumbsToGraph } from "./map";

export function makeBreadcrumbsHandler(host: IntegrationHost) {
  return (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
    ctx.addChild(new BreadcrumbsChild(el, host, source, ctx));
  };
}

type BcEventsLike = {
  on?: (e: string, cb: () => void) => unknown;
  off?: (r: unknown) => void;
  offref?: (r: unknown) => void;
};

/** The Breadcrumbs API with the plugin internals this integration reads when present. */
type BcPluginApi = BcApiLike & { plugin?: { events?: BcEventsLike; graph?: unknown } };

class BreadcrumbsChild extends MarkdownRenderChild {
  private mountEl: HTMLElement;
  private surface: IntegrationSurface;
  private schedule: () => void;
  private BcEvents: BcEventsLike | null = null;
  private BcRef: unknown = null;
  private destroyed = false;

  constructor(
    containerEl: HTMLElement,
    private host: IntegrationHost,
    private source: string,
    private ctx: MarkdownPostProcessorContext,
  ) {
    super(containerEl);
    this.mountEl = containerEl.createDiv({ cls: "pele-integration pele-integration-breadcrumbs" });
    this.surface = new IntegrationSurface(host, this.mountEl, ctx);
    this.schedule = debounce(() => void this.render(), this.host.settings().breadcrumbs.debounceMs);
  }

  onload(): void {
    void this.render();
    this.subscribe();
  }

  onunload(): void {
    this.destroyed = true;
    this.surface.release();
    try {
      if (this.BcRef !== null) {
        if (this.BcEvents?.off) this.BcEvents.off(this.BcRef);
        else if (this.BcEvents?.offref) this.BcEvents.offref(this.BcRef);
      }
    } catch { /* already gone */ }
    this.BcRef = null;
  }

  private subscribe(): void {
    const detection = getBcApi(this.host.app);
    const api: BcPluginApi | undefined = detection.api;
    const events = api?.plugin?.events;
    if (!events || typeof events.on !== "function") return;
    this.BcEvents = events;
    try {
      // Breadcrumbs re-triggers "graph-update" on every graph rebuild (main.ts:41,122-126).
      this.BcRef = events.on("graph-update", () => this.schedule());
    } catch { /* event bus shape differs; initial render still works */ }
  }

  private async render(): Promise<void> {
    if (this.destroyed) return;
    const settings = this.host.settings().breadcrumbs;
    if (!settings.enabled) {
      this.surface.notice("Pele Breadcrumbs integration is off. Enable it under Settings → Mehrpele → Integrations.");
      return;
    }
    const detection = getBcApi(this.host.app);
    if (detection.status !== "ok" || !detection.api) {
      this.surface.notice(`Pele Breadcrumbs: ${detection.detail}`);
      return;
    }
    const options = parseBreadcrumbsOptions(this.source);
    const showImplied = options.implied || settings.showImplied;
    // Breadcrumbs keys its graph by full file path (with extension); `start:` is
    // written like a link (`Note`, `folder/Note`, `[[Note]]`), so resolve it.
    const startLink = options.start?.replace(/^\[\[|\]\]$/g, "").split("|")[0]?.trim();
    const start = startLink
      ? (this.host.app.metadataCache.getFirstLinkpathDest(startLink, this.ctx.sourcePath)?.path ?? startLink)
      : this.ctx.sourcePath;
    if (!start) {
      this.surface.notice("Pele Breadcrumbs: no start note (open a note or set `start:`).");
      return;
    }
    const api: BcPluginApi = detection.api;
    const graph = api.plugin?.graph;
    try {
      const spec = breadcrumbsToGraph(
        start,
        (path) => {
          const raw = api.get_neighbours(path);
          return raw === undefined ? undefined : normaliseBcEdges(raw, graph);
        },
        {
          fields: options.fields,
          depth: options.depth,
          implied: showImplied,
          maxNodes: Math.min(options.maxNodes, settings.maxNodes),
          direction: options.direction,
        },
      );
      if (spec.nodes.length <= 1 && spec.edges.length === 0) {
        this.surface.notice(`Pele Breadcrumbs: no neighbours found for “${start}”.`);
        return;
      }
      const prepared = prepareFlowchart(this.host.app, this.host.settings(), spec, {
        maxNodes: Math.min(options.maxNodes, settings.maxNodes),
      });
      const generated = flowchartFromGraph(prepared.spec, prepared.options);
      this.surface.show(generated.source);
    } catch (e) {
      this.surface.notice(`Pele Breadcrumbs: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
