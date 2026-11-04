import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(`${import.meta.dir}/../styles.css`, "utf8");

/** Declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return "";
  return css.slice(at + selector.length + 2, css.indexOf("}", at)).trim();
}

describe("companion overlay CSS (api FrameHandle.overlay)", () => {
  test("the overlay covers the host and never clips by default", () => {
    const base = ruleBody(".pele-host > .mehrpele-overlay");
    expect(base).toContain("inset: 0");
    expect(base).not.toContain("overflow");
  });

  test("while the mount scrolls (minimum scale) the overlay clips like the mount", () => {
    const scrolling = ruleBody(".pele-host:has(> .pele-mount.is-scrolling) > .mehrpele-overlay");
    expect(scrolling).toContain("overflow: clip");
  });
});
