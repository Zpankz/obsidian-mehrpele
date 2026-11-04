/**
 * Feature toggles, read from the v3 settings. The registry's single entry
 * point to them.
 */
import { isEnabledV3, type SettingsV3, type ToggleId } from "../settings/schema";

export { TOGGLE_IDS } from "../settings/schema";

export type FeatureId = ToggleId;

/** Whether a feature's toggle is on in these settings. */
export function isEnabled(s: SettingsV3, id: FeatureId): boolean {
  return isEnabledV3(s, id);
}
