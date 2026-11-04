/**
 * Mehrpele public surface. The host plugin wires this in;
 * nothing here imports the host's main.ts/diagram-frame.ts.
 */
export {
  hasMehrpeleDirective,
  isMehrpeleSource,
  extractLabels,
  parseMehrpele,
  stripMehrpeleDirective,
  findQuotedSpans,
} from "./extract";
export {
  escapeLabelMarkdown,
  unescapeLabelMarkdown,
  markdownToFallback,
  diagramFenceSummary,
  parseSoleEmbed,
  parseEmbedSize,
  buildModel,
  type MehrpeleLabel,
  type MehrpeleModel,
  type MehrpeleEmbedTarget,
  type MehrpeleLabelKind,
  type MehrpeleLabelSize,
} from "./model";
export {
  buildPlaceholder,
  makeReservationMeasurer,
  placeholderSource,
  spanNeedsUnquoting,
  clampSize,
  linesForHeight,
  type ReservedLabel,
} from "./placeholder";
export {
  resolveAnchors,
  parseViewBox,
  svgBoxToClient,
  svgScale,
  svgAnchorIds,
  edgeSvgId,
  clusterSvgId,
  type AnchorBox,
  type ViewBox,
} from "./anchors";
export {
  registerEmbedRenderer,
  embedRenderers,
  isBaseTarget,
  isCanvasTarget,
  embedBoxSize,
  embedMarkdown,
  type EmbedRenderer,
  type MehrpeleEmbedContext,
} from "./embeds";
export { mountMehrpele, type MehrpeleMounted } from "./mount";
export {
  embedOrigin,
  inlineOrigin,
  originGesture,
  originLinktext,
  originTooltip,
  portalNodeId,
  ORIGIN_ROOT_CLASS,
  type NestedOrigin,
  type OriginPane,
} from "./origin";
export {
  resolveDiagramEmbed,
  type MehrpeleHost,
  type RenderedLabel,
  type LabelMode,
  type NestedDiagramSpec,
  type NestedDiagramHandle,
} from "./labels";
export {
  NESTED_DIAGRAM_LANGS,
  parseSoleDiagramFence,
  soleDiagramInSection,
  diagramFileLang,
  fitContentSize,
  minContentWidth,
  labelsInRawSource,
  rewriteLabel,
  withFenceWidth,
  withFenceBody,
  withEmbedSize,
  embedRequestedSize,
  embedAlias,
  type NestedDiagram,
  type NestedDiagramLang,
  type FitOptions,
} from "./nested";
export { attachNodeResize, clampResize, RESIZING_CLASS, type NodeResizeOptions } from "./node-resize";
export { mehrpeleCheckSource, mehrpeleRenderSource, validateMehrpele } from "./validate";
export {
  DEFAULT_MEHRPELE_SETTINGS,
  normalizeMehrpeleSettings,
  mehrpeleApplies,
  type MehrpeleSettings,
  type MermaidLabelMode,
  type EmbedScaling,
  type EmbedSizing,
} from "./settings";
export {
  embedUiScale,
  isViewportMode,
  screenScaleOf,
  setViewportBox,
  viewportBoxOf,
  viewportLayoutBox,
  type ViewportBox,
} from "./viewport";
export {
  registerMehrpeleBasesView,
  MehrpeleDiagramView,
  MEHRPELE_BASES_VIEW_TYPE,
  getDiagramViewOptions,
  type MehrpeleBasesDeps,
} from "./bases-view";
export {
  generateBasesSource,
  sanitiseNodeId,
  DEFAULT_BASES_SOURCE_OPTIONS,
  type BaseEntryLike,
  type BasesSourceOptions,
  type BasesSourceResult,
} from "./bases-source";
