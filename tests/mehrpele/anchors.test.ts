import { describe, expect, test } from "bun:test";
import { render } from "pele";
import {
  ancestorTranslates,
  anchorScope,
  parseViewBox,
  resolveAnchors,
  svgAnchorIds,
  svgBoxToClient,
  svgScale,
} from "../../src/mehrpele/anchors";
import type { MehrpeleLabel } from "../../src/mehrpele/model";

function label(anchorId: string, kind: MehrpeleLabel["kind"], fallbackText = "x"): MehrpeleLabel {
  return { anchorId, kind, markdown: fallbackText, fallbackText, span: { start: 0, end: 0 } };
}

const SYNTHETIC = `<svg viewBox="0 0 400 300">
<g class="pele-node pele-shape-rect" data-id="A" transform="translate(100,80)"><rect x="-50" y="-30" width="100" height="60"/><text class="pele-label">A</text></g>
<g class="pele-node pele-shape-circle" data-id="C" transform="translate(300,80)"><circle r="40"/><text class="pele-label">C</text></g>
<g class="pele-edge-label" data-id="L_A_B_0"><rect x="150" y="140" width="80" height="20"/><text x="190" y="150">go</text></g>
<g class="pele-cluster" data-id="grp"><rect x="10" y="180" width="200" height="100"/><text class="pele-cluster-label" x="110" y="200">Title</text></g>
</svg>`;

