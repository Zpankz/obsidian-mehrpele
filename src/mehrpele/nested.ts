/**
 * Nested diagrams + node-content sizing (pure: no DOM, no App).
 *
 * A label is a *nested diagram* when its whole Markdown is one diagram fence
 * (```mermaid / ~~~pele / ```mehrpele …) or a sole embed whose target holds
 * exactly one diagram (a diagram file, or a note / heading / block section
 * that is a single diagram fence). Nested diagrams render as real Pele
 * frames inside the node instead of going through MarkdownRenderer, so they
 * size to the inner diagram and keep zoom / resize / code reveal.
 *
 * Sizes written back to the source use the syntax each form already has:
 * inline fences get `width=N` in their info string (like top-level blocks),
 * embeds get Obsidian's `|W` / `|WxH`.
 */
import { parseFenceInfo, serializeFenceSize } from "../info-width";
import { isViewTarget, withWebEmbedSize } from "./views/syntax"; // view-nodes
import { extractLabels } from "./extract";
import type { MehrpeleEmbedTarget, MehrpeleLabel, MehrpeleLabelSize } from "./model";
import type { EmbedSizing } from "./settings";

export const NESTED_DIAGRAM_LANGS = ["mermaid", "pele", "mehrpele"] as const;
export type NestedDiagramLang = (typeof NESTED_DIAGRAM_LANGS)[number];

export interface NestedDiagram {
  lang: NestedDiagramLang;
  /** Diagram source between the fences. */
  code: string;
  /** `width=N` from the inner fence info string, if any. */
  width?: number;
  /** `height=N` from the inner fence info string (a box height), if any. */
  height?: number;
}

const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\n]*)$/;

function isDiagramLang(lang: string): lang is NestedDiagramLang {
  return (NESTED_DIAGRAM_LANGS as readonly string[]).includes(lang);
}

/**
 * Parse text that is exactly one diagram fence (surrounding blank lines
 * allowed). The closing fence must use the opening marker's character and be
 * at least as long (CommonMark).
 */
export function parseSoleDiagramFence(text: string): NestedDiagram | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length < 2) return null;
  const open = FENCE_OPEN_RE.exec(lines[0]);
  if (!open) return null;
  const marker = open[1];
  // Backtick fences may not carry backticks in their info string.
  if (marker[0] === "`" && open[2].includes("`")) return null;
  const info = parseFenceInfo(`${marker}${open[2] ?? ""}`);
  const lang = info.lang.toLowerCase();
  if (!isDiagramLang(lang)) return null;
  const closer = new RegExp(`^[ \\t]*\\${marker[0]}{${marker.length},}[ \\t]*$`);
  if (!closer.test(lines[lines.length - 1])) return null;
  const body = lines.slice(1, -1);
  // A closing fence inside would have ended the block early: not one fence.
  if (body.some((l) => closer.test(l))) return null;
  const out: NestedDiagram = { lang, code: body.join("\n") };
  if (info.width !== undefined) out.width = info.width;
  if (info.height !== undefined) out.height = info.height;
  return out;
}

/**
 * The single diagram in a resolved note section, or null. Accepts the
 * section as Obsidian resolves it: an optional leading heading line, an
 * optional frontmatter block (whole-note embeds), trailing `^block-id`
 * lines and blank lines around the fence. Anything else means the section
 * is ordinary Markdown and keeps the normal embed rendering.
 */
export function soleDiagramInSection(text: string): NestedDiagram | null {
  let t = text.replace(/\r\n?/g, "\n");
  const fm = /^---\n[\s\S]*?\n---[ \t]*(\n|$)/.exec(t);
  if (fm) t = t.slice(fm[0].length);
  const lines = t.split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  if (lines.length > 0 && /^#{1,6}\s/.test(lines[0])) lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1].trim() === "" || /^\s*\^[A-Za-z0-9-]+\s*$/.test(lines[lines.length - 1]))) {
    lines.pop();
  }
  return parseSoleDiagramFence(lines.join("\n"));
}

const DIAGRAM_FILE_RE = /\.(mmd|mermaid|pele)$/i;

/** Embed targets that are diagram source files (`![[flow.mmd]]`). */
export function diagramFileLang(target: MehrpeleEmbedTarget): NestedDiagramLang | null {
  const m = DIAGRAM_FILE_RE.exec(target.linkpath.trim());
  if (!m) return null;
  return m[1].toLowerCase() === "pele" ? "pele" : "mermaid";
}

/** Embed targets that may resolve to Markdown notes (no extension or `.md`). */
export function isNoteTarget(target: MehrpeleEmbedTarget): boolean {
  if (isViewTarget(target)) return false; // view-nodes: web pages and view: targets are fixed viewports
  const path = target.linkpath.trim();
  const base = path.slice(path.lastIndexOf("/") + 1);
  return /\.md$/i.test(base) || !base.includes(".");
}

// -- sizing ----------------------------------------------------------------

