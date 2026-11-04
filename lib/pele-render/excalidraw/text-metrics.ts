// Conservative text metrics for Excalidraw bound labels (no DOM, no canvas).
//
// Advance widths (per-mille em, ASCII U+0020..U+007E) were extracted with
// fontTools from the fonts Excalidraw ships (zsviczian/excalidraw@efcd365,
// packages/excalidraw/fonts/**). Helvetica (2) has no bundled file — it is
// the system face — so Liberation Sans (9, metric-compatible with Arial /
// Helvetica) stands in for it. Line heights mirror
// packages/common/src/font-metadata.ts (FONT_METADATA[*].metrics.lineHeight).
//
// Container rules mirror packages/element/src/textElement.ts:
//  - BOUND_TEXT_PADDING = 5 (packages/common/src/constants.ts)
//  - getBoundTextMaxWidth / getBoundTextMaxHeight: rectangle = side - 2*pad,
//    ellipse = round(side/2*sqrt2) - 2*pad, diamond = round(side/2) - 2*pad
//  - redrawTextBoundingBox wraps with wrapText(originalText, font, maxWidth),
//    which breaks a single word mid-word once it is wider than maxWidth, and
//    grows the container's *height* (top-anchored) when the wrapped text is
//    taller than getBoundTextMaxHeight.
// Unset label fontFamily resolves to DEFAULT_FONT_FAMILY = Excalifont (5)
// (constants.ts; newTextElement in newElement.ts).

export const BOUND_TEXT_PADDING = 5;
export const DEFAULT_FONT_FAMILY = 5;
/** Multiplier on summed advances: covers canvas rounding, hinting and fallback faces. */
export const WIDTH_SAFETY = 1.1;

const ADVANCES: Record<number, number[]> = {
  // Virgil — fonts/Virgil/Virgil-Regular.woff2
  1: [500,296,328,797,803,939,719,266,415,338,516,625,257,411,274,500,688,271,712,681,640,618,640,538,765,609,242,258,605,617,485,466,805,656,727,644,780,674,574,789,551,545,634,613,599,766,644,726,661,705,678,608,804,714,517,746,598,516,797,491,500,500,544,826,437,667,508,502,569,547,486,501,494,219,328,487,263,633,467,554,493,546,430,543,565,568,523,609,562,469,572,573,168,496,841],
  // Helvetica (Liberation Sans, metric-compatible) — fonts/Liberation/LiberationSans-Regular.woff2
  2: [278,278,355,557,557,890,667,191,334,334,390,584,278,334,278,278,557,557,557,557,557,557,557,557,557,557,278,278,584,584,584,557,1016,667,667,723,723,667,611,778,723,278,500,667,557,834,723,778,667,778,723,667,611,723,667,944,667,667,611,278,278,278,470,557,334,557,557,500,557,557,278,557,557,223,223,500,223,834,557,557,557,557,334,500,278,557,500,723,500,500,500,334,260,334,584],
  // Cascadia — fonts/Cascadia/CascadiaCode-Regular.woff2
  3: [586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586,586],
  // Excalifont — fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2
  5: [400,314,371,783,721,928,718,218,441,402,525,550,257,411,274,561,664,427,700,608,585,618,640,558,636,629,264,298,550,550,550,466,829,676,761,629,780,707,661,780,573,545,569,613,543,766,632,767,698,768,736,622,857,730,592,786,628,564,832,472,589,497,510,670,600,576,555,504,605,537,497,555,567,244,328,533,225,663,526,600,537,539,412,543,553,548,525,693,591,530,572,504,299,544,669],
  // Nunito — fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2
  6: [261,233,405,600,600,933,701,226,326,326,451,600,233,427,233,290,600,600,600,600,600,600,600,600,600,600,233,233,600,600,600,447,947,733,679,675,747,586,551,729,764,262,331,634,548,858,741,771,637,771,673,618,607,731,694,1104,655,601,593,324,290,324,600,500,361,533,587,465,587,534,340,590,572,237,241,508,301,861,572,560,587,587,365,483,358,565,518,844,530,517,466,361,270,361,600],
  // Lilita One — fonts/Lilita/Lilita-Regular-i7dPIFZ9Zz-WBtRtedDbYEF8RXi4EwQ.woff2
  7: [188,287,460,833,531,798,667,301,430,422,557,602,305,525,229,573,639,406,525,528,598,524,575,500,570,565,277,277,484,580,450,584,867,655,594,561,616,493,472,621,644,429,462,620,435,907,648,696,570,706,590,531,502,628,661,953,683,615,563,385,587,385,687,636,350,517,520,424,565,486,375,516,501,273,271,531,272,788,551,513,555,511,396,450,368,544,521,752,557,537,454,362,628,362,459],
  // Comic Shanns — fonts/ComicShanns/ComicShanns-Regular-279a7b317d12eb88de06167bd672b4b4.woff2
  8: [550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550,550],
  // Assistant — fonts/Assistant/Assistant-Regular.woff2
  10: [200,282,409,492,492,817,600,242,297,297,412,492,242,308,242,352,492,451,492,492,492,492,492,492,492,492,242,242,492,492,492,419,839,539,585,569,613,524,490,614,648,257,475,573,481,721,644,661,562,661,563,530,533,643,509,782,505,468,539,297,352,297,492,500,540,501,551,454,552,492,284,500,540,242,242,487,250,825,543,540,552,552,340,416,331,540,459,710,436,459,419,297,237,297,492],
};
ADVANCES[9] = ADVANCES[2]!; // Liberation Sans