describe("anchor geometry (synthetic SVG)", () => {
  test("viewBox parsing", () => {
    expect(parseViewBox(SYNTHETIC)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(parseViewBox("<svg></svg>")).toBeNull();
  });

  test("rect node box is offset by its translate", () => {
    const boxes = resolveAnchors(SYNTHETIC, [label("A", "node")], new Map());
    expect(boxes).toEqual([
      { anchorId: "A", x: 50, y: 50, width: 100, height: 60, shape: "rect" },
    ]);
  });

  test("circle node centres the reserved size", () => {
    const boxes = resolveAnchors(
      SYNTHETIC,
      [label("C", "node")],
      new Map([["C", { width: 120, height: 60 }]]),
    );
    expect(boxes).toEqual([
      { anchorId: "C", x: 240, y: 50, width: 120, height: 60, shape: "circle" },
    ]);
  });

  test("edge label maps A->B#0 to L_A_B_0 and uses its rect", () => {
    const boxes = resolveAnchors(SYNTHETIC, [label("A->B#0", "edge", "go")], new Map());
    expect(boxes).toEqual([
      { anchorId: "A->B#0", x: 150, y: 140, width: 80, height: 20, shape: "edge" },
    ]);
  });

  test("cluster title anchors on the cluster label position", () => {
    const boxes = resolveAnchors(
      SYNTHETIC,
      [label("subgraph:grp", "cluster", "Title")],
      new Map([["subgraph:grp", { width: 200, height: 28 }]]),
    );
    expect(boxes[0]).toMatchObject({ anchorId: "subgraph:grp", width: 200, height: 28, shape: "cluster" });
    expect(boxes[0].x).toBe(10);
  });

  test("missing anchors are omitted, never fabricated", () => {
    expect(resolveAnchors(SYNTHETIC, [label("ZZZ", "node")], new Map())).toHaveLength(0);
  });

  test("anchor id inventory", () => {
    expect(svgAnchorIds(SYNTHETIC)).toEqual({
      nodes: ["A", "C"],
      edges: ["L_A_B_0"],
      clusters: ["grp"],
    });
  });

  test("viewBox → client transform scales and offsets", () => {
    const vb = { x: 0, y: 0, width: 400, height: 300 };
    expect(svgScale(vb, { width: 800, height: 600 })).toBe(2);
    expect(
      svgBoxToClient({ x: 50, y: 50, width: 100, height: 60 }, vb, { width: 800, height: 600 }),
    ).toEqual({ left: 100, top: 100, width: 200, height: 120 });
    expect(
      svgBoxToClient({ x: 50, y: 50, width: 100, height: 60 }, vb, {
        width: 200, height: 150, offsetX: 10, offsetY: 5,
      }),
    ).toEqual({ left: 35, top: 30, width: 50, height: 30 });
  });
});

describe("wrapper transforms and sequence twins", () => {
  // Pele wraps sequence (and mindmap) content in one translated group; the
  // node rects sit at negative x inside it. Ignoring the wrapper shifted
  // every overlay up-left by exactly that translate ("Alice rendered 3x").
  const seq = render("sequenceDiagram\n  participant A as Alice\n  A->>B: hello\n").svg;
  const wrapper = /<g transform="translate\(([-\d.]+),([-\d.]+)\)">/.exec(seq);
  const rects = [...seq.matchAll(/data-id="A"><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g)];

  test("fixture still has the shape this test pins (wrapper + negative-x twins)", () => {
    expect(wrapper).not.toBeNull();
    expect(rects).toHaveLength(2);
    expect(Number(rects[0][1])).toBeLessThan(0);
    expect(seq.indexOf("pele-actor-footer")).toBeLessThan(seq.indexOf('pele-actor-participant" data-id="A"'));
  });

  test("participant boxes include the wrapper translate and land inside the viewBox", () => {
    const boxes = resolveAnchors(seq, [label("A", "node")], new Map());
    const tx = Number(wrapper![1]);
    const ty = Number(wrapper![2]);
    const footer = rects[0];
    const header = rects[1];
    expect(boxes).toHaveLength(2);
    // Header first (it takes the live label), each with its own DOM ordinal.
    expect(boxes[0]).toMatchObject({ twin: 1, x: tx + Number(header[1]), y: ty + Number(header[2]), width: Number(header[3]) });
    expect(boxes[1]).toMatchObject({ twin: 0, x: tx + Number(footer[1]), y: ty + Number(footer[2]) });
    const vb = parseViewBox(seq)!;
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(vb.x);
      expect(b.x + b.width).toBeLessThanOrEqual(vb.x + vb.width);
    }
  });

  test("each twin hides the text of its own group", () => {
    const boxes = resolveAnchors(seq, [label("A", "node")], new Map());
    expect(boxes.map(anchorScope)).toEqual([
      { selector: '.pele-node[data-id="A"]', index: 1 },
      { selector: '.pele-node[data-id="A"]', index: 0 },
    ]);
    // Single (non-twin) nodes carry no ordinal and scope the first match.
    const single = resolveAnchors(SYNTHETIC, [label("A", "node")], new Map());
    expect(single[0].twin).toBeUndefined();
    expect(anchorScope(single[0])).toEqual({ selector: '.pele-node[data-id="A"]', index: 0 });
    expect(anchorScope({ anchorId: "A->B#0", x: 0, y: 0, width: 1, height: 1, shape: "edge" })).toEqual({
      selector: '.pele-edge-label[data-id="L_A_B_0"]',
      index: 0,
    });
  });

  test("actor stick figures anchor on their label text, not the head", () => {
    const svg = render("sequenceDiagram\n  actor C as Carol\n  C->>B: hi\n").svg;
    const w = /<g transform="translate\(([-\d.]+),([-\d.]+)\)">/.exec(svg)!;
    const texts = [...svg.matchAll(/pele-actor-actor[^"]*" data-id="C">[\s\S]*?<text class="pele-label" x="([-\d.]+)" y="([-\d.]+)"/g)];
    const boxes = resolveAnchors(svg, [label("C", "node")], new Map([["C", { width: 40, height: 20 }]]));
    expect(boxes).toHaveLength(2);
    expect(boxes.map((b) => b.shape)).toEqual(["text", "text"]);
    // Header (second in the DOM) first.
    expect(boxes[0].x + 20).toBeCloseTo(Number(w[1]) + Number(texts[1][1]));
    expect(boxes[0].y + 10).toBeCloseTo(Number(w[2]) + Number(texts[1][2]));
  });

  test("mindmap nodes include the wrapper translate", () => {
    const mm = render("mindmap\n  root((r))\n    a\n    b").svg;
    const vb = parseViewBox(mm)!;
    const ids = svgAnchorIds(mm).nodes;
    const boxes = resolveAnchors(mm, ids.map((id) => label(id, "node")), new Map());
    expect(boxes.length).toBeGreaterThan(0);
    // Text-only nodes centre a fallback-sized box, so check the centres.
    for (const b of boxes) {
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      expect(cx).toBeGreaterThan(vb.x);
      expect(cx).toBeLessThan(vb.x + vb.width);
      expect(cy).toBeGreaterThan(vb.y);
      expect(cy).toBeLessThan(vb.y + vb.height);
    }
  });

  test("ancestor translates compose, pop on close and skip self-closing groups", () => {
    const svg = '<svg><g transform="translate(10,20)"><g/><g transform="translate(5)"><g id="x"></g></g><g id="y"></g></g><g id="z"></g></svg>';
    const at = (needle: string) => svg.indexOf(needle);
    const map = ancestorTranslates(svg, [at('<g id="x"'), at('<g id="y"'), at('<g id="z"')]);
    expect(map.get(at('<g id="x"'))).toEqual({ x: 15, y: 20 });
    expect(map.get(at('<g id="y"'))).toEqual({ x: 10, y: 20 });
    expect(map.get(at('<g id="z"'))).toEqual({ x: 0, y: 0 });
  });

  test("viewBox mapping with a negative origin", () => {
    const c = svgBoxToClient({ x: -53.75, y: -8, width: 107.5, height: 44 }, { x: -60, y: -10, width: 200, height: 100 }, {
      width: 400,
      height: 200,
    });
    expect(c).toEqual({ left: 12.5, top: 4, width: 215, height: 88 });
  });
});
