/** Integrations public surface. main.ts wires this in. */
import type { MarkdownPostProcessorContext } from "obsidian";
import { makeBreadcrumbsHandler } from "./breadcrumbs/index";
import { makeDatacoreHandler, publishPeleMermaid } from "./datacore/index";
import type { IntegrationHost } from "./host";
import { makeTasksHandler } from "./tasknotes/index";

export {
  flowchartFromGraph,
  ganttFromSpec,
  mindmapFromTree,
  kanbanFromSpec,
  sanitiseId,
  escapeQuotedLabel,
  quotedLabel,
  DEFAULT_MAX_NODES,
  type GraphSpec,
  type GraphNode,
  type GraphEdge,
  type GraphGroup,
  type GraphShape,
  type GanttSpec,
  type GanttTask,
  type MindmapSpec,
  type TreeNode,
  type KanbanSpec,
  type KanbanColumn,
  type GeneratorOptions,
  type GeneratedSource,
} from "./graph-to-pele";
export {
  parseKeyValueOptions,
  parseBreadcrumbsOptions,
  parseDatacoreOptions,
  parseTaskOptions,
  type BreadcrumbsOptions,
  type DatacoreBlockOptions,
  type TaskBlockOptions,
  type TaskView,
} from "./options";
export {
  DEFAULT_INTEGRATION_SETTINGS,
  normalizeIntegrationSettings,
  type IntegrationSettings,
  type BreadcrumbsIntegrationSettings,
  type DatacoreIntegrationSettings,
  type TaskNotesIntegrationSettings,
} from "./settings";
export {
  getBcApi,
  getDatacoreApi,
  getTaskNotesApi,
  normaliseBcEdges,
  unwrapDatacoreResult,
  type Detection,
  type DetectionStatus,
  type BcApiLike,
  type BcEdgeLike,
  type DatacoreApiLike,
  type DatacorePageLike,
  type TaskInfoLike,
  type TaskNotesApiLike,
} from "./detect";
export type { IntegrationHost, PeleMountHandle, PeleRenderResultLike } from "./host";
export { breadcrumbsToGraph, basenameLabel } from "./breadcrumbs/map";
export { datacoreToGraph, datacoreToGantt } from "./datacore/map";
export { createPeleComponent, type DcLike, type PeleComponent } from "./datacore/component";
export { publishPeleMermaid, PELE_MERMAID_VERSION, type PeleMermaidGlobal } from "./datacore/index";
export {
  tasksToGantt,
  tasksToGraph,
  tasksToKanban,
  filterTasks,
  DEFAULT_STATUS_MAPPING,
  type TaskStatusMapping,
} from "./tasknotes/map";

export type CodeBlockHandler = (
  source: string,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
) => void;

export interface IntegrationRegistration {
  /** Unregister window.peleMermaid (call from onunload). */
  unregisterPeleMermaid: () => void;
}

/**
 * Register all integration code-block processors on the host plugin.
 * Only registers blocks whose integration is enabled at load time
 * (Obsidian cannot unregister a single processor; see README).
 */
export function registerIntegrations(
  host: IntegrationHost,
  register: (lang: string, handler: CodeBlockHandler) => void,
): IntegrationRegistration {
  const settings = host.settings();
  let unregisterPeleMermaid = (): void => undefined;
  if (settings.datacore.enabled) {
    unregisterPeleMermaid = publishPeleMermaid(host);
    register("pele-datacore", makeDatacoreHandler(host));
  }
  if (settings.breadcrumbs.enabled) {
    register("pele-breadcrumbs", makeBreadcrumbsHandler(host));
  }
  if (settings.tasknotes.enabled) {
    register("pele-tasks", makeTasksHandler(host));
  }
  return { unregisterPeleMermaid };
}
