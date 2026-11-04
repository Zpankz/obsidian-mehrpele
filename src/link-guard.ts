/**
 * Capture-phase guard for obsidian:// links clicked inside Pele diagrams,
 * Mehrpele overlays and the lightbox. Diagrams can come from untrusted notes,
 * and Advanced URI's `commandid`/`data` params run commands or write notes, so
 * this runs before Obsidian's own (delegated) link handlers and the browser's
 * default navigation.
 */
import {
  classifyObsidianUri,
  isObsidianUri,
  obsidianUriBlockedMessage,
  type ObsidianUriPolicy,
} from "./link-classify";

const SCOPE = ".pele-embed, .pele-host, .lightbox";

interface ClickLike {
  target: EventTarget | null;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

interface AnchorLike {
  getAttribute(name: string): string | null;
  /** HTMLAnchorElement: resolved string; SVGAElement: SVGAnimatedString. */
  href?: unknown;
  ownerDocument?: { baseURI?: string } | null;
}

/** Raw attribute href (HTML `href`, SVG `href`/`xlink:href`). */
function rawHref(anchor: AnchorLike): string {
  const animated = anchor.href as { baseVal?: unknown } | undefined;
  if (animated && typeof animated === "object" && typeof animated.baseVal === "string") {
    return animated.baseVal;
  }
  return anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href") ?? "";
}

/**
 * The URL the browser will actually navigate to: `HTMLAnchorElement.href` is
 * already parsed; SVG anchors are resolved with `new URL(raw, baseURI)`.
 * Null when the href does not parse (the browser would not navigate either).
 */
export function parsedAnchorUrl(anchor: AnchorLike): { href: string; protocol: string } | null {
  try {
    if (typeof anchor.href === "string" && anchor.href) {
      const u = new URL(anchor.href);
      return { href: u.href, protocol: u.protocol };
    }
    const base =
      anchor.ownerDocument?.baseURI ??
      (window as { document?: { baseURI?: string } }).document?.baseURI ??
      "app://obsidian.md/";
    const u = new URL(rawHref(anchor), base);
    return { href: u.href, protocol: u.protocol };
  } catch {
    return null;
  }
}

/** Stops the click and reports why when it's a blocked obsidian:// link in scope. */
export function guardAnchorClick(
  evt: ClickLike,
  policy: ObsidianUriPolicy,
  notify: (message: string) => void,
): boolean {
  const anchor = (evt.target as Element | null)?.closest?.("a") as (Element & AnchorLike) | null | undefined;
  if (!anchor || !anchor.closest(SCOPE)) return false;
  const raw = rawHref(anchor);
  const parsed = parsedAnchorUrl(anchor);
  const parsedIsObsidian = parsed?.protocol.toLowerCase() === "obsidian:";
  if (!parsedIsObsidian && !isObsidianUri(raw)) return false;
  // Classify both the authored and the browser-parsed form; either being
  // blocked (or not an allowed navigation/command) blocks the click.
  const candidates = [raw, ...(parsedIsObsidian && parsed ? [parsed.href] : [])];
  let blocked: ReturnType<typeof classifyObsidianUri> | null = null;
  for (const href of candidates) {
    const c = classifyObsidianUri(href, policy);
    if (c.outcome !== "navigation" && c.outcome !== "command") {
      blocked = c;
      break;
    }
  }
  if (!blocked) return false;
  evt.preventDefault();
  evt.stopImmediatePropagation();
  notify(obsidianUriBlockedMessage(blocked));
  return true;
}

/**
 * Attach-once helper: `attach(doc)` runs at most once per Document (main
 * window, already-open popouts at load/layout-ready, future `window-open`).
 */
export function createDocumentGuard<D extends object>(attach: (doc: D) => void): (doc: D | null | undefined) => boolean {
  const seen = new WeakSet<D>();
  return (doc) => {
    if (!doc || seen.has(doc)) return false;
    seen.add(doc);
    attach(doc);
    return true;
  };
}
