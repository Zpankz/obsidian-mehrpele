import type { PeleErrorLike, RepairAttempt, RepairCandidate, RepairOptions, RepairResult, RepairTier } from "./types.js";
import { toErrorLike, validateSource } from "./validate.js";
import { lintCandidates } from "./rules.js";
import { diffLines } from "./diff.js";
import { extractDiagramFromLlm, preserveDirectives } from "./llm-text.js";

function aborted(signal?: AbortSignal): boolean { return Boolean(signal?.aborted); }

export async function repairDiagram(source: string, opts: RepairOptions = {}): Promise<RepairResult> {
  if (typeof source !== "string") throw new TypeError("repairDiagram: source must be a string");
  const tiersIn = opts.tiers ?? ["linter"];
  for (const t of tiersIn) if (!["linter", "jev", "llm"].includes(t)) throw new TypeError(`repairDiagram: unknown tier "${t}"`);
  const tiers: RepairTier[] = ["linter", "jev", "llm"].filter((t) => tiersIn.includes(t as RepairTier)) as RepairTier[];
  const jevMin = opts.jevMinConfidence ?? 0.2;
  const maxAttempts = opts.llmMaxAttempts ?? 2;
  const maxCand = opts.maxCandidates ?? 12;
  const attempts: RepairAttempt[] = [];

  if (aborted(opts.signal)) return { ok: false, fixes: [], attempts, error: { message: "aborted" } };
  const first = validateSource(source, opts.config);
  if (first.ok) return { ok: true, source, tier: undefined, fixes: [], attempts: [], unchanged: true, lossy: false };
  let lastError: PeleErrorLike = first.error;

  const candidates = lintCandidates(source, lastError);
  const nonLossy = candidates.filter((c) => !c.lossy);
  let jevPool: RepairCandidate[] = [];
  let jevLossyPick: RepairCandidate | undefined;

  const accept = (cand: RepairCandidate, tier: RepairTier): RepairResult => ({
    ok: true, source: preserveDirectives(source, cand.source), tier, fixes: cand.fixes, attempts,
    lossy: cand.lossy, ...(cand.dropped && cand.dropped.length ? { dropped: cand.dropped } : {}),
  });

  if (tiers.includes("linter")) {
    if (candidates.length === 0) {
      attempts.push({ tier: "linter", ok: false, detail: "no valid linter candidates", candidates: 0, error: lastError });
    } else {
      const first = nonLossy[0];
      const uniqueNonLossy = first !== undefined && (nonLossy.length === 1 || (nonLossy[1]).cost > first.cost);
      if (uniqueNonLossy) {
        attempts.push({ tier: "linter", ok: true, detail: `accepted unique cheapest non-lossy candidate at cost ${first.cost} (of ${candidates.length})`, candidates: candidates.length });
        return accept(first, "linter");
      }
      if (!tiers.includes("jev") && !tiers.includes("llm")) {
        // linter-only: prefer a tied non-lossy candidate, else the cheapest lossy (flagged)
        const pick = first ?? (candidates[0]);
        attempts.push({ tier: "linter", ok: true, detail: pick.lossy ? `linter-only fallback: accepted cheapest lossy candidate at cost ${pick.cost}` : `linter-only: accepted tied non-lossy candidate at cost ${pick.cost}`, candidates: candidates.length });
        return accept(pick, "linter");
      }
      jevPool = candidates.slice(0, maxCand);
      attempts.push({ tier: "linter", ok: false, detail: nonLossy.length === 0 ? `only lossy candidate(s) available (${candidates.length}); escalating` : `non-lossy candidates tie at cost ${first?.cost}; escalating`, candidates: candidates.length });
    }
  } else if (tiers.includes("jev")) {
    jevPool = candidates.slice(0, maxCand);
  }

  if (tiers.includes("jev")) {
    if (aborted(opts.signal)) return { ok: false, fixes: [], attempts, error: { message: "aborted" } };
    if (!opts.jev) {
      attempts.push({ tier: "jev", ok: false, detail: "jev tier enabled but no provider configured", candidates: jevPool.length });
    } else if (jevPool.length === 0) {
      attempts.push({ tier: "jev", ok: false, detail: "no candidates to rank", candidates: 0 });
    } else {
      const describe = (c: RepairCandidate) => `${c.fixes.join("; ")} (cost ${c.cost})${c.lossy ? ` [lossy: ${c.dropped?.join("; ") ?? "removes content"}]` : ""}`;
      const options: Record<string, string> = {};
      jevPool.forEach((c, i) => { options[`c${i + 1}`] = `${describe(c)}\n${diffLines(source, c.source)}`; });
      options["none"] = "none preserves the author's intent";
      const state = `Broken Mermaid diagram:\n${source}\n\nPele error (${lastError.code ?? "error"} at line ${lastError.line ?? "?"}:${lastError.column ?? "?"}): ${lastError.message}\n\nCandidates:\n${jevPool.map((c, i) => `--- c${i + 1}: ${describe(c)}\n${diffLines(source, c.source)}`).join("\n")}`;
      const question = "Which single repair best preserves the author's intent while making the diagram valid? Prefer non-lossy repairs; choose a lossy one only if no non-lossy repair preserves intent. Choose none if no candidate preserves intent.";
      try {
        const choice = await opts.jev.choose(state, question, options);
        const detail = `choice=${choice.choice} confidence=${choice.confidence} probabilities=${JSON.stringify(choice.probabilities)}`;
        const winner = choice.choice !== "none" ? jevPool[Number(choice.choice.slice(1)) - 1] : undefined;
        if (winner && choice.confidence >= jevMin && !winner.lossy) {
          attempts.push({ tier: "jev", ok: true, detail, candidates: jevPool.length });
          return accept(winner, "jev");
        }
        if (winner && choice.confidence >= jevMin && winner.lossy) {
          if (!tiers.includes("llm")) {
            attempts.push({ tier: "jev", ok: true, detail: `${detail}; accepted jev's lossy pick (no llm tier)`, candidates: jevPool.length });
            return accept(winner, "jev");
          }
          jevLossyPick = winner;
          attempts.push({ tier: "jev", ok: false, detail: `${detail}; jev picked a lossy candidate — trying llm first`, candidates: jevPool.length });
        } else {
          attempts.push({ tier: "jev", ok: false, detail: `${detail}; abstained/escalating (min confidence ${jevMin})`, candidates: jevPool.length });
        }
      } catch (err) {
        if (aborted(opts.signal)) return { ok: false, fixes: [], attempts, error: { message: "aborted" } };
        attempts.push({ tier: "jev", ok: false, detail: `jev provider failed: ${(err as Error).message}`, candidates: jevPool.length, error: toErrorLike(err) });
      }
    }
  }

  if (tiers.includes("llm")) {
    if (!opts.llm) {
      attempts.push({ tier: "llm", ok: false, detail: "llm tier enabled but no provider configured" });
    } else {
      const system = "You repair Mermaid 12.1.0 diagram source for the Pele renderer. Make minimal edits, preserve ids, labels, structure and intent. Output ONLY the diagram source, no explanation, no fences.";
      let tried = attempts.filter((a) => a.tier === "linter").map((a) => a.detail).join("; ") || "none";
      for (let n = 1; n <= maxAttempts; n++) {
        if (aborted(opts.signal)) return { ok: false, fixes: [], attempts, error: { message: "aborted" } };
        const numbered = source.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
        const user = `Repair this diagram.\n\nSource (with line numbers):\n${numbered}\n\nPele error: code=${lastError.code ?? "unknown"} line=${lastError.line ?? "?"} col=${lastError.column ?? "?"} snippet=${lastError.snippet ?? ""}\n${lastError.message}\n\nLinter tried: ${tried}\nLinter candidates: ${candidates.length}. Output ONLY the repaired diagram source.`;
        try {
          const reply = await opts.llm.complete(system, user, opts.signal);
          const extracted = extractDiagramFromLlm(reply);
          const v = validateSource(extracted, opts.config);
          if (v.ok) {
            attempts.push({ tier: "llm", ok: true, detail: `attempt ${n}: valid ${v.type} diagram` });
            return { ok: true, source: preserveDirectives(source, extracted), tier: "llm", fixes: [`llm repair (attempt ${n})`], attempts, lossy: false };
          }
          lastError = v.error;
          tried = `llm attempt ${n} still invalid: ${v.error.message.split("\n")[0]}`;
          attempts.push({ tier: "llm", ok: false, detail: `attempt ${n}: still invalid: ${v.error.message.split("\n")[0]}`, error: v.error });
        } catch (err) {
          if (aborted(opts.signal)) return { ok: false, fixes: [], attempts, error: { message: "aborted" } };
          attempts.push({ tier: "llm", ok: false, detail: `attempt ${n}: provider failed: ${(err as Error).message}`, error: toErrorLike(err) });
          break;
        }
      }
    }
  }

  // Final fallback: Jev's lossy pick, else a tied non-lossy candidate, else cheapest lossy.
  const fallback = jevLossyPick ?? (tiers.includes("linter") ? (nonLossy[0] ?? candidates[0]) : undefined);
  if (fallback) {
    attempts.push({ tier: jevLossyPick ? "jev" : "linter", ok: true, detail: `final fallback: accepted ${fallback.lossy ? "lossy" : "non-lossy"} candidate at cost ${fallback.cost}`, candidates: candidates.length });
    return accept(fallback, jevLossyPick ? "jev" : "linter");
  }

  return { ok: false, fixes: [], attempts, error: lastError };
}
