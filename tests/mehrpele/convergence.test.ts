import { describe, expect, test } from "bun:test";
import { render } from "pele";
import { parseViewBox, resolveAnchors } from "../../src/mehrpele/anchors";
import { isImageTarget } from "../../src/mehrpele/embeds";
import { extractLabels } from "../../src/mehrpele/extract";
import type { MehrpeleLabelSize } from "../../src/mehrpele/model";
import { overlayTransform } from "../../src/mehrpele/overlay";
import {
  buildPlaceholder,
  makeReservationMeasurer,
  placeholderSource,
  reservedBoxSize,
} from "../../src/mehrpele/placeholder";
import { clientToSvgSize, decideRemeasure, intrinsicSvgSize, type SizedAnchor } from "../../src/mehrpele/remeasure";

/**
 * Re-measure convergence, simulated against real Pele renders.
 *
 * The frame caps the SVG at a column width, so the diagram is drawn at
 * scale s = min(1, column / viewBox.width). Overlay labels are laid out 1:1
 * and CSS-scaled by s (overlay.ts), so their layout box is the true content
 * size in SVG units at any scale. The pre-fix pipeline measured *unscaled*
 * overlay content in client px and divided by s: reservations grew as the
 * diagram shrank, which shrank it further — boxes never came back down.
 */
const SOURCE = [
  "flowchart LR",
  '  A["**Start** — see [[Mehrpele]]"] --> B["$\\nabla_\\theta \\mathbb{E}[R(\\tau)]x$"]',
  '  B --> C["> [!note] Callouts work too"]',
].join("\n");

/** True intrinsic content sizes once MathJax/callout CSS have settled. */
const CONTENT: Record<string, MehrpeleLabelSize> = {
  A: { width: 182, height: 24 },
  B: { width: 190, height: 24 },
  C: { width: 168, height: 46 },
};

/** Pre-measure estimates (MathJax not yet typeset: raw TeX is wide). */
const PRE: Record<string, MehrpeleLabelSize> = {
  A: { width: 182, height: 24 },
  B: { width: 403, height: 110 },
  C: { width: 168, height: 92 },
};

const COLUMN = 520;
const OPTS = { maxWidth: 480, maxHeight: 320 };

function renderWith(sizes: Record<string, MehrpeleLabelSize>) {
  const labels = extractLabels(SOURCE);
  const reserved = labels.map((l, i) => buildPlaceholder(l, sizes[l.anchorId]!, 16, i));
  const result = render(placeholderSource(SOURCE, reserved), { measurer: makeReservationMeasurer(reserved) });
  const viewBox = parseViewBox(result.svg)!;
  const scale = Math.min(1, COLUMN / viewBox.width);
  const boxes = resolveAnchors(result.svg, labels, new Map(Object.entries(sizes)));
  return { scale, boxes };
}

type Measure = (content: MehrpeleLabelSize, scale: number) => MehrpeleLabelSize;

/** Fixed: layout box (1:1) + transformed client rect cross-check. */
const measureScaledOverlay: Measure = (c, s) =>
  intrinsicSvgSize({ offsetWidth: c.width, offsetHeight: c.height }, { width: c.width * s, height: c.height * s }, s);

/** Pre-fix: unscaled overlay content, client px divided by the SVG scale. */
const measureUnscaledOverlay: Measure = (c, s) => clientToSvgSize(c, s);

function runCycle(measure: Measure, maxPasses = 2) {
  let sizes = { ...PRE };
  let passes = 0;
  for (let pass = 0; pass <= maxPasses; pass++) {
    const { scale } = renderWith(sizes);
    const current: SizedAnchor[] = Object.entries(sizes).map(([anchorId, size]) => ({ anchorId, size }));
    const measured: SizedAnchor[] = Object.keys(sizes).map((anchorId) => ({
      anchorId,
      size: measure(CONTENT[anchorId]!, scale),
    }));
    const d = decideRemeasure(current, measured, pass, OPTS);
    if (!d.changed) return { sizes, passes, converged: true, ...renderWith(sizes) };
    if (pass >= maxPasses) break;
    passes++;
    sizes = Object.fromEntries(d.next.map((n) => [n.anchorId, n.size]));
  }
  return { sizes, passes, converged: false, ...renderWith(sizes) };
}

