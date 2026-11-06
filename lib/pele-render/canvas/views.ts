/**
 * `%% pele-view A=localgraph depth=1; A=backlink %%` (pele-mermaid view
 * nodes: views attached to diagram nodes) across canvas round trips. Each
 * card keeps its node's entries (`peleViews`, the text after `ID=`), so the
 * directive is rebuilt with the ids the diagram has after conversion. Pure;
 * the entry grammar itself belongs to pele-mermaid (src/mehrpele/views).
 */
import { pushTo } from "./util.js";

const LINE_RE = /^[ \t]*%%[ \t]*pele-view\b(.*?)%%[ \t]*$/gm;

/** Split on `;` outside quotes and braces. */
function splitEntries(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = false;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === "\\" && i + 1 < body.length) cur += body[++i];
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') quote = true;
    else if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    if (c === ";" && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Node id → its attached view entries, in source order. */
export function parseViewEntries(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of source.matchAll(LINE_RE)) {
    for (const entry of splitEntries(m[1] ?? "")) {
      const eq = entry.indexOf("=");
      const node = eq > 0 ? entry.slice(0, eq).trim() : "";
      const spec = eq > 0 ? entry.slice(eq + 1).trim() : "";
      // Same node-id rule as pele-mermaid's directive parser.
      if (!node || !spec || !/^[^\s=;]+$/.test(node)) continue;
      pushTo(out, node, spec);
    }
  }
  return out;
}

/** One directive line for `[nodeId, entry]` pairs ("" when none). */
export function formatViewLine(entries: [string, string][]): string {
  return entries.length ? `%% pele-view ${entries.map(([id, spec]) => `${id}=${spec}`).join("; ")} %%` : "";
}
