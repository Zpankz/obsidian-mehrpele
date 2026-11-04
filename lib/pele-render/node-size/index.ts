/**
 * Per-node sizing: `%% pele-size A=220x96 C=150 "Make tea"=x72 %%`.
 * Directive helpers (pure), the sizable-node table and lint for `check`.
 */
import { detectType, parse } from "../pele.js";
import { mehrpeleRenderSource } from "../mehrpele.js";
import { sizableNodes, SIZABLE_TYPES, type SizeCaps } from "./adapters.js";
import { lintSizeDirective, withNodeSize, type NodeSize } from "./directive.js";

export {
  formatSize,
  formatSizeDirective,
  hasSizeDirective,
  lintSizeDirective,
  MAX_NODE_SIZE,
  parseSizeDirective,
  pruneNodeSizes,
  quoteId,
  SIZE_DIRECTIVE_RE,
  stripSizeDirective,
  topLevelLines,
  withNodeSize,
  withSizeDirective,
} from "./directive.js";
export type { NodeSize, SizeDirectiveLint, WithNodeSizeOptions } from "./directive.js";
export { flowchartCaps, sizableNodes, SIZABLE_TYPES } from "./adapters.js";
export type { LabelRef, SizableNode, SizeCaps } from "./adapters.js";
export { nodeBoxes, nodeBoxMap, shapeBox } from "./svgbox.js";
export type { Box, NodeBox } from "./svgbox.js";
export { cleanSizedText, FILL_CLOSE, FILL_OPEN, JOINER, withNodeSizing } from "./solve.js";
export type { NodeSizeInfo, NodeSizeResult } from "./solve.js";

/** Whether a diagram type supports `pele-size` at all. */
export function supportsNodeSizes(type: string | null | undefined): boolean {
  return !!type && (SIZABLE_TYPES as readonly string[]).includes(type);
}

/**
 * Sizable nodes of a source (id → what can be sized), or null when the
 * source does not parse or its type has no node sizing.
 */
export function nodeSizeCaps(source: string): Map<string, SizeCaps> | null {
  const capsOf = (src: string): Map<string, SizeCaps> | null => {
    const model = parse(src) as unknown as { type?: string };
    if (!supportsNodeSizes(model?.type)) return null;
    const out = new Map<string, SizeCaps>();
    for (const [id, n] of sizableNodes(model)) out.set(id, n.caps);
    return out;
  };
  try {
    return capsOf(source);
  } catch {
    // Mehrpele labels (Markdown, nested fences) are not Pele label text:
    // read the node table from the neutralised source instead.
    if (!source.includes('"')) return null;
    try {
      return capsOf(mehrpeleRenderSource(source));
    } catch {
      return null;
    }
  }
}

/**
 * Set or (with null) remove one node's entry, pruning entries for nodes the
 * diagram no longer has. When the source does not parse nothing is pruned.
 */
export function setNodeSize(source: string, id: string, size: NodeSize | null): string {
  const caps = nodeSizeCaps(source);
  return withNodeSize(source, id, size, caps ? { keep: (k) => caps.has(k) } : {});
}

export interface NodeSizeWarning {
  code: "unsupported-type" | "unknown-node" | "malformed-entry" | "not-sizable";
  message: string;
  id?: string;
}

/** Problems with a source's `pele-size` entries (warnings: Mermaid still renders). */
export function lintNodeSizes(source: string): NodeSizeWarning[] {
  const lint = lintSizeDirective(source);
  if (lint.lines === 0) return [];
  const out: NodeSizeWarning[] = [];
  for (const raw of lint.malformed) {
    out.push({ code: "malformed-entry", message: `pele-size: cannot read entry "${raw}" (use id=W, id=WxH or id=xH)` });
  }
  let type: string | null = null;
  try {
    type = detectType(source);
  } catch {
    type = null;
  }
  if (!supportsNodeSizes(type)) {
    out.push({
      code: "unsupported-type",
      message: `pele-size is not supported for ${type === "block" ? "block" : type ?? "this diagram"}; entries are ignored`,
    });
    return out;
  }
  let model: unknown;
  try {
    model = parse(source);
  } catch {
    return out; // the render error is reported on its own
  }
  let nodes: ReturnType<typeof sizableNodes>;
  try {
    nodes = sizableNodes(model);
  } catch {
    return out;
  }
  const known = new Set<string>();
  try {
    // Every node id the SVG would carry, sizable or not (for a precise message).
    const m = model as { nodes?: Map<string, unknown> };
    if (m.nodes instanceof Map) for (const k of m.nodes.keys()) known.add(String(k));
  } catch {
    /* other model shapes */
  }
  for (const [id] of lint.sizes) {
    if (nodes.has(id)) continue;
    if (known.has(id)) out.push({ code: "not-sizable", id, message: `pele-size: node "${id}" has a fixed size; entry ignored` });
    else out.push({ code: "unknown-node", id, message: `pele-size: no node "${id}" in this diagram; entry ignored` });
  }
  return out;
}
