/** FNV-1a 64-bit, isomorphic (no node:crypto). Returns 16-char lowercase hex. */
export function sourceHash(source: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  // UTF-8 encode
  const bytes = new TextEncoder().encode(source);
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

export function sanitizeId(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9_]/g, "_");
  if (!s) s = "x";
  if (/^[0-9]/.test(s)) s = "x" + s;
  return s;
}

export function slugify(text: string): string {
  let s = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) s = "node";
  s = s.slice(0, 24).replace(/_+$/g, "") || "node";
  if (/^[0-9]/.test(s)) s = "n_" + s;
  return s;
}