export interface FitOptions {
  /** Hard box the content must fit (embed-node maxima). */
  cap: { width: number; height: number };
  mode: EmbedSizing;
  /** Legible mode: smallest scale of the natural size an explicit size may request. */
  minScale: number;
}

/** Smallest width an explicit size may request (legible floor, never above the cap fit). */
export function minContentWidth(natural: MehrpeleLabelSize, o: FitOptions): number {
  if (o.mode !== "legible" || natural.width <= 0) return 16;
  const fit = capScale(natural, o.cap);
  return Math.max(16, Math.round(natural.width * Math.min(Math.max(o.minScale, 0), fit, 1)));
}

function capScale(natural: MehrpeleLabelSize, cap: { width: number; height: number }): number {
  if (natural.width <= 0 || natural.height <= 0) return 1;
  return Math.min(cap.width / natural.width, cap.height / natural.height);
}

/**
 * Largest scale an explicit size may request: the cap fit, or the natural
 * size when that is larger (a big screenshot can be dragged up to 100%;
 * small content can be enlarged up to the cap).
 */
export function maxContentScale(natural: MehrpeleLabelSize, cap: { width: number; height: number }): number {
  return Math.max(capScale(natural, cap), 1);
}

/** Largest size an explicit size may request (see maxContentScale). */
export function maxContentSize(natural: MehrpeleLabelSize, cap: { width: number; height: number }): MehrpeleLabelSize {
  if (natural.width <= 0 || natural.height <= 0) return { ...cap };
  const s = maxContentScale(natural, cap);
  return { width: Math.floor(natural.width * s), height: Math.floor(natural.height * s) };
}

/**
 * Display size for content with a natural size (an image or a diagram),
 * aspect ratio preserved, never clipped:
 * - no explicit size: natural size, shrunk to fit the cap (the node maxima;
 *   the frame's zoom/lightbox shows it full size);
 * - explicit `|W` / `|WxH` / `width=` (written, or set by dragging the node
 *   corner): that size, but in legible mode never below `minScale` of the
 *   natural size (a 958px screenshot at `|100` is unreadable) unless the
 *   cap fit is smaller still, and never above the larger of the cap fit and
 *   the natural size.
 */
export function fitContentSize(
  natural: MehrpeleLabelSize,
  requested: { width?: number; height?: number },
  o: FitOptions,
): MehrpeleLabelSize {
  if (natural.width <= 0 || natural.height <= 0) {
    return {
      width: Math.max(1, Math.round(Math.min(requested.width ?? o.cap.width, o.cap.width))),
      height: Math.max(1, Math.round(Math.min(requested.height ?? o.cap.height, o.cap.height))),
    };
  }
  let scale: number;
  if (requested.width !== undefined || requested.height !== undefined) {
    const sw = requested.width !== undefined ? requested.width / natural.width : Infinity;
    const sh = requested.height !== undefined ? requested.height / natural.height : Infinity;
    scale = Math.min(sw, sh);
    // The floor never exceeds the cap fit: a small written size must not
    // come out larger than no size at all (same floor as minContentWidth).
    if (o.mode === "legible") scale = Math.max(scale, Math.min(o.minScale, capScale(natural, o.cap)));
    scale = Math.min(scale, maxContentScale(natural, o.cap));
  } else {
    scale = Math.min(1, capScale(natural, o.cap));
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  return {
    width: Math.max(1, Math.round(natural.width * scale)),
    height: Math.max(1, Math.round(natural.height * scale)),
  };
}

// -- source rewrites ---------------------------------------------------------

/** Labels with spans in the *raw* source (directive kept), for rewrites. */
export function labelsInRawSource(source: string): MehrpeleLabel[] {
  // extractLabels strips the directive (shifting offsets); blank it to
  // spaces of equal length instead so spans index the raw text.
  const masked = source.replace(/(^|\n)([ \t]*%%\s*mehrpele\s*%%[ \t]*)(?=\n|$)/g, (_m, nl: string, d: string) => nl + " ".repeat(d.length));
  return extractLabels(masked);
}

/** The raw text between a label's quotes. */
export function rawLabelInner(source: string, label: MehrpeleLabel): string {
  return source.slice(label.span.start + 1, label.span.end - 1);
}

/** Replace the raw text between one label's quotes. */
export function replaceLabelInner(source: string, label: MehrpeleLabel, inner: string): string {
  return source.slice(0, label.span.start + 1) + inner + source.slice(label.span.end - 1);
}

/**
 * Rewrite one label (found by anchor id in the raw source) through `edit`,
 * which receives and returns the raw quoted text. Returns null when the label
 * is missing or the edit is a no-op.
 */
export function rewriteLabel(
  source: string,
  anchorId: string,
  edit: (rawInner: string) => string | null,
): string | null {
  const labels = labelsInRawSource(source);
  const label = [...labels].reverse().find((l) => l.anchorId === anchorId);
  if (!label) return null;
  const before = rawLabelInner(source, label);
  const after = edit(before);
  if (after === null || after === before) return null;
  return replaceLabelInner(source, label, after);
}

/** Set (or remove) `width=N` on a label that is one diagram fence. */
export function withFenceWidth(rawInner: string, width: number | null): string | null {
  return withFenceSize(rawInner, { width });
}

/**
 * Set (or remove) the box of a label that is one diagram fence: `width=W`
 * and `height=H` (null removes a token, an absent key keeps it).
 */
export function withFenceSize(rawInner: string, size: { width?: number | null; height?: number | null }): string | null {
  const lead = /^\s*/.exec(rawInner)![0];
  const rest = rawInner.slice(lead.length);
  const nl = rest.indexOf("\n");
  if (nl < 0) return null;
  const first = rest.slice(0, nl);
  if (!FENCE_OPEN_RE.test(first)) return null;
  const px = (v: number | null | undefined) => (v === undefined ? undefined : v !== null && v > 0 ? Math.round(v) : null);
  const next = serializeFenceSize(first, {
    ...(size.width !== undefined ? { width: px(size.width) } : {}),
    ...(size.height !== undefined ? { height: px(size.height) } : {}),
  });
  return lead + next + rest.slice(nl);
}

const SIZE_RE = /^\d+(?:x\d+)?$|^x\d+$/;

/**
 * Set (or remove) the size of a sole-embed label: `![[t]]` → `![[t|W]]` /
 * `![[t|WxH]]`. A plain alias is kept (`![[t|alias|W]]`); only a trailing
 * size segment is replaced.
 */
export function withEmbedSize(
  rawInner: string,
  size: { width: number; height?: number } | null,
): string | null {
  const m = /^(\s*)!\[\[([^\]]+)\]\](\s*)$/.exec(rawInner);
  if (!m) return withWebEmbedSize(rawInner, size); // view-nodes: `![|WxH](https://…)` web embeds
  const parts = m[2].split("|");
  if (parts.length > 1 && SIZE_RE.test(parts[parts.length - 1].trim())) parts.pop();
  if (size) {
    const w = Math.max(1, Math.round(size.width));
    parts.push(size.height !== undefined ? `${w}x${Math.max(1, Math.round(size.height))}` : `${w}`);
  }
  return `${m[1]}![[${parts.join("|")}]]${m[3]}`;
}

