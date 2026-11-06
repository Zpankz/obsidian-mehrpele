/**
 * Where each diagram type keeps a node's label in Pele's parsed model, and
 * which nodes can be sized. Reads Pele 1.6 model internals: an unknown model
 * shape yields no refs, so a diagram falls back to its natural render.
 *
 * block-beta is deliberately absent (one cell's size is its whole column's
 * and row's), as are fixed-geometry types (architecture, gantt, pie, …).
 */
import type { DiagramModel, MindmapModel, StateModel } from "pele";

export interface LabelRef {
  id: string;
  get(): string;
  set(label: string): void;
}

/**
 * What a node can be sized in. `square`: one dimension (circles; W only).
 * `coupled`: width and height interact (diamonds, slanted shapes), so the
 * solver clamps to what the shape allows.
 */
export interface SizeCaps {
  w: boolean;
  h: boolean;
  lock: "free" | "square" | "coupled";
  /** Pele's shape name (flowcharts: `square`, `round`, `subroutine`, `diamond`, …). */
  shape?: string;
}

/** Diagram types whose nodes can carry `pele-size` entries. */
export const SIZABLE_TYPES = ["flowchart", "state", "class", "er", "sequence", "mindmap", "kanban", "c4"] as const;

const FREE: SizeCaps = { w: true, h: true, lock: "free" };
const SQUARE: SizeCaps = { w: true, h: false, lock: "square" };
const COUPLED: SizeCaps = { w: true, h: true, lock: "coupled" };
const HEIGHT_ONLY: SizeCaps = { w: false, h: true, lock: "free" };

const FLOW_SQUARE = new Set(["circle", "doublecircle", "dbl-circ", "circ", "double-circle"]);
const FLOW_COUPLED = new Set([
  "diamond", "diam", "decision", "question", "rhombus",
  "stadium", "pill", "terminal",
  "hexagon", "hex", "prepare",
  "odd",
  "lean_right", "lean_left", "lean-r", "lean-l", "in-out", "out-in", "lean-right", "lean-left",
  "trapezoid", "inv_trapezoid", "trap-b", "trap-t", "priority", "manual", "trapezoid-bottom", "trapezoid-top",
  "bow-rect", "stored-data", "curv-trap", "display", "delay", "half-rounded-rectangle",
  "tri", "extract", "triangle", "flip-tri", "manual-file", "flipped-triangle", "notch-pent", "loop-limit",
]);
/** Fixed glyphs with no label box. */
const FLOW_FIXED = new Set([
  "f-circ", "filled-circle", "junction", "sm-circ", "small-circle", "start", "framed-circle", "fr-circ", "stop",
  "cross-circ", "crossed-circle", "summary", "fork", "join", "bolt", "com-link", "lightning-bolt",
  "hourglass", "collate",
]);

function flowShape(n: { type?: string; props?: { shape?: string } }): string {
  return String(n.props?.shape ?? n.type ?? "square");
}

/** Caps of one flowchart node (null = not sizable). */
export function flowchartCaps(n: { type?: string; props?: { shape?: string }; img?: unknown; icon?: unknown }): SizeCaps | null {
  if (n.img || n.icon) return null; // native shape-data w/h sizes assets
  const s = flowShape(n);
  if (FLOW_FIXED.has(s)) return null;
  if (FLOW_SQUARE.has(s)) return { ...SQUARE, shape: s };
  if (FLOW_COUPLED.has(s)) return { ...COUPLED, shape: s };
  return { ...FREE, shape: s };
}

// Mermaid mindmap node types: 0 default (borderless), 1 rounded, 2 rect,
// 3 circle, 4 cloud, 5 bang, 6 hexagon. Default nodes are sizable too: the
// root and nodes with children draw a pill, leaves draw text only (their box
// is the label's layout box, see svgbox.ts mindmapTextBoxes).
function mindmapCaps(n: { type?: number; isRoot?: boolean }): SizeCaps | null {
  if (n.type === 3) return SQUARE;
  if (n.type === 4 || n.type === 5 || n.type === 6) return COUPLED;
  return FREE;
}

