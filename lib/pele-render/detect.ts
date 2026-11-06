/**
 * Internal helper (not re-exported from any entry point): Pele's
 * detectType() with "cannot tell" folded into null, for callers that only
 * label a source and must not fail on it.
 */
import type { DiagramType } from "pele";
import { detectType } from "./pele.js";

/** The source's diagram type, or null when it is unknown or detectType() throws. */
export function detectTypeOrNull(source: string): DiagramType | null {
  try {
    return detectType(source);
  } catch {
    return null;
  }
}
