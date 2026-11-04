/**
 * Extended Graph adapter (Obsidian side). Reads only the plugin's settings
 * data — never its code (GPLv3, see style-map.ts) — and gathers node facts
 * (tags, frontmatter, path) from the metadata cache. EG 2.x keeps its live
 * settings in a module-private static (not on the plugin instance), so we use
 * its persisted `data.json`, primed at load and refreshed when the file changes.
 */
import { getAllTags, type App, type CachedMetadata } from "obsidian";
import type { GraphNode, GraphSpec } from "../graph-to-pele";
import {
  applyExtendedGraphStyle,
  egClassName,
  nodeColorFor,
  parseExtendedGraphSettings,
  themeSafeClassDef,
  type ExtendedGraphStyle,
  type NodeFacts,
  type StyledGraph,
} from "./style-map";

export const EXTENDED_GRAPH_ID = "extended-graph";

interface PluginsLike {
  plugins?: Record<string, { settings?: unknown } | undefined>;
  enabledPlugins?: Set<string> | string[];
}

let warned = false;
let diskSettings: unknown;

/** EG's persisted settings file inside the vault config dir. */
export function extendedGraphDataPath(app: App): string {
  return `${app.vault.configDir}/plugins/${EXTENDED_GRAPH_ID}/data.json`;
}

/** Load (or reload) EG's persisted settings into the cache; safe when absent. */
export async function primeExtendedGraphSettings(app: App): Promise<void> {
  try {
    const path = extendedGraphDataPath(app);
    diskSettings = (await app.vault.adapter.exists(path)) ? JSON.parse(await app.vault.adapter.read(path)) : undefined;
    warned = false;
  } catch {
    diskSettings = undefined;
  }
}

/** Is a community plugin both enabled and loaded? */
export function communityPluginEnabled(app: App, id: string): boolean {
  const plugins = (app as unknown as { plugins?: PluginsLike }).plugins;
  if (!plugins?.plugins?.[id]) return false;
  const enabled = plugins.enabledPlugins;
  if (enabled instanceof Set) return enabled.has(id);
  if (Array.isArray(enabled)) return enabled.includes(id);
  return true;
}

/**
 * Current Extended Graph style, or null when the plugin is absent/disabled or
 * its settings shape is unrecognised (logged once per launch, then skipped).
 */
export function readExtendedGraphStyle(app: App): ExtendedGraphStyle | null {
  if (!communityPluginEnabled(app, EXTENDED_GRAPH_ID)) return null;
  const plugins = (app as unknown as { plugins?: PluginsLike }).plugins;
  const live = plugins?.plugins?.[EXTENDED_GRAPH_ID]?.settings;
  const parsed = parseExtendedGraphSettings(live ?? diskSettings);
  if (!parsed.ok) {
    if (!warned) {
      warned = true;
      console.warn(`[pele-mermaid] Extended Graph settings not recognised (${parsed.reason}); using default colours.`);
    }
    return null;
  }
  return parsed.style;
}

function stringValues(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(stringValues);
  if (typeof v === "string") {
    // Frontmatter links (`[[Note]]`) compare by their link text.
    const m = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(v.trim());
    return [m ? m[1].trim() : v.trim()];
  }
  if (typeof v === "number" || typeof v === "boolean") return [String(v)];
  return [];
}

/** Node facts for a vault path from the metadata cache. */
export function nodeFactsFor(app: App, path: string): NodeFacts {
  const file = app.vault.getFileByPath(path);
  let cache: CachedMetadata | null = null;
  try {
    cache = file ? app.metadataCache.getFileCache(file) : null;
  } catch {
    cache = null;
  }
  const tags = cache ? (getAllTags(cache) ?? []).map((t) => t.replace(/^#/, "")) : [];
  const properties: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(cache?.frontmatter ?? {})) {
    properties[key.toLowerCase()] = stringValues(value);
  }
  return { path, tags, properties };
}

function nodePath(node: GraphNode): string | undefined {
  const candidate = node.href?.trim() || node.id;
  if (!candidate || /^[a-z][a-z0-9+.-]*:/i.test(candidate)) return undefined;
  return candidate;
}

/** Decorate a GraphSpec with Extended Graph colours/shapes (null style = unchanged). */
export function styleGraphWithExtendedGraph(app: App, spec: GraphSpec, style: ExtendedGraphStyle | null): StyledGraph {
  if (!style) return { spec, options: {} };
  return applyExtendedGraphStyle(spec, style, (node) => {
    const path = nodePath(node);
    return path ? nodeFactsFor(app, path) : undefined;
  });
}

/**
 * Bases-view node style from Extended Graph colours. `classDefs` fills as
 * `classesFor` resolves entries (bases-source reads it right after).
 */
export function basesNodeStyleFromExtendedGraph(
  app: App,
  style: ExtendedGraphStyle | null,
): { classesFor(entry: { path: string }): string[]; classDefs: Record<string, string> } | null {
  if (!style) return null;
  const classDefs: Record<string, string> = {};
  return {
    classDefs,
    classesFor(entry) {
      const color = nodeColorFor(style, nodeFactsFor(app, entry.path));
      if (!color) return [];
      const cls = `pele-${egClassName(color.key, color.type)}`;
      classDefs[cls] = themeSafeClassDef(color.color);
      return [cls];
    },
  };
}
