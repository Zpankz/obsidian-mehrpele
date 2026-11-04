/**
 * Label text ⇄ label syntax (pure). The inline editor shows and edits the
 * label as Markdown text; these helpers read it out of a label's raw source
 * and write edited text back in the form the block needs:
 *
 * - Plain text that needs no Markdown stays a plain label (unquoted when the
 *   characters allow it).
 * - Markdown, wikilinks, embeds, callouts, tables, maths, newlines become a
 *   quoted Mehrpele label. Escaping is minimal and reversible: `"` → `\"`,
 *   and a backslash is doubled only where it would otherwise read as an
 *   escape (before `"` or `\`, or at the very end) — so LaTeX such as
 *   `$\nabla x$` is written exactly as typed.
 * - A plain mermaid/pele block becomes Mehrpele (`%% mehrpele %%`) only when
 *   Markdown is needed and the settings allow it; otherwise the text is kept
 *   as a quoted plain label (`#quot;`, `<br>`).
 */
import { unescapeLabelMarkdown } from "../mehrpele/model";

export const MEHRPELE_DIRECTIVE_LINE = "%% mehrpele %%";

/** Minimal reversible Mehrpele escaping (see module doc). */
export function escapeMehrpele(markdown: string): string {
  let out = "";
  for (let i = 0; i < markdown.length; i++) {
    const ch = markdown[i];
    if (ch === '"') out += '\\"';
    else if (ch === "\\") {
      const next = markdown[i + 1];
      out += next === undefined || next === '"' || next === "\\" ? "\\\\" : "\\";
    } else out += ch;
  }
  return out;
}

export const unescapeMehrpele = unescapeLabelMarkdown;

/** Characters a label may hold unquoted in every slot we write. */
const SAFE_UNQUOTED = /^[\p{L}\p{N} _.,:;!?'@%+/-]+$/u;

/** Text that renders the same as plain text and fits an unquoted label. */
export function isPlainSafe(text: string): boolean {
  return SAFE_UNQUOTED.test(text) && !/--|==|-\.|^\s|\s$/.test(text);
}

/**
 * Whether `text` needs Markdown rendering to show as typed: any newline or
 * Markdown/Obsidian syntax character.
 */
export function needsMarkdown(text: string): boolean {
  return /[\n*_`[\]$#>|~=<\\]/.test(text) || /^\s*(?:[-+]\s|\d+[.)]\s)/.test(text);
}

export interface LabelContext {
  /** Quoted labels in this block are Markdown (mehrpele lang, directive, or "always"). */
  markdownBlock: boolean;
  /** The block may switch to Mehrpele (Mehrpele on, label mode not "off"). */
  canSwitch: boolean;
  /** The label was quoted before (keep quoting in a Markdown block). */
  wasQuoted: boolean;
  /** Plain mermaid Markdown-string (`"`…`"`) before: keep the form. */
  wasMarkdownString?: boolean;
}

export interface FormattedLabel {
  /** What goes between the slot's delimiters (quotes included when quoted). */
  raw: string;
  /** The block must gain `%% mehrpele %%`. */
  switchToMehrpele: boolean;
  quoted: boolean;
}

/** Label text → raw label syntax for `ctx`. */
export function formatLabel(text: string, ctx: LabelContext): FormattedLabel {
  const md = needsMarkdown(text);
  if (ctx.markdownBlock || (md && ctx.canSwitch)) {
    const switchToMehrpele = !ctx.markdownBlock;
    if (!md && !ctx.wasQuoted && isPlainSafe(text)) return { raw: text, switchToMehrpele: false, quoted: false };
    return { raw: `"${escapeMehrpele(text)}"`, switchToMehrpele, quoted: true };
  }
  if (isPlainSafe(text) && !ctx.wasMarkdownString) return { raw: text, switchToMehrpele: false, quoted: false };
  const plain = text.replace(/"/g, "#quot;").replace(/\r?\n/g, "<br>");
  if (ctx.wasMarkdownString) return { raw: `"\`${plain}\`"`, switchToMehrpele: false, quoted: true };
  return { raw: `"${plain}"`, switchToMehrpele: false, quoted: true };
}

/** Raw label syntax → the text the editor shows. */
export function labelText(raw: string, markdownBlock: boolean): { text: string; markdownString: boolean } {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    const inner = t.slice(1, -1);
    if (markdownBlock) return { text: unescapeMehrpele(inner), markdownString: false };
    const ms = inner.length >= 2 && inner.startsWith("`") && inner.endsWith("`");
    const body = ms ? inner.slice(1, -1) : inner;
    return { text: decodePlain(body), markdownString: ms };
  }
  return { text: decodePlain(t), markdownString: false };
}

function decodePlain(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/#quot;/g, '"')
    .replace(/#amp;/g, "&")
    .replace(/#lt;/g, "<")
    .replace(/#gt;/g, ">");
}

/** Add the `%% mehrpele %%` directive (first line), unless present. */
export function withMehrpeleDirective(source: string): string {
  if (/(^|\n)\s*%%\s*mehrpele\s*%%/.test(source)) return source;
  // After YAML frontmatter: the diagram type must stay the first thing Pele reads after it.
  const fm = /^(\s*---[ \t]*\n[\s\S]*?\n[ \t]*---[ \t]*(?:\n|$))/.exec(source);
  if (fm) return `${fm[1]}${fm[1].endsWith("\n") ? "" : "\n"}${MEHRPELE_DIRECTIVE_LINE}\n${source.slice(fm[1].length)}`;
  const indent = /^[ \t]*/.exec(source)![0];
  return `${indent}${MEHRPELE_DIRECTIVE_LINE}\n${source}`;
}

/** Offset shift `withMehrpeleDirective` causes (0 when the directive was there). */
export function directiveShift(before: string, after: string): number {
  return after.length - before.length;
}
