/**
 * Live Preview takeover self-check verdict (pure, so it tests without CM).
 * `failed` needs evidence: code-block widgets on screen yet no widget class
 * matched. With no code blocks open there is nothing to judge (`pending`).
 */
export type LpSelfCheckVerdict = "ok" | "pending" | "failed";

export function lpSelfCheckVerdict({ patched, sawCodeBlocks }: { patched: boolean; sawCodeBlocks: boolean }): LpSelfCheckVerdict {
  if (patched) return "ok";
  return sawCodeBlocks ? "failed" : "pending";
}
