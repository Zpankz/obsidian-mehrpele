/**
 * Mehrpele label model — stable contract.
 *
 * Other modules (notably the Advanced Canvas converter) may import ONLY the
 * types and pure functions from this file. Changing the meaning of
 * `anchorId`, `markdown` or `embedTarget` is a breaking change.
 *
 * Identity is the diagram source id, never the label content. `markdown` is
 * byte-identical to the text between the quotes (after `\"` unescaping), so a
 * converter can regenerate the block. Linkpaths are never resolved here.
 */

export type MehrpeleLabelKind = "node" | "edge" | "cluster";

export interface MehrpeleEmbedTarget {
  linkpath: string;
  subpath: string;
  aliasOrSize?: string;
}

export interface MehrpeleLabel {
  /**
   * Pele source node id, exactly as written (e.g. `T1`).
   * Edges: `${start}->${end}#${edgeIndex}`.
   * Subgraph/cluster titles: `subgraph:${id}`.
   */
  anchorId: string;
  kind: MehrpeleLabelKind;
  /** Raw Markdown inside the quotes, verbatim. Empty string = plain label. */
  markdown: string;
  /** Plain-text fallback shown in SVG/export (Markdown stripped to readable text). */
  fallbackText: string;
  /** Character span of the quoted label in the source (includes the quotes). */
  span: { start: number; end: number };
  /** True iff the label is a sole embed: `![[X]]` / `![[X|size]]`. */
  embedTarget?: MehrpeleEmbedTarget;
}

export interface MehrpeleModel {
  /** Source order, duplicates preserved. */
  labels: MehrpeleLabel[];
  /** anchorId → label (last wins, duplicates warned). */
  byAnchor: Map<string, MehrpeleLabel>;
}

export interface MehrpeleLabelSize {
  width: number;
  height: number;
}

/** Escape a Markdown string for inclusion inside a double-quoted diagram label. */
export function escapeLabelMarkdown(markdown: string): string {
  return markdown.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Unescape `\"` and `\\` inside a quoted label. */
export function unescapeLabelMarkdown(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\\" && i + 1 < raw.length && (raw[i + 1] === '"' || raw[i + 1] === "\\")) {
      out += raw[i + 1];
      i++;
    } else {
      out += raw[i];
    }
  }
  return out;
}

const SOLE_EMBED_RE = /^!\[\[([^\]]+)\]\]$/;

/** Parse `![[X]]` / `![[X#sub|size]]` when the whole label is one embed. */
export function parseSoleEmbed(markdown: string): MehrpeleEmbedTarget | undefined {
  const m = SOLE_EMBED_RE.exec(markdown.trim());
  if (!m) return undefined;
  const inner = m[1];
  const pipe = inner.indexOf("|");
  const target = pipe >= 0 ? inner.slice(0, pipe) : inner;
  const aliasOrSize = pipe >= 0 ? inner.slice(pipe + 1) : undefined;
  const hash = target.indexOf("#");
  const linkpath = (hash >= 0 ? target.slice(0, hash) : target).trim();
  const subpath = hash >= 0 ? target.slice(hash) : "";
  if (!linkpath) return undefined;
  return aliasOrSize !== undefined
    ? { linkpath, subpath, aliasOrSize }
    : { linkpath, subpath };
}

/** Parse an embed size alias: `400x300`, `400`, `x300`, or a plain alias. */
export function parseEmbedSize(
  aliasOrSize: string | undefined,
): { width?: number; height?: number } {
  if (!aliasOrSize) return {};
  const m = /^(\d+)?(?:x(\d+))?$/.exec(aliasOrSize.trim());
  if (!m || (m[1] === undefined && m[2] === undefined)) return {};
  const out: { width?: number; height?: number } = {};
  if (m[1] !== undefined) out.width = Number(m[1]);
  if (m[2] !== undefined) out.height = Number(m[2]);
  return out;
}

const DIAGRAM_KIND_NAMES: Record<string, string> = {
  graph: "flowchart",
  flowchart: "flowchart",
  sequencediagram: "sequence",
  classdiagram: "class",
  statediagram: "state",
  erdiagram: "ER",
  gitgraph: "git graph",
  requirementdiagram: "requirement",
  quadrantchart: "quadrant chart",
  xychart: "XY chart",
};

/**
 * "flowchart diagram" for Markdown that is exactly one diagram fence
 * (```mermaid / ~~~pele / ```mehrpele …), else null. Mirrors
 * nested.ts#parseSoleDiagramFence loosely (this file stays dependency-free).
 */
export function diagramFenceSummary(markdown: string): string | null {
  const lines = markdown.replace(/\r\n?/g, "\n").trim().split("\n");
  if (lines.length < 2) return null;
  const open = /^(`{3,}|~{3,})[ \t]*(mermaid|pele|mehrpele)(?:[ \t][^\n]*)?$/i.exec(lines[0].trim());
  const close = /^(`{3,}|~{3,})$/.exec(lines[lines.length - 1].trim());
  if (!open || !close || close[1][0] !== open[1][0] || close[1].length < open[1].length) return null;
  let body = lines.slice(1, -1);
  // Mermaid frontmatter (--- title / config ---) precedes the diagram keyword.
  if (body[0]?.trim() === "---") {
    const end = body.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) body = body.slice(end + 1);
  }
  const head = body.find((l) => l.trim() !== "" && !/^\s*%%/.test(l))?.trim().split(/\s+/)[0] ?? "";
  const key = head.replace(/-(v2|beta)$/i, "").toLowerCase();
  const name = DIAGRAM_KIND_NAMES[key] ?? key.replace(/diagram$/, "");
  return name ? `${name} diagram` : "diagram";
}

/** Strip Markdown to a readable plain-text fallback (links → display text). */
export function markdownToFallback(markdown: string): string {
  // A nested diagram (the label is one diagram fence) reads as its kind,
  // not as "~~~mermaid flowchart TD X[...] …".
  const nested = diagramFenceSummary(markdown);
  if (nested) return nested;
  let s = markdown;
  // Sole / inline embeds → their linkpath (or size-stripped target).
  s = s.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "$1");
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Wikilinks → alias or target's display part.
  s = s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, target: string, alias?: string) =>
    (alias ?? target).trim(),
  );
  s = s.replace(/\[\[#[^\]|]*(?:\|([^\]]*))?\]\]/g, (_m, alias?: string) => alias ?? "");
  // Markdown links → text.
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Callout markers.
  s = s.replace(/>\s*\[!\w+\][-+]?\s*/g, "");
  s = s.replace(/^>\s?/gm, "");
  // Headings, emphasis, code, strikethrough.
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2");
  s = s.replace(/(\*|_)(.*?)\1/g, "$2");
  s = s.replace(/~~(.*?)~~/g, "$1");
  s = s.replace(/`([^`]*)`/g, "$1");
  // Table pipes read as separators.
  s = s.replace(/\|/g, " ");
  return s.replace(/[ \t]+/g, " ").trim();
}

/** Build the model index; last duplicate anchor wins. */
export function buildModel(labels: MehrpeleLabel[]): MehrpeleModel {
  const byAnchor = new Map<string, MehrpeleLabel>();
  for (const label of labels) {
    if (byAnchor.has(label.anchorId)) {
      console.warn(`[mehrpele] duplicate label anchor "${label.anchorId}"; last definition wins`);
    }
    byAnchor.set(label.anchorId, label);
  }
  return { labels, byAnchor };
}
