/**
 * Settings schema v3. Pure and DOM-free.
 *
 * Layout: `core.{appearance,security,advanced}`, one `features.<id>` object per
 * feature (each with `enabled`), and the shared `llm` provider block.
 * `normalizeV3` rebuilds the object from this schema, so unknown keys are dropped.
 */
import { DEFAULT_EDGE_KEY } from "../materialise/plan";
import { parseSchemes } from "../mehrpele/views/settings";

export const SETTINGS_VERSION_V3 = 3;

export type PanZoomMode = "auto" | "always";
export type LabelMode = "directive" | "always";
export type JevTransport = "http" | "cli";
export type LlmProviderKind = "anthropic" | "openai";
export type ReasoningEffort = "default" | "none" | "low" | "medium" | "high";

export interface SettingsV3 {
  settingsVersion: 3;
  core: {
    overrideMermaid: boolean;
    iconsEnabled: boolean;
    ganttToday: boolean;
    appearance: { maxWidth: number; fontFamily: string; fontSize: number };
    security: {
      allowLinks: boolean;
      allowCommandUris: boolean;
      commandAllowlist: string[];
      allowRemoteImages: boolean;
      /** Pass Pele's SVG through the allow-list sanitizer (on by default, like core Obsidian). */
      sanitize: boolean;
    };
    advanced: { maxSourceLength: number; defaultConfigJson: string };
  };
  features: {
    reflow: { enabled: boolean; switchDirection: boolean; minTextScale: number };
    "pan-zoom": { enabled: boolean; mode: PanZoomMode };
    resize: { enabled: boolean };
    toolbar: { enabled: boolean };
    "inline-edit": { enabled: boolean };
    autocomplete: { enabled: boolean; model: string };
    "live-view": {
      enabled: boolean;
      mermaidLabelMode: LabelMode;
      embeds: boolean;
      noteCardLabels: boolean;
      maxLabelWidth: number;
      maxLabelHeight: number;
      maxEmbedWidth: number;
      maxEmbedHeight: number;
      maxLabels: number;
      /** Legible floor as a fraction of natural size; 0 = honour sizes exactly. */
      minEmbedScale: number;
    };
    nested: { enabled: boolean; maxDepth: number };
    bases: { enabled: boolean };
    "view-nodes": {
      enabled: boolean;
      attachedViews: boolean;
      maxLiveViews: number;
      webEnabled: boolean;
      allowedSchemes: string[];
    };
    repair: {
      enabled: boolean;
      preview: boolean;
      llm: boolean;
      jev: {
        enabled: boolean;
        transport: JevTransport;
        baseUrl: string;
        keySecretId: string;
        binPath: string;
        /** Security state: the binary path the user approved; kept only while it equals `binPath`. */
        binConfirmed: string;
        model: string;
      };
    };
    canvas: { enabled: boolean; portals: "link" | "inline"; portalDepth: number; layout: "auto" | "canvas"; outputFolder: string };
    materialise: { enabled: boolean; rootFolder: string; defaultKey: string; keyStyle: "slug" | "verbatim" };
    integrations: {
      maxNodes: number;
      breadcrumbs: { enabled: boolean; showImplied: boolean };
      datacore: { enabled: boolean };
      tasknotes: { enabled: boolean };
      "extended-graph": { enabled: boolean };
    };
    excalidraw: {
      enabled: boolean;
      /** Pele CSS variable → colour overrides for converted drawings; empty = the live theme. */
      palette: Record<string, string>;
      /** Output scale for converted drawings. */
      scale: number;
    };
    cli: { enabled: boolean };
  };
  llm: {
    provider: LlmProviderKind;
    baseUrl: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    timeoutSec: number;
    anthropicKeySecretId: string;
    openaiKeySecretId: string;
  };
}

export type FeatureId = keyof SettingsV3["features"];
/** Integration toggles are addressed as `integrations.<name>`. */
export type IntegrationId = `integrations.${Exclude<keyof SettingsV3["features"]["integrations"], "maxNodes">}`;
export type ToggleId = Exclude<FeatureId, "integrations"> | IntegrationId;

export const TOGGLE_IDS: readonly ToggleId[] = [
  "reflow", "pan-zoom", "resize", "toolbar", "inline-edit", "autocomplete", "live-view", "nested", "bases",
  "view-nodes", "repair", "canvas", "materialise", "excalidraw", "cli",
  "integrations.breadcrumbs", "integrations.datacore", "integrations.tasknotes", "integrations.extended-graph",
];

