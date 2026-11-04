/**
 * Node label autocomplete (Cmd/Ctrl-click on a "+"): asks the configured
 * LLM (the repair feature's providers: Anthropic, OpenAI-compatible, Ollama)
 * for a few labels for the node being added. Pure prompt + reply parsing;
 * the provider is injected.
 */
import type { Relation } from "./concept-edit";

export interface CompletionModel {
  complete(system: string, user: string, signal?: AbortSignal): Promise<string>;
}

const SYSTEM =
  "You suggest short labels for a new node in a Mermaid diagram used for concept mapping. " +
  "Reply with a JSON array of 3 to 5 distinct strings, each at most 6 words, no Markdown, no explanations.";

const ROLE: Record<Relation, string> = {
  child: "a child of (follows from / is part of)",
  parent: "a parent of (leads to / contains)",
  "sibling-before": "a sibling of (alongside, same level as)",
  "sibling-after": "a sibling of (alongside, same level as)",
};

export function completionPrompt(source: string, nodeId: string, nodeText: string, relation: Relation | "shared-child", others: string[] = []): string {
  const what =
    relation === "shared-child"
      ? `a node that follows from all of: ${others.map((o) => JSON.stringify(o)).join(", ")}`
      : `${ROLE[relation]} the node ${JSON.stringify(nodeText)} (id ${nodeId})`;
  return `Diagram:\n\`\`\`mermaid\n${source.trim()}\n\`\`\`\n\nSuggest labels for ${what}.`;
}

/**
 * Labels from a model reply: JSON array(s) (one, or one per line), else one
 * label per line with bullets, numbers, brackets and quotes stripped.
 */
export function parseSuggestions(reply: string, max = 5): string[] {
  const text = reply.replace(/```(?:json)?/g, "").trim();
  let items: string[] = [];
  for (const m of text.matchAll(/\[[^[\]]*\]/g)) {
    try {
      const v = JSON.parse(m[0]) as unknown;
      if (Array.isArray(v)) items.push(...v.filter((x): x is string => typeof x === "string"));
    } catch {
      /* not JSON */
    }
  }
  if (!items.length) {
    items = text
      .split("\n")
      // Prose around the list ("Here are some labels:") is not a label.
      .filter((l) => !/:\s*$/.test(l.trim()) && l.trim().split(/\s+/).length <= 8)
      .map((l) =>
      l
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
        .replace(/^[\s["']+|[\s\]"',]+$/g, ""),
    );
  }
  const out: string[] = [];
  for (const raw of items) {
    const s = raw.replace(/\s+/g, " ").trim().slice(0, 80);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export async function suggestLabels(
  model: CompletionModel,
  req: { source: string; nodeId: string; nodeText: string; relation: Relation | "shared-child"; others?: string[] },
  signal?: AbortSignal,
): Promise<string[]> {
  const reply = await model.complete(SYSTEM, completionPrompt(req.source, req.nodeId, req.nodeText, req.relation, req.others ?? []), signal);
  return parseSuggestions(reply);
}
