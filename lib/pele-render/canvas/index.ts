/**
 * `pele-render/canvas`: Mermaid ⇄ Obsidian Canvas conversion (to-canvas.ts,
 * from-canvas.ts), the palette/embed helpers it builds on, and the pinned
 * layout engine it shares with core rendering (../layout/).
 */
export { sourceHash } from "./ids.js";
export { parseSvgGeometry, pathPoints } from "../layout/svg-geom.js";
export type { BBox, SvgGeometry } from "../layout/svg-geom.js";
export { withCanvasLayout, usesCanvasLayout } from "../layout/layout.js";
export {
  edgeKey,
  formatPosDirective,
  hasCanvasLayout,
  lintLayoutDirective,
  lintLayoutWarnings,
  parseLayoutDirective,
  stripLayoutDirective,
} from "../layout/directive.js";
export type { CanvasLayout, EdgePorts, PinnedBox, Side } from "../layout/directive.js";
export { CANVAS_PRESETS, legacyPresetClass, presetClass, presetHex, presetOfClass, presetOfHex, presetThemeCss, TINT_ALPHA, tintStyles } from "./palette.js";
export { EMBED_DEFAULT, EMBED_PAD, parseEmbedLabel } from "./embed.js";
export { formatWebEmbedLabel, parseWebEmbedLabel } from "./web.js"; // view-nodes
export { applyFolderTokens, folderBaseBlock, folderBaseYaml, folderSpecFromEmbed, folderSpecFromParams, formatFolderEmbed, normalizeFolderPath, parseFolderLabel, type FolderSpec } from "./folder.js"; // view-nodes
export { parseProvenance } from "./provenance.js";
export { routeEdge, routeOrthogonal } from "../layout/route.js";

export type { CanvasData, CanvasEdge, CanvasNode, FromCanvasOptions, FromCanvasResult, ToCanvasOptions } from "./types.js";
export { normalizeHex } from "./style.js";
export { stringifyCanvas } from "./serialize.js";
export { canvasNodeSize, type CanvasShapeInfo } from "./size.js";
export { mermaidToCanvas } from "./to-canvas.js";
export { canvasToMermaid, labelNeedsMarkdown } from "./from-canvas.js";
