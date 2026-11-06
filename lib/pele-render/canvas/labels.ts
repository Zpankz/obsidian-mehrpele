import { formatSize, type NodeSize } from "../node-size/index.js";
import { sourceHash } from "./ids.js";

// Mehrpele escapes (`\"`, `\\` inside quoted labels): Pele has no string
// escapes, so they are swapped for private-use characters around parse/render
// and restored in the label texts. Unquoted text and `%%` lines are untouched.
export const QUOTE_PH = "";
export const BACKSLASH_PH = "";
export function shieldQuotes(src: string): string {
  if (!src.includes("\\")) return src;
  let out = "";
  let inQ = false;
  let lineStart = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (!inQ && lineStart && c === "%" && src[i + 1] === "%") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      out += src.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === "\n") lineStart = true;
    else if (c !== " " && c !== "\t") lineStart = false;
    if (inQ && c === "\\" && (src[i + 1] === '"' || src[i + 1] === "\\")) {
      out += src[i + 1] === '"' ? QUOTE_PH : BACKSLASH_PH;
      i++;
      continue;
    }
    if (c === '"') inQ = !inQ;
    out += c;
  }
  return out;
}
/** Pele label text → the label as written: Mehrpele escapes, `#quot;`-style entities. */
export function labelText(t: string | undefined): string {
  if (!t) return t ?? "";
  let s = t.includes(QUOTE_PH) ? t.split(QUOTE_PH).join('"') : t;
  if (s.includes(BACKSLASH_PH)) s = s.split(BACKSLASH_PH).join("\\");
  if (s.includes("ﬂ°")) s = s.replace(/ﬂ°(°?)(\w+)¶ß/g, (m, num: string, name: string) => {
    if (num || /^\d+$/.test(name)) { const n = Number(name); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ({ quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: " ", num: "#" } as Record<string, string>)[name] ?? m;
  });
  return s;
}

/** Signature of a node as written: label, shape and size entry. */
export function nodeSig(text: string, shape: string | undefined, size: NodeSize | undefined): string {
  return sourceHash(`${text}\u0000${shape ?? "square"}\u0000${size ? formatSize(size) : ""}`).slice(0, 8);
}