const LINE_HEIGHTS: Record<number, number> = { 1: 1.25, 2: 1.15, 3: 1.2, 5: 1.25, 6: 1.25, 7: 1.15, 8: 1.25, 9: 1.15, 10: 1.25 };

/** Unknown families (4 = Obsidian "Local Font", custom ids): widest known advance per glyph. */
const MAX_ADVANCES: number[] = ADVANCES[1].map((_, i) => Math.max(...Object.values(ADVANCES).map((a) => a[i])));
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f000}-\u{1faff}\u{20000}-\u{3fffd}]/u;
const COMBINING = /[\u0300-\u036f\ufe00-\ufe0f\u200b-\u200f]/u;

function advancesFor(fontFamily: number | undefined): number[] {
  return ADVANCES[fontFamily ?? DEFAULT_FONT_FAMILY] ?? MAX_ADVANCES;
}

export function lineHeightFor(fontFamily: number | undefined): number {
  return LINE_HEIGHTS[fontFamily ?? DEFAULT_FONT_FAMILY] ?? 1.25;
}

function charAdvance(ch: string, adv: number[]): number {
  const code = ch.codePointAt(0)!;
  if (code >= 0x20 && code <= 0x7e) return adv[code - 0x20];
  if (COMBINING.test(ch)) return 0;
  if (WIDE.test(ch)) return 1000;
  const base = ch.normalize("NFD").codePointAt(0)!;
  if (base >= 0x20 && base <= 0x7e) return adv[base - 0x20];
  // Unmapped script (Cyrillic, Greek, …): widest Latin letter in this face.
  let widest = 0;
  for (let c = 0x41; c <= 0x7a; c++) if (c <= 0x5a || c >= 0x61) widest = Math.max(widest, adv[c - 0x20]);
  return widest;
}

/** Upper-bound pixel width of one line as Excalidraw's canvas measureText would see it. */
export function estimateLineWidth(line: string, fontSize: number, fontFamily?: number): number {
  const adv = advancesFor(fontFamily);
  let sum = 0;
  for (const ch of line.normalize("NFC")) sum += charAdvance(ch, adv);
  return Math.ceil((sum * fontSize / 1000) * WIDTH_SAFETY);
}