/**
 * Features with no toggle. `mermaid-override` and `lp-takeover`
 * follow `core.overrideMermaid`; the rest are always on.
 */
export const CORE_FEATURE_IDS = [
  "render-core", "pele-diagram-types", "mermaid-override", "lp-takeover", "link-guard", "math", "hover",
] as const;

/** Fresh-install defaults: light and private. Only `reflow` among the toggles is on. */
export function defaultSettingsV3(): SettingsV3 {
  return {
    settingsVersion: 3,
    core: {
      overrideMermaid: true,
      iconsEnabled: true,
      ganttToday: true,
      appearance: { maxWidth: 0, fontFamily: "", fontSize: 0 },
      security: { allowLinks: true, allowCommandUris: false, commandAllowlist: [], allowRemoteImages: false, sanitize: true },
      advanced: { maxSourceLength: 0, defaultConfigJson: "" },
    },
    features: {
      reflow: { enabled: true, switchDirection: false, minTextScale: 0.8 },
      "pan-zoom": { enabled: false, mode: "auto" },
      resize: { enabled: false },
      toolbar: { enabled: false },
      "inline-edit": { enabled: false },
      autocomplete: { enabled: false, model: "" },
      "live-view": {
        enabled: false, mermaidLabelMode: "directive", embeds: true, noteCardLabels: true,
        maxLabelWidth: 480, maxLabelHeight: 320, maxEmbedWidth: 640, maxEmbedHeight: 480, maxLabels: 50, minEmbedScale: 0.5,
      },
      nested: { enabled: false, maxDepth: 3 },
      bases: { enabled: false },
      "view-nodes": { enabled: false, attachedViews: true, maxLiveViews: 6, webEnabled: false, allowedSchemes: ["https", "http"] },
      repair: {
        enabled: false, preview: false, llm: false,
        jev: {
          enabled: false, transport: "http", baseUrl: "https://api.typesafe.ai", keySecretId: "pele-mermaid-jev-key",
          binPath: "", binConfirmed: "", model: "jev-latest",
        },
      },
      canvas: { enabled: false, portals: "link", portalDepth: 1, layout: "canvas", outputFolder: "" },
      materialise: { enabled: false, rootFolder: "{{folder}}/{{note}}", defaultKey: DEFAULT_EDGE_KEY, keyStyle: "slug" },
      integrations: {
        maxNodes: 200,
        breadcrumbs: { enabled: false, showImplied: false },
        datacore: { enabled: false },
        tasknotes: { enabled: false },
        "extended-graph": { enabled: false },
      },
      excalidraw: { enabled: false, palette: {}, scale: 1 },
      cli: { enabled: false },
    },
    llm: {
      provider: "anthropic", baseUrl: "", model: "claude-sonnet-5-5", reasoningEffort: "default", timeoutSec: 120,
      anthropicKeySecretId: "pele-mermaid-anthropic-key", openaiKeySecretId: "pele-mermaid-openai-key",
    },
  };
}

// -- value guards -------------------------------------------------------------

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
const nonEmpty = (v: unknown, d: string): string => (typeof v === "string" && v.trim() ? v : d);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Number ≥ 0 (0 means "use the default" for these keys). */
const nonNeg = (v: unknown, d: number): number => (finite(v) && v >= 0 ? v : d);
const positive = (v: unknown, d: number): number => (finite(v) && v > 0 ? v : d);
const clamp = (v: unknown, lo: number, hi: number, d: number, round = false): number =>
  finite(v) ? Math.min(hi, Math.max(lo, round ? Math.round(v) : v)) : d;
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
const strRecord = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj(v))) if (typeof val === "string") out[k] = val;
  return out;
};

/**
 * Rebuild a v3 object from the schema: every known key validated (bad values
 * fall back to the fresh default), unknown keys dropped. Idempotent.
 */
