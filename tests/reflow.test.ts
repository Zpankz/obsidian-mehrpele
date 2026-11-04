import { describe, expect, test } from "bun:test";
import { render } from "pele-render/pele";
import { nodeBoxMap } from "pele-render/node-size";
import { applyPlanSource, ReflowPlanner } from "pele-render/reflow";
import { layoutWidthFor, reflowPolicy } from "../src/reflow-frame";
import { DEFAULT_REFLOW_SETTINGS, DEFAULT_SETTINGS, normalizeReflowSettings, normalizeSettings } from "../src/settings/v2";
import { writeNodeSize } from "../src/node-size";

const LR = `flowchart LR
  A[Collect requirements from stakeholders] --> B{Is the scope clear enough?}
  B -->|Yes, proceed| C[Draft the technical design document]
  B -->|No| D[Schedule a clarification workshop]
  C --> E[(Design repository)]
  C --> F[Review with the architecture group]
  F --> G([Approved])
  G --> H[[Implementation sprint]]`;

describe("reflow settings", () => {
  test("defaults: reflow, direction switch and sideways turns on; floor 0.8; legacy magnify off", () => {
    expect(DEFAULT_SETTINGS.reflow).toEqual({
      enabled: true,
      switchDirection: true,
      autoTurn: true,
      minTextScale: 0.8,
      legacyMagnify: false,
      animate: true,
    });
    expect(normalizeSettings(null).reflow).toEqual(DEFAULT_REFLOW_SETTINGS);
  });

  test("normalisation is tolerant and clamps the floor", () => {
    expect(normalizeReflowSettings({ minTextScale: 0.1 }).minTextScale).toBe(0.3);
    expect(normalizeReflowSettings({ minTextScale: 3 }).minTextScale).toBe(1);
    expect(normalizeReflowSettings({ minTextScale: Number.NaN }).minTextScale).toBe(0.8);
    expect(normalizeReflowSettings({ enabled: "yes" as unknown as boolean }).enabled).toBe(true);
    expect(normalizeSettings({ reflow: { legacyMagnify: true } as never }).reflow.legacyMagnify).toBe(true);
  });

  test("the planner policy follows the settings", () => {
    // v3 has one switch: autoTurn follows switchDirection (as the v2 view did).
    expect(reflowPolicy({ enabled: true, switchDirection: false, minTextScale: 0.6 })).toEqual({
      switchDirection: false,
      autoTurn: false,
      minTextScale: 0.6,
    });
  });
});

describe("width= semantics", () => {
  test("width=N is a maximum layout width: L = min(N, column)", () => {
    expect(layoutWidthFor(1200, {})).toBe(1200);
    expect(layoutWidthFor(1200, { width: 520 })).toBe(520);
    expect(layoutWidthFor(400, { width: 520 })).toBe(400);
    expect(layoutWidthFor(1200, { width: 900, settingsMax: 700 })).toBe(700);
    expect(layoutWidthFor(0, { width: 520 })).toBe(0); // not laid out yet
  });

  test("nested frames use their node bound, not the shrink-wrapped column", () => {
    expect(layoutWidthFor(90, { nestedMax: 480 })).toBe(480);
    expect(layoutWidthFor(0, { nestedMax: 480, width: 300 })).toBe(300);
  });

  test("a width below the LR layout switches direction instead of pinning it (legacy pinned it)", () => {
    const planner = new ReflowPlanner(LR, {}, render, reflowPolicy(DEFAULT_REFLOW_SETTINGS));
    const plan = planner.plan(layoutWidthFor(1600, { width: 620 }));
    expect(plan.direction).toBe("TB");
    expect(plan.scale).toBe(1);
  });

  test("a width above the natural size never magnifies", () => {
    const planner = new ReflowPlanner("flowchart TD\n  A --> B", {}, render);
    const plan = planner.plan(layoutWidthFor(1600, { width: 900 }));
    expect(plan.scale).toBe(1);
    expect(plan.width).toBeLessThan(200);
  });
});

describe("composition with node sizes", () => {
  test("a node-size edit made on the switched layout is written to the authored source", () => {
    const planner = new ReflowPlanner(LR, {}, render);
    const plan = planner.plan(500);
    expect(plan.direction).toBe("TB");
    // The handle edits the authored source (node ids are direction-invariant)…
    const next = writeNodeSize(LR, "A", { w: 240, h: 96 });
    expect(next.split("\n")[0]).toBe("flowchart LR");
    // …and the frame renders it with the same direction rewrite.
    const shown = render(applyPlanSource(next, plan), plan.options);
    const box = nodeBoxMap(shown.svg).get("A")!;
    const authored = nodeBoxMap(render(next, {}).svg).get("A")!;
    expect(Math.round(box.w)).toBe(Math.round(authored.w));
    expect(Math.round(box.h)).toBe(Math.round(authored.h));
  });

  test("a rebuilt planner (source edited in place) keeps the direction shown", () => {
    const a = new ReflowPlanner(LR, {}, render);
    const natural = a.plan(5000);
    const tb = a.plan(Math.floor(natural.width * 0.8));
    expect(tb.direction).toBe("TB");
    const edited = writeNodeSize(LR, "H", { w: 160 });
    const b = new ReflowPlanner(edited, {}, render);
    b.seed(tb);
    expect(b.plan(Math.floor(natural.width * 0.8) + 10).direction).toBe("TB");
  });
});
