/**
 * Obsidian 1.15 core-Pele look parity, DOM-light (no `obsidian` import) so the
 * pieces unit-test without an app.
 *
 * Core styles `.mermaid` (theme vars, `.mermaid .pele a.internal-link`, LP zoom
 * offsets), so our hosts carry that class. Core's JS only touches `.mermaid`
 * elements it registered itself (`ef.has(el)` guards), so the class is inert there.
 */

/** Wrapper of every inline frame and Mehrpele shell (`.pele-host`, not the embed root). */
export const PELE_HOST_CLASS = "image-wrapper pele-host mermaid";
/** Lightbox media wrapper: same theme hooks as inline frames. */
export const LIGHTBOX_HOST_CLASS = "media-wrapper pele-host mermaid";

/** Core's diagram font (`--font-mermaid` on body, as core's math measurer reads it); "" when absent. */
export function bodyMermaidFont(): string {
  try {
    const body = window.document?.body;
    if (!body || typeof getComputedStyle !== "function") return "";
    return getComputedStyle(body).getPropertyValue("--font-mermaid").trim();
  } catch {
    return "";
  }
}

/** Core's zoom-control labels (pele's defaults today; passed so they track core, not pele). */
export const ZOOM_LABELS = Object.freeze({ zoomIn: "Zoom in", zoomOut: "Zoom out", reset: "Reset zoom" });

// pele's mount() compares `zoom` by identity and rebuilds the controls when it
// changes, so every update must pass the same object.
const ZOOM_AUTO = Object.freeze({ labels: ZOOM_LABELS });
const ZOOM_ALWAYS = Object.freeze({ always: true, labels: ZOOM_LABELS });

export type ZoomMountOption = false | typeof ZOOM_AUTO | typeof ZOOM_ALWAYS;

/** Mount `zoom` for a setting value at `el`: core's labels, and off inside Canvas (it pans/zooms itself). */
export function zoomOption(zoom: boolean | "auto", el: { closest(selector: string): unknown }): ZoomMountOption {
  if (zoom === false) return false;
  if (el.closest(".canvas-wrapper")) return false;
  return zoom === true ? ZOOM_ALWAYS : ZOOM_AUTO;
}

interface LinkRoot {
  querySelectorAll(selector: string): ArrayLike<{ classList: { add(token: string): void } }>;
}

/** Core's onRender step: non-internal diagram links get `external-link` (theme icon/colour hooks). */
export function markExternalLinks(root: LinkRoot): void {
  const links = root.querySelectorAll("a:not(.internal-link)");
  for (let i = 0; i < links.length; i++) links[i].classList.add("external-link");
}
