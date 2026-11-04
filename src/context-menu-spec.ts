/**
 * The diagram context menu (pure): what it offers, in sections (copy,
 * export, open, size), icon first with short labels for tooltips and
 * aria-labels; and where it goes (at the pointer, flipped to stay inside the
 * viewport). Plain frames and Mehrpele shells share it.
 */

/** The host's own items. Companion items (api `addMenuItems`) get other ids. */
export type BuiltinContextItemId =
  | "svg" | "png" | "link" | "wikilink"
  | "export-svg" | "export-png"
  | "source" | "playground" | "canvas" | "excalidraw"
  | "reset-size" | "reset-node-size" | "reset-all-sizes";

/** Any item id: a built-in one, or a companion one (`ext:…`). */
export type ContextItemId = BuiltinContextItemId | (string & {});

export interface ContextItem {
  id: ContextItemId;
  icon: string;
  label: string;
  /** Runs instead of the menu's `run(id)` when picked (companion items). */
  onPick?: (evt: MouseEvent) => void;
}

export interface ContextSection {
  /** "copy" | "export" | "open" | "size" for the built-ins; companion sections use `ext:…`. */
  id: string;
  label: string;
  items: ContextItem[];
}

/** What the diagram under the pointer supports. */
export interface ContextCaps {
  /** A block link can be made (the diagram is in a note). */
  link: boolean;
  /** The Excalidraw companion is available. */
  excalidraw: boolean;
  /** The diagram has a stored width to reset. */
  width: boolean;
  /** The node under the pointer has a stored size. */
  nodeSize: boolean;
  /** Some node has a stored size. */
  allSizes: boolean;
}

/** A registry entry: shown when `when(caps)` holds (always when absent). */
export interface ContextItemSpec {
  id: BuiltinContextItemId;
  icon: string;
  label: string;
  when?: (c: ContextCaps) => boolean;
}

export interface ContextSectionSpec {
  id: "copy" | "export" | "open" | "size";
  label: string;
  items: readonly ContextItemSpec[];
}

/**
 * The built-in menu, in order. Companion items are appended after these sections each
 * time a menu opens (src/api/menu-items.ts).
 */
export const BUILTIN_CONTEXT_MENU: readonly ContextSectionSpec[] = [
  {
    id: "copy",
    label: "Copy",
    items: [
      { id: "svg", icon: "copy", label: "Copy SVG" },
      { id: "png", icon: "image", label: "Copy PNG" },
      { id: "link", icon: "link", label: "Copy link", when: (c) => c.link },
      { id: "wikilink", icon: "brackets", label: "Copy wikilink", when: (c) => c.link },
    ],
  },
  {
    id: "export",
    label: "Export",
    items: [
      { id: "export-svg", icon: "file-code", label: "Export SVG" },
      { id: "export-png", icon: "file-image", label: "Export PNG" },
    ],
  },
  {
    id: "open",
    label: "Open",
    items: [
      { id: "source", icon: "code-2", label: "Edit source" },
      { id: "playground", icon: "external-link", label: "Open in playground" },
      { id: "canvas", icon: "layout-dashboard", label: "Convert to canvas" },
      { id: "excalidraw", icon: "pen-tool", label: "Convert to Excalidraw", when: (c) => c.excalidraw },
    ],
  },
  {
    id: "size",
    label: "Size",
    items: [
      { id: "reset-size", icon: "rotate-ccw", label: "Reset size", when: (c) => c.width },
      { id: "reset-node-size", icon: "scaling", label: "Reset node size", when: (c) => c.nodeSize },
      { id: "reset-all-sizes", icon: "maximize", label: "Reset all node sizes", when: (c) => c.allSizes },
    ],
  },
];

/** The built-in sections for `c`, empty sections dropped, then the `companion` sections (api addMenuItems). */
export function contextItems(c: ContextCaps, companion: readonly ContextSection[] = []): ContextSection[] {
  const builtin = BUILTIN_CONTEXT_MENU.map((s) => ({
    id: s.id,
    label: s.label,
    items: s.items.filter((i) => !i.when || i.when(c)).map(({ id, icon, label }) => ({ id, icon, label })),
  })).filter((s) => s.items.length > 0);
  return [...builtin, ...companion.filter((s) => s.items.length > 0)];
}

/** Margin kept from the viewport's edges. */
const EDGE = 4;

/** At the pointer, down-right; flipped left / up when it would overflow, then kept inside. */
export function placeContextMenu(at: { x: number; y: number }, size: { width: number; height: number }, viewport: { width: number; height: number }): { left: number; top: number } {
  let left = at.x;
  let top = at.y;
  if (left + size.width > viewport.width - EDGE) left = at.x - size.width;
  if (top + size.height > viewport.height - EDGE) top = at.y - size.height;
  const clamp = (v: number, len: number, max: number) => Math.max(0, Math.min(v, max - len - EDGE));
  return { left: clamp(left, size.width, viewport.width), top: clamp(top, size.height, viewport.height) };
}
