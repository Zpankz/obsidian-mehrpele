/**
 * Minimal in-place rewrite of a diagram block so chosen nodes show a note
 * embed: `A[Old]` → `A["![[Folder/A]]"]` (shape kept), a node without a
 * label gets one at its first bare mention, a state's description becomes
 * `Id : "![[…]]"`. Everything else (comments, classDef/style/click lines,
 * subgraph headers, edge labels, quoted text) is left byte-identical. Pure.
 */
import { escapeLabelMarkdown } from "../mehrpele/model";
import type { MaterialiseType } from "./graph";

export const MEHRPELE_DIRECTIVE_LINE = "%% mehrpele %%";

/** `"![[linktext]]"` as a quoted Mehrpele label. */
export function embedLabel(linktext: string): string {
  return `"${escapeLabelMarkdown(`![[${linktext}]]`)}"`;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(source: string, edits: Edit[]): string {
  let out = source;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

const ID_CHAR = /[A-Za-z0-9_]/;
/** Openers longest first, with the closers each accepts. */
const SHAPES: [string, string[]][] = [
  ["(((", [")))"]],
  ["((", ["))"]],
  ["([", ["])"]],
  ["[[", ["]]"]],
  ["[(", [")]"]],
  ["{{", ["}}"]],
  ["[/", ["/]", "\\]"]],
  ["[\\", ["\\]", "/]"]],
  ["(", [")"]],
  ["[", ["]"]],
  ["{", ["}"]],
  [">", ["]"]],
];
/** Flowchart lines that never define nodes. */
const NON_NODE_LINE = /^\s*(?:%%|subgraph\b|end\s*$|classDef\b|class\s|style\s|linkStyle\b|click\s|direction\s|accTitle\b|accDescr\b)/;
const HEADER_LINE = /^\s*(?:flowchart|graph|stateDiagram(?:-v2)?)\b/;

/** End index of the quoted span starting at `i` (index past the closing quote), or -1. */
function quotedEnd(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\" && j + 1 < s.length) {
      j += 2;
      continue;
    }
    if (c === '"') return j + 1;
    j++;
  }
  return -1;
}

/** Line ranges of the body, skipping a leading `---` frontmatter block. */
function bodyLines(source: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  let pos = 0;
  for (const text of source.split("\n")) {
    out.push({ start: pos, end: pos + text.length, text });
    pos += text.length + 1;
  }
  if (out[0]?.text.trim() === "---") {
    const close = out.findIndex((l, i) => i > 0 && l.text.trim() === "---");
    if (close > 0) return out.slice(close + 1);
  }
  return out;
}

/** Inline edge text `-- text -->` / `== text ==>` / `-. text .->` starting at `i`: its end. */
function inlineEdgeTextEnd(s: string, i: number): number {
  const m = /^(?:--|==|-\.)[ \t]+[^\n]*?[ \t]*(?:-->|--[xo]|---|==>|==[xo]|===|\.->|\.-)/.exec(s.slice(i));
  return m ? i + m[0].length : -1;
}

/** Label span of a node shape opened at `i` (after the id), or null. */
function shapeLabelSpan(s: string, i: number, lineEnd: number): { start: number; end: number } | null {
  for (const [open, closers] of SHAPES) {
    if (!s.startsWith(open, i)) continue;
    let j = i + open.length;
    while (j < lineEnd && (s[j] === " " || s[j] === "\t")) j++;
    if (s[j] === '"') {
      const q = quotedEnd(s, j);
      if (q < 0) return null;
      let k = q;
      while (k < lineEnd && (s[k] === " " || s[k] === "\t")) k++;
      if (closers.some((c) => s.startsWith(c, k))) return { start: i + open.length, end: k };
      return null;
    }
    let best = -1;
    for (const c of closers) {
      const at = s.indexOf(c, i + open.length);
      if (at >= 0 && at <= lineEnd && (best < 0 || at < best)) best = at;
    }
    if (best < 0) return null;
    return { start: i + open.length, end: best };
  }
  return null;
}

/** `@{ … }` metadata block at `i`: its label value span (or where to insert one). */
function atBlockLabel(s: string, i: number): { start: number; end: number; insert: boolean } | null {
  if (!s.startsWith("@{", i)) return null;
  let j = i + 2;
  let depth = 1;
  while (j < s.length && depth > 0) {
    if (s[j] === '"') {
      const q = quotedEnd(s, j);
      if (q < 0) return null;
      j = q;
      continue;
    }
    if (s[j] === "{") depth++;
    else if (s[j] === "}") depth--;
    j++;
  }
  if (depth !== 0) return null;
  const inner = s.slice(i + 2, j - 1);
  const m = /(^|[\s,])label\s*:\s*/.exec(inner);
  if (m) {
    const vStart = i + 2 + m.index + m[0].length;
    if (s[vStart] === '"') {
      const q = quotedEnd(s, vStart);
      if (q > 0) return { start: vStart, end: q, insert: false };
    }
    let vEnd = vStart;
    while (vEnd < j - 1 && s[vEnd] !== "," && s[vEnd] !== "}" && s[vEnd] !== "\n") vEnd++;
    return { start: vStart, end: vEnd, insert: false };
  }
  return { start: i + 2, end: i + 2, insert: true };
}

