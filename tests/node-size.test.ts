import { describe, expect, test } from "bun:test";
import { render } from "pele-render/pele";
import { nodeBoxMap, FILL_OPEN, FILL_CLOSE } from "pele-render/node-size";
import {
  clearNodeSizes,
  committedEntry,
  dragNodeBox,
  isSameBox,
  pruneNoteSizes,
  pruneStaleSizes,
  settleEntry,
  shiftBoxEntry,
  writeNodeSize,
} from "../src/node-size";
import { extractLabels } from "../src/mehrpele/extract";
import { buildPlaceholder, fillerWidth, makeReservationMeasurer, placeholderSource } from "../src/mehrpele/placeholder";

const FREE = { w: true, h: true, lock: "free" as const };
const SQUARE = { w: true, h: false, lock: "square" as const };
const HEIGHT = { w: false, h: true, lock: "free" as const };
const line = (s: string) => s.split("\n").filter((l) => l.includes("pele-size")).join("|");

describe("dragNodeBox (box-handle drag clamps)", () => {
  test("both axes grow by twice the pointer delta (nodes are centred)", () => {
    expect(dragNodeBox({ w: 100, h: 48 }, { x: 10, y: 0 }, FREE, { lineHeight: 0 })).toEqual({ w: 120, h: 48 });
    expect(dragNodeBox({ w: 100, h: 48 }, { x: 0, y: 12 }, FREE, { lineHeight: 0 })).toEqual({ w: 100, h: 72 });
  });

  test("height snaps to whole lines", () => {
    expect(dragNodeBox({ w: 100, h: 48 }, { x: 0, y: 5 }, FREE, { lineHeight: 24 }).h).toBe(48);
    expect(dragNodeBox({ w: 100, h: 48 }, { x: 0, y: 7 }, FREE, { lineHeight: 24 }).h).toBe(72);
    expect(dragNodeBox({ w: 100, h: 48 }, { x: 0, y: -30 }, FREE, { lineHeight: 24 }).h).toBe(24);
  });

  test("min and max bounds", () => {
    expect(dragNodeBox({ w: 100, h: 48 }, { x: -500, y: -500 }, FREE, { lineHeight: 0 })).toEqual({ w: 16, h: 16 });
    expect(dragNodeBox({ w: 100, h: 48 }, { x: 5000, y: 0 }, FREE, { lineHeight: 0 }).w).toBe(1600);
    expect(dragNodeBox({ w: 100, h: 48 }, { x: -500, y: 0 }, FREE, { lineHeight: 0, min: 40 }).w).toBe(40);
  });

  test("square nodes follow the larger delta; height-only nodes keep their width", () => {
    expect(dragNodeBox({ w: 60, h: 60 }, { x: 5, y: 20 }, SQUARE, { lineHeight: 24 })).toEqual({ w: 100, h: 100 });
    expect(dragNodeBox({ w: 184, h: 41 }, { x: 50, y: 20 }, HEIGHT, { lineHeight: 0 })).toEqual({ w: 184, h: 81 });
  });
});

describe("committedEntry / settleEntry", () => {
  test("only changed dimensions, merged with the existing entry", () => {
    expect(committedEntry({ w: 100, h: 48 }, { w: 140, h: 48 }, undefined, FREE)).toEqual({ w: 140 });
    expect(committedEntry({ w: 100, h: 48 }, { w: 100, h: 72 }, { w: 130 }, FREE)).toEqual({ w: 130, h: 72 });
    expect(committedEntry({ w: 100, h: 48 }, { w: 140, h: 72 }, undefined, FREE)).toEqual({ w: 140, h: 72 });
  });

  test("no change, no entry (never a write)", () => {
    expect(committedEntry({ w: 100, h: 48 }, { w: 100, h: 48 }, undefined, FREE)).toBeNull();
    expect(committedEntry({ w: 100, h: 48 }, { w: 120, h: 48 }, { w: 120 }, FREE)).toBeNull();
  });

  test("square writes W only; height-only writes H only", () => {
    expect(committedEntry({ w: 60, h: 60 }, { w: 90, h: 90 }, undefined, SQUARE)).toEqual({ w: 90 });
    expect(committedEntry({ w: 184, h: 41 }, { w: 184, h: 81 }, undefined, HEIGHT)).toEqual({ h: 81 });
  });

  test("a clamped result is written as rendered; within 2 units the request stands", () => {
    expect(settleEntry({ w: 200, h: 60 }, { w: 201, h: 125 })).toEqual({ w: 200, h: 125 });
    expect(settleEntry({ w: 200 }, null)).toEqual({ w: 200 });
    expect(isSameBox({ w: 131, h: 82 }, { w: 132, h: 82 })).toBe(true);
    expect(isSameBox({ w: 140 }, { w: 132, h: 82 })).toBe(false);
  });
});

