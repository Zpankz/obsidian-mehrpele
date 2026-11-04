/**
 * Per-render generator context for integration flowcharts: Advanced URI deep
 * links (when that plugin is enabled) and the optional Extended Graph style
 * map (setting "Use Extended Graph colours"). Obsidian side; generators stay pure.
 */
import type { App } from "obsidian";
import type { GeneratorOptions, GraphSpec } from "./graph-to-pele";
import { communityPluginEnabled, readExtendedGraphStyle, styleGraphWithExtendedGraph } from "./extended-graph/index";
import type { IntegrationSettings } from "./settings";

export const ADVANCED_URI_ID = "obsidian-advanced-uri";

export function advancedUriEnabled(app: App): boolean {
  return communityPluginEnabled(app, ADVANCED_URI_ID);
}

/** Vault name when Advanced URI is enabled, else undefined (internal links). */
export function advancedUriVault(app: App): string | undefined {
  return advancedUriEnabled(app) ? app.vault.getName() : undefined;
}

/** Apply link + style context to a flowchart GraphSpec before generation. */
export function prepareFlowchart(
  app: App,
  settings: IntegrationSettings,
  spec: GraphSpec,
  base: GeneratorOptions,
): { spec: GraphSpec; options: GeneratorOptions } {
  const style = settings.extendedGraph.useColors ? readExtendedGraphStyle(app) : null;
  const styled = styleGraphWithExtendedGraph(app, spec, style);
  return {
    spec: styled.spec,
    options: { ...base, ...styled.options, advancedUriVault: advancedUriVault(app) },
  };
}
