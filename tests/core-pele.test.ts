import "./helpers/dom-globals";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CORE_PELE_VERSION, hasCorePele } from "../src/core-pele";
import { lpSelfCheckVerdict } from "../src/lp-self-check";

describe("hasCorePele", () => {
  test("core's lazy window.pele means core Pele", () => {
    expect(hasCorePele({ win: { pele: {} }, apiVersionAtLeast: () => false })).toBe(true);
  });
  test("apiVersion ≥ 1.15.0 means core Pele even before window.pele loads", () => {
    const asked: string[] = [];
    expect(hasCorePele({ win: {}, apiVersionAtLeast: (v) => (asked.push(v), true) })).toBe(true);
    expect(asked).toEqual([CORE_PELE_VERSION]);
    expect(CORE_PELE_VERSION).toBe("1.15.0");
  });
  test("older builds: neither", () => {
    expect(hasCorePele({ win: {}, apiVersionAtLeast: () => false })).toBe(false);
    expect(hasCorePele({ win: undefined, apiVersionAtLeast: () => false })).toBe(false);
  });
  test("a throwing version probe is treated as an older build", () => {
    expect(
      hasCorePele({
        win: {},
        apiVersionAtLeast: () => {
          throw new Error("no api");
        },
      }),
    ).toBe(false);
  });
});

describe("Live Preview self-check verdict", () => {
  test("patched is ok whatever else happened", () => {
    expect(lpSelfCheckVerdict({ patched: true, sawCodeBlocks: true })).toBe("ok");
  });
  test("code blocks on screen but no widget class: failed", () => {
    expect(lpSelfCheckVerdict({ patched: false, sawCodeBlocks: true })).toBe("failed");
  });
  test("no code blocks yet: pending (cannot tell)", () => {
    expect(lpSelfCheckVerdict({ patched: false, sawCodeBlocks: false })).toBe("pending");
  });
});

describe("wiring", () => {
  const root = new URL("../", import.meta.url).pathname;
  const main = readFileSync(`${root}main.ts`, "utf8");
  const lp = readFileSync(`${root}src/lp-patch.ts`, "utf8");
  test("layout-ready runs the self-check over open editors", () => {
    expect(main.includes("onLayoutReady(() => this.lp?.selfCheck(this.liveEditorViews()))")).toBe(true);
  });
  test("one Notice, on core-Pele builds only", () => {
    expect(main.includes('new Notice("Live preview editing unavailable on this Obsidian build")')).toBe(true);
    expect(main.includes("hasCorePele({ apiVersionAtLeast: requireApiVersion })")).toBe(true);
    expect(lp.includes("if (this.reportedUnavailable) return;")).toBe(true);
  });
});
