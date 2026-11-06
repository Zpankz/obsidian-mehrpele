/**
 * `%% pele-size … %%` — per-node box sizes, stored as a Mermaid comment line
 * so mermaid.js (GitHub, Obsidian without the plugin) ignores it.
 *
 *   %% pele-size A=220x96 B=180 C=x120 "Make tea"=160x48 %%
 *
 * Entries are `id=W`, `id=WxH` or `id=xH` in integer SVG units (CSS px at
 * scale 1). Ids are bare when they match BARE_ID, otherwise JSON-quoted.
 * Several lines merge and the last occurrence of an id wins. Writers keep a
 * single line as the last line of the block. Only top-level lines count: a
 * directive inside a quoted (nested-diagram) label belongs to that inner
 * diagram. Pure: no Pele, no DOM.
 */
import { parseId, quoteId } from "../directive/id.js";

export { quoteId };

export interface NodeSize {
  w?: number;
  h?: number;
}

const SIZE_LINE_RE = /^[ \t]*%%[ \t]*pele-size\b.*%%[ \t]*$/;
/** One directive line: group 1 = the entries. */
const SIZE_BODY_RE = /^[ \t]*%%[ \t]*pele-size\b(.*?)%%[ \t]*$/;
/**
 * One directive line (global/multiline): group 1 = the entries.
 * @deprecated Also matches lines inside a nested label, which the parser
 * ignores. Use `parseSizeDirective`, or `topLevelLines` to find lines.
 */
export const SIZE_DIRECTIVE_RE = new RegExp(SIZE_BODY_RE.source, "gm");
const ENTRY_RE = /("(?:[^"\\]|\\.)*"|[^\s=]+)=(\S*)/g;

/** Largest accepted dimension (SVG units). */
export const MAX_NODE_SIZE = 10000;

export interface SizeDirectiveLint {
  sizes: Map<string, NodeSize>;
  /** Entries that could not be read (raw text). */
  malformed: string[];
  /** Number of directive lines. */
  lines: number;
}

function parseValue(raw: string): NodeSize | null {
  const m = /^(\d+)?(?:x(\d+))?$/.exec(raw);
  if (!m || (!m[1] && !m[2])) return null;
  const w = m[1] ? Number(m[1]) : undefined;
  const h = m[2] ? Number(m[2]) : undefined;
  const ok = (v: number | undefined) => v === undefined || (v >= 1 && v <= MAX_NODE_SIZE);
  if (!ok(w) || !ok(h)) return null;
  return { ...(w !== undefined ? { w } : {}), ...(h !== undefined ? { h } : {}) };
}

/**
 * For each line of `source`, whether it starts outside every quoted label.
 * A `"` right after a label opener (`[ ( { | >`, spaces allowed) opens a
 * label; inside one, `\` escapes the next character (Mehrpele's `\"`) and
 * any other `"` closes it. A quote anywhere else (`27" monitor`) is text.
 * A label that never closes is text too: its opening quote is dropped and
 * the source rescanned. Whole-line `%%` comments are skipped, so a stray
 * quote in a comment can't swallow the lines after it.
 */
export function topLevelLines(source: string): boolean[] {
  const lines = source.split("\n");
  const ignored = new Set<string>();
  for (;;) {
    const out: boolean[] = [];
    let open: string | null = null;
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n] ?? "";
      out.push(open === null);
      if (open === null && /^[ \t]*%%/.test(line)) continue;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (open !== null) {
          if (c === "\\") i++;
          else if (c === '"') open = null;
        } else if (c === '"' && !ignored.has(`${n}:${i}`) && LABEL_OPENER.test(line.slice(0, i))) {
          open = `${n}:${i}`;
        }
      }
    }
    if (open === null) return out;
    ignored.add(open);
  }
}

