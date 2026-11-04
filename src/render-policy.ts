/** DOM-free render-policy helpers: config JSON validation + playground URLs. */

export type ConfigParse =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; error: string };

/** Validate the "Default Mermaid config" setting. Empty text = no config. */
export function parseConfigJson(text: string): ConfigParse {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, config: {} };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "Config must be a JSON object." };
    }
    return { ok: true, config: parsed as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const PLAYGROUND_BASE = "https://pele.run/playground";
export const PLAYGROUND_MAX_SOURCE = 100_000;
export const PLAYGROUND_MAX_HASH = 400_000;

/** Playground deep link, or null when the source/hash would exceed limits. */
export function buildPlaygroundUrl(source: string): string | null {
  if (source.length > PLAYGROUND_MAX_SOURCE) return null;
  const url = `${PLAYGROUND_BASE}#${new URLSearchParams({ source }).toString()}`;
  if (url.length > PLAYGROUND_MAX_HASH) return null;
  return url;
}

/** accTitle from diagram source (for lightbox title / aria-label), if present. */
export function extractAccTitle(source: string): string | null {
  const m = /^\s*accTitle\s*:\s*(.+?)\s*$/m.exec(source);
  return m ? (m[1] ?? null) : null;
}
