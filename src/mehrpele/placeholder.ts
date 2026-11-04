/**
 * Placeholder + measurer box reservation. Pure.
 *
 * Measured Pele metrics (pele@1.13.0):
 * - `<br>` in a quoted label creates one SVG line per segment.
 * - Text block height: one line is round(1.5 em); from Pele 1.9 on, two or
 *   more lines are round(1.3 em) each (1.6.0 used 1.5 em throughout).
 * - Flowchart rect: boxW = max(48, textW + 36), boxH = block + 24 at 16px.
 * - Edge labels render at 14px: boxW = textW + 8, boxH = block.
 * - State nodes / sequence participants: pad 32 x 20.
 * - Diamonds inscribe the label (bbox overshoots); class boxes size from
 *   members; mindmap shapes have no rect. Those use a centred overlay over
 *   the reserved label area instead of the shape bbox (see anchors.ts).
 *
 * Sizes passed in are *content* sizes (the rendered label's intrinsic box in
 * CSS px = SVG units at scale 1). Pele adds its own padding around the
 * reserved text, so a reservation of W×H yields a node box of
 * (W + pad.w) × (block height of the fewest lines holding H + pad.h) — content plus
 * padding, never content squeezed into the padding.
 *
 * The placeholder keeps the readable fallback text as its first line so the
 * SVG alone (export, lightbox without overlay, screen readers) still reads
 * correctly; filler lines are empty so height is reserved without noise.
 */
import type { TextMeasurer } from "pele";
import { FILL_OPEN } from "pele-render/node-size";
import { stripMehrpeleDirective } from "./extract";
import type { MehrpeleLabel, MehrpeleLabelSize } from "./model";

export const DEFAULT_FONT_SIZE = 16;
/** Pele's line height for a one-line label, and per line once it wraps (1.9+). */
export const LINE_HEIGHT_RATIO = 1.5;
export const MULTI_LINE_HEIGHT_RATIO = 1.3;

/** Box padding Pele adds around a label, per anchor kind (at 16px). */
export const NODE_PAD = { w: 36, h: 24 };
export const COMPACT_PAD = { w: 32, h: 20 };
export const EDGE_PAD = { w: 8, h: 0 };
export const EDGE_FONT_SIZE = 14;

/**
 * Unique per-anchor placeholder token (private-use area). Pele measures it
 * through the reservation measurer, so two labels with identical fallback
 * text still reserve different boxes. mount.ts strips it from the live SVG.
 */
export const TOKEN_RE = /\uE000m(\d+)\uE001/g;

export function placeholderToken(index: number): string {
  return `\uE000m${index}\uE001`;
}

export interface ReservedLabel {
  label: MehrpeleLabel;
  size: MehrpeleLabelSize;
  /** Line count the placeholder must occupy (≥1). */
  lines: number;
  /** Placeholder inner text (token + fallback line + empty `<br>` fillers). */
  placeholder: string;
  /** Unique token for this reservation (measurer key). */
  token: string;
  /** The complete first placeholder line (token + inert fallback text). */
  line: string;
}

/**
 * Inert single-line fallback for the placeholder: Pele must measure exactly
 * this text, so drop what its label parser rewrites — backslash escapes
 * (`\nabla` would become a line break), entity/HTML markers, quotes and
 * backticks — and collapse whitespace. TeX commands keep their name.
 */
