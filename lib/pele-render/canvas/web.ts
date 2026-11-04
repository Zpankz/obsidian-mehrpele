/**
 * Canvas link cards ⇄ Mehrpele web-view nodes (pele-mermaid view nodes):
 * `A["![[https://example.com|440x320]]"]` (or the Markdown form
 * `A["![Title|440x320](https://example.com)"]`) is a live web page in a node,
 * like a Canvas link card. The node box is the embed box (full bleed), as for
 * file cards, so card sizes round-trip exactly. Pure.
 */
import { EMBED_DEFAULT, EMBED_PAD } from "./embed.js";

export interface WebEmbedLabel {
  url: string;
  size?: { w?: number; h?: number };
  /** Markdown form alt text (without the size). */
  alt?: string;
  form: "wiki" | "md";
}

const WEB_RE = /^https?:\/\/\S+$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)(?:[?#].*)?$/i;

export function isWebUrl(url: string): boolean {
  return WEB_RE.test(url.trim()) && !IMAGE_RE.test(url.trim());
}

function sizeOf(seg: string | undefined): { w?: number; h?: number } | undefined {
  const m = seg ? /^(\d+)?(?:x(\d+))?$/.exec(seg.trim()) : null;
  if (!m || (!m[1] && !m[2])) return undefined;
  return { ...(m[1] ? { w: Number(m[1]) } : {}), ...(m[2] ? { h: Number(m[2]) } : {}) };
}

/** A label that is exactly one web-page embed (http/https, not an image), else null. */
export function parseWebEmbedLabel(label: string): WebEmbedLabel | null {
  const t = label.trim();
  const wiki = /^!\[\[([^[\]\n]+)\]\]$/.exec(t);
  if (wiki) {
    // As Obsidian (and Mehrpele's parseSoleEmbed) read it: the target ends at the first `|`.
    const parts = wiki[1].split("|");
    const last = parts.length > 1 ? sizeOf(parts[parts.length - 1]) : undefined;
    const url = parts[0].trim();
    if (!isWebUrl(url)) return null;
    return last ? { url, size: last, form: "wiki" } : { url, form: "wiki" };
  }
  const md = /^!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^\s)]+)\s*\)$/.exec(t);
  if (md) {
    const url = md[2].replace(/^<|>$/g, "").trim();
    if (!isWebUrl(url)) return null;
    const segs = md[1] ? md[1].split("|") : [];
    const size = segs.length ? sizeOf(segs[segs.length - 1]) : undefined;
    const alt = (size ? segs.slice(0, -1) : segs).join("|");
    return { url, form: "md", ...(size ? { size } : {}), ...(alt ? { alt } : {}) };
  }
  return null;
}

/** `![[url|WxH]]` (the Markdown form when the URL holds `|` or `]`). */
export function formatWebEmbedLabel(url: string, size?: { w?: number; h?: number }, form: "wiki" | "md" = "wiki", alt?: string): string {
  const sz = size && (size.w !== undefined || size.h !== undefined) ? `${size.w ?? ""}${size.h !== undefined ? `x${size.h}` : ""}` : "";
  if (form === "md" || /[|\]]/.test(url)) {
    const a = [alt, sz].filter(Boolean).join("|");
    return `![${a}](${/[\s()]/.test(url) ? `<${url}>` : url})`;
  }
  return `![[${url}${sz ? `|${sz}` : ""}]]`;
}

/** Node box (SVG units) of a web-view label: the embed box + Pele's padding. */
export function webNodeBox(e: WebEmbedLabel): { w: number; h: number } {
  return { w: (e.size?.w ?? EMBED_DEFAULT.w) + EMBED_PAD.w, h: (e.size?.h ?? EMBED_DEFAULT.h) + EMBED_PAD.h };
}
