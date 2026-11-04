/**
 * Modified clicks on a frame's zoom and code buttons (desktop):
 *
 * - zoom: Mod → the diagram in a new tab, Mod+Alt → to the right,
 *   Mod+Alt+Shift → a new window (Keymap.isModEvent's panes, as for links);
 * - code: Mod → open as a canvas, Mod+Alt → the note's source to the right
 *   at the block's fence, Mod+Alt+Shift → the same in a new window.
 *
 * The buttons are the frame's own (diagram-frame / Mehrpele shell): they are
 * tagged here, their tooltips list the variants, and a capture listener on
 * the action bar takes modified clicks before the buttons' plain handlers.
 * Icons and tooltips follow held keys through mod-icons.
 */
import { Notice, Platform, setTooltip, type App } from "obsidian";
import { editSourceIn, frameLine, openDiagramView, type Pane } from "../diagram-view";
import { modAction, modState, tipWithHints, variantId } from "./mod-actions";

export interface FrameActionsHost {
  app: App;
  /** Write the diagram to a canvas next to its note and open it. */
  convertToCanvas?(source: string, sourcePath: string, lang: string): Promise<string | null>;
}

export interface FrameActionsTarget {
  root: HTMLElement;
  lang: string;
  sourcePath: string;
  source(): string;
}

const ZOOM = ".pele-zoom-action";
const CODE = ".pele-code-action";

export function attachFrameActions(host: FrameActionsHost, frame: FrameActionsTarget): () => void {
  if (Platform.isMobile) return () => undefined;
  const bar = frame.root.querySelector<HTMLElement>(":scope > .embed-actions");
  const zoom = bar?.querySelector<HTMLElement>(":scope > .embed-action:has(> .lucide-zoom-in)");
  const code = bar?.querySelector<HTMLElement>(":scope > .edit-block-button");
  if (!bar || (!zoom && !code)) return () => undefined;
  const isMac = Platform.isMacOS;
  const tag = (el: HTMLElement | null | undefined, cls: string, fallback: string) => {
    if (!el) return;
    el.addClass(cls.slice(1));
    setTooltip(el, tipWithHints(el.getAttribute("aria-label") || fallback, modAction(cls), isMac));
  };
  tag(zoom, ZOOM, "Zoom in");
  tag(code, CODE, "Edit block");

  const onClick = (e: MouseEvent) => {
    const btn = (e.target as Element | null)?.closest?.(`${ZOOM}, ${CODE}`);
    if (!btn || btn.parentElement !== bar) return;
    const isZoom = btn.matches(ZOOM);
    const id = variantId(modAction(isZoom ? ZOOM : CODE), modState(e, isMac));
    if (!id) return; // plain click: the button's own action
    e.preventDefault();
    e.stopImmediatePropagation();
    void run(host, frame, isZoom, id).catch((err: unknown) => {
      console.error("[pele-mermaid] frame action", err);
      new Notice(`Pele: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  bar.addEventListener("click", onClick, true);
  return () => bar.removeEventListener("click", onClick, true);
}

async function run(host: FrameActionsHost, frame: FrameActionsTarget, isZoom: boolean, id: string): Promise<void> {
  const source = frame.source();
  const line = frameLine(host.app, frame.root, frame.sourcePath);
  if (isZoom) return openDiagramView(host.app, frame.sourcePath, frame.lang, source, id as Pane, line);
  if (id === "canvas") {
    if (!host.convertToCanvas) throw new Error("canvas conversion is unavailable");
    await host.convertToCanvas(source, frame.sourcePath, frame.lang);
    return;
  }
  await editSourceIn(host.app, frame.sourcePath, source, id as "split" | "window", line);
}
