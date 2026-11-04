/** Repair settings shape + DOM-free mapping to engine RepairOptions. */
import type { JevProvider, LlmProvider, RepairOptions, RepairTier } from "pele-render/repair";
import type { SettingsV3 } from "./settings/schema";

export type JevTransport = "http" | "cli";
export type LlmProviderKind = "anthropic" | "openai";

export interface RepairSettings {
  previewBeforeApplying: boolean;
  tierLinter: boolean;
  tierJev: boolean;
  tierLlm: boolean;
  jevTransport: JevTransport;
  jevBaseUrl: string;
  jevModel: string;
  jevBinPath: string;
  /** A custom jev binary path the user explicitly approved to run (one-time confirmation). */
  jevBinConfirmed: string;
  jevMinConfidence: number;
  jevKeySecretId: string;
  llmProvider: LlmProviderKind;
  llmBaseUrl: string;
  llmModel: string;
  llmMaxAttempts: number;
  /** OpenAI-compatible `reasoning_effort` ("default" = omit). The Ollama preset sets "none": reasoning models then answer in ~1s instead of minutes. */
  llmReasoningEffort: "default" | "none" | "low" | "medium" | "high";
  /** Abort one OpenAI-compatible LLM request after this many seconds. */
  llmTimeoutSec: number;
  anthropicKeySecretId: string;
  openaiKeySecretId: string;
}

export const DEFAULT_REPAIR_SETTINGS: RepairSettings = {
  previewBeforeApplying: false,
  tierLinter: true,
  tierJev: false,
  tierLlm: false,
  jevTransport: "http",
  jevBaseUrl: "https://api.typesafe.ai",
  jevModel: "jev-latest",
  jevBinPath: "",
  jevBinConfirmed: "",
  jevMinConfidence: 0.2,
  jevKeySecretId: "pele-mermaid-jev-key",
  llmProvider: "anthropic",
  llmBaseUrl: "",
  llmModel: "claude-sonnet-5-5",
  llmMaxAttempts: 2,
  llmReasoningEffort: "default",
  llmTimeoutSec: 120,
  anthropicKeySecretId: "pele-mermaid-anthropic-key",
  openaiKeySecretId: "pele-mermaid-openai-key",
};

/** Enabled tiers in the fixed execution order linter → jev → llm. */
export function enabledTiers(s: RepairSettings): RepairTier[] {
  const tiers: RepairTier[] = [];
  if (s.tierLinter) tiers.push("linter");
  if (s.tierJev) tiers.push("jev");
  if (s.tierLlm) tiers.push("llm");
  return tiers;
}

export function toRepairOptions(
  s: RepairSettings,
  providers: { jev?: JevProvider; llm?: LlmProvider; signal?: AbortSignal } = {},
): RepairOptions {
  return {
    tiers: enabledTiers(s),
    ...(providers.jev ? { jev: providers.jev } : {}),
    ...(providers.llm ? { llm: providers.llm } : {}),
    jevMinConfidence: s.jevMinConfidence,
    llmMaxAttempts: s.llmMaxAttempts,
    ...(providers.signal ? { signal: providers.signal } : {}),
  };
}

/**
 * Whether a repair must be shown as a diff before it touches the note. Jev and
 * LLM results are model output (an LLM rewrite can change anything), so they
 * are always reviewed regardless of "Preview before applying"; lossy results
 * too. Only deterministic linter fixes keep the 1-click path.
 */
export function repairNeedsReview(
  result: { tier?: RepairTier; lossy?: boolean },
  s: Pick<RepairSettings, "previewBeforeApplying">,
): boolean {
  return s.previewBeforeApplying || !!result.lossy || result.tier === "jev" || result.tier === "llm";
}

/** Fixed engine knobs (no longer settings). */
export const JEV_MIN_CONFIDENCE = 0.2;
export const LLM_MAX_ATTEMPTS = 2;

/** Runtime repair options from the v3 settings (Repair feature + shared `llm` block). Read-only. */
export function repairOptions(s: SettingsV3): RepairSettings {
  const r = s.features.repair, jev = r.jev, llm = s.llm;
  return {
    previewBeforeApplying: r.preview,
    tierLinter: r.enabled,
    tierJev: jev.enabled,
    tierLlm: r.llm,
    jevTransport: jev.transport,
    jevBaseUrl: jev.baseUrl,
    jevModel: jev.model,
    jevBinPath: jev.binPath,
    jevBinConfirmed: jev.binConfirmed,
    jevMinConfidence: JEV_MIN_CONFIDENCE,
    jevKeySecretId: jev.keySecretId,
    llmProvider: llm.provider,
    llmBaseUrl: llm.baseUrl,
    llmModel: llm.model,
    llmMaxAttempts: LLM_MAX_ATTEMPTS,
    llmReasoningEffort: llm.reasoningEffort,
    llmTimeoutSec: llm.timeoutSec,
    anthropicKeySecretId: llm.anthropicKeySecretId,
    openaiKeySecretId: llm.openaiKeySecretId,
  };
}
