/**
 * `%% pele-view … %%` — views attached to diagram nodes (pure).
 *
 *   %% pele-view A=localgraph depth=1; A=backlink; B=graph search="tag:#x" %%
 *
 * Entries are separated by `;`; a node may repeat (each entry is one more
 * attached view, shown in order). Each entry is `ID=TYPE key=value…` or
 * `ID=view:TYPE?key=value&…` (the label syntax). Values are bare tokens or
 * double-quoted (`\"` and `\\` escapes); a value starting with `{` runs to
 * its matching `}` (JSON for `state=`). Several directive lines are merged.
 * Like `%% pele-size %%`, it is a Mermaid comment: Pele ignores it, and the
 * block tools (repair, reflow, materialise, canvas conversion) keep it.
 */
import { canonicalViewType, isSpecError, parseStateJson, parseViewText, type SpecError, type ViewNodeSpec } from "./syntax";

export interface AttachedView {
  /** Diagram node id, as written. */
  node: string;
  spec: ViewNodeSpec;
}

export interface DirectiveParse {
  views: AttachedView[];
  /** Entries that did not parse, with the reason (shown in the panel). */
  errors: { entry: string; error: string }[];
}

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
      if (c === "\\" && i + 1 < body.length) {
        cur += body[++i];
      } else if (c === '"') quote = false;
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

/** Tokenise `key=value key="v w" key={…} flag`. */
export function tokenizeParams(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    let key = "";
    while (i < n && !/[\s=]/.test(text[i])) key += text[i++];
    let value = "true";
    if (text[i] === "=") {
      i++;
      if (text[i] === '"') {
        i++;
        value = "";
        while (i < n && text[i] !== '"') {
          if (text[i] === "\\" && i + 1 < n) i++;
          value += text[i++];
        }
        i++; // closing quote
      } else if (text[i] === "{") {
        const start = i;
        let depth = 0;
        let q = false;
        for (; i < n; i++) {
          const c = text[i];
          if (q) {
            if (c === "\\") i++;
            else if (c === '"') q = false;
            continue;
          }
          if (c === '"') q = true;
          else if (c === "{") depth++;
          else if (c === "}" && --depth === 0) {
            i++;
            break;
          }
        }
        value = text.slice(start, i);
      } else {
        value = "";
        while (i < n && !/\s/.test(text[i])) value += text[i++];
      }
    }
    if (key) out.push({ key: key.toLowerCase(), value });
  }
  return out;
}

/** One entry's view spec (`localgraph depth=1` or `view:localgraph?depth=1`). */
export function parseEntrySpec(text: string): ViewNodeSpec | SpecError {
  const t = text.trim();
  if (!t) return { error: "missing view type" };
  if (t.toLowerCase().startsWith("view:")) return parseViewText(t);
  const sp = t.search(/\s/);
  const name = sp < 0 ? t : t.slice(0, sp);
  if (!/^[\w.:-]+$/.test(name)) return { error: `"${name}" is not a valid view type` };
  const params: Record<string, string> = {};
  let state: Record<string, unknown> | undefined;
  for (const { key, value } of tokenizeParams(sp < 0 ? "" : t.slice(sp + 1))) {
    if (key === "state") {
      const parsed = parseStateJson(value);
      if (!parsed.ok) return { error: parsed.error };
      state = parsed.value;
    } else params[key] = value;
  }
  return state ? { kind: "view", type: canonicalViewType(name), params, state } : { kind: "view", type: canonicalViewType(name), params };
}

/** All attached views of a block, in source order. */
export function parseViewDirective(source: string): DirectiveParse {
  const views: AttachedView[] = [];
  const errors: DirectiveParse["errors"] = [];
  for (const m of source.matchAll(LINE_RE)) {
    for (const entry of splitEntries(m[1] ?? "")) {
      const eq = entry.indexOf("=");
      const node = eq > 0 ? entry.slice(0, eq).trim() : "";
      if (!node || !/^[^\s=;]+$/.test(node)) {
        errors.push({ entry, error: "expected NODE=view" });
        continue;
      }
      const spec = parseEntrySpec(entry.slice(eq + 1));
      if (isSpecError(spec)) errors.push({ entry, error: spec.error });
      else views.push({ node, spec });
    }
  }
  return { views, errors };
}

/** Attached views of one node, in order. */
export function viewsForNode(source: string, node: string): ViewNodeSpec[] {
  return parseViewDirective(source).views.filter((v) => v.node === node).map((v) => v.spec);
}

export function hasViewDirective(source: string): boolean {
  LINE_RE.lastIndex = 0;
  const hit = LINE_RE.test(source);
  LINE_RE.lastIndex = 0;
  return hit;
}

function quoteValue(v: string): string {
  if (v === "") return '""';
  if (/^\{[\s\S]*\}$/.test(v)) {
    try {
      JSON.parse(v);
      return v;
    } catch {
      /* quote it */
    }
  }
  return /[\s;"\\%]/.test(v) || v.includes("%%") ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}

/** `localgraph depth=1` for one spec. */
export function formatEntrySpec(spec: ViewNodeSpec): string {
  const parts = [spec.type];
  for (const k of Object.keys(spec.params)) {
    const v = spec.params[k];
    parts.push(v === "true" ? k : `${k}=${quoteValue(v)}`);
  }
  if (spec.state) parts.push(`state=${JSON.stringify(spec.state)}`);
  return parts.join(" ");
}

/** The directive line for these views ("" when none). */
export function formatViewDirective(views: AttachedView[]): string {
  if (views.length === 0) return "";
  return `%% pele-view ${views.map((v) => `${v.node}=${formatEntrySpec(v.spec)}`).join("; ")} %%`;
}

/**
 * Replace the block's directive(s) with one line for `views` (the first
 * directive's position; else appended as the last line). Lines that did not
 * parse are kept only when nothing replaces them.
 */
export function setViewDirective(source: string, views: AttachedView[]): string {
  const line = formatViewDirective(views);
  const lines = source.split("\n");
  const idx: number[] = [];
  lines.forEach((l, i) => {
    if (/^[ \t]*%%[ \t]*pele-view\b.*%%[ \t]*$/.test(l)) idx.push(i);
  });
  if (idx.length) {
    const indent = /^[ \t]*/.exec(lines[idx[0]])![0];
    const out = lines.filter((_, i) => !idx.slice(1).includes(i));
    if (line) out[idx[0]] = indent + line;
    else out.splice(idx[0], 1);
    return out.join("\n");
  }
  if (!line) return source;
  const trailing = source.endsWith("\n");
  const body = trailing ? source.slice(0, -1) : source;
  return `${body}\n${line}${trailing ? "\n" : ""}`;
}

/** Drop entries whose node no longer exists. Unchanged source when nothing is stale. */
export function pruneViewDirective(source: string, nodeIds: ReadonlySet<string>): { source: string; removed: string[] } {
  const { views, errors } = parseViewDirective(source);
  const removed = views.filter((v) => !nodeIds.has(v.node)).map((v) => v.node);
  if (removed.length === 0 || errors.length > 0) return { source, removed: errors.length ? [] : removed };
  return { source: setViewDirective(source, views.filter((v) => nodeIds.has(v.node))), removed };
}
