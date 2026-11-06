/**
 * Canvas file cards ⇄ Mehrpele embed labels (`A["![[Note#Heading|400x300]]"]`).
 *
 * A Mehrpele embed node is full bleed (pele-mermaid src/mehrpele/bleed.ts):
 * the embed fills its node edge to edge, so the node box *is* the embed box
 * (`|WxH`, default 320×240). A card of W×H canvas px at `scale` therefore
 * becomes `|${W/scale}x${H/scale}` and back exactly. Image embeds size to the
 * image: only the width is written (`|W`), the height follows the picture.
 * Pure.
 */

/** Padding between an embed and its node box: none (full bleed). */
export const EMBED_PAD = { w: 0, h: 0 } as const;
/** Mehrpele's default embed box (settings › embed default size). */
export const EMBED_DEFAULT = { w: 320, h: 240 } as const;

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

export interface EmbedLabel {
  /** `![[…]]` (true) or a plain wikilink `[[…]]` (false). */
  embed: boolean;
  file: string;
  /** `#Heading` / `#^block`, or "". */
  subpath: string;
  /** Text after `|` that is not a size. */
  alias?: string;
  size?: { w?: number; h?: number };
}

/** A label that is exactly one embed or wikilink, else null. */
export function parseEmbedLabel(label: string): EmbedLabel | null {
  const t = label.trim();
  const m = /^(!?)\[\[([^[\]\n]+)\]\]$/.exec(t);
  if (!m) return null;
  const [target = "", ...rest] = m[2].split("|");
  const after = rest.join("|");
  const hash = target.indexOf("#");
  const file = (hash >= 0 ? target.slice(0, hash) : target).trim();
  const subpath = hash >= 0 ? target.slice(hash) : "";
  if (!file) return null;
  const out: EmbedLabel = { embed: m[1] === "!", file, subpath };
  const sm = /^(\d+)?(?:x(\d+))?$/.exec(after.trim());
  if (after && sm && (sm[1] || sm[2])) out.size = { ...(sm[1] ? { w: Number(sm[1]) } : {}), ...(sm[2] ? { h: Number(sm[2]) } : {}) };
  else if (after) out.alias = after;
  return out;
}

export function isImageFile(file: string): boolean {
  return IMAGE_EXT_RE.test(file);
}

/** `![[file#sub|size]]` / `[[file#sub|alias]]`. */
export function formatEmbedLabel(e: EmbedLabel): string {
  const size = e.size && (e.size.w !== undefined || e.size.h !== undefined) ? `${e.size.w ?? ""}${e.size.h !== undefined ? `x${e.size.h}` : ""}` : "";
  const tail = size || e.alias ? `|${size || e.alias}` : "";
  return `${e.embed ? "!" : ""}[[${e.file}${e.subpath}${tail}]]`;
}

/** Embed size for a card of w×h canvas px (images: width only). */
export function embedSizeForCard(w: number, h: number, scale: number, image: boolean): { w: number; h?: number } {
  const ew = Math.max(1, Math.round(w / scale - EMBED_PAD.w));
  if (image) return { w: ew };
  return { w: ew, h: Math.max(1, Math.round(h / scale - EMBED_PAD.h)) };
}

/**
 * Node box (SVG units) of an embed label: the embed box + padding. Images
 * without a height get 3:4 of their width (the CLI cannot see the picture).
 * null for plain wikilinks (they render as text).
 */
export function embedNodeBox(e: EmbedLabel): { w: number; h: number } | null {
  if (!e.embed) return null;
  const image = isImageFile(e.file);
  const w = e.size?.w ?? EMBED_DEFAULT.w;
  const h = e.size?.h ?? (image ? Math.round(w * 0.75) : EMBED_DEFAULT.h);
  return { w: w + EMBED_PAD.w, h: h + EMBED_PAD.h };
}