describe("source edits", () => {
  const src = "flowchart LR\n  A[x] --> B[y]";

  test("writeNodeSize adds, updates, removes and prunes vanished nodes", () => {
    const a = writeNodeSize(src, "A", { w: 120 });
    expect(line(a)).toBe("%% pele-size A=120 %%");
    const b = writeNodeSize(`${a.replace(/\n%%.*$/, "")}\n%% pele-size A=120 Gone=3 %%`, "B", { h: 72 });
    expect(line(b)).toBe("%% pele-size A=120 B=x72 %%");
    expect(writeNodeSize(a, "A", null)).toBe(src);
  });

  test("Mehrpele sources (Markdown labels) prune through their neutralised form", () => {
    const m = 'flowchart LR\n  A["**bold** ```mermaid\nflowchart LR\nX-->Y\n```"] --> B\n%% pele-size A=200 Z=9 %%';
    expect(line(writeNodeSize(m, "B", { w: 90 }))).toBe("%% pele-size A=200 B=90 %%");
  });

  test("clearNodeSizes and pruneStaleSizes", () => {
    const s = `${src}\n%% pele-size A=1 Z=2 %%`;
    expect(clearNodeSizes(s)).toBe(src);
    expect(line(pruneStaleSizes(s))).toBe("%% pele-size A=1 %%");
  });

  test("pruneNoteSizes plans one body edit per affected block", () => {
    const md = "# N\n\n```mermaid\nflowchart LR\n  A --> B\n%% pele-size A=10 Q=4 %%\n```\n\n```mermaid\nflowchart LR\n  C\n```\n";
    const plan = pruneNoteSizes(md);
    expect(plan).toEqual([{ firstLine: 3, lastLine: 5, body: "flowchart LR\n  A --> B\n%% pele-size A=10 %%" }]);
  });
});

describe("media nodes: content handle shifts the box entry", () => {
  const src = 'flowchart LR\n  I["![[p.png|200]]"] --> B\n%% pele-size I=300x260 %%';

  test("content grows by Δ → box grows by Δ (one source)", () => {
    expect(line(shiftBoxEntry(src, "I", { dw: 40, dh: 30 }, { width: 240, height: 180 }))).toBe("%% pele-size I=340x290 %%");
  });

  test("a dimension under content + padding is dropped (box follows content)", () => {
    expect(line(shiftBoxEntry(src, "I", { dw: 40, dh: 30 }, { width: 330, height: 180 }))).toBe("%% pele-size I=x290 %%");
    expect(line(shiftBoxEntry(src, "I", { dw: -200, dh: -200 }, { width: 400, height: 400 }))).toBe("");
  });

  test("no box entry: label-only edit", () => {
    const plain = 'flowchart LR\n  I["![[p.png|200]]"]';
    expect(shiftBoxEntry(plain, "I", { dw: 40, dh: 30 }, { width: 240, height: 180 })).toBe(plain);
  });
});

describe("Mehrpele reservation + pele-size", () => {
  test("the reservation measurer counts the filler after a token line", () => {
    expect(fillerWidth(`${FILL_OPEN}00''${FILL_CLOSE}`, 16, 0)).toBeCloseTo(2 * 0.55 * 16 + 2 * 0.19 * 16, 5);
    expect(fillerWidth(`${FILL_OPEN}0${FILL_CLOSE}`, 16, 0, { width: (t) => t.length * 10 })).toBe(10);
  });

  test("a Markdown label's node box can be sized beyond its content", () => {
    const source = 'flowchart LR\n  M["**Markdown** label"] --> N\n%% pele-size M=300x96 %%';
    const labels = extractLabels(source);
    const reserved = labels.map((l, i) => buildPlaceholder(l, { width: 120, height: 24 }, 16, i));
    const measurer = makeReservationMeasurer(reserved);
    const r = render(placeholderSource(source, reserved), { measurer });
    const b = nodeBoxMap(r.svg).get("M")!;
    expect(Math.abs(b.w - 300)).toBeLessThanOrEqual(3);
    expect(Math.abs(b.h - 96)).toBeLessThanOrEqual(12); // height moves on Pele's line grid
    // the token survives (mount strips it from the live SVG)
    expect(r.svg).toContain("\uE000m0\uE001");
  });

  test("quoted ids in the directive are never labels", () => {
    const labels = extractLabels('flowchart LR\n  A["x"]\n%% pele-size "Make tea"=120 A=90 %%');
    expect(labels.map((l) => l.anchorId)).toEqual(["A"]);
  });
});

describe("regressions (plugin)", () => {
  test("a node that vanished mid-drag gets no entry", () => {
    const src = "flowchart LR\n  A --> B";
    expect(writeNodeSize(src, "Gone", { w: 100 })).toBe(src);
  });

  test("pruneNoteSizes handles bodies ending with a blank line", () => {
    const md = "```mermaid\nflowchart LR\n  A --> B\n%% pele-size A=10 Q=4 %%\n\n```\n";
    expect(pruneNoteSizes(md)).toEqual([{ firstLine: 1, lastLine: 4, body: "flowchart LR\n  A --> B\n%% pele-size A=10 %%\n" }]);
  });
});