/** Text before a `"` that opens a quoted label. */
const LABEL_OPENER = /[[({|>][ \t]*$/;

/** Top-level directive lines (CR stripped). */
function directiveLines(source: string): string[] {
  const outer = topLevelLines(source);
  return source
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l, i) => outer[i] && SIZE_LINE_RE.test(l));
}

/** Every entry of every directive line, with what could not be read. */
export function lintSizeDirective(source: string): SizeDirectiveLint {
  const sizes = new Map<string, NodeSize>();
  const malformed: string[] = [];
  let lines = 0;
  for (const line of directiveLines(source)) {
    const body = SIZE_BODY_RE.exec(line)?.[1] ?? "";
    lines++;
    let rest = body;
    for (const e of body.matchAll(ENTRY_RE)) {
      rest = rest.replace(e[0], "");
      const id = parseId(e[1]);
      const size = parseValue(e[2]);
      if (id === null || size === null) {
        malformed.push(e[0]);
        continue;
      }
      // Last occurrence wins, but keeps the id's first position.
      sizes.set(id, size);
    }
    for (const junk of rest.split(/\s+/).filter(Boolean)) malformed.push(junk);
  }
  return { sizes, malformed, lines };
}

/** Node sizes from every `%% pele-size … %%` line (malformed entries ignored). */
export function parseSizeDirective(source: string): Map<string, NodeSize> {
  return lintSizeDirective(source).sizes;
}

/** Whether the source has a directive line at all. */
export function hasSizeDirective(source: string): boolean {
  return directiveLines(source).length > 0;
}

export function formatSize(size: NodeSize): string {
  const w = size.w !== undefined ? String(Math.round(size.w)) : "";
  const h = size.h !== undefined ? `x${Math.round(size.h)}` : "";
  return w + h;
}

/** The directive line for `sizes`; "" when there is nothing to write. */
export function formatSizeDirective(sizes: Map<string, NodeSize> | Iterable<[string, NodeSize]>): string {
  const entries = [...sizes].filter(([, s]) => s.w !== undefined || s.h !== undefined);
  if (entries.length === 0) return "";
  return `%% pele-size ${entries.map(([id, s]) => `${quoteId(id)}=${formatSize(s)}`).join(" ")} %%`;
}

/** The source without its directive lines (line endings kept). */
export function stripSizeDirective(source: string): string {
  const lines = source.split("\n");
  const outer = topLevelLines(source);
  const kept = lines.filter((l, i) => !(outer[i] && SIZE_LINE_RE.test(l.replace(/\r$/, ""))));
  return kept.length === lines.length ? source : kept.join("\n");
}

/**
 * Replace every directive line with one line for `sizes`, placed last
 * (before trailing blank lines). Removing the last entry removes the line.
 */
export function withSizeDirective(source: string, sizes: Map<string, NodeSize>): string {
  const line = formatSizeDirective(sizes);
  const stripped = stripSizeDirective(source);
  if (!line) return stripped;
  const trailing = /(\r?\n[ \t]*)*$/.exec(stripped)?.[0] ?? "";
  const body = stripped.slice(0, stripped.length - trailing.length);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return `${body}${body ? eol : ""}${line}${trailing}`;
}

export interface WithNodeSizeOptions {
  /** Ids that still exist: other entries are pruned (stale). */
  keep?: (id: string) => boolean;
}

/**
 * Set (or with `null` remove) one node's size. Existing entries keep their
 * place, new ids are appended; entries the `keep` predicate rejects are
 * pruned on the same write.
 */
export function withNodeSize(source: string, id: string, size: NodeSize | null, opts: WithNodeSizeOptions = {}): string {
  const sizes = parseSizeDirective(source);
  const next = new Map<string, NodeSize>();
  for (const [k, v] of sizes) {
    if (k === id) continue;
    if (opts.keep && !opts.keep(k)) continue;
    next.set(k, v);
  }
  const clean = size && (size.w !== undefined || size.h !== undefined) ? normalizeSize(size) : null;
  if (clean) {
    // Keep an existing id's position.
    if (sizes.has(id)) {
      const ordered = new Map<string, NodeSize>();
      for (const [k] of sizes) {
        const kept = k === id ? clean : next.get(k);
        if (kept) ordered.set(k, kept);
      }
      return sameDirective(source, ordered) ? source : withSizeDirective(source, ordered);
    }
    next.set(id, clean);
  }
  return sameDirective(source, next) ? source : withSizeDirective(source, next);
}

/** Drop entries whose id `keep` rejects. Unchanged source when nothing is stale. */
export function pruneNodeSizes(source: string, keep: (id: string) => boolean): string {
  const sizes = parseSizeDirective(source);
  const next = new Map([...sizes].filter(([id]) => keep(id)));
  return next.size === sizes.size ? source : withSizeDirective(source, next);
}

function normalizeSize(s: NodeSize): NodeSize {
  const clamp = (v: number) => Math.min(MAX_NODE_SIZE, Math.max(1, Math.round(v)));
  return { ...(s.w !== undefined ? { w: clamp(s.w) } : {}), ...(s.h !== undefined ? { h: clamp(s.h) } : {}) };
}

/** True when the source already says exactly `sizes` on one well-placed line. */
function sameDirective(source: string, sizes: Map<string, NodeSize>): boolean {
  return withSizeDirective(source, sizes) === source;
}
