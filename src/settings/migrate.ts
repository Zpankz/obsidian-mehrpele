/**
 * v1/v2 → v3 settings migration. Pure.
 *
 * v1/v2 data first goes through the v2 normaliser, which fills every absent key
 * with its OLD default and applies the v1→v2 zoom reset. So an absent key keeps
 * the behaviour it had before the upgrade. The result is then mapped onto v3 and
 * rebuilt by `normalizeV3`, so retired and unknown keys are dropped.
 */
import { normalizeSettings, type PeleSettings } from "./v2";
import { defaultSettingsV3, isV3Shape, normalizeV3, type SettingsV3 } from "./schema";

export interface MigrateContext {
  /** pele-excalidraw is installed and enabled (carries over to `features.excalidraw.enabled`). */
  peleExcalidrawEnabled?: boolean;
}

export type MigrateFrom = "fresh" | "v2" | "v3";

export interface MigrateResult {
  settings: SettingsV3;
  /** The stored data differs from the result and should be saved now. */
  changed: boolean;
  from: MigrateFrom;
}

/**
 * Map a fully normalised v2 object onto v3 (before schema validation).
 * `storedSanitize` is the raw stored `sanitizeSvg`, if any: an explicit value
 * survives, an absent one gets the new default.
 */
export function v2ToV3(v2: PeleSettings, ctx: MigrateContext = {}, storedSanitize?: unknown): SettingsV3 {
  const d = defaultSettingsV3();
  const m = v2.mehrpele;
  const vn = m.viewNodes;
  const r = v2.repair;
  const i = v2.integrations;
  const sanitize = typeof storedSanitize === "boolean" ? storedSanitize : d.core.security.sanitize;
  return {
    settingsVersion: 3,
    core: {
      overrideMermaid: v2.overrideMermaid,
      iconsEnabled: v2.iconsEnabled,
      ganttToday: v2.ganttToday,
      appearance: { maxWidth: v2.maxWidth, fontFamily: v2.fontFamily, fontSize: v2.fontSize },
      security: {
        allowLinks: v2.allowLinks,
        allowCommandUris: v2.linkPolicy.allowCommandUris,
        commandAllowlist: [...v2.linkPolicy.commandAllowlist],
        allowRemoteImages: v2.allowRemoteImages,
        sanitize,
      },
      advanced: { maxSourceLength: v2.maxSourceLength, defaultConfigJson: v2.defaultConfigJson },
    },
    features: {
      reflow: {
        enabled: v2.reflow.enabled,
        switchDirection: v2.reflow.switchDirection && v2.reflow.autoTurn,
        minTextScale: v2.reflow.minTextScale,
      },
      "pan-zoom": {
        enabled: v2.zoomMode === "auto" || v2.zoomMode === "always",
        mode: v2.zoomMode === "always" ? "always" : "auto",
      },
      resize: { enabled: v2.nodeResize !== "off" },
      toolbar: { enabled: v2.edit.toolbar },
      "inline-edit": { enabled: v2.edit.inlineEdit },
      autocomplete: { enabled: v2.edit.autocomplete.enabled, model: v2.edit.autocomplete.model },
      "live-view": {
        enabled: v2.mehrpeleEnabled,
        mermaidLabelMode: m.mermaidLabelMode === "always" ? "always" : "directive",
        embeds: m.allowEmbeds,
        noteCardLabels: m.noteCardLabels,
        maxLabelWidth: m.maxLabelWidth,
        maxLabelHeight: m.maxLabelHeight,
        maxEmbedWidth: m.maxEmbedWidth,
        maxEmbedHeight: m.maxEmbedHeight,
        maxLabels: m.maxLabels,
        minEmbedScale: m.embedSizing === "exact" ? 0 : m.minEmbedScale,
      },
      nested: { enabled: m.nestedDiagrams, maxDepth: m.maxNestingDepth },
      bases: { enabled: m.basesViewEnabled },
      "view-nodes": {
        enabled: vn.enabled,
        attachedViews: vn.attachedViews,
        maxLiveViews: vn.maxLiveViews,
        webEnabled: vn.webEnabled,
        allowedSchemes: [...vn.allowedSchemes],
      },
      repair: {
        enabled: true,
        preview: r.previewBeforeApplying,
        llm: r.tierLlm,
        jev: {
          enabled: r.tierJev,
          transport: r.jevTransport,
          baseUrl: r.jevBaseUrl,
          keySecretId: r.jevKeySecretId,
          binPath: r.jevBinPath,
          binConfirmed: r.jevBinConfirmed, // normalizeV3 keeps it only if it equals binPath
          model: r.jevModel,
        },
      },
      canvas: { ...v2.canvas, enabled: true },
      materialise: {
        enabled: true,
        rootFolder: v2.materialise.rootFolder,
        defaultKey: v2.materialise.defaultKey,
        keyStyle: v2.materialise.keyStyle,
      },
      integrations: {
        maxNodes: Math.max(i.breadcrumbs.maxNodes, i.datacore.maxNodes, i.tasknotes.maxNodes),
        breadcrumbs: { enabled: i.breadcrumbs.enabled, showImplied: i.breadcrumbs.showImplied },
        datacore: { enabled: i.datacore.enabled },
        tasknotes: { enabled: i.tasknotes.enabled },
        "extended-graph": { enabled: i.extendedGraph.useColors },
      },
      excalidraw: { ...d.features.excalidraw, enabled: ctx.peleExcalidrawEnabled === true },
      cli: { enabled: v2.cliEnabled },
    },
    llm: {
      provider: r.llmProvider,
      baseUrl: r.llmBaseUrl,
      model: r.llmModel,
      reasoningEffort: r.llmReasoningEffort,
      timeoutSec: r.llmTimeoutSec,
      anthropicKeySecretId: r.anthropicKeySecretId,
      openaiKeySecretId: r.openaiKeySecretId,
    },
  };
}

/**
 * Migrate whatever `loadData()` returned to v3.
 * - `null`/non-object → fresh v3 defaults, `changed: true` so they are written.
 * - v3 → re-validated; `changed` only if validation altered it (unknown keys, bad values).
 * - v1/v2 → behaviour-preserving map, `changed: true`.
 */
export function migrate(raw: unknown, ctx: MigrateContext = {}): MigrateResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { settings: defaultSettingsV3(), changed: true, from: "fresh" };
  }
  if (isV3Shape(raw)) {
    const settings = normalizeV3(raw);
    return { settings, changed: JSON.stringify(settings) !== JSON.stringify(raw), from: "v3" };
  }
  const data = raw as Partial<PeleSettings>;
  const v2 = normalizeSettings(data);
  return { settings: normalizeV3(v2ToV3(v2, ctx, data.sanitizeSvg)), changed: true, from: "v2" };
}