type MindmapNode = MindmapModel["nodes"][number];

/**
 * The state graph Pele builds at parse time (its StateDb carries it; the
 * public StateModel type does not declare it).
 */
interface StateGraphView {
  graph?: { nodes?: { id: string; shape: string | undefined; label: string | undefined; isGroup: boolean }[] };
}

function mindmapNodes(model: MindmapModel): MindmapNode[] {
  const seen = new Set<MindmapNode>();
  const out: MindmapNode[] = [];
  const walk = (n: MindmapNode | undefined): void => {
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  for (const n of model.nodes ?? []) walk(n);
  return out;
}

export interface SizableNode {
  ref: LabelRef;
  caps: SizeCaps;
}

/** Sizable nodes of a parsed model, keyed by the SVG `data-id`. Throws on an unexpected model shape. */
export function sizableNodes(parsed: unknown): Map<string, SizableNode> {
  const out = new Map<string, SizableNode>();
  if (!parsed || typeof parsed !== "object") return out;
  // A Pele parse result; every read below stays defensive (`?.`, `?? []`)
  // because these are Pele internals that may change shape.
  const model = parsed as DiagramModel;
  const add = (id: unknown, caps: SizeCaps | null, get: () => string, set: (v: string) => void): void => {
    if (typeof id !== "string" || !id || !caps || out.has(id)) return;
    out.set(id, { ref: { id, get, set }, caps });
  };
  try {
    switch (model.type) {
      case "flowchart":
        for (const n of model.nodes?.values?.() ?? []) {
          add(n.id, flowchartCaps(n), () => (typeof n.text === "string" ? n.text : n.id), (v) => {
            n.text = v;
          });
        }
        break;
      case "state":
        // Pele builds the state graph at parse time: labels live on graph.nodes.
        for (const n of (model as StateModel & StateGraphView).graph?.nodes ?? []) {
          if (n.isGroup || !/^rect|^rounded$/.test(String(n.shape))) continue;
          // The title only: extra description lines keep their own compartment.
          add(n.id, FREE, () => String(n.label ?? n.id), (v) => {
            n.label = v;
          });
        }
        break;
      case "class":
        for (const c of model.classes?.values?.() ?? []) {
          add(c.id, FREE, () => c.label ?? c.id, (v) => {
            c.label = v;
          });
        }
        break;
      case "er":
        for (const e of model.entities?.values?.() ?? []) {
          add(e.label, FREE, () => e.alias || e.label, (v) => {
            e.alias = v;
          });
        }
        break;
      case "sequence":
        for (const a of model.actors?.values?.() ?? []) {
          add(a.name, FREE, () => a.description ?? a.name, (v) => {
            a.description = v;
          });
        }
        break;
      case "mindmap":
        for (const n of mindmapNodes(model)) {
          add(n.nodeId, mindmapCaps(n), () => n.descr ?? n.nodeId, (v) => {
            n.descr = v;
          });
        }
        break;
      case "kanban":
        for (const s of model.sections ?? []) {
          for (const it of s.items ?? []) {
            add(it.id, HEIGHT_ONLY, () => it.label ?? it.id, (v) => {
              it.label = v;
            });
          }
        }
        break;
      case "c4":
        for (const s of model.shapes ?? []) {
          add(s.alias, FREE, () => s.label ?? s.alias, (v) => {
            s.label = v;
          });
        }
        break;
      default:
        // Other diagram types have no sizable nodes.
        break;
    }
  } catch (err) {
    // Unexpected model shape (a Pele upgrade): callers render naturally and
    // must not treat "no sizable nodes" as "every entry is stale".
    throw new Error(`pele-size: unsupported ${String(model.type)} model (${(err as Error)?.message ?? err})`);
  }
  return out;
}
