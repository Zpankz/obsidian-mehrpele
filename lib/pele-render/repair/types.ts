export type RepairTier = "linter" | "jev" | "llm";
export interface PeleErrorLike { message: string; code?: string; type?: string | null; line?: number; column?: number; snippet?: string }
export interface RepairCandidate { source: string; tier: RepairTier; fixes: string[]; cost: number; type?: string; lossy: boolean; dropped?: string[] }
export interface RepairAttempt { tier: RepairTier; ok: boolean; detail: string; candidates?: number; error?: PeleErrorLike }
export interface JevChoice { choice: string; confidence: number; probabilities: Record<string, number> }
export interface JevProvider { choose(state: string, question: string, options: Record<string, string>): Promise<JevChoice> }
export interface LlmProvider { complete(system: string, user: string, signal?: AbortSignal): Promise<string> }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;
export interface RepairOptions {
  tiers?: RepairTier[];
  jev?: JevProvider; llm?: LlmProvider;
  jevMinConfidence?: number;
  llmMaxAttempts?: number;
  maxCandidates?: number;
  config?: object;
  signal?: AbortSignal;
}
export interface RepairResult { ok: boolean; source?: string; tier?: RepairTier; fixes: string[]; attempts: RepairAttempt[]; error?: PeleErrorLike; unchanged?: boolean; lossy?: boolean; dropped?: string[] }
