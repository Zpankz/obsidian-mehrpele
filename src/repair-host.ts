/** Repair: provider construction, 1-click repair and the connection tests. */
import {
  Notice,
  requestUrl
} from "obsidian";
import { DiagramFrame } from "./diagram-frame";
import {
  createAnthropicProvider,
  createJevHttpProvider,
  createOpenAICompatibleProvider, repairDiagram, type JevProvider,
  type LlmProvider,
  type RepairResult
} from "pele-render/repair";
import { makeFetchLike } from "./repair-fetch";
import { repairNeedsReview, repairOptions, toRepairOptions, type RepairSettings } from "./repair-settings";
import type PeleMermaidPlugin from "../main";
import { MehrpeleShell } from "./mehrpele/shell";
import { RepairPreviewModal, RepairFailureModal } from "./repair-modals";

/** 1-click repair for a Mehrpele shell (same tiers/apply contract as frames). */
export async function repairShell(plugin: PeleMermaidPlugin, shell: MehrpeleShell): Promise<void> {
  if (shell.isRepairBusy) return;
  if (!shell.canApplyRepair) {
    new Notice("Pele: repair can't write back here. Canvas and embeds are read-only; open the note to repair.");
    return;
  }
  shell.setRepairBusy(true);
  window.setTimeout(() => {
    void (async () => {
      try {
        const result = await repairDiagram(
          shell.source,
          toRepairOptions(repairOptions(plugin.settings), {
            jev: buildJevProvider(plugin),
            llm: buildLlmProvider(plugin),
          }),
        );
        if (!result.ok || !result.source) {
          const tiersRan = result.attempts.map((a) => a.tier).join(" → ") || "none";
          new RepairFailureModal(
            plugin.app,
            result.error?.message ?? "no tier could fix this diagram",
            tiersRan,
            shell.source,
          ).open();
          return;
        }
        if (result.unchanged || result.source === shell.source) {
          new Notice("Pele: diagram is already valid.");
          return;
        }
        if (repairNeedsReview(result, repairOptions(plugin.settings))) {
          if (!(await confirmRepair(plugin, shell.source, result))) return;
        }
        const applied = await shell.applyRepaired(result.source);
        if (!applied) {
          new Notice("Pele: could not locate that diagram to apply the repair; nothing changed.");
          return;
        }
        const droppedNote = result.lossy
          ? ` (lossy): removed/commented ${result.dropped && result.dropped.length > 0 ? result.dropped.join(", ") : "content"}`
          : "";
        const fixes = (result.fixes.length > 0 ? result.fixes.join("; ") : "fixed") + droppedNote;
        new Notice(`Repaired by ${result.tier ?? "linter"}: ${fixes}. Cmd/Ctrl+Z to undo in Live Preview.`, 8000);
      } catch (e) {
        new Notice(`Pele: repair failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        shell.setRepairBusy(false);
      }
    })();
  }, 0);
}

export function repairFetch(plugin: PeleMermaidPlugin) {
  return makeFetchLike(async (req) => {
    const r = await requestUrl({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body,
      throw: false,
    });
    return { status: r.status, json: r.json, text: r.text };
  });
}

export function secret(plugin: PeleMermaidPlugin, id: string): string | null {
  try {
    return plugin.app.secretStorage.getSecret(id);
  } catch {
    return null;
  }
}

export function buildJevProvider(plugin: PeleMermaidPlugin, r: RepairSettings = repairOptions(plugin.settings)): JevProvider | undefined {
  if (!r.tierJev) return undefined;
  const key = secret(plugin, r.jevKeySecretId);
  if (!key) return undefined;
  return createJevHttpProvider({
    apiKey: key,
    baseUrl: r.jevBaseUrl,
    model: r.jevModel,
    fetch: repairFetch(plugin),
  });
}

export function buildLlmProvider(plugin: PeleMermaidPlugin, r: RepairSettings = repairOptions(plugin.settings)): LlmProvider | undefined {
  if (!r.tierLlm) return undefined;
  if (r.llmProvider === "anthropic") {
    const key = secret(plugin, r.anthropicKeySecretId);
    if (!key) return undefined;
    return createAnthropicProvider({ apiKey: key, model: r.llmModel, fetch: repairFetch(plugin) });
  }
  const key = secret(plugin, r.openaiKeySecretId);
  return createOpenAICompatibleProvider({
    baseUrl: r.llmBaseUrl || "https://api.openai.com/v1",
    model: r.llmModel,
    ...(key ? { apiKey: key } : {}),
    fetch: repairFetch(plugin),
    reasoningEffort: r.llmReasoningEffort,
    timeoutMs: Math.max(1, r.llmTimeoutSec || 120) * 1000,
  });
}

/** 1-click repair entry (frame button, context of a live frame). */
export async function repairFrame(plugin: PeleMermaidPlugin, frame: DiagramFrame): Promise<void> {
  if (frame.isRepairBusy) return;
  if (!frame.canApplyRepair) {
    new Notice("Pele: repair can't write back here. Canvas and embeds are read-only; open the note to repair.");
    return;
  }
  frame.setRepairBusy(true);
  // Yield so the spinner paints before any synchronous linter work.
  window.setTimeout(() => {
    void (async () => {
      try {
        const result = await repairDiagram(
          frame.source,
          toRepairOptions(repairOptions(plugin.settings), {
            jev: buildJevProvider(plugin),
            llm: buildLlmProvider(plugin),
          }),
        );
        await handleRepairResult(plugin, frame, result);
      } catch (e) {
        new Notice(`Pele: repair failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        frame.setRepairBusy(false);
      }
    })();
  }, 0);
}

export async function handleRepairResult(plugin: PeleMermaidPlugin, frame: DiagramFrame, result: RepairResult): Promise<void> {
  const tiersRan = result.attempts.map((a) => a.tier).join(" → ") || "none";
  if (!result.ok || !result.source) {
    const msg = result.error?.message ?? "no tier could fix this diagram";
    new RepairFailureModal(plugin.app, msg, tiersRan, frame.source).open();
    return;
  }
  if (result.unchanged || result.source === frame.source) {
    new Notice("Pele: diagram is already valid.");
    return;
  }
  // Lossy repairs (content removed/commented out) and Jev/LLM results always
  // require the confirm modal, even when "Preview before applying" is off.
  if (repairNeedsReview(result, repairOptions(plugin.settings))) {
    if (!(await confirmRepair(plugin, frame.source, result))) return;
  }
  const oldSource = frame.source;
  const applied = await frame.applyRepaired(result.source);
  if (!applied) {
    new Notice("Pele: could not locate that diagram to apply the repair; nothing changed.");
    return;
  }
  const droppedNote = result.lossy
    ? ` (lossy): removed/commented ${result.dropped && result.dropped.length > 0 ? result.dropped.join(", ") : "content"}`
    : "";
  const fixes = (result.fixes.length > 0 ? result.fixes.join("; ") : "fixed") + droppedNote;
  const inLp = !!frame.root.closest(".cm-preview-code-block");
  if (inLp) {
    new Notice(`Repaired by ${result.tier ?? "linter"}: ${fixes}. Cmd/Ctrl+Z to undo.`, 8000);
  } else {
    const notice = new Notice(`Repaired by ${result.tier ?? "linter"}: ${fixes}`, 10_000);
    try {
      const btn = notice.messageEl.createEl("button", { text: "Undo", cls: "pele-notice-undo" });
      btn.addEventListener("click", () => {
        void frame.applyRepairSwap(oldSource, result.source!).then((ok) => {
          new Notice(ok ? "Pele: repair undone." : "Pele: undo failed (diagram changed).");
          notice.hide();
        });
      });
    } catch {
      /* notice DOM unavailable */
    }
  }
}

export async function testJevConnection(plugin: PeleMermaidPlugin): Promise<void> {
  const provider = buildJevProvider(plugin, { ...repairOptions(plugin.settings), tierJev: true });
  if (!provider) {
    new Notice("Pele: Jev is not configured (missing API key?).");
    return;
  }
  const started = Date.now();
  try {
    const choice = await provider.choose(
      "On a clear day, the sky appears blue.",
      "Is the statement true?",
      { yes: "The statement is true", no: "The statement is false" },
    );
    new Notice(
      `Pele: Jev OK — chose "${choice.choice}" (confidence ${choice.confidence.toFixed(2)}) in ${Date.now() - started} ms.`,
      8000,
    );
  } catch (e) {
    new Notice(`Pele: Jev test failed: ${e instanceof Error ? e.message : String(e)}`, 8000);
  }
}

export async function testLlmConnection(plugin: PeleMermaidPlugin): Promise<void> {
  const provider = buildLlmProvider(plugin, { ...repairOptions(plugin.settings), tierLlm: true });
  if (!provider) {
    new Notice("Pele: LLM is not configured (missing key?).");
    return;
  }
  const started = Date.now();
  try {
    const reply = await provider.complete("You are a connection test.", "Reply with exactly: OK");
    new Notice(`Pele: LLM OK in ${Date.now() - started} ms — "${reply.trim().slice(0, 40)}"`, 8000);
  } catch (e) {
    new Notice(`Pele: LLM test failed: ${e instanceof Error ? e.message : String(e)}`, 8000);
  }
}

export async function fetchOllamaModels(plugin: PeleMermaidPlugin): Promise<void> {
  try {
    const r = await requestUrl({ url: "http://localhost:11434/api/tags", throw: false });
    const models = (r.json as { models?: { name: string }[] } | null)?.models ?? [];
    plugin.ollamaModels = models.map((m) => m.name).filter(Boolean);
    if (plugin.ollamaModels.length === 0) new Notice("Pele: Ollama answered but lists no models.");
    else {
      const llm = plugin.settings.llm;
      if (!llm.model || llm.model.startsWith("claude")) {
        llm.model = plugin.ollamaModels[0]!;
        await plugin.saveSettings();
      }
      new Notice(`Pele: Ollama models: ${plugin.ollamaModels.slice(0, 8).join(", ")}`, 8000);
    }
  } catch {
    new Notice("Pele: Ollama is unreachable at localhost:11434.");
  }
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

/** Repair a source string with caller-provided apply (commands). */
export async function repairAndApply(
  plugin: PeleMermaidPlugin,
  lang: string,
  source: string,
  apply: (newSource: string) => Promise<boolean>,
): Promise<"repaired" | "valid" | "failed" | "cancelled"> {
  const check = plugin.validateDiagram(lang, source);
  if (check.ok) return "valid";
  const result = await repairDiagram(
    source,
    toRepairOptions(repairOptions(plugin.settings), {
      jev: buildJevProvider(plugin),
      llm: buildLlmProvider(plugin),
    }),
  );
  if (!result.ok || !result.source || result.source === source) return "failed";
  if (repairNeedsReview(result, repairOptions(plugin.settings)) && !(await confirmRepair(plugin, source, result))) {
    return "cancelled";
  }
  return (await apply(result.source)) ? "repaired" : "failed";
}
