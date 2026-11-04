import { detectType } from "pele-render/pele";

/**
 * The diagram type of a Mermaid block, as pele names it ("flowchart", "class", "state", "er",
 * "mindmap", …), from its header alone; null when pele knows no type for it. A frame knows
 * its rendered type only after its first mount, and a reflowing frame mounts only once it
 * has a width (a Reading-view section below the fold may never have had one).
 */
export function sourceDiagramType(source: string): string | null {
  try {
    return detectType(source) ?? null;
  } catch {
    return null;
  }
}
