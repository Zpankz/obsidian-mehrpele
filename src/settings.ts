/** DOM-free mapping from the v3 settings to Pele MountOptions. */
import type { RenderOptions } from "pele";
import { parseConfigJson } from "./render-policy";
import type { SettingsV3 } from "./settings/schema";

export type ZoomMode = "off" | "auto" | "always";

/** Subset of pele's MountOptions driven by settings (DOM-free shape). */
export interface MountOptionValues {
  zoom: boolean | "auto";
  maxWidth?: number;
  fontFamily?: string;
  fontSize?: number;
  links: boolean;
  images: boolean;
  linkSchemes: string[];
  imageSchemes: string[];
  linkRel: string;
  config?: RenderOptions["config"];
  now?: number;
  limit?: number;
}

export function resolveZoom(mode: ZoomMode): boolean | "auto" {
  switch (mode) {
    case "off":
      return false;
    case "always":
      return true;
    case "auto":
    default:
      return "auto";
  }
}

/** The pan/zoom mode in effect: the feature's mode while it is on, else "off". */
export function zoomMode(s: SettingsV3): ZoomMode {
  const pz = s.features["pan-zoom"];
  return pz.enabled ? pz.mode : "off";
}

export function toMountOptions(s: SettingsV3): MountOptionValues {
  const { appearance, security, advanced } = s.core;
  const out: MountOptionValues = {
    zoom: resolveZoom(zoomMode(s)),
    links: security.allowLinks,
    images: security.allowRemoteImages,
    // Pele's defaults plus obsidian:// (routed by the plugin's link handling).
    linkSchemes: ["http", "https", "mailto", "tel", "obsidian"],
    imageSchemes: ["http", "https"],
    linkRel: "noopener",
  };
  if (appearance.maxWidth > 0) out.maxWidth = appearance.maxWidth;
  const font = appearance.fontFamily.trim();
  if (font) out.fontFamily = font;
  if (appearance.fontSize > 0) out.fontSize = appearance.fontSize;
  const cfg = parseConfigJsonLoose(advanced.defaultConfigJson);
  if (cfg) out.config = cfg as RenderOptions["config"];
  if (s.core.ganttToday) out.now = Date.now();
  if (advanced.maxSourceLength > 0) out.limit = advanced.maxSourceLength;
  return out;
}

/** Parsed config or undefined when empty/invalid (invalid input never reaches Pele). */
function parseConfigJsonLoose(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  const parsed = parseConfigJson(text);
  return parsed.ok ? parsed.config : undefined;
}
