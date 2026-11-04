// Minimal Excalidraw skeleton types (own copy; no @excalidraw runtime dep).
export type Arrowhead = "arrow" | "bar" | "circle" | "circle_outline" | "triangle" | "triangle_outline" | "diamond" | "diamond_outline" | null;

export interface SkeletonLabel {
  text: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  /**
   * Text colour. Without it Excalidraw gives bound text its container's stroke. Like `groupIds`,
   * the Excalidraw CLI `create` validator rejects it, so `groups: false` output leaves it out.
   */
  strokeColor?: string;
  /** Bound text joins its container's group (Excalidraw groups container + text together). */
  groupIds?: string[];
}

export interface ExcalidrawElementSkeleton {
  id: string;
  type: "rectangle" | "ellipse" | "diamond" | "text" | "arrow" | "line" | "frame" | "image";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: "hachure" | "cross-hatch" | "solid" | "zigzag";
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  roughness?: number;
  opacity?: number;
  roundness?: { type: 1 | 2 | 3; value?: number } | null;
  /** Composite shapes share one group id. Not accepted by the Excalidraw CLI `create` validator; see `groups` option. */
  groupIds?: string[];
  label?: SkeletonLabel;
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  points?: [number, number][];
  start?: { id: string };
  end?: { id: string };
  startArrowhead?: Arrowhead;
  endArrowhead?: Arrowhead;
  children?: string[];
  name?: string | null;
  link?: string | null;
  status?: "saved" | "pending";
  fileId?: string;
  scale?: [number, number];
}

export interface ExcalidrawFileEntry {
  mimeType: string;
  dataURL: string;
  id: string;
  created: number;
}

export interface PeleToExcalidrawOptions {
  palette?: Record<string, string>;
  scale?: number;
  /** Excalidraw font id for labels (1 Virgil, 2 Helvetica, 3 Cascadia, 5 Excalifont, 6 Nunito, …). Unset → Excalidraw default (Excalifont); label fitting measures with that face. */
  fontFamily?: number;
  imageFallback?: "svg" | "none";
  /**
   * Emit `groupIds` on composite shapes and `label.strokeColor` (default true). Set false for strict skeleton
   * consumers such as the Excalidraw CLI `create` command; labels then take their container's stroke.
   */
  groups?: boolean;
}

export interface PeleToExcalidrawResult {
  elements: ExcalidrawElementSkeleton[];
  files: Record<string, ExcalidrawFileEntry>;
  fidelity: "native" | "image";
  dropped: string[];
}
