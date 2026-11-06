/** Obsidian Canvas JSON and the conversion options/results. */
export interface CanvasNode {
  id: string; type: "text" | "file" | "link" | "group";
  x: number; y: number; width: number; height: number;
  color?: string; text?: string; file?: string; subpath?: string; url?: string;
  label?: string; background?: string; backgroundStyle?: string;
  styleAttributes?: Record<string, string | null>;
  portal?: boolean; interdimensionalEdges?: CanvasEdge[]; collapsed?: boolean;
  [key: string]: unknown;
}
export interface CanvasEdge {
  id: string; fromNode: string; toNode: string;
  fromSide?: "top" | "right" | "bottom" | "left"; toSide?: "top" | "right" | "bottom" | "left";
  fromEnd?: "none" | "arrow"; toEnd?: "none" | "arrow";
  color?: string; label?: string;
  styleAttributes?: Record<string, string | null>;
  [key: string]: unknown;
}
export interface CanvasData { nodes: CanvasNode[]; edges: CanvasEdge[]; metadata?: Record<string, unknown>; [key: string]: unknown }

export interface ToCanvasOptions {
  advancedCanvas?: boolean;
  /** Canvas px per SVG unit (default: the source's provenance scale, else 2). */
  scale?: number;
  origin?: { x: number; y: number };
  sourcePath?: string;
  mehrpele?: boolean;
  previous?: CanvasData;
  /** Always write `fromSide`/`toSide`, even for edges whose provenance had none (Cannoli requires both). */
  explicitSides?: boolean;
}
export interface FromCanvasOptions {
  /** Markdown labels: true quotes every label, false never, undefined decides (result.mehrpele). */
  mehrpele?: boolean;
  portals?: "link" | "inline";
  portalDepth?: number;
  resolveCanvas?: (path: string) => CanvasData | null;
  direction?: "auto" | "TD" | "LR" | "BT" | "RL";
  includeProvenance?: boolean;
  /** `canvas`: add `%% pele-layout canvas %%` + `%% pele-pos %%` so Pele draws the canvas positions. */
  layout?: "auto" | "canvas";
  /** Canvas px per SVG unit (default: the canvas's `metadata.pele.scale`, else 1). */
  scale?: number;
  /** view-nodes: link cards become live web-view nodes (`![[url|WxH]]`) instead of clickable text nodes. */
  webNodes?: boolean;
}
export interface FromCanvasResult {
  source: string;
  type: string;
  dropped: string[];
  /** True when the labels are Markdown (write a `mehrpele` block). */
  mehrpele: boolean;
}

/**
 * Internal: the `pele*` fields mermaidToCanvas writes on cards and
 * canvasToMermaid reads back (Canvas keeps unknown keys). Read from a canvas
 * file they are only as trustworthy as the file.
 */
export interface PeleCanvasNode extends CanvasNode {
  peleId?: string; peleShape?: string; peleKind?: string;
  peleClasses?: string[]; peleStyles?: string[]; peleDir?: string;
  peleViews?: string[]; peleLink?: string; peleTooltip?: string; peleFill?: string;
  peleText?: string; peleLabel?: string; peleEmbed?: boolean;
}
/** Internal: the `pele*` fields on edges (see PeleCanvasNode). */
export interface PeleCanvasEdge extends CanvasEdge {
  peleEdgeType?: string; peleStroke?: string; peleStyles?: string[];
}
/** Internal: a canvas card on its way back to a Mermaid node definition. */
export interface OutNode { canvasId: string; mermaidId: string; node: PeleCanvasNode; label: string; shape?: string; parentGroup?: string }
