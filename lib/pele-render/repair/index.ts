// Public `pele-render/repair` entry point. Browser-safe: no node: imports here or
// in any module it re-exports (the Node-only Jev CLI provider lives outside this barrel).
export type {
  RepairTier, PeleErrorLike, RepairCandidate, RepairAttempt, JevChoice, JevProvider, LlmProvider, FetchLike,
  RepairOptions, RepairResult,
} from "./types.js";
export { validateSource } from "./validate.js";
export { diffLines } from "./diff.js";
export { REPAIR_RULES, lintCandidates } from "./rules.js";
export { repairDiagram } from "./engine.js";
export { preserveDirectives, extractDiagramFromLlm, playgroundUrl } from "./llm-text.js";
export { createJevHttpProvider, createAnthropicProvider, createOpenAICompatibleProvider } from "./providers.js";
