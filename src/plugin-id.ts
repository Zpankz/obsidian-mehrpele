/**
 * The plugin's manifest id. `onload` sets it from `this.manifest.id`; the
 * default only covers code that runs before load (tests).
 */
export let PLUGIN_ID = "mehrpele";

export function setPluginId(id: string): void {
  PLUGIN_ID = id;
}
