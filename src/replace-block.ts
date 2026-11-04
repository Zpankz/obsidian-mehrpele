/** DOM-free block-body replacement preserving the fence line (incl. width=). */
import { locateBlockForPersist } from "./fence-locate";

export type ReplaceResult =
  | { ok: true; text: string; fenceLine: number }
  | { ok: false; reason: "ambiguous" | "missing" };

/**
 * Replace the body of the block whose fence+body matches (fenceLine, oldSource).
 * The fence line itself is preserved verbatim. Aborts when the block cannot be
 * located uniquely (same relocation rules as width persistence).
 */
export function replaceBlockBody(
  text: string,
  fenceLine: number,
  oldSource: string,
  newSource: string,
): ReplaceResult {
  const hit = locateBlockForPersist(text, fenceLine, oldSource);
  if (hit.kind === "ambiguous") return { ok: false, reason: "ambiguous" };
  if (hit.kind === "missing") return { ok: false, reason: "missing" };
  const lines = text.split("\n");
  const oldCount = oldSource.replace(/\n$/, "").split("\n").length;
  const newLines = newSource.replace(/\n$/, "").split("\n");
  lines.splice(hit.line + 1, oldCount, ...newLines);
  return { ok: true, text: lines.join("\n"), fenceLine: hit.line };
}
