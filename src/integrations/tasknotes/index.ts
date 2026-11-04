/** ```pele-tasks``` block (read-only). Obsidian-only; mapping stays pure. */
import { MarkdownRenderChild, type MarkdownPostProcessorContext } from "obsidian";
import { getTaskNotesApi, type StatusConfigLike } from "../detect";
import { flowchartFromGraph, ganttFromSpec, kanbanFromSpec } from "../graph-to-pele";
import { prepareFlowchart } from "../generator-context";
import { debounce, IntegrationSurface, type IntegrationHost } from "../host";
import { parseTaskOptions } from "../options";
import {
  DEFAULT_STATUS_MAPPING,
  filterTasks,
  mappingWithCatalog,
  tasksToGantt,
  tasksToGraph,
  tasksToKanban,
  type TaskStatusMapping,
} from "./map";

const REFRESH_EVENTS = [
  "task.created",
  "task.updated",
  "task.deleted",
  "task.status.changed",
  "task.dependencies.changed",
  "task.scheduled.changed",
  "task.due.changed",
] as const;

export function makeTasksHandler(host: IntegrationHost) {
  return (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
    ctx.addChild(new TasksChild(el, host, source, ctx));
  };
}

class TasksChild extends MarkdownRenderChild {
  private mountEl: HTMLElement;
  private surface: IntegrationSurface;
  private schedule: () => void;
  private refs: unknown[] = [];
  private eventsApi: { off?: (r: unknown) => void } | null = null;
  private destroyed = false;

  constructor(
    containerEl: HTMLElement,
    private host: IntegrationHost,
    private source: string,
    private ctx: MarkdownPostProcessorContext,
  ) {
    super(containerEl);
    this.mountEl = containerEl.createDiv({ cls: "pele-integration pele-integration-tasks" });
    this.surface = new IntegrationSurface(host, this.mountEl, ctx);
    this.schedule = debounce(() => void this.render(), this.host.settings().tasknotes.debounceMs);
  }

  onload(): void {
    void this.render();
    this.subscribe();
  }

  onunload(): void {
    this.destroyed = true;
    this.surface.release();
    for (const ref of this.refs) {
      try {
        this.eventsApi?.off?.(ref);
      } catch { /* already gone */ }
    }
    this.refs = [];
  }

  private subscribe(): void {
    const detection = getTaskNotesApi(this.host.app);
    const api = detection.api;
    if (!api) return;
    const events = (api.events ?? api);
    if (typeof events.on !== "function") return;
    this.eventsApi = events;
    for (const name of REFRESH_EVENTS) {
      try {
        const ref = events.on(name, () => this.schedule());
        if (ref !== undefined) this.refs.push(ref);
      } catch { /* event unsupported in this version */ }
    }
  }

  private mapping(): TaskStatusMapping {
    const s = this.host.settings().tasknotes;
    const base: TaskStatusMapping = {
      done: s.doneStatuses.length > 0 ? s.doneStatuses : DEFAULT_STATUS_MAPPING.done,
      active: s.activeStatuses.length > 0 ? s.activeStatuses : DEFAULT_STATUS_MAPPING.active,
      crit: s.critStatuses.length > 0 ? s.critStatuses : DEFAULT_STATUS_MAPPING.crit,
    };
    const detection = getTaskNotesApi(this.host.app);
    let catalog: StatusConfigLike[] | undefined;
    try {
      catalog = detection.api?.catalog?.statuses?.();
    } catch { /* catalog unavailable */ }
    return mappingWithCatalog(base, catalog);
  }

  private async render(): Promise<void> {
    if (this.destroyed) return;
    const settings = this.host.settings().tasknotes;
    if (!settings.enabled) {
      this.surface.notice("Pele TaskNotes integration is off. Enable it under Settings → Mehrpele → Integrations.");
      return;
    }
    const detection = getTaskNotesApi(this.host.app);
    if (detection.status !== "ok" || !detection.api) {
      this.surface.notice(`Pele TaskNotes: ${detection.detail}`);
      return;
    }
    const options = parseTaskOptions(this.source);
    const maxNodes = Math.min(options.maxNodes, settings.maxNodes);
    try {
      const all = await detection.api.listTasks({});
      if (this.destroyed) return;
      const tasks = filterTasks(all, { status: options.status, tags: options.tags, project: options.project });
      if (tasks.length === 0) {
        this.surface.notice("Pele TaskNotes: no tasks match this filter.");
        return;
      }
      const mapping = this.mapping();
      let generated;
      if (options.view === "dependencies") {
        const prepared = prepareFlowchart(this.host.app, this.host.settings(), tasksToGraph(tasks, mapping), { maxNodes });
        generated = flowchartFromGraph(prepared.spec, prepared.options);
      } else if (options.view === "kanban") {
        generated = kanbanFromSpec(tasksToKanban(tasks, options.status), { maxNodes });
      } else {
        const { spec, skippedNoDate } = tasksToGantt(tasks, { mapping, groupBy: options.group });
        generated = ganttFromSpec(spec, { maxNodes });
        if (generated.nodeCount === 0) {
          this.surface.notice(
            `Pele TaskNotes: ${tasks.length} task(s) matched but none have scheduled/due dates${skippedNoDate > 0 ? ` (${skippedNoDate} skipped)` : ""}. Try view: dependencies.`,
          );
          return;
        }
      }
      this.surface.show(generated.source);
    } catch (e) {
      this.surface.notice(`Pele TaskNotes: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
