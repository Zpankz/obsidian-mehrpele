/**
 * Where a nested (or portalled) diagram's source lives, and the gesture
 * rules for opening it from the nested frame. Pure — no Obsidian imports —
 * so the rules are unit-testable; main.ts does the DOM wiring and opening.
 */
import { isCanvasTarget } from "./embeds";
import type { MehrpeleEmbedTarget } from "./model";

export type NestedOrigin =
  /** `![[Note]]`, `![[Note#Heading]]`, `![[Note#^id]]` or a diagram file. */
  | { kind: "embed"; linkpath: string; subpath: string; sourcePath: string }
  /** `![[x.canvas]]` / `![[x.canvas#node-id]]` (Advanced Canvas portals). */
  | { kind: "portal"; linkpath: string; subpath: string; sourcePath: string }
  /** A fence written inside the label: lives in the outer block. */
  | { kind: "inline"; sourcePath: string; line?: number };

/** Origin of a sole-embed label. */
export function embedOrigin(target: MehrpeleEmbedTarget, sourcePath: string): NestedOrigin {
  return {
    kind: isCanvasTarget(target) ? "portal" : "embed",
    linkpath: target.linkpath,
    subpath: target.subpath,
    sourcePath,
  };
}

/**
 * Origin of an inline fence: the enclosing diagram's own origin when that
 * diagram is itself nested (its source lives there), else the outer block.
 */
export function inlineOrigin(parent: NestedOrigin | undefined, sourcePath: string, line?: number): NestedOrigin {
  if (parent) return parent;
  return line === undefined ? { kind: "inline", sourcePath } : { kind: "inline", sourcePath, line };
}

/** Link text for `openLinkText` / hover previews (headings and blocks scroll into view). */
export function originLinktext(origin: NestedOrigin): string {
  return origin.kind === "inline" ? origin.sourcePath : `${origin.linkpath}${origin.subpath}`;
}

/** Canvas node id of a portal's `#node-id` subpath, if any. */
export function portalNodeId(origin: NestedOrigin): string | null {
  if (origin.kind !== "portal") return null;
  const id = origin.subpath.replace(/^#\^?/, "");
  return id ? id : null;
}

/** Tooltip of the "Open original" action. */
export function originTooltip(origin: NestedOrigin): string {
  if (origin.kind === "inline") return "Reveal block in editor";
  const name = origin.linkpath.split("/").pop() ?? origin.linkpath;
  return `Open ${name}${origin.subpath}`;
}

/** Targets that keep their own click behaviour (links, our handles, chrome). */
export const ORIGIN_IGNORE =
  "a, button, input, select, textarea, .embed-actions, .image-resize-corner, .mehrpele-node-resize, .pele-source-panel, .pele-error-actions";

/** Class on every element that opens an origin (nested frames, portal embeds). */
export const ORIGIN_ROOT_CLASS = "pele-origin-root";

/** Drag distance (px) past which a press is a drag, never an open. */
export const ORIGIN_CLICK_SLOP = 4;

interface ClosestLike {
  closest?(selector: string): unknown;
}

export type OriginPane = "tab" | "split" | "window" | boolean;

/**
 * Whether a click on a nested frame opens its original, and where:
 * Mod-click (Cmd/Ctrl, + Alt = split, + Alt+Shift = window) or middle-click
 * on the diagram background, per `Keymap.isModEvent` (`pane`). Plain clicks
 * and double-clicks never navigate. Null = not ours.
 */
export function originGesture(
  evt: { type: string; button: number; target: unknown; clientX: number; clientY: number },
  ctx: {
    /** `Keymap.isModEvent(evt)`. */
    pane: OriginPane;
    /** The origin root (nested frame / portal embed) the listener is on. */
    root: unknown;
    /** Where the pointer went down in this frame (null = not pressed here). */
    pressedAt: { x: number; y: number } | null;
    /** A resize drag is in progress here or in an enclosing frame. */
    resizing: boolean;
  },
): OriginPane | null {
  const middle = evt.type === "auxclick" && evt.button === 1;
  const modClick = evt.type === "click" && evt.button === 0 && !!ctx.pane;
  if (!middle && !modClick) return null;
  if (ctx.resizing) return null;
  const target = evt.target as ClosestLike | null;
  if (typeof target?.closest !== "function") return null;
  if (target.closest(ORIGIN_IGNORE)) return null;
  // A deeper nested frame or portal handles its own background.
  if (target.closest(`.${ORIGIN_ROOT_CLASS}`) !== ctx.root) return null;
  if (ctx.pressedAt) {
    const moved = Math.hypot(evt.clientX - ctx.pressedAt.x, evt.clientY - ctx.pressedAt.y);
    if (moved > ORIGIN_CLICK_SLOP) return null;
  }
  return middle ? "tab" : ctx.pane;
}