function rewriteFlowchart(source: string, targets: ReadonlyMap<string, string>): string {
  const edits: Edit[] = [];
  const labelled = new Set<string>();
  const firstBare = new Map<string, number>();
  const ids = [...targets.keys()].sort((a, b) => b.length - a.length);
  let headerSeen = false;
  for (const line of bodyLines(source)) {
    if (!headerSeen) {
      if (HEADER_LINE.test(line.text)) headerSeen = true;
      continue;
    }
    if (NON_NODE_LINE.test(line.text)) continue;
    let i = line.start;
    const end = line.end;
    while (i < end) {
      const c = source[i];
      if (c === '"') {
        const q = quotedEnd(source, i);
        i = q < 0 ? end : q;
        continue;
      }
      if (c === "|") {
        // Piped edge label.
        let j = i + 1;
        while (j < end && source[j] !== "|") {
          if (source[j] === '"') {
            const q = quotedEnd(source, j);
            j = q < 0 ? end : q;
          } else j++;
        }
        i = j + 1;
        continue;
      }
      if (c === "%" && source[i + 1] === "%") break; // trailing comment
      if ((c === "-" || c === "=") && (source[i - 1] === " " || source[i - 1] === "\t")) {
        const t = inlineEdgeTextEnd(source, i);
        if (t > 0) {
          i = t;
          continue;
        }
      }
      const prev = source[i - 1] ?? "";
      if (ID_CHAR.test(c) && !ID_CHAR.test(prev) && prev !== ":") {
        // A target id (longest first; ids may contain `-`), else the plain token.
        const id = ids.find((x) => source.startsWith(x, i) && i + x.length <= end && !ID_CHAR.test(source[i + x.length] ?? ""));
        let after = i;
        if (id) after = i + id.length;
        else while (after < end && ID_CHAR.test(source[after])) after++;
        // Any node's shape is skipped whole, so ids inside unquoted labels never match.
        const span = shapeLabelSpan(source, after, end);
        if (span) {
          if (id) {
            edits.push({ start: span.start, end: span.end, text: embedLabel(targets.get(id)!) });
            labelled.add(id);
          }
          i = span.end;
          continue;
        }
        const at = atBlockLabel(source, after);
        if (at) {
          if (id) {
            const embed = embedLabel(targets.get(id)!);
            edits.push(at.insert ? { start: at.start, end: at.end, text: ` label: ${embed},` } : { start: at.start, end: at.end, text: embed });
            labelled.add(id);
          }
          i = at.end;
          continue;
        }
        if (id && !firstBare.has(id)) firstBare.set(id, after);
        i = after;
        continue;
      }
      i++;
    }
  }
  for (const [id, pos] of firstBare) {
    if (labelled.has(id)) continue;
    edits.push({ start: pos, end: pos, text: `[${embedLabel(targets.get(id)!)}]` });
  }
  return applyEdits(source, edits);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteState(source: string, targets: ReadonlyMap<string, string>): string {
  const lines = source.split("\n");
  const drop = new Set<number>();
  const described = new Set<string>();
  const firstMention = new Map<string, number>();
  for (let li = 0; li < lines.length; li++) {
    const text = lines[li];
    if (/^\s*%%/.test(text) || HEADER_LINE.test(text)) continue;
    // `state "Label" as Id` (not a composite) → `state Id`; the description carries the embed.
    const alias = /^(\s*)state\s+"(?:\\.|[^"\\])*"\s+as\s+([A-Za-z0-9_]+)\s*$/.exec(text);
    if (alias && targets.has(alias[2])) {
      lines[li] = `${alias[1]}state ${alias[2]}`;
      // The description goes right under the state's own declaration.
      firstMention.set(alias[2], li);
      continue;
    }
    const desc = /^(\s*)([A-Za-z0-9_]+)\s*:(.*)$/.exec(text);
    if (desc && !text.includes("-->") && targets.has(desc[2])) {
      const id = desc[2];
      if (described.has(id)) drop.add(li);
      else {
        lines[li] = `${desc[1]}${id} : ${embedLabel(targets.get(id)!)}`;
        described.add(id);
      }
      if (!firstMention.has(id)) firstMention.set(id, li);
      continue;
    }
    const blanked = text.replace(/"(?:\\.|[^"\\])*"/g, (m) => " ".repeat(m.length)).replace(/:.*$/, "");
    for (const id of targets.keys()) {
      if (firstMention.has(id)) continue;
      if (new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(id)}(?![A-Za-z0-9_])`).test(blanked)) firstMention.set(id, li);
    }
  }
  const inserts = new Map<number, string[]>();
  for (const [id, li] of firstMention) {
    if (described.has(id)) continue;
    const indent = /^\s*/.exec(lines[li])![0];
    (inserts.get(li) ?? inserts.set(li, []).get(li)!).push(`${indent}${id} : ${embedLabel(targets.get(id)!)}`);
  }
  const out: string[] = [];
  for (let li = 0; li < lines.length; li++) {
    if (!drop.has(li)) out.push(lines[li]);
    for (const extra of inserts.get(li) ?? []) out.push(extra);
  }
  return out.join("\n");
}

/** Insert the `%% mehrpele %%` directive as the first body line (after any `---` frontmatter). */
export function withMehrpeleDirective(source: string): string {
  if (/(^|\n)\s*%%\s*mehrpele\s*%%/.test(source)) return source;
  const lines = source.split("\n");
  let at = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) at = close + 1;
  }
  lines.splice(at, 0, MEHRPELE_DIRECTIVE_LINE);
  return lines.join("\n");
}

/**
 * Rewrite `targets` (node id → embed linktext) in a block body. With
 * `addDirective`, a non-Mehrpele block also gets `%% mehrpele %%` (only
 * when something was rewritten).
 */
export function rewriteBlock(
  source: string,
  type: MaterialiseType,
  targets: ReadonlyMap<string, string>,
  opts: { addDirective: boolean },
): string {
  if (!targets.size) return source;
  const next = type === "state" ? rewriteState(source, targets) : rewriteFlowchart(source, targets);
  if (next === source) return source;
  return opts.addDirective ? withMehrpeleDirective(next) : next;
}
