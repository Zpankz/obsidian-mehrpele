/**
 * DOM-free parsing/serialising of the fence info string size, e.g.
 * ```mermaid width=480 zoom=1.4
 *
 * `width=N` is the layout box (a maximum layout width under responsive
 * reflow); `height=H` gives the box a height too (a corner dragged down: the
 * layout that fills W×H wins and scales up to fill it). `zoom=Z` is the
 * legacy explicit display zoom of earlier corner drags (still rendered; the
 * next drag writes a box instead). They are independent tokens.
 */

export interface FenceInfo {
  /** Fence marker, e.g. "```" or "~~~" ("" when given a bare info string). */
  fence: string;
  lang: string;
  width?: number;
  /** Box height, when the fence carries `height=H`. */
  height?: number;
  /** Display zoom (> 1), when the fence carries `zoom=Z`. */
  zoom?: number;
  /** Remaining info tokens after the language, excluding width=, height= and zoom= tokens. */
  rest: string[];
}

/** A fence's size tokens. */
export interface FenceSize {
  width?: number;
  height?: number;
  zoom?: number;
}

/** Zoom bounds: what the corner can set and what a hand-written token is clamped to. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;

const FENCE_LINE_RE = /^(\s*)(`{3,}|~{3,})[ \t]*(.*)$/;
const WIDTH_TOKEN_RE = /^width=(\d{1,5})$/;
const HEIGHT_TOKEN_RE = /^height=(\d{1,5})$/;
const ZOOM_TOKEN_RE = /^zoom=(\d{1,2}(?:\.\d{1,3})?)$/;

/** A zoom value as stored: clamped to [ZOOM_MIN, ZOOM_MAX], 2 decimals; undefined when it is 1. */
export function normaliseZoom(z: number | null | undefined): number | undefined {
  if (z === null || z === undefined || !Number.isFinite(z)) return undefined;
  const v = Math.round(Math.min(Math.max(z, ZOOM_MIN), ZOOM_MAX) * 100) / 100;
  return v > 1 ? v : undefined;
}

function parseInfoTokens(info: string): { lang: string; width?: number; height?: number; zoom?: number; rest: string[] } {
  const tokens = info.trim().split(/\s+/).filter(Boolean);
  const lang = tokens[0] ?? "";
  const rest: string[] = [];
  let width: number | undefined;
  let height: number | undefined;
  let zoom: number | undefined;
  for (const tok of tokens.slice(1)) {
    const m = WIDTH_TOKEN_RE.exec(tok);
    const h = m ? null : HEIGHT_TOKEN_RE.exec(tok);
    const z = m || h ? null : ZOOM_TOKEN_RE.exec(tok);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) width = n;
    } else if (h) {
      const n = Number.parseInt(h[1], 10);
      if (Number.isFinite(n) && n > 0) height = n;
    } else if (z) {
      zoom = normaliseZoom(Number.parseFloat(z[1]));
    } else {
      rest.push(tok);
    }
  }
  return {
    lang,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(zoom !== undefined ? { zoom } : {}),
    rest,
  };
}

/** Parse a full fence line ("```mermaid width=480") or a bare info string ("mermaid width=480"). */
export function parseFenceInfo(lineOrInfo: string): FenceInfo {
  const fm = FENCE_LINE_RE.exec(lineOrInfo);
  if (fm) {
    const parsed = parseInfoTokens(fm[3] ?? "");
    return { fence: fm[2] ?? "```", ...parsed };
  }
  const parsed = parseInfoTokens(lineOrInfo);
  return { fence: "", ...parsed };
}

/** Width declared in a fence line / info string, if any. */
export function parseInfoWidth(lineOrInfo: string | null | undefined): number | undefined {
  if (!lineOrInfo) return undefined;
  return parseFenceInfo(lineOrInfo).width;
}

/** Height declared in a fence line / info string, if any. */
export function parseInfoHeight(lineOrInfo: string | null | undefined): number | undefined {
  if (!lineOrInfo) return undefined;
  return parseFenceInfo(lineOrInfo).height;
}

/** Width, height and zoom of a fence line / info string (absent tokens omitted). */
export function parseFenceSize(lineOrInfo: string | null | undefined): FenceSize {
  if (!lineOrInfo) return {};
  const { width, height, zoom } = parseFenceInfo(lineOrInfo);
  return { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(zoom !== undefined ? { zoom } : {}) };
}

/** Zoom declared in a fence line / info string, if any (> 1). */
export function parseInfoZoom(lineOrInfo: string | null | undefined): number | undefined {
  if (!lineOrInfo) return undefined;
  return parseFenceInfo(lineOrInfo).zoom;
}

/**
 * What to change on a fence: a number sets, null removes, undefined keeps
 * the token the line already has.
 */
export interface FenceSizeEdit {
  width?: number | null;
  height?: number | null;
  zoom?: number | null;
}

/**
 * Return `fenceLine` with its width, height and/or zoom set or removed, preserving
 * fence marker, language and other info tokens.
 */
export function serializeFenceSize(fenceLine: string, edit: FenceSizeEdit): string {
  const fm = FENCE_LINE_RE.exec(fenceLine);
  const indent = fm?.[1] ?? "";
  const parsed = fm
    ? { fence: fm[2] ?? "```", ...parseInfoTokens(fm[3] ?? "") }
    : { fence: "```", ...parseInfoTokens(fenceLine) };
  const width = edit.width === undefined ? parsed.width : edit.width;
  const height = edit.height === undefined ? parsed.height : edit.height;
  const zoom = normaliseZoom(edit.zoom === undefined ? parsed.zoom : edit.zoom);
  const tokens = [parsed.lang, ...parsed.rest];
  if (width !== null && width !== undefined && width > 0) tokens.push(`width=${Math.round(width)}`);
  if (height !== null && height !== undefined && height > 0) tokens.push(`height=${Math.round(height)}`);
  if (zoom !== undefined) tokens.push(`zoom=${zoom}`);
  return `${indent}${parsed.fence}${tokens.filter(Boolean).join(" ")}`;
}

/**
 * Return `fenceLine` with its width set (or removed when width is null/<=0),
 * preserving fence marker, language and other info tokens (zoom included).
 */
export function serializeFenceWidth(fenceLine: string, width: number | null): string {
  return serializeFenceSize(fenceLine, { width: width !== null && width > 0 ? width : null });
}

/** Info line (opening fence) for a block starting at `lineStart` (0-based) in `text`. */
export function fenceLineAt(text: string, lineStart: number): string | undefined {
  // Scans up to the line instead of splitting the whole note (companion resyncs call this).
  if (!(lineStart >= 0) || !Number.isInteger(lineStart)) return undefined;
  let from = 0;
  for (let i = 0; i < lineStart; i++) {
    const nl = text.indexOf("\n", from);
    if (nl < 0) return undefined;
    from = nl + 1;
  }
  const end = text.indexOf("\n", from);
  return text.slice(from, end < 0 ? undefined : end);
}

/** The fence's info-string tokens after the language, size tokens left out ("cannoli"); "" for none. */
export function fenceRestOf(line: string | null | undefined): string {
  return line ? parseFenceInfo(line).rest.join(" ") : "";
}
