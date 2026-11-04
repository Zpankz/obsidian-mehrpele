import { describe, expect, test } from "bun:test";
import { chooseFit, containScale, fitCandidates, FILL_MAX, innerBox, shapeKind } from "../src/node-fill";

describe("node fill: choosing a fit", () => {
  const inner = { width: 300, height: 200 };

  test("contain scale is the tighter axis", () => {
    expect(containScale({ width: 100, height: 20 }, inner)).toBe(3);
    expect(containScale({ width: 150, height: 100 }, inner)).toBe(2);
  });

  test("fixed content (a formula) just scales up, capped", () => {
    const s = fitCandidates(inner, 480).map((m) => ({ maxWidth: m, width: 120, height: 30 }));
    const fit = chooseFit(s, inner);
    expect(fit.scale).toBe(2.5);
    expect(fit.maxWidth).toBe(480); // ties keep the widest wrap
    expect(chooseFit([{ maxWidth: 480, width: 20, height: 10 }], inner).scale).toBe(FILL_MAX);
  });

  test("wrapping text picks the wrap where width and height limits meet", () => {
    // 600 px of text: at wrap w it is w wide and ceil(600 / w) lines of 24 px.
    const s = fitCandidates(inner, 480).map((m) => ({ maxWidth: m, width: Math.min(m, 600), height: Math.ceil(600 / Math.min(m, 600)) * 24 }));
    const fit = chooseFit(s, inner);
    const naive = containScale({ width: 300, height: 48 }, inner); // wrap at the inner width
    expect(fit.scale).toBeGreaterThan(naive);
    expect(fit.maxWidth).toBeLessThan(300);
  });

  test("never below 1×: too big content wraps at the inner width and overflows (the node grows)", () => {
    const s = [480, 300, 200].map((m) => ({ maxWidth: m, width: Math.max(m, 250), height: 400 }));
    const fit = chooseFit(s, inner);
    expect(fit.scale).toBe(1);
    expect(fit.maxWidth).toBe(300);
    expect(fit.overflow).toBe(true);
  });

  test("candidates include the natural cap, the box and a fixed ladder of narrower wraps", () => {
    expect(fitCandidates(inner, 480)).toEqual([480, 300, 280, 230, 190, 160, 130, 108, 90, 74, 60, 48, 38, 30, 24, 18]);
  });
  test("a wider box keeps the narrower wraps it had (growing a side never loses the best fill)", () => {
    const small = fitCandidates({ width: 90, height: 100 }, 480).filter((w) => w < 90 && w !== 480);
    const big = fitCandidates({ width: 260, height: 100 }, 480);
    expect(small.length).toBeGreaterThan(0);
    for (const w of small) expect(big).toContain(w);
  });
});

describe("node fill: inner boxes", () => {
  const box = { x: -100, y: -50, w: 200, h: 100 };
  test("rects lose Pele's label padding; circles and diamonds inscribe", () => {
    expect(innerBox(box, "rect", 16)).toEqual({ x: -82, y: -38, w: 164, h: 76 });
    const c = innerBox({ x: 0, y: 0, w: 100, h: 100 }, "circle", 16);
    expect(Math.round(c.w)).toBe(35); // 100/√2 − 36
    const d = innerBox(box, "diamond", 16);
    expect(d.w).toBe(64);
    expect(d.h).toBe(26);
  });
  test("shape kinds from node classes", () => {
    expect(shapeKind("pele-node pele-shape-diam")).toBe("diamond");
    expect(shapeKind("pele-node pele-shape-circle pele-root")).toBe("circle");
    expect(shapeKind("pele-node pele-shape-text")).toBe("text");
    expect(shapeKind("pele-node pele-shape-rounded")).toBe("rect");
    expect(shapeKind("pele-node pele-shape-hex")).toBe("polygon");
  });
});
