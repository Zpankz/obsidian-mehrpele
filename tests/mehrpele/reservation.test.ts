import { describe, expect, test } from "bun:test";
import { render } from "pele";
import { resolveAnchors } from "../../src/mehrpele/anchors";
import { extractLabels } from "../../src/mehrpele/extract";
import {
  buildPlaceholder,
  makeReservationMeasurer,
  placeholderSource,
  inertFallbackLine,
  reservedBoxSize,
} from "../../src/mehrpele/placeholder";

/**
 * Pele's measured metrics as tests (pele@1.13.0, headless render). Reservations are
 * *content* sizes; Pele adds its own padding, so a flowchart rect box is
 * content + (36 × 24) with the height rounded up to Pele's line grid (one
 * line 1.5 em, two or more lines 1.3 em each), edge labels add their own
 * small padding, other types resolve to centred-overlay boxes.
 */
function renderReserved(source: string, sizes: Record<string, { width: number; height: number }>) {
  const labels = extractLabels(source);
  const reserved = labels
    .filter((l) => sizes[l.anchorId])
    .map((l, i) => buildPlaceholder(l, sizes[l.anchorId], 16, i));
  const src = placeholderSource(source, reserved);
  const measurer = makeReservationMeasurer(reserved);
  const result = render(src, { measurer });
  const sizeMap = new Map(labels.map((l) => [l.anchorId, sizes[l.anchorId]] as const));
  return { result, labels, boxes: resolveAnchors(result.svg, labels, sizeMap) };
}

describe("unique placeholder tokens", () => {
  test("identical fallback text on two labels reserves different boxes", () => {
    const { boxes } = renderReserved(
      'flowchart TD\n  A["**same** text"] --> B["*same* text"]',
      { A: { width: 184, height: 72 }, B: { width: 94, height: 72 } },
    );
    expect(boxes.find((b) => b.anchorId === "A")?.width).toBe(220);
    expect(boxes.find((b) => b.anchorId === "B")?.width).toBe(130);
  });
});

