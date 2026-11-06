import { render } from "../pele.js";
import type { PeleErrorLike } from "./types.js";

export function toErrorLike(err: unknown): PeleErrorLike {
  const e = err as { message?: unknown; code?: unknown; type?: unknown; line?: unknown; column?: unknown; snippet?: unknown };
  return {
    message: err instanceof Error ? err.message : String(err),
    code: typeof e?.code === "string" ? e.code : undefined,
    type: typeof e?.type === "string" || e?.type === null ? (e.type) : undefined,
    line: typeof e?.line === "number" && e.line > 0 ? e.line : undefined,
    column: typeof e?.column === "number" && e.column > 0 ? e.column : undefined,
    snippet: typeof e?.snippet === "string" ? e.snippet : undefined,
  };
}

export function validateSource(source: string, config?: object): { ok: true; type: string } | { ok: false; error: PeleErrorLike } {
  if (typeof source !== "string") throw new TypeError("validateSource: source must be a string");
  try {
    const r = render(source, config ? { config: config as never } : undefined);
    return { ok: true, type: r.type };
  } catch (err) {
    return { ok: false, error: toErrorLike(err) };
  }
}