/** Requested size from a sole embed's alias segments (last size segment wins). */
export function embedRequestedSize(target: MehrpeleEmbedTarget): { width?: number; height?: number } {
  if (!target.aliasOrSize) return {};
  const segs = target.aliasOrSize.split("|");
  const last = segs[segs.length - 1].trim();
  const m = /^(\d+)?(?:x(\d+))?$/.exec(last);
  if (!m || (m[1] === undefined && m[2] === undefined)) return {};
  const out: { width?: number; height?: number } = {};
  if (m[1] !== undefined) out.width = Number(m[1]);
  if (m[2] !== undefined) out.height = Number(m[2]);
  return out;
}

/** Alias text of a sole embed without its size segment ("" when none). */
export function embedAlias(target: MehrpeleEmbedTarget): string {
  if (!target.aliasOrSize) return "";
  const segs = target.aliasOrSize.split("|");
  if (SIZE_RE.test(segs[segs.length - 1].trim())) segs.pop();
  return segs.join("|");
}

/**
 * Raw-text offsets of each unescaped character of a quoted label (`\"` and
 * `\\` are one character), plus a final entry for the end.
 */
function unescapedOffsets(raw: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    at.push(i);
    if (raw[i] === "\\" && i + 1 < raw.length && (raw[i + 1] === '"' || raw[i + 1] === "\\")) {
      text += raw[i + 1];
      i++;
    } else {
      text += raw[i];
    }
  }
  at.push(raw.length);
  return { text, at };
}

/**
 * Replace the body of a label that is one diagram fence with `nextCode`
 * (a nested diagram changed its own source, e.g. a node resized inside it).
 * Only the changed middle is re-escaped, so the rest of the quoted text —
 * including how the author escaped it — stays byte-identical.
 */
export function withFenceBody(rawInner: string, nextCode: string): string | null {
  const first = rawInner.indexOf("\n");
  const last = rawInner.lastIndexOf("\n");
  if (first < 0 || last <= first) return null;
  const head = rawInner.slice(0, first + 1);
  const tail = rawInner.slice(last);
  if (!FENCE_OPEN_RE.test(head.trimEnd().replace(/^\s*/, ""))) return null;
  const rawBody = rawInner.slice(first + 1, last);
  const { text: oldCode, at } = unescapedOffsets(rawBody);
  if (oldCode === nextCode) return null;
  let p = 0;
  const max = Math.min(oldCode.length, nextCode.length);
  while (p < max && oldCode[p] === nextCode[p]) p++;
  let sfx = 0;
  while (sfx < max - p && oldCode[oldCode.length - 1 - sfx] === nextCode[nextCode.length - 1 - sfx]) sfx++;
  const middle = nextCode.slice(p, nextCode.length - sfx).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const body = rawBody.slice(0, at[p]) + middle + rawBody.slice(at[oldCode.length - sfx]);
  return head + body + tail;
}
