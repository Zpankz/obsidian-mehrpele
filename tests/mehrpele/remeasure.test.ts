import { describe, expect, test } from "bun:test";
import { clientToSvgSize, decideRemeasure, type SizedAnchor } from "../../src/mehrpele/remeasure";

const cur: SizedAnchor[] = [
  { anchorId: "A", size: { width: 366, height: 169 } },
  { anchorId: "B", size: { width: 100, height: 40 } },
];
const opts = { maxWidth: 480, maxHeight: 400 };

describe("decideRemeasure", () => {
  test("shrinks over-reserved boxes to measured content", () => {
    const d = decideRemeasure(cur, [
      { anchorId: "A", size: { width: 192, height: 26 } },
      { anchorId: "B", size: { width: 100, height: 40 } },
    ], 0, opts);
    expect(d.changed).toBe(true);
    expect(d.next.find((n) => n.anchorId === "A")?.size).toEqual({ width: 192, height: 26 });
    expect(d.mayContinue).toBe(true);
  });

  test("stable within tolerance converges (no change)", () => {
    const d = decideRemeasure(cur, [
      { anchorId: "A", size: { width: 365, height: 168 } },
      { anchorId: "B", size: { width: 101, height: 39 } },
    ], 0, opts);
    expect(d.changed).toBe(false);
    expect(d.mayContinue).toBe(false);
  });

  test("pass budget bounds extra re-renders", () => {
    const measured = [{ anchorId: "A", size: { width: 10, height: 10 } }];
    expect(decideRemeasure(cur, measured, 1, opts).mayContinue).toBe(true);
    expect(decideRemeasure(cur, measured, 2, opts).mayContinue).toBe(false);
  });

  test("regression: a stretched overlay box shrinks to intrinsic content", () => {
    // Reservation grew to 350x430 while content is 190x24: next must shrink
    // to the intrinsic size (placeholder padding is applied downstream),
    // never grow from measuring the stretched overlay item.
    const d = decideRemeasure(
      [{ anchorId: "T2", size: { width: 350, height: 430 } }],
      [{ anchorId: "T2", size: { width: 190, height: 24 } }],
      0,
      opts,
    );
    expect(d.changed).toBe(true);
    expect(d.next[0]?.size).toEqual({ width: 190, height: 24 });
  });

  test("scale correction: client px convert to SVG units before comparing", () => {
    // At scale 2, a 380x48 client-px intrinsic box is 190x24 SVG units.
    expect(clientToSvgSize({ width: 380, height: 48 }, 2)).toEqual({ width: 190, height: 24 });
    expect(clientToSvgSize({ width: 190, height: 24 }, 1)).toEqual({ width: 190, height: 24 });
    expect(clientToSvgSize({ width: 95, height: 12 }, 0.5)).toEqual({ width: 190, height: 24 });
    // …and after conversion it converges against the 190x24 reservation.
    const svgSize = clientToSvgSize({ width: 380, height: 48 }, 2);
    const d = decideRemeasure(
      [{ anchorId: "T2", size: { width: 190, height: 24 } }],
      [{ anchorId: "T2", size: svgSize }],
      0,
      opts,
    );
    expect(d.changed).toBe(false);
  });

  test("measured sizes are clamped to max label box", () => {
    const d = decideRemeasure(cur, [{ anchorId: "A", size: { width: 9999, height: 9999 } }], 0, opts);
    expect(d.next.find((n) => n.anchorId === "A")?.size).toEqual({ width: 480, height: 400 });
  });
});
