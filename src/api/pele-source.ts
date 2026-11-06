/**
 * Canvas embeds: a fence with a `cannoli` token in its info string whose whole
 * body is the single line `%% pele-source: [[X.canvas]] %%` shows the canvas, converted to
 * Mermaid, through the host's mountCanvas. The frame keys to the fence and has no fence line,
 * so edit gestures never write converted Mermaid into the comment body. The Reading-view
 * processor and the Live Preview widget both call mountPeleSource.
 */
import type { TFile } from "obsidian";
import type { FenceLocation } from "./frame-handles";
import type { MountCanvasOpts } from "./host-api";

const PELE_SOURCE = /^%%\s*pele-source:\s*\[\[([^\]|#\n]+)(?:\|[^\]\n]*)?\]\]\s*%%$/;

/** The canvas path of a pele-source body (`.canvas` appended when missing), or null when the body is anything else. */
export function parsePeleSource(body: string): string | null {
  const m = PELE_SOURCE.exec(body.trim());
  const path = m?.[1]?.trim();
  if (!path) return null;
  return /\.canvas$/i.test(path) ? path : `${path}.canvas`;
}

/** Whether a fence's info-string rest carries the `cannoli` token. */
export function isCannoliFence(fenceRest: string): boolean {
  return fenceRest.split(/\s+/).includes("cannoli");
}

export interface PeleSourceDeps {
  /** metadataCache.getFirstLinkpathDest. */
  resolve(link: string, sourcePath: string): TFile | null;
  /** The host-internal mountCanvas. */
  mountCanvas(file: TFile, el: HTMLElement, opts: MountCanvasOpts): { destroy(): void };
}

/**
 * Mounts the canvas a pele-source fence names into `el`; a missing canvas shows a `.pele-error`.
 * Null when the fence is not a canvas embed (the caller renders it as a normal diagram).
 */
export function mountPeleSource(
  deps: PeleSourceDeps,
  source: string,
  el: HTMLElement,
  sourcePath: string,
  fenceRest: string,
  key: string,
  locate: () => FenceLocation | null,
): { destroy(): void } | null {
  if (!isCannoliFence(fenceRest)) return null;
  const link = parsePeleSource(source);
  if (link === null) return null;
  const file = deps.resolve(link, sourcePath);
  if (file?.extension !== "canvas") {
    const err = el.createDiv({ cls: "pele-error", text: `Canvas not found: ${link}` });
    return { destroy: () => err.remove() };
  }
  return deps.mountCanvas(file, el, { fenceRest, key, locate, sourcePath });
}
