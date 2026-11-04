/** DOM-free formatting of Pele (and unknown) render errors. */

export interface PeleErrorLike {
  name?: string;
  message: string;
  code?: string;
  type?: string | null;
  line?: number;
  column?: number;
  snippet?: string;
}

export function asPeleErrorLike(err: unknown): PeleErrorLike | null {
  if (err instanceof Error) {
    const e = err as Error & Partial<PeleErrorLike>;
    // Only Pele-shaped errors carry code/line/column/snippet; a plain Error
    // may coincidentally expose unrelated numeric props in some engines.
    const isPele = typeof e.code === "string" || e.name === "PeleError";
    return {
      name: e.name,
      message: e.message,
      code: isPele && typeof e.code === "string" ? e.code : undefined,
      type: isPele && typeof e.type === "string" ? e.type : null,
      line: isPele && typeof e.line === "number" ? e.line : undefined,
      column: isPele && typeof e.column === "number" ? e.column : undefined,
      snippet: isPele && typeof e.snippet === "string" ? e.snippet : undefined,
    };
  }
  if (typeof err === "string") return { message: err };
  if (err && typeof err === "object" && "message" in err) {
    return asPeleErrorLike(new Error(String((err).message)));
  }
  return null;
}

export interface FormatErrorOptions {
  showSnippet?: boolean;
}

/**
 * One-line header plus optional snippet, e.g.
 *   Pele: syntax error (flowchart) at 3:1 — Parse error on line 3: …
 * The snippet (when shown) is appended on following lines verbatim.
 */
export function formatError(err: unknown, opts: FormatErrorOptions = {}): string {
  const showSnippet = opts.showSnippet !== false;
  const like = asPeleErrorLike(err);
  if (!like) return `Pele: ${String(err)}`;
  const parts: string[] = ["Pele:"];
  if (like.code) parts.push(`[${like.code}]`);
  if (like.type) parts.push(`(${like.type})`);
  if (typeof like.line === "number" && like.line > 0) {
    const col = typeof like.column === "number" && like.column > 0 ? `:${like.column}` : "";
    parts.push(`at ${like.line}${col} —`);
  }
  parts.push(like.message);
  let out = parts.join(" ");
  const snippet = like.snippet?.replace(/\s+$/, "") ?? "";
  // Pele's parse messages usually embed the snippet already; don't repeat it.
  if (showSnippet && snippet.trim().length > 0 && !like.message.includes(snippet)) {
    out += `\n${snippet}`;
  }
  return out;
}
