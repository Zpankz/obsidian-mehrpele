/**
 * Node ids inside `%% pele-* %%` directive entries (`pele-size`, `pele-pos`):
 * bare when they match BARE_ID, otherwise JSON-quoted (`"Make tea"=160x48`).
 * Pure: no Pele, no DOM.
 */

/** Ids written without quotes: letters, digits and `_ . : -`. */
export const BARE_ID = /^[\p{L}\p{N}_.:-]+$/u;

/** An id as a directive writes it. */
export function quoteId(id: string): string {
  return BARE_ID.test(id) ? id : JSON.stringify(id);
}

/** An id as read from a directive entry; null for a malformed or empty quoted id. */
export function parseId(raw: string): string | null {
  if (!raw.startsWith('"')) return raw;
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}
