/** Edit toolbar / inline editor settings (DOM-free). */
import type { SettingsV3 } from "../settings/schema";

export interface AutocompleteSettings {
  /** Cmd/Ctrl-click on a "+" asks the model for label suggestions. */
  enabled: boolean;
  /** Model override; "" uses the Repair LLM model. Provider, URL and keys are Repair's. */
  model: string;
}

export interface EditSettings {
  /** Hover/click toolbar on nodes, edges and subgraphs. */
  toolbar: boolean;
  /** "Edit text" and double-click open the rendered inline editor. */
  inlineEdit: boolean;
  /** Node label autocomplete. */
  autocomplete: AutocompleteSettings;
}

export const DEFAULT_EDIT_SETTINGS: EditSettings = { toolbar: true, inlineEdit: true, autocomplete: { enabled: false, model: "" } };

export function normalizeEditSettings(data: Partial<EditSettings> | null | undefined): EditSettings {
  return {
    toolbar: data?.toolbar !== false,
    inlineEdit: data?.inlineEdit !== false,
    autocomplete: {
      enabled: data?.autocomplete?.enabled === true,
      model: typeof data?.autocomplete?.model === "string" ? data.autocomplete.model.trim() : "",
    },
  };
}

/** Runtime edit options from the v3 settings (three feature toggles). Read-only. */
export function editOptions(s: SettingsV3): EditSettings {
  const f = s.features;
  return {
    toolbar: f.toolbar.enabled,
    inlineEdit: f["inline-edit"].enabled,
    autocomplete: { enabled: f.autocomplete.enabled, model: f.autocomplete.model },
  };
}
