/**
 * Load settings at plugin start: read, import from the old `pele-mermaid`
 * folder when this install has none, migrate to v3, and save right away when
 * the migration changed anything.
 */
import { migrate, type MigrateFrom } from "./migrate";
import type { SettingsV3 } from "./schema";

/** The old plugin folder; settings saved under the previous id live here. */
export const LEGACY_PLUGIN_DIR = "pele-mermaid";

export interface SettingsHost {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
  manifest: { dir?: string };
  app: {
    vault: { configDir: string; adapter: { exists(path: string): Promise<boolean>; read(path: string): Promise<string> } };
    plugins?: { enabledPlugins?: Set<string> };
  };
}

export const NOTICE_FRESH = "Mehrpele starts light: most features are off. Turn on what you need in Settings › Mehrpele.";
export const NOTICE_MIGRATED = "Mehrpele settings were upgraded. Your features are unchanged.";
export const NOTICE_SANITIZE_OFF =
  "Mehrpele: SVG sanitising is off in your settings. Turn it on under Security unless you trust every diagram.";

/** Raw data from the old folder, or null when absent, unreadable, or this install already lives there. */
async function readLegacy(host: SettingsHost): Promise<unknown> {
  const { configDir, adapter } = host.app.vault;
  const dir = `${configDir}/plugins/${LEGACY_PLUGIN_DIR}`;
  if (!host.manifest.dir || host.manifest.dir === dir) return null;
  const path = `${dir}/data.json`;
  try {
    if (!(await adapter.exists(path))) return null;
    return JSON.parse(await adapter.read(path));
  } catch {
    return null;
  }
}

export interface LoadResult {
  settings: SettingsV3;
  from: MigrateFrom;
  imported: boolean;
}

export async function loadSettings(host: SettingsHost, notify?: (message: string) => void): Promise<LoadResult> {
  let raw = await host.loadData();
  let imported = false;
  if (raw == null) {
    const legacy = await readLegacy(host);
    if (legacy != null) {
      raw = legacy;
      imported = true;
    }
  }
  const { settings, changed, from } = migrate(raw, {
    peleExcalidrawEnabled: host.app.plugins?.enabledPlugins?.has("pele-excalidraw") === true,
  });
  if (changed || imported) {
    try {
      await host.saveData(settings);
    } catch (e) {
      console.error("Mehrpele: could not save migrated settings", e);
    }
  }
  if (from === "fresh") notify?.(NOTICE_FRESH);
  else if (from === "v2") notify?.(NOTICE_MIGRATED);
  // Once by construction: only the v2 → v3 load reaches here, and it saves v3.
  if (from === "v2" && !settings.core.security.sanitize) notify?.(NOTICE_SANITIZE_OFF);
  return { settings, from, imported };
}
