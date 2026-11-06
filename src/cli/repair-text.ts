/** Pure core of `pele:repair`: apply repairs to file text and summarise results (DOM/vault-free). */
import { replaceBlockBody } from "../replace-block";

export interface RepairReplacement {
  /** 1-based line of the first source line (DiagramRef.line). */
  line: number;
  old: string;
  next: string;
}

/**
 * Apply CLI repairs to the current file text. Each replacement is located
 * independently by fence + exact body (so one block that moved or can't be
 * found — or a different lang — never aborts the others); whole-file diagrams
 * replace the entire body when it still equals the repaired source.
 */
export function applyRepairsToText(
  text: string,
  wholeFile: boolean,
  replacements: readonly RepairReplacement[],
): { text: string; applied: number; skipped: number } {
  // Diagram sources are LF-normalised; a consistently CRLF file is matched in
  // LF and written back in CRLF (mixed endings are left alone → skipped).
  const crlf = text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
  if (crlf) {
    const r = applyRepairsToText(text.replace(/\r\n/g, "\n"), wholeFile, replacements);
    return { ...r, text: r.applied > 0 ? r.text.replace(/\n/g, "\r\n") : text };
  }
  if (wholeFile) {
    const r = replacements[0];
    if (!r) return { text, applied: 0, skipped: 0 };
    const body = text.replace(/\r?\n$/, "");
    if (body !== r.old.replace(/\r?\n$/, "")) return { text, applied: 0, skipped: replacements.length };
    const trailing = text.slice(body.length);
    return { text: r.next.replace(/\n$/, "") + trailing, applied: 1, skipped: replacements.length - 1 };
  }
  let out = text;
  let applied = 0;
  let skipped = 0;
  // Bottom-up so earlier fence lines stay valid hints.
  for (const r of [...replacements].sort((a, b) => b.line - a.line)) {
    const replaced = replaceBlockBody(out, Math.max(0, r.line - 2), r.old, r.next);
    if (replaced.ok) {
      out = replaced.text;
      applied++;
    } else skipped++;
  }
  return { text: out, applied, skipped };
}

/** One entry of `pele:repair format=json` (same shape as `pele-render repair --format json`). */
export interface RepairResultEntry {
  file: string;
  index: number;
  line: number;
  ok: boolean;
  tier?: string;
  fixes: string[];
  attempts: unknown;
  unchanged?: boolean;
  lossy: boolean;
  dropped?: string[];
}

export interface RepairSummary {
  diagrams: number;
  repaired: number;
  failed: number;
  results: RepairResultEntry[];
}

/** Engine RepairResult → summary entry (pele-render's mapping, field for field). */
export function repairResultEntry(
  d: { file: string; index: number; line: number },
  r: { ok: boolean; tier?: string; fixes: string[]; attempts: unknown; unchanged?: boolean; lossy?: boolean; dropped?: string[] },
): RepairResultEntry {
  return {
    file: d.file,
    index: d.index,
    line: d.line,
    ok: r.ok,
    tier: r.tier,
    fixes: r.fixes,
    attempts: r.attempts,
    unchanged: r.unchanged,
    lossy: r.lossy ?? false,
    ...(r.dropped && r.dropped.length ? { dropped: r.dropped } : {}),
  };
}

/** Counts exactly as pele-render: repaired = ok && !unchanged, failed = !ok. */
export function buildRepairSummary(results: RepairResultEntry[]): RepairSummary {
  return {
    diagrams: results.length,
    repaired: results.filter((r) => r.ok && !r.unchanged).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
