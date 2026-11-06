import { formatViewLine, parseViewEntries } from "../canvas/views.js"; // view-nodes
import { hasSizeDirective, nodeSizeCaps, parseSizeDirective, withSizeDirective } from "../node-size/index.js";

const MEHRPELE_LINE_RE = /^[ \t]*%%\s*mehrpele\s*%%[ \t]*$/m;

/**
 * Keep the plugin's comment directives through a repair that rewrote the
 * source (an LLM reply drops comments freely): `%% mehrpele %%` is restored
 * at the top, `%% pele-size … %%` and `%% pele-view … %%` at the end,
 * filtered to nodes that still exist. A repair that kept them is returned
 * unchanged.
 */
export function preserveDirectives(before: string, after: string): string {
  let out = after;
  const mehrpeleLine = MEHRPELE_LINE_RE.exec(before);
  if (mehrpeleLine && !MEHRPELE_LINE_RE.test(out)) out = `${mehrpeleLine[0].trim()}\n${out}`;
  if (hasSizeDirective(before) && !hasSizeDirective(out)) {
    const caps = nodeSizeCaps(out);
    const kept = new Map([...parseSizeDirective(before)].filter(([id]) => !caps || caps.has(id)));
    if (kept.size) out = withSizeDirective(out, kept);
  }
  // view-nodes: `%% pele-view … %%` (views attached to nodes), likewise.
  const views = parseViewEntries(before);
  if (views.size && parseViewEntries(out).size === 0) {
    const caps = nodeSizeCaps(out);
    const line = formatViewLine([...views].filter(([id]) => !caps || caps.has(id)).flatMap(([id, specs]) => specs.map((v): [string, string] => [id, v])));
    if (line) out = `${out.replace(/\n+$/, "")}\n${line}${/\n$/.test(out) ? "\n" : ""}`;
  }
  return out;
}

export function extractDiagramFromLlm(text: string): string {
  if (typeof text !== "string") throw new TypeError("extractDiagramFromLlm: text must be a string");
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  const fence = /```(?:mermaid)?\s*\n([\s\S]*?)```/.exec(s);
  if (fence) return (fence[1]).trim() + "\n";
  s = s.trim();
  // slice from first plausible diagram header line
  const headerRe = /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|pie|gantt|gitGraph|mindmap|timeline|journey|xychart|quadrantChart|requirementDiagram|C4|sankey|block|packet|kanban|architecture|radar|treemap|info|agentflow|usecase|railroad|treeView|venn|cynefin|wardley|swimlane|ishikawa|eventmodeling|%%\{|---)/;
  const lines = s.split("\n");
  const hi = lines.findIndex((l) => headerRe.test(l));
  if (hi > 0) s = lines.slice(hi).join("\n");
  return s.replace(/```\s*$/, "").trim() + "\n";
}

export function playgroundUrl(source: string): string {
  if (typeof source !== "string") throw new TypeError("playgroundUrl: source must be a string");
  if (source.length > 100_000) throw new Error("playgroundUrl: source exceeds 100000 characters");
  return `https://pele.run/playground#${new URLSearchParams({ source }).toString()}`;
}
