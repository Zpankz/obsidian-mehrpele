import { describe, expect, test } from "bun:test";
import { ReflowPlanner } from "pele-render/reflow";
import { effectiveZoom, resolveFrameDrag, sameFrameSize, VERTICAL_INTENT, type FrameStart } from "../src/frame-resize";
import { parseFenceInfo, serializeFenceSize, type FenceSize } from "../src/info-width";
import { layoutWidthFor } from "../src/reflow-frame";

const bounds = { min: 20, max: 1000, minHeight: 40, maxHeight: 4000, boxable: true };

describe("resolveFrameDrag: the corner follows the pointer on each axis", () => {
  test("horizontal travel alone sizes the width (centred: 2 × dx); the height stays the chart's", () => {
    expect(resolveFrameDrag({ width: 400, height: 150 }, 50, 0, bounds)).toEqual({ width: 500, height: undefined });
    expect(resolveFrameDrag({ width: 400, height: 150 }, -50, 2, bounds)).toEqual({ width: 300, height: undefined });
  });
  test("vertical travel sets a box height; the width stays put (no aspect lock)", () => {
    expect(resolveFrameDrag({ width: 400, height: 150 }, 0, 120, bounds)).toEqual({ width: 400, height: 270 });
    expect(resolveFrameDrag({ width: 400, height: 150 }, 10, -60, bounds)).toEqual({ width: 420, height: 90 });
  });
  test("a frame with a height keeps it on a horizontal drag", () => {
    expect(resolveFrameDrag({ width: 400, height: 300, hasHeight: true }, 30, 1, bounds)).toEqual({ width: 460, height: 301 });
  });
  test("legacy zoom= migrates to a box on the first real drag", () => {
    expect(resolveFrameDrag({ width: 448, height: 409, legacyZoom: true }, 20, 0, bounds)).toEqual({ width: 488, height: 409 });
  });
  test("bounds clamp each axis on its own", () => {
    expect(resolveFrameDrag({ width: 900, height: 100 }, 400, 0, bounds)).toEqual({ width: 1000, height: undefined });
    expect(resolveFrameDrag({ width: 400, height: 100 }, 0, -500, bounds)).toEqual({ width: 400, height: 40 });
  });
  test("no travel (or jitter under the vertical threshold) changes nothing: no write", () => {
    expect(resolveFrameDrag({ width: 400, height: 150 }, 0, 0, bounds)).toBeNull();
    expect(resolveFrameDrag({ width: 400, height: 150 }, 0, VERTICAL_INTENT - 1, bounds)).toBeNull();
    expect(resolveFrameDrag({ width: 400, height: 150, hasHeight: true }, 0.2, 0.3, bounds)).toBeNull();
    expect(resolveFrameDrag({ width: 448, height: 409, legacyZoom: true }, 0, 0, bounds)).toBeNull();
  });
  test("frames that cannot take a box (nested, legacy magnify, Canvas cards) size the width only", () => {
    const r = resolveFrameDrag({ width: 300, height: 100 }, 50, 80, { ...bounds, boxable: false });
    expect(r).toEqual({ width: 400, height: undefined, keepZoom: true });
    expect(sameFrameSize(r!, { width: 400, zoom: 2 })).toBe(true);
  });
  test("sameFrameSize: a legacy zoom is a difference (the drag writes the box)", () => {
    expect(sameFrameSize({ width: 448, height: 409 }, { width: 448, height: 409 })).toBe(true);
    expect(sameFrameSize({ width: 448, height: 409 }, { width: 448, zoom: 1.6 })).toBe(false);
  });
});

describe("fence tokens", () => {
  test("height= parses and serialises beside width=; a drag write drops a legacy zoom", () => {
    expect(parseFenceInfo("```mermaid width=448 height=300").height).toBe(300);
    expect(serializeFenceSize("```mermaid width=448 zoom=1.6", { width: 488, height: 409, zoom: null })).toBe("```mermaid width=488 height=409");
    expect(serializeFenceSize("```mermaid width=448 height=300 title", { width: null, height: null, zoom: null })).toBe("```mermaid title");
  });
  test("backward compatible: rendering never rewrites width=/zoom=, an untouched token is kept", () => {
    expect(serializeFenceSize("```mermaid width=448 zoom=1.6", {})).toBe("```mermaid width=448 zoom=1.6");
    expect(serializeFenceSize("```mermaid width=448 zoom=1.6", { width: 500 })).toBe("```mermaid width=500 zoom=1.6");
    expect(parseFenceInfo("```mermaid width=448 zoom=0.8").zoom).toBeUndefined(); // zoom < 1 is no zoom
  });
});