/** Excalidraw label text: Mermaid `<br>` becomes a hard line break. */
export function labelText(text: string): string {
  return text.replace(/<br\s*\/?>/gi, "\n");
}

/** Estimated unwrapped text box (width = widest hard line, height = lines × fontSize × lineHeight). */
export function estimateTextBox(text: string, fontSize: number, fontFamily?: number): { width: number; height: number; lines: number } {
  const lines = text.split(/\r?\n/);
  const width = Math.max(0, ...lines.map((l) => estimateLineWidth(l, fontSize, fontFamily)));
  return { width, height: Math.ceil(lines.length * fontSize * lineHeightFor(fontFamily)), lines: lines.length };
}

export type TextContainerType = "rectangle" | "ellipse" | "diamond";

/** Mirror of getBoundTextMaxWidth (non-arrow, non-legacy containers). */
export function boundTextMaxWidth(type: TextContainerType, width: number): number {
  if (type === "ellipse") return Math.round((width / 2) * Math.SQRT2) - BOUND_TEXT_PADDING * 2;
  if (type === "diamond") return Math.round(width / 2) - BOUND_TEXT_PADDING * 2;
  return width - BOUND_TEXT_PADDING * 2;
}

/** Mirror of getBoundTextMaxHeight (non-arrow, non-legacy containers). */
export function boundTextMaxHeight(type: TextContainerType, height: number): number {
  return boundTextMaxWidth(type, height);
}

/**
 * Smallest container side whose bound-text extent holds `text` px.
 * Starts from computeContainerDimensionForBoundText and steps until the
 * mirrored max-width rule is satisfied (rounding makes the closed form ±1).
 */
export function minContainerSide(type: TextContainerType, text: number): number {
  const d = Math.ceil(text) + BOUND_TEXT_PADDING * 2;
  let side = type === "ellipse" ? Math.round((d / Math.SQRT2) * 2) : type === "diamond" ? 2 * d : d;
  while (boundTextMaxWidth(type, side) < text) side++;
  while (side > 1 && boundTextMaxWidth(type, side - 1) >= text) side--;
  return side;
}

/** Mirror of getBoundTextMaxWidth for arrow containers (ARROW_LABEL_WIDTH_FRACTION 0.7, min ratio 11). */
export function arrowLabelMaxWidth(arrowWidth: number, fontSize: number): number {
  return Math.max(0.7 * arrowWidth, fontSize * 11);
}

const words = (line: string) => line.split(/\s+/).filter(Boolean);

/** Widest single word: Excalidraw's wrapText only breaks *inside* a word wider than maxWidth. */
export function longestWordWidth(text: string, fontSize: number, fontFamily?: number): number {
  let max = 0;
  for (const line of text.split(/\r?\n/)) for (const w of words(line)) max = Math.max(max, estimateLineWidth(w, fontSize, fontFamily));
  return max;
}

/** Greedy word wrap with the estimator (whitespace breaks only — a subset of Excalidraw's break opportunities). */
export function estimateWrappedLines(text: string, maxWidth: number, fontSize: number, fontFamily?: number): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let cur = "";
    for (const w of words(line)) {
      const next = cur ? `${cur} ${w}` : w;
      if (cur && estimateLineWidth(next, fontSize, fontFamily) > maxWidth) { out.push(cur); cur = w; } else cur = next;
    }
    out.push(cur);
  }
  return out;
}

/** Widths of every contiguous word run inside each hard line (candidate wrap widths). */
export function runWidths(text: string, fontSize: number, fontFamily?: number): number[] {
  const set = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const ws = words(line);
    for (let i = 0; i < ws.length; i++) for (let j = i + 1; j <= Math.min(ws.length, i + 24); j++) set.add(estimateLineWidth(ws.slice(i, j).join(" "), fontSize, fontFamily));
  }
  return [...set].sort((a, b) => a - b);
}