describe("box reservation", () => {
  test("flowchart rect reserves content + node padding", () => {
    const { boxes } = renderReserved(
      'flowchart TD\n  A["**big** label"] --> B["x"]',
      { A: { width: 164, height: 72 } },
    );
    const a = boxes.find((b) => b.anchorId === "A");
    // 72px of content needs four 21px lines (84) + 24 padding.
    expect(a).toMatchObject({ width: 200, height: 108, shape: "rect" });
    expect(reservedBoxSize("node", { width: 164, height: 72 })).toEqual({ width: 200, height: 108 });
  });

  test("flowchart height follows the <br> filler line count", () => {
    const { boxes } = renderReserved('flowchart TD\n  A["tall"] --> B["x"]', {
      A: { width: 84, height: 120 },
    });
    // Never less than content + padding: six 21px lines hold 120px.
    expect(boxes.find((b) => b.anchorId === "A")?.height).toBe(6 * 21 + 24);
    expect(reservedBoxSize("node", { width: 84, height: 120 }).height).toBe(6 * 21 + 24);
  });

  test("regression: one-line content gets a one-line box with padding on both axes", () => {
    // `**Start** — see [[Mehrpele]]` measured ~182×24: the old rule reserved
    // content-minus-padding, so the overlay overflowed its node horizontally.
    const { boxes } = renderReserved('flowchart LR\n  A["**Start** — see [[Mehrpele]]"] --> B', {
      A: { width: 182, height: 24 },
    });
    const a = boxes.find((b) => b.anchorId === "A")!;
    expect(a.width).toBe(182 + 36);
    expect(a.height).toBe(48);
    expect(a.width).toBeGreaterThan(182);
  });

  test("edge labels reserve width (14px metrics, own padding)", () => {
    const { boxes, result } = renderReserved('flowchart LR\n  A -->|"wide label"| B', {
      "A->B#0": { width: 180, height: 21 },
    });
    expect(result.svg).toContain("pele-edge-label");
    const e = boxes.find((b) => b.anchorId === "A->B#0");
    expect(e).toBeDefined();
    // Edge rect = reserved text width + small padding; within 12px of target.
    expect(Math.abs((e?.width ?? 0) - 180)).toBeLessThanOrEqual(12);
  });

  test("state nodes reserve within a few px (compact padding)", () => {
    const { boxes } = renderReserved('stateDiagram-v2\n  s1: "First"\n  s1 --> s2: go', {
      s1: { width: 168, height: 72 },
    });
    const s1 = boxes.find((b) => b.anchorId === "s1");
    expect(s1).toBeDefined();
    // Compact padding (32 × 20): content + padding, height on the line grid (84 for 72).
    expect(Math.abs((s1?.width ?? 0) - 200)).toBeLessThanOrEqual(8);
    expect(Math.abs((s1?.height ?? 0) - (84 + 20))).toBeLessThanOrEqual(8);
  });

  test("diamond centres the reserved box instead of using the shape bbox", () => {
    const { boxes } = renderReserved('flowchart TD\n  B{"decide?" } --> C["x"]', {
      B: { width: 160, height: 72 },
    });
    const b = boxes.find((x) => x.anchorId === "B");
    expect(b).toMatchObject({ width: 160, height: 72, shape: "polygon" });
  });

  test("subgraph title resolves as a cluster box", () => {
    const { boxes } = renderReserved(
      'flowchart TD\n  subgraph grp ["Group title"]\n    A --> B\n  end',
      { "subgraph:grp": { width: 200, height: 28 } },
    );
    expect(boxes.find((b) => b.anchorId === "subgraph:grp")?.shape).toBe("cluster");
  });

  test("sequence participant resolves (header box, reserved size centred)", () => {
    const { boxes } = renderReserved(
      'sequenceDiagram\n  participant A as "Alice"\n  A->>B: hi',
      { A: { width: 168, height: 48 } },
    );
    const a = boxes.filter((b) => b.anchorId === "A");
    expect(a.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(a[0].width - 200)).toBeLessThanOrEqual(8);
  });

  test("placeholder source keeps readable fallback text in the SVG", () => {
    const { result } = renderReserved('flowchart TD\n  A["**Start** [[Welcome]]"] --> B["x"]', {
      A: { width: 200, height: 96 },
    });
    expect(result.svg).toContain("Start Welcome");
    expect(result.svg).not.toContain("MP0");
  });

  test("unreserved labels resolve to their natural boxes (overlay only covers rendered labels)", () => {
    const { boxes } = renderReserved('flowchart TD\n  A["x"] --> B["y"]', {});
    expect(boxes.map((b) => b.anchorId)).toEqual(["A", "B"]);
  });
});

describe("reserved lines never grow extra height (live math/table/callout regression)", () => {
  test("a reservation wider than Pele's wrap width stays one line", () => {
    const { boxes } = renderReserved('flowchart TD\n  A["a long label with many words here and more words"] --> B', {
      A: { width: 400, height: 24 },
    });
    expect(boxes.find((b) => b.anchorId === "A")).toMatchObject({ width: 436, height: 48 });
  });

  test("raw TeX fallback cannot inject a line break (\\nabla)", () => {
    const { boxes, result } = renderReserved(
      'flowchart LR\n  T2("$\\nabla_\\theta \\mathbb{E}_{\\tau\\sim p_\\theta}[R(\\tau)]x$")',
      { T2: { width: 190, height: 24 } },
    );
    expect(boxes.find((b) => b.anchorId === "T2")).toMatchObject({ width: 226, height: 48 });
    expect(result.svg).not.toContain("<tspan");
  });

  test("inert fallback drops escapes/entities/quotes and keeps TeX command names", () => {
    expect(inertFallbackLine("$\\nabla_\\theta x$ & <b>#quot;\"q\"`c`", "A")).toBe("$nabla_theta x$ bquot;qc");
    expect(inertFallbackLine("   ", "fallback")).toBe("fallback");
    expect(inertFallbackLine("x".repeat(100), "A")).toHaveLength(80);
  });
});