export function inertFallbackLine(text: string, fallback: string): string {
  const cleaned = (text.split("\n")[0] ?? "")
    .replace(/\\([A-Za-z]+)/g, "$1")
    .replace(/[\\#&<>"`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const capped = cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
  return capped || fallback;
}

/** Single-line height in SVG units for a label kind at a base font size. */
export function lineHeightFor(kind: MehrpeleLabel["kind"], fontSize: number): number {
  const size = kind === "edge" ? EDGE_FONT_SIZE : fontSize;
  return size * LINE_HEIGHT_RATIO;
}

/** Height Pele gives a label of `lines` lines (its text-block rule). */
export function blockHeightFor(kind: MehrpeleLabel["kind"], lines: number, fontSize: number): number {
  const size = kind === "edge" ? EDGE_FONT_SIZE : fontSize;
  return lines <= 1 ? Math.round(size * LINE_HEIGHT_RATIO) : lines * Math.round(size * MULTI_LINE_HEIGHT_RATIO);
}

export function padFor(kind: MehrpeleLabel["kind"]): { w: number; h: number } {
  return kind === "edge" ? EDGE_PAD : NODE_PAD;
}

/** Lines needed so Pele reserves at least `height` (content) for this label. */
export function linesForHeight(
  kind: MehrpeleLabel["kind"],
  height: number,
  fontSize: number = DEFAULT_FONT_SIZE,
): number {
  // Small epsilon: a 24.0001px measurement must not cost a whole extra line.
  const need = height - 0.01 * lineHeightFor(kind, fontSize);
  if (need <= blockHeightFor(kind, 1, fontSize)) return 1;
  const step = blockHeightFor(kind, 2, fontSize) / 2;
  return Math.max(2, Math.ceil(need / step));
}

/**
 * Node box Pele draws for a content reservation (flowchart rect metrics from
 * the measurements above). Used by tests and diagnostics; Pele remains the source of
 * truth for the rendered geometry.
 */
export function reservedBoxSize(
  kind: MehrpeleLabel["kind"],
  content: MehrpeleLabelSize,
  fontSize: number = DEFAULT_FONT_SIZE,
): MehrpeleLabelSize {
  const pad = padFor(kind);
  const lines = linesForHeight(kind, content.height, fontSize);
  const width = content.width + pad.w;
  return {
    width: kind === "edge" ? width : Math.max(48, width),
    height: blockHeightFor(kind, lines, fontSize) + pad.h,
  };
}

/**
 * Build the placeholder inner text for one label: the fallback text (first
 * line only, it is what the SVG/export shows) plus empty `<br>` filler lines
 * reserving the measured height.
 */
export function buildPlaceholder(
  label: MehrpeleLabel,
  size: MehrpeleLabelSize,
  fontSize: number = DEFAULT_FONT_SIZE,
  index = 0,
): ReservedLabel {
  const lines = linesForHeight(label.kind, size.height, fontSize);
  const fallbackLine = inertFallbackLine(label.fallbackText, label.anchorId.replace(/[^A-Za-z0-9_-]/g, "") || "label");
  const token = placeholderToken(index);
  const line = token + fallbackLine;
  const placeholder = [line, ...Array<string>(lines - 1).fill("")].join("<br>");
  return { label, size, lines, placeholder, token, line };
}

/**
 * A TextMeasurer that reserves measured widths: the complete token line of a
 * reserved label measures as the label's content width — Pele then adds its
 * node padding around it. Everything else delegates to `base` (or a
 * character estimate when no base is available).
 *
 * Partial token lines (Pele's word-wrap accumulates a line chunk by chunk
 * and re-measures the span so far) measure 0, so a reserved line never
 * reaches Pele's wrap width and never splits into extra lines: the
 * reservation alone decides the box height.
 */
export function makeReservationMeasurer(
  reserved: ReservedLabel[],
  base?: TextMeasurer,
): TextMeasurer {
  // Primary key: the unique per-anchor token (identical fallback text on two
  // labels must not share a width). Legacy fallback-text key kept for texts
  // Pele measures without the token (e.g. unreserved mentions).
  const byToken = new Map<string, { width: number; length: number }>();
  const byFallback = new Map<string, number>();
  for (const r of reserved) {
    const width = Math.max(1, r.size.width);
    if (r.token) byToken.set(r.token, { width, length: (r.line ?? r.token).trim().length });
    const key = (r.label.fallbackText.split("\n")[0] ?? "").trim() || r.label.anchorId;
    if (!byFallback.has(key)) byFallback.set(key, width);
  }
  const fallbackMeasurer: TextMeasurer = base ?? {
    width: (text, size) => text.length * size * 0.5,
  };
  return {
    width(text, size, style) {
      const m = /\uE000m(\d+)\uE001/.exec(text);
      if (m) {
        const hit = byToken.get(`\uE000m${m[1]}\uE001`);
        if (hit !== undefined) {
          if (text.trim().length < hit.length) return 0;
          // A sized node (`%% pele-size %%`) widens its label with a fenced
          // filler after the token line: measure the filler on top of the
          // reservation so the box can grow past the content.
          const fill = text.indexOf(FILL_OPEN);
          return fill >= 0 ? hit.width + fillerWidth(text.slice(fill), size, style, base) : hit.width;
        }
      }
      const hit = byFallback.get(text.trim());
      if (hit !== undefined) return hit;
      return fallbackMeasurer.width(text, size, style);
    },
  };
}

/**
 * Width of a node-size filler (`FILL_OPEN 000'' FILL_CLOSE`): the base
 * measurer when there is one, else per-glyph estimates ("0" ≈ 0.55 em,
 * "'" ≈ 0.19 em; the zero-width fence counts nothing), so the solver can
 * place the box to a few px.
 */
export function fillerWidth(filler: string, size: number, style: number, base?: TextMeasurer): number {
  const glyphs = filler.replace(/[\u200C\u200D]/g, "");
  if (base) return base.width(glyphs, size, style);
  let w = 0;
  for (const ch of glyphs) w += ch === "'" ? 0.19 * size : 0.55 * size;
  return w;
}

/**
 * State descriptions (`s1: "..."`) and sequence aliases
 * (`participant A as "..."`) are unquoted syntax in Pele: the quotes are
 * literal text there, so the placeholder must replace the whole quoted span
 * (quotes dropped). Flowchart node/edge/subgraph labels keep their quotes.
 */
export function spanNeedsUnquoting(source: string, label: MehrpeleLabel): boolean {
  const lineStart = source.lastIndexOf("\n", label.span.start - 1) + 1;
  const head = source.slice(lineStart, label.span.start);
  if (/^\s*(participant|actor)\s+\S+\s+as\s*$/.test(head)) return true;
  if (/^\s*[A-Za-z0-9_[\]*]+\s*:\s*$/.test(head) && /^\s*stateDiagram/.test(source)) return true;
  return false;
}

/**
 * Substitute every extracted label's quoted content with its placeholder.
 * Returns the Pele-ready source (directive stripped, quotes preserved —
 * except state/sequence forms, see spanNeedsUnquoting).
 * Labels without a reserved size keep their original quoted text.
 */
export function placeholderSource(
  source: string,
  reserved: ReservedLabel[],
  fontSize: number = DEFAULT_FONT_SIZE,
): string {
  void fontSize;
  const clean = stripMehrpeleDirective(source);
  if (reserved.length === 0) return clean;
  // Replace from the end so earlier spans stay valid.
  const sorted = [...reserved].sort((a, b) => b.label.span.start - a.label.span.start);
  let out = clean;
  for (const r of sorted) {
    const { start, end } = r.label.span;
    if (out.slice(start, start + 1) !== '"') continue;
    if (spanNeedsUnquoting(clean, r.label)) {
      out = out.slice(0, start) + r.placeholder + out.slice(end);
    } else {
      out = out.slice(0, start + 1) + escapeForQuoted(r.placeholder) + out.slice(end - 1);
    }
  }
  return out;
}

/** Escape placeholder text for a double-quoted diagram label. */
function escapeForQuoted(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Clamp a measured size to the configured maxima (≥1). */
export function clampSize(
  size: MehrpeleLabelSize,
  max: { width: number; height: number },
): MehrpeleLabelSize {
  return {
    width: Math.max(1, Math.min(size.width, max.width)),
    height: Math.max(1, Math.min(size.height, max.height)),
  };
}
