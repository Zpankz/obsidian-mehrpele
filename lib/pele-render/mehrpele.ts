/**
 * Mehrpele blocks (Markdown in diagram labels) — validate and render them the
 * way the Obsidian plugin does. Pure.
 *
 * In a Mehrpele block (```mehrpele, or a mermaid/pele block carrying the
 * `%% mehrpele %%` directive) every double-quoted label is Markdown that the
 * plugin renders as HTML; Pele only ever sees a placeholder. Label Markdown
 * such as a nested diagram fence (```` ~~~mermaid ```` / ```` ``` ```` inside
 * the quotes) or `\"` escapes is not valid Pele label text, so checking the
 * raw block would report errors the rendered diagram does not have.
 *
 * Here each quoted span becomes its plain fallback text (one line, Markdown
 * stripped; a nested diagram reads as "flowchart diagram"). The plugin
 * classifies which quoted spans are labels; this CLI treats every quoted
 * span outside `%%` lines as one, which only differs for quoted non-label
 * text (pie slice names, click tooltips) — plain text either way.
 */

const DIRECTIVE_RE = /(^|\n)\s*%%\s*mehrpele\s*%%/;
const DIRECTIVE_LINE_RE = /(^|\n)([ \t]*%%\s*mehrpele\s*%%[ \t]*)(?=\n|$)/g;

/** A Mehrpele block: `mehrpele` fence, or the opt-in directive in the source. */
export function isMehrpeleDiagram(lang: string | undefined, source: string): boolean {
  const l = (lang ?? "").toLowerCase();
  if (l === "mehrpele") return true;
  if (l && l !== "mermaid" && l !== "pele") return false;
  return DIRECTIVE_RE.test(source);
}

interface Span {
  start: number;
  end: number;
  raw: string;
}

/** Double-quoted spans honouring `\"` / `\\` escapes, skipping `%%` comment lines. */
function quotedSpans(source: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    // `%%` at the start of a line: a comment or %%{init}%% directive line.
    if (ch === "%" && source[i + 1] === "%" && source.slice(source.lastIndexOf("\n", i - 1) + 1, i).trim() === "") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (ch !== '"') {
      i++;
      continue;
    }
    const start = i++;
    let raw = "";
    let closed = false;
    while (i < source.length) {
      const c = source[i];
      if (c === "\\" && i + 1 < source.length) {
        raw += c + source[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        closed = true;
        i++;
        break;
      }
      raw += c;
      i++;
    }
    if (closed) spans.push({ start, end: i, raw });
  }
  return spans;
}

function unescape(raw: string): string {
  return raw.replace(/\\(["\\])/g, "$1");
}

const KIND_NAMES: Record<string, string> = {
  graph: "flowchart", flowchart: "flowchart", sequencediagram: "sequence", classdiagram: "class",
  statediagram: "state", erdiagram: "ER", gitgraph: "git graph", requirementdiagram: "requirement",
  quadrantchart: "quadrant chart", xychart: "XY chart",
};

/** "flowchart diagram" when the Markdown is exactly one diagram fence. */
function nestedSummary(md: string): string | null {
  const lines = md.replace(/\r\n?/g, "\n").trim().split("\n");
  if (lines.length < 2) return null;
  const open = /^(`{3,}|~{3,})[ \t]*(mermaid|pele|mehrpele)(?:[ \t][^\n]*)?$/i.exec(lines[0].trim());
  const close = /^(`{3,}|~{3,})$/.exec(lines[lines.length - 1].trim());
  if (!open || !close || close[1][0] !== open[1][0] || close[1].length < open[1].length) return null;
  let body = lines.slice(1, -1);
  if (body[0]?.trim() === "---") {
    const end = body.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) body = body.slice(end + 1);
  }
  const head = body.find((l) => l.trim() !== "" && !/^\s*%%/.test(l))?.trim().split(/\s+/)[0] ?? "";
  const key = head.replace(/-(v2|beta)$/i, "").toLowerCase();
  const name = KIND_NAMES[key] ?? key.replace(/diagram$/, "");
  return name ? `${name} diagram` : "diagram";
}

/** Plain one-line fallback for label Markdown (what the SVG shows). */
export function labelFallbackText(markdown: string): string {
  const nested = nestedSummary(markdown);
  if (nested) return nested;
  let s = markdown;
  s = s.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "$1");
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, t: string, a?: string) => (a ?? t).trim());
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2").replace(/(\*|_)(.*?)\1/g, "$2").replace(/~~(.*?)~~/g, "$1").replace(/`([^`]*)`/g, "$1");
  s = s.replace(/\|/g, " ");
  const line = (s.split("\n").find((l) => l.trim() !== "") ?? "")
    .replace(/\\([A-Za-z]+)/g, "$1")
    .replace(/[\\#&<>"`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (line.length > 80 ? `${line.slice(0, 79)}…` : line) || "label";
}

/** State descriptions / sequence aliases: the quotes are literal text there. */
function unquoted(source: string, start: number): boolean {
  const head = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
  if (/^\s*(participant|actor)\s+\S+\s+as\s*$/.test(head)) return true;
  return /^\s*[A-Za-z0-9_[\]*]+\s*:\s*$/.test(head) && /^\s*stateDiagram/.test(source);
}

function neutralise(source: string, keepLines: boolean): string {
  let out = source;
  for (const s of quotedSpans(source).reverse()) {
    const text = labelFallbackText(unescape(s.raw));
    if (unquoted(source, s.start)) {
      out = out.slice(0, s.start) + text + out.slice(s.end);
      continue;
    }
    const nl = keepLines ? (s.raw.match(/\n/g)?.length ?? 0) : 0;
    out = out.slice(0, s.start + 1) + text + "\n".repeat(nl) + out.slice(s.end - 1);
  }
  return out;
}

/** Line-preserving neutralised source (error lines match the block). */
export function mehrpeleCheckSource(source: string): string {
  return neutralise(source.replace(DIRECTIVE_LINE_RE, (_m, nl: string, d: string) => nl + " ".repeat(d.length)), true);
}

/** One line per label, directive removed: what renders (labels as fallback text). */
export function mehrpeleRenderSource(source: string): string {
  return neutralise(source.replace(/(^|\n)[ \t]*%%\s*mehrpele\s*%%[ \t]*(\n|$)/g, "$1"), false);
}

/**
 * Run `fn` on the neutralised source: valid when either variant is; else
 * throws the line-preserving variant's error (its lines match the block).
 */
export function withMehrpeleSource<T>(source: string, fn: (src: string) => T): T {
  try {
    return fn(mehrpeleCheckSource(source));
  } catch (err) {
    try {
      return fn(mehrpeleRenderSource(source));
    } catch {
      throw err;
    }
  }
}
