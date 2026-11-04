/** "Materialise diagram as notes" settings. DOM-free. */
import type { SettingsV3 } from "../settings/schema";
import { DEFAULT_EDGE_KEY, type ExistingPolicy, type KeyStyle } from "./plan";

export interface MaterialiseSettings {
  /** Root folder template; `{{folder}}` = the note's folder, `{{note}}` = its name. */
  rootFolder: string;
  /** Property for unlabelled edges. */
  defaultKey: string;
  /** Labelled edges: slugified (`depends-on`) or verbatim (`depends on`) property names. */
  keyStyle: KeyStyle;
  /** Rewrite the block so every node embeds its note. */
  rewriteBlock: boolean;
  /** A note with the planned name already exists. */
  onExisting: ExistingPolicy;
}

export const DEFAULT_MATERIALISE_SETTINGS: MaterialiseSettings = {
  rootFolder: "{{folder}}/{{note}}",
  defaultKey: DEFAULT_EDGE_KEY,
  keyStyle: "slug",
  rewriteBlock: true,
  onExisting: "link",
};

export function normalizeMaterialiseSettings(raw: Partial<MaterialiseSettings> | null | undefined): MaterialiseSettings {
  const r = raw ?? {};
  return {
    rootFolder: typeof r.rootFolder === "string" && r.rootFolder.trim() ? r.rootFolder : DEFAULT_MATERIALISE_SETTINGS.rootFolder,
    defaultKey: typeof r.defaultKey === "string" && r.defaultKey.trim() ? r.defaultKey.trim() : DEFAULT_EDGE_KEY,
    keyStyle: r.keyStyle === "verbatim" ? "verbatim" : "slug",
    rewriteBlock: r.rewriteBlock !== false,
    onExisting: r.onExisting === "skip" || r.onExisting === "suffix" ? r.onExisting : "link",
  };
}

/** Runtime options from the v3 settings; rewriting the block and linking existing notes are fixed. Read-only. */
export function materialiseOptions(s: SettingsV3): MaterialiseSettings {
  const m = s.features.materialise;
  return { rootFolder: m.rootFolder, defaultKey: m.defaultKey, keyStyle: m.keyStyle, rewriteBlock: true, onExisting: "link" };
}
