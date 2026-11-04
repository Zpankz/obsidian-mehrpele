/**
 * Control keys are dotted v3 paths (`features.reflow.minTextScale`). These
 * read and write them on a v3 object, converting the two list-valued keys to
 * and from the text their controls edit.
 */
import { parseSchemes } from "../mehrpele/views/settings";
import type { SettingsV3 } from "../settings/schema";

type Obj = Record<string, unknown>;

/** List-valued keys, edited as text. */
const LISTS: Readonly<Record<string, { join: string; split: (s: string) => string[] }>> = {
  "core.security.commandAllowlist": {
    join: "\n",
    split: (s) => s.split("\n").map((l) => l.trim()).filter(Boolean),
  },
  "features.view-nodes.allowedSchemes": { join: ", ", split: (s) => parseSchemes(s) },
};

/** The raw value at a dotted path, or undefined. */
export function getPath(v3: SettingsV3, key: string): unknown {
  let cur: unknown = v3;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Obj)[part];
  }
  return cur;
}

/** Set a dotted path that already exists. Unknown paths throw: a typo must not save silently. */
export function setPath(v3: SettingsV3, key: string, value: unknown): void {
  const parts = key.split(".");
  const last = parts.pop()!;
  let cur: unknown = v3;
  for (const part of parts) {
    cur = cur && typeof cur === "object" ? (cur as Obj)[part] : undefined;
  }
  if (!cur || typeof cur !== "object" || !(last in (cur as Obj))) throw new Error(`Unknown setting: ${key}`);
  (cur as Obj)[last] = value;
}

/** The value a control shows for `key`. */
export function readControl(v3: SettingsV3, key: string): unknown {
  const v = getPath(v3, key);
  const list = LISTS[key];
  return list && Array.isArray(v) ? v.join(list.join) : v;
}

/** Write a control's value to `key`, converting text back to a list where needed. */
export function writeControl(v3: SettingsV3, key: string, value: unknown): void {
  const list = LISTS[key];
  if (list) {
    setPath(v3, key, list.split(typeof value === "string" ? value : ""));
    return;
  }
  const cur = getPath(v3, key);
  if (typeof cur === "number") {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
    // Empty or bad input: keep the old value (normalize would reset it anyway).
    setPath(v3, key, Number.isFinite(n) ? n : cur);
    return;
  }
  setPath(v3, key, value);
}
