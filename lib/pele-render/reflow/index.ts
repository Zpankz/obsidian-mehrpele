/**
 * Responsive reflow: layout plans for a width (flowchart ladder, sideways
 * turns, Pele's native reflow) plus the `%% pele-reflow … %%` directive.
 * Shared by the Obsidian plugin, the lightbox and the CLI (`--max-width`).
 */
export {
  hasReflowDirective,
  lintReflowDirective,
  lintReflowWarnings,
  MIN_FLOOR,
  parseReflowDirective,
  REFLOW_DIRECTIVE_RE,
} from "./directive.js";
export type { ReflowDirective, ReflowDirectiveLint } from "./directive.js";
export {
  flipSource,
  flowchartDirection,
  hasHorizontalSubgraph,
  hasWrittenDirection,
  headerLine,
  turnSource,
  TURNABLE_TYPES,
} from "./transpose.js";
export {
  applyPlanSource,
  DEFAULT_REFLOW_POLICY,
  DIRECTION_BREAKPOINT,
  displayScale,
  FILL_MAX_SCALE,
  fillScale,
  NATURAL_WIDTH,
  planFillReflow,
  planReflow,
  ReflowPlanner,
  similarLayout,
} from "./plan.js";
export type { LayoutSize, PlannerOptions, ReflowMode, ReflowPlan, ReflowPolicy, ReflowRender } from "./plan.js";