describe("re-measure convergence (scale-corrected overlay)", () => {
  test("the column forces a scaled-down diagram (precondition)", () => {
    expect(renderWith(PRE).scale).toBeLessThan(1);
    expect(renderWith(CONTENT).scale).toBeLessThan(1);
  });

  test("converges to intrinsic content within 2 passes, boxes = content + padding", () => {
    const r = runCycle(measureScaledOverlay);
    expect(r.converged).toBe(true);
    expect(r.passes).toBeLessThanOrEqual(2);
    expect(r.sizes).toEqual(CONTENT);
    for (const id of ["A", "B", "C"]) {
      const box = r.boxes.find((b) => b.anchorId === id)!;
      expect({ width: box.width, height: box.height }).toEqual(reservedBoxSize("node", CONTENT[id]!));
    }
    // The math node shrinks from the raw-TeX estimate to its typeset size.
    const math = r.boxes.find((b) => b.anchorId === "B")!;
    expect(math.width).toBe(190 + 36);
    expect(math.height).toBe(48);
  });

  test("a converged diagram stays converged (no re-render on the next trigger)", () => {
    const { scale } = renderWith(CONTENT);
    const d = decideRemeasure(
      Object.entries(CONTENT).map(([anchorId, size]) => ({ anchorId, size })),
      Object.entries(CONTENT).map(([anchorId, c]) => ({ anchorId, size: measureScaledOverlay(c, scale) })),
      0,
      OPTS,
    );
    expect(d.changed).toBe(false);
  });

  test("root cause: measuring unscaled overlay content in client px never comes back down", () => {
    const r = runCycle(measureUnscaledOverlay);
    expect(r.converged).toBe(false);
    // Reservations end up inflated by 1/scale instead of matching content.
    expect(r.sizes.B!.width).toBeGreaterThan(CONTENT.B!.width * 1.2);
  });
});

describe("scale correction helpers", () => {
  test("intrinsicSvgSize reads layout units regardless of the CSS scale", () => {
    for (const s of [0.5, 0.73, 1, 1.6]) {
      expect(
        intrinsicSvgSize({ offsetWidth: 190, offsetHeight: 24 }, { width: 190 * s, height: 24 * s }, s),
      ).toEqual({ width: 190, height: 24 });
    }
  });

  test("intrinsicSvgSize never rounds below sub-pixel content", () => {
    // offsetWidth rounds 190.4 down to 190; the transformed rect keeps it.
    expect(intrinsicSvgSize({ offsetWidth: 190, offsetHeight: 24 }, { width: 190.4 * 0.5, height: 12 }, 0.5)).toEqual({
      width: 191,
      height: 24,
    });
  });

  test("overlayTransform scales label layout to the SVG client scale", () => {
    expect(overlayTransform(0.5)).toBe("scale(0.5)");
    expect(overlayTransform(1)).toBe("");
    expect(overlayTransform(0.99995)).toBe("");
    expect(overlayTransform(Number.NaN)).toBe("");
    expect(overlayTransform(1.25)).toBe("scale(1.25)");
  });

  test("image embeds are measured (not fixed boxes)", () => {
    const t = (linkpath: string) => ({ linkpath, subpath: "", aliasOrSize: "100" });
    expect(isImageTarget(t("Pasted image 20240101120000.png"))).toBe(true);
    expect(isImageTarget(t("diagram.SVG"))).toBe(true);
    expect(isImageTarget(t("Board.canvas"))).toBe(false);
    expect(isImageTarget(t("Tasks.base"))).toBe(false);
    expect(isImageTarget(t("Note"))).toBe(false);
  });
});