export function normalizeV3(raw: unknown): SettingsV3 {
  const d = defaultSettingsV3();
  const r = obj(raw);
  const core = obj(r.core), app = obj(core.appearance), sec = obj(core.security), adv = obj(core.advanced);
  const f = obj(r.features);
  const reflow = obj(f.reflow), pz = obj(f["pan-zoom"]), ac = obj(f.autocomplete), lv = obj(f["live-view"]);
  const nested = obj(f.nested), vn = obj(f["view-nodes"]), rep = obj(f.repair), jev = obj(rep.jev);
  const canvas = obj(f.canvas), mat = obj(f.materialise), integ = obj(f.integrations), ex = obj(f.excalidraw);
  const llm = obj(r.llm);
  const on = (v: unknown, dflt: boolean) => bool(obj(v).enabled, dflt);

  const binPath = str(jev.binPath, d.features.repair.jev.binPath).trim();
  const binConfirmed = str(jev.binConfirmed, "");
  const schemes = Array.isArray(vn.allowedSchemes) ? parseSchemes(vn.allowedSchemes.join(",")) : [];

  return {
    settingsVersion: 3,
    core: {
      overrideMermaid: bool(core.overrideMermaid, d.core.overrideMermaid),
      iconsEnabled: bool(core.iconsEnabled, d.core.iconsEnabled),
      ganttToday: bool(core.ganttToday, d.core.ganttToday),
      appearance: {
        maxWidth: nonNeg(app.maxWidth, d.core.appearance.maxWidth),
        fontFamily: str(app.fontFamily, d.core.appearance.fontFamily),
        fontSize: nonNeg(app.fontSize, d.core.appearance.fontSize),
      },
      security: {
        allowLinks: bool(sec.allowLinks, d.core.security.allowLinks),
        allowCommandUris: sec.allowCommandUris === true,
        commandAllowlist: strList(sec.commandAllowlist),
        allowRemoteImages: bool(sec.allowRemoteImages, d.core.security.allowRemoteImages),
        sanitize: bool(sec.sanitize, d.core.security.sanitize),
      },
      advanced: {
        maxSourceLength: nonNeg(adv.maxSourceLength, d.core.advanced.maxSourceLength),
        defaultConfigJson: str(adv.defaultConfigJson, d.core.advanced.defaultConfigJson),
      },
    },
    features: {
      reflow: {
        enabled: bool(reflow.enabled, d.features.reflow.enabled),
        switchDirection: bool(reflow.switchDirection, d.features.reflow.switchDirection),
        minTextScale: clamp(reflow.minTextScale, 0.3, 1, d.features.reflow.minTextScale),
      },
      "pan-zoom": { enabled: on(pz, false), mode: oneOf(pz.mode, ["auto", "always"] as const, "auto") },
      resize: { enabled: on(f.resize, false) },
      toolbar: { enabled: on(f.toolbar, false) },
      "inline-edit": { enabled: on(f["inline-edit"], false) },
      autocomplete: { enabled: on(ac, false), model: str(ac.model, "").trim() },
      "live-view": {
        enabled: on(lv, false),
        mermaidLabelMode: oneOf(lv.mermaidLabelMode, ["directive", "always"] as const, "directive"),
        embeds: bool(lv.embeds, d.features["live-view"].embeds),
        noteCardLabels: bool(lv.noteCardLabels, d.features["live-view"].noteCardLabels),
        maxLabelWidth: positive(lv.maxLabelWidth, d.features["live-view"].maxLabelWidth),
        maxLabelHeight: positive(lv.maxLabelHeight, d.features["live-view"].maxLabelHeight),
        maxEmbedWidth: positive(lv.maxEmbedWidth, d.features["live-view"].maxEmbedWidth),
        maxEmbedHeight: positive(lv.maxEmbedHeight, d.features["live-view"].maxEmbedHeight),
        maxLabels: positive(lv.maxLabels, d.features["live-view"].maxLabels),
        minEmbedScale: clamp(lv.minEmbedScale, 0, 1, d.features["live-view"].minEmbedScale),
      },
      nested: {
        enabled: on(nested, false),
        maxDepth: finite(nested.maxDepth) && Number.isInteger(nested.maxDepth) && nested.maxDepth >= 0
          ? Math.min(nested.maxDepth, 8) : d.features.nested.maxDepth,
      },
      bases: { enabled: on(f.bases, false) },
      "view-nodes": {
        enabled: on(vn, false),
        attachedViews: bool(vn.attachedViews, d.features["view-nodes"].attachedViews),
        maxLiveViews: clamp(vn.maxLiveViews, 1, 32, d.features["view-nodes"].maxLiveViews, true),
        webEnabled: bool(vn.webEnabled, d.features["view-nodes"].webEnabled),
        allowedSchemes: schemes.length ? schemes : [...d.features["view-nodes"].allowedSchemes],
      },
      repair: {
        enabled: on(rep, false),
        preview: bool(rep.preview, false),
        llm: bool(rep.llm, false),
        jev: {
          enabled: on(jev, false),
          transport: oneOf(jev.transport, ["http", "cli"] as const, "http"),
          baseUrl: nonEmpty(jev.baseUrl, d.features.repair.jev.baseUrl),
          keySecretId: nonEmpty(jev.keySecretId, d.features.repair.jev.keySecretId),
          binPath,
          binConfirmed: binConfirmed && binConfirmed === binPath ? binConfirmed : "",
          model: nonEmpty(jev.model, d.features.repair.jev.model),
        },
      },
      canvas: {
        enabled: on(canvas, false),
        portals: oneOf(canvas.portals, ["link", "inline"] as const, "link"),
        portalDepth: clamp(canvas.portalDepth, 0, 5, d.features.canvas.portalDepth, true),
        layout: oneOf(canvas.layout, ["auto", "canvas"] as const, "canvas"),
        outputFolder: str(canvas.outputFolder, ""),
      },
      materialise: {
        enabled: on(mat, false),
        rootFolder: nonEmpty(mat.rootFolder, d.features.materialise.rootFolder),
        defaultKey: nonEmpty(mat.defaultKey, DEFAULT_EDGE_KEY).trim(),
        keyStyle: oneOf(mat.keyStyle, ["slug", "verbatim"] as const, "slug"),
      },
      integrations: {
        maxNodes: clamp(finite(integ.maxNodes) ? Math.floor(integ.maxNodes) : undefined, 1, 1000, d.features.integrations.maxNodes),
        breadcrumbs: { enabled: on(integ.breadcrumbs, false), showImplied: bool(obj(integ.breadcrumbs).showImplied, false) },
        datacore: { enabled: on(integ.datacore, false) },
        tasknotes: { enabled: on(integ.tasknotes, false) },
        "extended-graph": { enabled: on(integ["extended-graph"], false) },
      },
      excalidraw: { enabled: on(ex, false), palette: strRecord(ex.palette), scale: clamp(ex.scale, 0.1, 10, 1) },
      cli: { enabled: on(f.cli, false) },
    },
    llm: {
      provider: oneOf(llm.provider, ["anthropic", "openai"] as const, "anthropic"),
      baseUrl: str(llm.baseUrl, ""),
      model: nonEmpty(llm.model, d.llm.model),
      reasoningEffort: oneOf(llm.reasoningEffort, ["default", "none", "low", "medium", "high"] as const, "default"),
      timeoutSec: positive(llm.timeoutSec, d.llm.timeoutSec),
      anthropicKeySecretId: nonEmpty(llm.anthropicKeySecretId, d.llm.anthropicKeySecretId),
      openaiKeySecretId: nonEmpty(llm.openaiKeySecretId, d.llm.openaiKeySecretId),
    },
  };
}

