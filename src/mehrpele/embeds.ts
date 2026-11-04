/**
 * Sole-embed handling + the embed-renderer extension seam.
 * The Advanced Canvas module registers a portal renderer here without
 * touching label extraction, measurement or overlay code.
 */
import type { Component } from "obsidian";
import type { MehrpeleEmbedTarget } from "./model";
import { parseEmbedSize } from "./model";
import type { NestedOrigin } from "./origin";
import type { MehrpeleSettings } from "./settings";

export interface MehrpeleEmbedContext {
  sourcePath: string;
  settings: MehrpeleSettings;
  /** Where the embedded content lives (portals open their `.canvas`). */
  origin?: NestedOrigin;
  /** The label's component: unloads when the label is released (view-nodes). */
  component?: Component;
}

/** Return true when the renderer handled the embed. */
export type EmbedRenderer = (
  target: MehrpeleEmbedTarget,
  el: HTMLElement,
  ctx: MehrpeleEmbedContext,
) => boolean | Promise<boolean>;

interface EmbedRendererEntry {
  match: (t: MehrpeleEmbedTarget) => boolean;
  render: EmbedRenderer;
}

const registry: EmbedRendererEntry[] = [];

/** Register an embed renderer (e.g. the Canvas portal renderer). Returns its unregister. */
export function registerEmbedRenderer(
  match: (t: MehrpeleEmbedTarget) => boolean,
  render: EmbedRenderer,
): () => void {
  const entry = { match, render };
  registry.push(entry);
  return () => {
    const i = registry.indexOf(entry);
    if (i >= 0) registry.splice(i, 1);
  };
}

/** Registered renderers, in registration order (built-ins first). */
export function embedRenderers(): EmbedRendererEntry[] {
  return [...registry];
}

export function clearEmbedRenderersForTest(): void {
  registry.length = 0;
}

export function isEmbedTarget(target: MehrpeleEmbedTarget): boolean {
  return target.linkpath.length > 0;
}

export function isBaseTarget(target: MehrpeleEmbedTarget): boolean {
  return target.linkpath.toLowerCase().endsWith(".base");
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/**
 * Image embeds size to the rendered image (honouring `|W` / `|WxH`), not to
 * the fixed embed box: their reservation follows the measured image like any
 * other label, so `![[x.png|100]]` gets a 100px-wide node, not 320×240.
 */
export function isImageTarget(target: MehrpeleEmbedTarget): boolean {
  return IMAGE_EXT_RE.test(target.linkpath.trim());
}

export function isCanvasTarget(target: MehrpeleEmbedTarget): boolean {
  return target.linkpath.toLowerCase().endsWith(".canvas");
}

/** Fixed box for a sole-embed label: `|WxH` wins, settings cap. */
export function embedBoxSize(
  target: MehrpeleEmbedTarget,
  settings: MehrpeleSettings,
): { width: number; height: number } {
  // The size is the last `|` segment (`![[Note|alias|400x300]]`, `![T|400x300](https://…)`), as resizes write it.
  const parsed = parseEmbedSize(target.aliasOrSize?.split("|").pop()); // view-nodes
  const width = Math.min(
    parsed.width ?? settings.embedDefaultWidth,
    settings.maxEmbedWidth,
  );
  const height = Math.min(
    parsed.height ?? settings.embedDefaultHeight,
    settings.maxEmbedHeight,
  );
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/** The embed syntax re-rendered through MarkdownRenderer for this target. */
export function embedMarkdown(target: MehrpeleEmbedTarget): string {
  const size = target.aliasOrSize ? `|${target.aliasOrSize}` : "";
  return `![[${target.linkpath}${target.subpath}${size}]]`;
}
