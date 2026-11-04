/**
 * Validating Mehrpele blocks (pure).
 *
 * Pele never sees a Mehrpele label's Markdown: mount.ts replaces every quoted
 * label with a placeholder before rendering. Validating the raw block would
 * therefore report errors the rendered diagram does not have — Pele's lexer
 * rejects backticks and `\"` inside quoted labels, which nested diagram
 * fences (```` ~~~mermaid ```` / ```` ``` ```` inside a label) and escaped
 * quotes need. Validation runs on a neutralised source instead: each label's
 * text becomes its inert fallback line, exactly what the placeholder shows.
 *
 * Two variants:
 * - `mehrpeleCheckSource` keeps the block's line numbers (multi-line labels
 *   keep their newlines inside the quotes; Pele accepts newlines in quoted
 *   flowchart/state labels), so error positions point at the real lines;
 * - `mehrpeleRenderSource` is single-line per label (what renders; also the
 *   source for headless SVG export, where labels read as fallback text).
 * `validateMehrpele` accepts a block when either variant is valid and reports
 * the line-preserving variant's error otherwise.
 */
import { extractLabels, stripMehrpeleDirective } from "./extract";
import { labelsInRawSource } from "./nested";
import { inertFallbackLine, spanNeedsUnquoting } from "./placeholder";
import type { MehrpeleLabel } from "./model";

const DIRECTIVE_LINE_RE = /(^|\n)([ \t]*%%\s*mehrpele\s*%%[ \t]*)(?=\n|$)/g;

function fallbackLine(label: MehrpeleLabel): string {
  return inertFallbackLine(label.fallbackText, label.anchorId.replace(/[^A-Za-z0-9_-]/g, "") || "label");
}

/** Replace labels (spans index `text`) from the end so earlier spans stay valid. */
function neutralise(text: string, labels: MehrpeleLabel[], keepLines: boolean): string {
  let out = text;
  for (const label of [...labels].sort((a, b) => b.span.start - a.span.start)) {
    const { start, end } = label.span;
    if (out[start] !== '"' || out[end - 1] !== '"') continue;
    const line = fallbackLine(label);
    if (spanNeedsUnquoting(text, label)) {
      // State descriptions / sequence aliases: the quotes are literal text
      // there and a newline would end the statement — always one line.
      out = out.slice(0, start) + line + out.slice(end);
      continue;
    }
    const newlines = keepLines ? (out.slice(start, end).match(/\n/g)?.length ?? 0) : 0;
    out = out.slice(0, start + 1) + line + "\n".repeat(newlines) + out.slice(end - 1);
  }
  return out;
}

/**
 * Line-preserving neutralised source: the `%% mehrpele %%` directive becomes
 * blank padding, labels become their fallback line plus the same number of
 * newlines, so line N of the result is line N of the block.
 */
export function mehrpeleCheckSource(source: string): string {
  const masked = source.replace(DIRECTIVE_LINE_RE, (_m, nl: string, d: string) => nl + " ".repeat(d.length));
  return neutralise(masked, labelsInRawSource(source), true);
}

/** Single-line neutralised source (directive stripped): what Pele renders. */
export function mehrpeleRenderSource(source: string): string {
  return neutralise(stripMehrpeleDirective(source), extractLabels(source), false);
}

/**
 * Validate a Mehrpele block with `validate` (e.g. pele-render's
 * validateSource, or a `parse`/`render` try-wrapper) on the neutralised
 * source. Valid when either variant is; otherwise the line-preserving
 * variant's result (its error lines match the block).
 */
export function validateMehrpele<R extends { ok: boolean }>(source: string, validate: (src: string) => R): R {
  const lines = validate(mehrpeleCheckSource(source));
  if (lines.ok) return lines;
  const single = validate(mehrpeleRenderSource(source));
  return single.ok ? single : lines;
}
