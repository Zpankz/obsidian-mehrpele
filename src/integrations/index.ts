/**
 * Integrations public surface. The plugin registers the code blocks in
 * src/features/integration-blocks.ts.
 */
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
