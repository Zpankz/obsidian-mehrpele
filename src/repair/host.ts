/** Repair: provider construction, 1-click repair and the connection tests. */
import {
  Notice,
  requestUrl
} from "obsidian";
import { DiagramFrame } from "../diagram-frame";
import {
  createAnthropicProvider,
  createJevHttpProvider,
  createOpenAICompatibleProvider, repairDiagram, type JevProvider,
  type LlmProvider,
  type RepairResult
} from "pele-render/repair";
import { makeFetchLike } from "./fetch";
import { repairNeedsReview, repairOptions, toRepairOptions, type RepairSettings } from "../repair-settings";
import { applyRepairResult, confirmRepair, type RepairTarget } from "./apply";
import type PeleMermaidPlugin from "../../main";
import { MehrpeleShell } from "../mehrpele/shell";

/** A frame or Mehrpele shell offering 1-click repair. */
interface OneClickTarget extends RepairTarget {
  readonly isRepairBusy: boolean;
  readonly canApplyRepair: boolean;
  setRepairBusy(busy: boolean): void;
}

/** Run the configured tiers on `target` behind its busy state, then hand the result to `onResult`. */
function runOneClickRepair(
  plugin: PeleMermaidPlugin,
  target: OneClickTarget,
  onResult: (result: RepairResult) => Promise<void>,
): void {
  if (target.isRepairBusy) return;
  if (!target.canApplyRepair) {
    new Notice("Pele: repair can't write back here. Canvas and embeds are read-only; open the note to repair.");
    return;
  }
  target.setRepairBusy(true);
  // Yield so the spinner paints before any synchronous linter work.
  window.setTimeout(() => {
    void (async () => {
      try {
        const result = await repairDiagram(
          target.source,
          toRepairOptions(repairOptions(plugin.settings), {
            jev: buildJevProvider(plugin),
            llm: buildLlmProvider(plugin),
          }),
        );
        await onResult(result);
      } catch (e) {
        new Notice(`Pele: repair failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        target.setRepairBusy(false);
      }
    })();
  }, 0);
}

/** 1-click repair for a Mehrpele shell (same tiers/apply contract as frames). */
export async function repairShell(plugin: PeleMermaidPlugin, shell: MehrpeleShell): Promise<void> {
  runOneClickRepair(plugin, shell, async (result) => {
    const applied = await applyRepairResult(plugin, shell, result);
    if (applied) new Notice(`${applied.summary}. Cmd/Ctrl+Z to undo in Live Preview.`, 8000);
  });
}

/** Provider fetch over Obsidian's requestUrl (CORS-free; non-2xx statuses come back, not thrown). */
export function repairFetch() {
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
    fetch: repairFetch(),
  });
}

export function buildLlmProvider(plugin: PeleMermaidPlugin, r: RepairSettings = repairOptions(plugin.settings)): LlmProvider | undefined {
  if (!r.tierLlm) return undefined;
  if (r.llmProvider === "anthropic") {
    const key = secret(plugin, r.anthropicKeySecretId);
    if (!key) return undefined;
    return createAnthropicProvider({ apiKey: key, model: r.llmModel, fetch: repairFetch() });
  }
  const key = secret(plugin, r.openaiKeySecretId);
  return createOpenAICompatibleProvider({
    baseUrl: r.llmBaseUrl || "https://api.openai.com/v1",
    model: r.llmModel,
    ...(key ? { apiKey: key } : {}),
    fetch: repairFetch(),
    reasoningEffort: r.llmReasoningEffort,
    timeoutMs: Math.max(1, r.llmTimeoutSec || 120) * 1000,
  });
}

/** 1-click repair entry (frame button, context of a live frame). */
export async function repairFrame(plugin: PeleMermaidPlugin, frame: DiagramFrame): Promise<void> {
  runOneClickRepair(plugin, frame, (result) => handleRepairResult(plugin, frame, result));
}

export async function handleRepairResult(plugin: PeleMermaidPlugin, frame: DiagramFrame, result: RepairResult): Promise<void> {
  const applied = await applyRepairResult(plugin, frame, result);
  if (!applied) return;
  const inLp = !!frame.root.closest(".cm-preview-code-block");
  if (inLp) {
    new Notice(`${applied.summary}. Cmd/Ctrl+Z to undo.`, 8000);
  } else {
    const notice = new Notice(applied.summary, 10_000);
    try {
      const btn = notice.messageEl.createEl("button", { text: "Undo", cls: "pele-notice-undo" });
      btn.addEventListener("click", () => {
        void frame.applyRepairSwap(applied.oldSource, result.source!).then((ok) => {
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
