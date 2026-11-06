import type { FetchLike, JevProvider, LlmProvider } from "./types.js";

async function readJson(res: { status: number; json(): Promise<unknown>; text(): Promise<string> }): Promise<unknown> {
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export function createJevHttpProvider(o: { apiKey: string; baseUrl?: string; model?: string; fetch: FetchLike }): JevProvider {
  if (!o?.apiKey) throw new TypeError("createJevHttpProvider: apiKey is required");
  if (!o?.fetch) throw new TypeError("createJevHttpProvider: fetch is required");
  const base = (o.baseUrl ?? "https://api.typesafe.ai").replace(/\/$/, "");
  const model = o.model ?? "jev-latest";
  return {
    async choose(state, question, options) {
      const res = await o.fetch(`${base}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify({ state, model, questions: { repair: { type: "choice", instructions: question, criteria: options } } }),
      });
      const data = (await readJson(res)) as { answers?: { repair?: { choice?: string; confidence?: number; probabilities?: Record<string, number> } } };
      const ans = data.answers?.repair;
      if (!ans || typeof ans.choice !== "string") throw new Error("jev: unexpected response shape (missing answers.repair)");
      return { choice: ans.choice, confidence: ans.confidence ?? 0, probabilities: ans.probabilities ?? {} };
    },
  };
}

export function createAnthropicProvider(o: { apiKey: string; model?: string; baseUrl?: string; fetch: FetchLike; maxTokens?: number }): LlmProvider {
  if (!o?.apiKey) throw new TypeError("createAnthropicProvider: apiKey is required");
  if (!o?.fetch) throw new TypeError("createAnthropicProvider: fetch is required");
  const base = (o.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const model = o.model ?? "claude-sonnet-5-5";
  return {
    async complete(system, user, signal) {
      const res = await o.fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": o.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: o.maxTokens ?? 4096, system, messages: [{ role: "user", content: user }] }),
        signal,
      });
      const data = (await readJson(res)) as { content?: { type?: string; text?: string }[] };
      const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      if (!text) throw new Error("anthropic: empty response");
      return text;
    },
  };
}

export function createOpenAICompatibleProvider(o: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetch: FetchLike;
  /** `reasoning_effort` for reasoning models (e.g. "none" makes Ollama qwen3.5 answer in ~1s instead of ~2min); omit/"default" to leave unset. */
  reasoningEffort?: string;
  /** Abort a single request after this many ms (default: no limit). */
  timeoutMs?: number;
}): LlmProvider {
  if (!o?.baseUrl) throw new TypeError("createOpenAICompatibleProvider: baseUrl is required");
  if (!o?.model) throw new TypeError("createOpenAICompatibleProvider: model is required");
  if (!o?.fetch) throw new TypeError("createOpenAICompatibleProvider: fetch is required");
  const base = o.baseUrl.replace(/\/$/, "");
  return {
    async complete(system, user, signal) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (o.apiKey) headers["authorization"] = `Bearer ${o.apiKey}`;
      const body: Record<string, unknown> = { model: o.model, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
      if (o.reasoningEffort && o.reasoningEffort !== "default") body.reasoning_effort = o.reasoningEffort;
      const { signal: merged, dispose } = withTimeout(signal, o.timeoutMs);
      try {
        const res = await o.fetch(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: merged });
        const data = (await readJson(res)) as { choices?: { message?: { content?: string } }[] };
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error("openai-compatible: empty response");
        return text;
      } catch (e) {
        if (merged?.aborted && !signal?.aborted) throw new Error(`openai-compatible: no response within ${Math.round((o.timeoutMs ?? 0) / 1000)}s`);
        throw e;
      } finally {
        dispose();
      }
    },
  };
}

/** Combine an optional caller signal with an optional timeout. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal | undefined; dispose: () => void } {
  if (!timeoutMs || timeoutMs <= 0) return { signal, dispose: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}
