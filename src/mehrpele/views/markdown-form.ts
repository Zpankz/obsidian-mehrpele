/**
 * The Markdown form of a web node, `A["![Title|440x320](https://…)"]`, is
 * also Markdown image syntax: badges and CDN images (`img.shields.io/…`,
 * `…?w=800`) often have no file extension. So the label stays Markdown (an
 * image, exactly as before) unless view nodes and web pages are on, the URL
 * is allowed, and it does not load as an image. Verdicts are cached per URL.
 */
import type { MehrpeleEmbedTarget } from "../model";
import type { MehrpeleSettings } from "../settings";
import { webUrlAllowed } from "./settings";
import { parseSoleWebEmbed } from "./syntax";

const verdicts = new Map<string, Promise<boolean>>();

/** True when `url` is not an image (it is shown as a web page). */
export function isWebPage(url: string, timeoutMs = 2500): Promise<boolean> {
  let v = verdicts.get(url);
  if (!v) {
    v = new Promise<boolean>((resolve) => {
      if (typeof Image === "undefined") return resolve(true);
      const img = new Image();
      const done = (page: boolean): void => {
        window.clearTimeout(timer);
        img.onload = img.onerror = null;
        resolve(page);
      };
      // A page that takes this long to answer is not a quick image either.
      const timer = window.setTimeout(() => done(true), timeoutMs);
      img.onload = () => done(false);
      img.onerror = () => {
        // A failed image (offline, 404) may be an image later: ask again in a minute.
        window.setTimeout(() => verdicts.delete(url), 60_000);
        done(true);
      };
      img.referrerPolicy = "no-referrer";
      img.src = url;
    });
    verdicts.set(url, v);
  }
  return v;
}

/** The web-view target for a sole `![…](https://…)` label that is a page, else undefined. */
export async function markdownWebTarget(markdown: string, settings: MehrpeleSettings): Promise<MehrpeleEmbedTarget | undefined> {
  const vn = settings.viewNodes;
  if (!vn?.enabled || !vn.webEnabled || !settings.allowEmbeds) return undefined;
  const target = parseSoleWebEmbed(markdown);
  if (!target || !webUrlAllowed(target.linkpath, vn)) return undefined;
  return (await isWebPage(target.linkpath)) ? target : undefined;
}

/** Start every Markdown-form probe of a diagram at once (labels then await cached verdicts). */
export function prefetchWebVerdicts(markdowns: string[], settings: MehrpeleSettings): void {
  for (const md of markdowns) void markdownWebTarget(md, settings);
}

export function clearWebVerdictsForTest(): void {
  verdicts.clear();
}