/*
 * The frame as DiagramFrame / MehrpeleShell show it, on the real planner:
 * a box height → planFill(W, H); a legacy zoom → the layout for box / zoom
 * shown at zoom; else the width-only plan (never magnified).
 */
interface Shown {
  key: string;
  /** Frame width (where the corner sits) and height (the corner's bottom). */
  wrap: number;
  frameH: number;
  /** Text magnification. */
  mag: number;
  zoom: number;
}

function show(planner: ReflowPlanner, fence: FenceSize, column: number): Shown {
  const box = layoutWidthFor(column, fence.width !== undefined ? { width: fence.width } : {});
  if (fence.height !== undefined) {
    planner.reset();
    const p = planner.planFill(box, fence.height);
    const chartW = p.width * p.scale;
    return { key: p.key, wrap: fence.width !== undefined ? Math.min(fence.width, column) : chartW, frameH: fence.height, mag: p.scale, zoom: 1 };
  }
  const z = effectiveZoom(fence.zoom, fence.width, column);
  planner.reset();
  const p = planner.plan(z > 1 ? Math.floor(box / z) : box);
  const s = p.scale * z;
  const chartW = p.width * s;
  return { key: p.key, wrap: fence.width !== undefined ? Math.min(fence.width, column) : Math.min(chartW, column), frameH: p.height * s, mag: s, zoom: z };
}

function startOf(sh: Shown, fence: FenceSize): FrameStart {
  // The fence's zoom, not the effective one (a narrow column may show it at 1×).
  return { width: sh.wrap, height: sh.frameH, hasHeight: fence.height !== undefined, legacyZoom: fence.height === undefined && fence.zoom !== undefined };
}

function drag(planner: ReflowPlanner, fence: FenceSize, column: number, dx: number, dy: number): { next: FenceSize; shown: Shown } {
  const st = startOf(show(planner, fence, column), fence);
  const r = resolveFrameDrag(st, dx, dy, { ...bounds, max: column });
  const next: FenceSize = r ? { width: r.width, ...(r.height !== undefined ? { height: r.height } : {}) } : fence;
  return { next, shown: show(planner, next, column) };
}

const LR = "flowchart LR\n  A[Start] --> B[Parse input] --> C[Validate]\n  A --> D[Other]";
const TB = "flowchart TB\n  A[Start] --> B[Parse input] --> C[Validate] --> D[Render] --> E[Done]";
const SEQ = "sequenceDiagram\n  Alice->>Bob: a fairly long message that wraps\n  Bob-->>Alice: and a reply";

const STARTS: { name: string; fence: FenceSize; column: number }[] = [
  { name: "neither", fence: {}, column: 700 },
  { name: "width only", fence: { width: 300 }, column: 700 },
  { name: "zoom only (legacy)", fence: { zoom: 1.6 }, column: 700 },
  { name: "width + zoom (legacy, the report)", fence: { width: 448, zoom: 1.6 }, column: 700 },
  { name: "width + zoom < 1", fence: { width: 448, ...(parseFenceInfo("mermaid zoom=0.8").zoom !== undefined ? { zoom: 0.8 } : {}) }, column: 700 },
  { name: "box", fence: { width: 420, height: 300 }, column: 700 },
  { name: "zoom shrunk by a narrow column", fence: { width: 600, zoom: 2 }, column: 450 },
  { name: "zoom shown at 1× in a narrow column", fence: { width: 600, zoom: 1.2 }, column: 450 },
];