/** Does this raw object have the v3 layout? */
export function isV3Shape(raw: unknown): boolean {
  const r = obj(raw);
  return finite(r.settingsVersion) && r.settingsVersion >= 3 && typeof r.core === "object" && typeof r.features === "object";
}

/** Is a toggle on? */
export function isEnabledV3(s: SettingsV3, id: ToggleId): boolean {
  if (id.startsWith("integrations.")) {
    const name = id.slice("integrations.".length) as Exclude<keyof SettingsV3["features"]["integrations"], "maxNodes">;
    return s.features.integrations[name].enabled;
  }
  return (s.features[id as Exclude<FeatureId, "integrations">]).enabled;
}

/** Set a toggle (mutates `s`). */
export function setEnabledV3(s: SettingsV3, id: ToggleId, on: boolean): void {
  if (id.startsWith("integrations.")) {
    const name = id.slice("integrations.".length) as Exclude<keyof SettingsV3["features"]["integrations"], "maxNodes">;
    s.features.integrations[name].enabled = on;
    return;
  }
  (s.features[id as Exclude<FeatureId, "integrations">]).enabled = on;
}

/** Every feature that is on: the core set plus the toggles that are enabled. */
export function enabledFeatureIds(s: SettingsV3): string[] {
  const core = CORE_FEATURE_IDS.filter((id) => s.core.overrideMermaid || (id !== "mermaid-override" && id !== "lp-takeover"));
  return [...core, ...TOGGLE_IDS.filter((id) => isEnabledV3(s, id))];
}

/**
 * Re-validate `s` in place: the result of `normalizeV3(s)` is written into the
 * existing objects, so references held to `s` or its sub-objects stay current.
 */
export function normalizeInPlace(s: SettingsV3): void {
  assignDeep(s as unknown as Obj, normalizeV3(s) as unknown as Obj);
}

function assignDeep(target: Obj, src: Obj): void {
  for (const k of Object.keys(target)) if (!(k in src)) delete target[k];
  for (const [k, v] of Object.entries(src)) {
    const cur = target[k];
    const plain = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
    if (plain(v) && plain(cur)) assignDeep(cur as Obj, v as Obj);
    else target[k] = v;
  }
}
