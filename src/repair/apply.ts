/** The shared outcome of a 1-click repair: failure modal, no-op, review, then apply. */
import { Notice } from "obsidian";
import type { RepairResult } from "pele-render/repair";
import { repairNeedsReview, repairOptions } from "../repair-settings";
import type PeleMermaidPlugin from "../../main";
import { RepairFailureModal, RepairPreviewModal } from "./modals";

/** A diagram that a repair result can be written back to (frame or Mehrpele shell). */
export interface RepairTarget {
  readonly source: string;
  applyRepaired(newSource: string): Promise<boolean>;
}

/** A repair that was written back: the source it replaced and the "Repaired by …" summary. */
export interface AppliedRepair {
  oldSource: string;
  summary: string;
}

/** "Repaired by <tier>: <fixes>", noting removed/commented content for lossy repairs. */
export function repairSummary(result: Pick<RepairResult, "tier" | "fixes" | "lossy" | "dropped">): string {
  const droppedNote = result.lossy
    ? ` (lossy): removed/commented ${result.dropped && result.dropped.length > 0 ? result.dropped.join(", ") : "content"}`
    : "";
  const fixes = (result.fixes.length > 0 ? result.fixes.join("; ") : "fixed") + droppedNote;
  return `Repaired by ${result.tier ?? "linter"}: ${fixes}`;
}

/** Diff preview; resolves true when the user applies. */
export function confirmRepair(plugin: PeleMermaidPlugin, oldSource: string, result: RepairResult): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    new RepairPreviewModal(
      plugin.app,
      oldSource,
      result.source ?? oldSource,
      resolve,
      result.lossy ? result.dropped : undefined,
      result.tier === "jev" || result.tier === "llm" ? result.tier : undefined,
    ).open();
  });
}

/**
 * Handle a repair result for `target`: show the failure modal, "already valid",
 * the review modal when required, or "could not locate". Returns the applied
 * repair (for the caller's success notice) or null when nothing was written.
 */
export async function applyRepairResult(
  plugin: PeleMermaidPlugin,
  target: RepairTarget,
  result: RepairResult,
): Promise<AppliedRepair | null> {
  if (!result.ok || !result.source) {
    const tiersRan = result.attempts.map((a) => a.tier).join(" → ") || "none";
    const msg = result.error?.message ?? "no tier could fix this diagram";
    new RepairFailureModal(plugin.app, msg, tiersRan, target.source).open();
    return null;
  }
  if (result.unchanged || result.source === target.source) {
    new Notice("Pele: diagram is already valid.");
    return null;
  }
  // Lossy repairs (content removed/commented out) and Jev/LLM results always
  // require the confirm modal, even when "Preview before applying" is off.
  if (repairNeedsReview(result, repairOptions(plugin.settings))) {
    if (!(await confirmRepair(plugin, target.source, result))) return null;
  }
  const oldSource = target.source;
  if (!(await target.applyRepaired(result.source))) {
    new Notice("Pele: could not locate that diagram to apply the repair; nothing changed.");
    return null;
  }
  return { oldSource, summary: repairSummary(result) };
}