describe("frame drag sweep: per-axis monotonic, the corner tracks the pointer", () => {
  for (const [sname, src] of Object.entries({ LR, TB, SEQ })) {
    for (const s of STARTS) {
      test(`${sname} · ${s.name}`, () => {
        const planner = new ReflowPlanner(src);
        const s0 = show(planner, s.fence, s.column);
        // Outward along each axis alone and diagonally: the text never shrinks.
        for (const [ux, uy] of [[1, 0], [0, 1], [1, 1], [1, 3]] as const) {
          let prev = s0.mag;
          for (let t = 1; t <= 24; t++) {
            const dx = ux * t * 12;
            const dy = uy * t * 12;
            const { next, shown } = drag(planner, s.fence, s.column, dx, dy);
            const ctx = `${dx},${dy} → ${JSON.stringify(next)} ${JSON.stringify(shown)}`;
            expect(shown.mag, ctx).toBeGreaterThanOrEqual(prev - 1e-9);
            prev = shown.mag;
            // The corner follows the pointer: width = start + 2·dx (unless clamped), height = start + dy.
            const wantW = Math.min(s.column, Math.round(s0.wrap + 2 * dx));
            expect(Math.abs(shown.wrap - wantW), ctx).toBeLessThanOrEqual(1);
            if (next.height !== undefined) expect(Math.abs(shown.frameH - Math.round(s0.frameH + dy)), ctx).toBeLessThanOrEqual(1);
          }
        }
        // Inward on either axis: the text never grows once the drag sizes a box of its own.
        for (const [ux, uy] of [[-1, 0], [0, -1], [-1, -1]] as const) {
          let prev = Number.POSITIVE_INFINITY;
          for (let t = 2; t <= 20; t++) {
            const { shown, next } = drag(planner, s.fence, s.column, ux * t * 8, uy * t * 8);
            const ctx = `${ux * t * 8},${uy * t * 8} → ${JSON.stringify(next)} ${JSON.stringify(shown)}`;
            expect(shown.mag, ctx).toBeLessThanOrEqual(prev + 1e-9);
            prev = shown.mag;
          }
        }
      });
    }
  }
});

describe("dragging an LR flowchart", () => {
  const planner = new ReflowPlanner(LR);
  const s0 = show(planner, {}, 700);
  test("down: the frame keeps its width and grows taller; the layout uses the height", () => {
    expect(s0.key).toBe("ladder:authored/n/200");
    const down = drag(planner, {}, 700, 0, 80);
    expect(down.next.width).toBe(Math.round(s0.wrap));
    expect(down.next.height).toBe(Math.round(s0.frameH + 80));
    expect(down.shown.mag).toBeGreaterThanOrEqual(s0.mag);
    expect(down.shown.key).toContain("~"); // spread along the vertical axis at the same width
    const far = drag(planner, {}, 700, 0, 500);
    expect(far.shown.key).toMatch(/TB/); // the box's aspect favours top-down
    expect(far.shown.mag).toBeGreaterThan(1);
  });
  test("left (narrower): reflows top-down, never magnified, no box height", () => {
    const left = drag(planner, {}, 700, -110, 0);
    expect(left.next.height).toBeUndefined();
    expect(left.shown.key).toMatch(/TB/);
    expect(left.shown.mag).toBeLessThanOrEqual(1);
  });
  test("diagonally out: both sides grow and the chart fills the box", () => {
    const out = drag(planner, {}, 700, 100, 100);
    expect(out.next).toEqual({ width: Math.round(s0.wrap + 200), height: Math.round(s0.frameH + 100) });
    expect(out.shown.mag).toBeGreaterThan(1);
  });
});

describe("a legacy zoom shown at 1× (column narrower than its box)", () => {
  test("a sideways drag still writes a box, so the zoom is not lost in a wider pane", () => {
    const planner = new ReflowPlanner(LR);
    const { next } = drag(planner, { width: 600, zoom: 1.2 }, 450, -20, 0);
    expect(next.height).toBeDefined();
    expect(next.zoom).toBeUndefined();
  });
});

describe("the reported case: width=448 zoom=1.6, dragged outward", () => {
  test("migrates to a box and the chart grows (it used to write width=414 zoom=1.04)", () => {
    const planner = new ReflowPlanner("flowchart LR\n  A[Start] --> B[Parse input] --> C[Validate]");
    const s0 = show(planner, { width: 448, zoom: 1.6 }, 700);
    const { next, shown } = drag(planner, { width: 448, zoom: 1.6 }, 700, 100, 10);
    expect(next.zoom).toBeUndefined();
    expect(next.width).toBe(648);
    expect(next.height).toBe(Math.round(s0.frameH + 10));
    expect(shown.mag).toBeGreaterThanOrEqual(s0.mag);
  });
});
