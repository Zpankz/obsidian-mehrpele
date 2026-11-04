import { describe, expect, test } from "bun:test";
import { validateSource } from "pele-render/repair";
import { mehrpeleCheckSource, mehrpeleRenderSource, validateMehrpele } from "../../src/mehrpele/validate";
import { clampResize } from "../../src/mehrpele/node-resize";
import { decideRemeasure } from "../../src/mehrpele/remeasure";
import { DEFAULT_MEHRPELE_SETTINGS, normalizeMehrpeleSettings } from "../../src/mehrpele/settings";
import { buildCheckSummary, diagramRenderSource } from "../../src/cli-handlers";

const NESTED = [
  "flowchart LR",
  '  P["**Parent**"] --> N["~~~mermaid',
  "flowchart TD",
  "  X --> Y",
  '~~~"]',
  '  O["outer"] --> I["~~~mehrpele',
  "flowchart TD",
  '  a[\\"**bold** inner\\"] --> b[\\"[[Mehrpele]]\\"]',
  '~~~"]',
].join("\n");

const OUTER_FENCE = ['flowchart TD', '  M["```pele', "sequenceDiagram", "  A->>B: hi", '```"] --> R["after"]'].join("\n");

const check = (src: string) => validateMehrpele(src, (s) => validateSource(s));

describe("Mehrpele validation", () => {
  test("raw label Markdown fails Pele's lexer (the false positive this fixes)", () => {
    expect(validateSource(OUTER_FENCE).ok).toBe(false);
    expect(validateSource(NESTED).ok).toBe(false);
  });

  test("nested fences, backticks and \\\" escapes validate", () => {
    expect(check(NESTED).ok).toBe(true);
    expect(check(OUTER_FENCE).ok).toBe(true);
  });

  test("genuine errors still fail, with the block's own line number", () => {
    const bad = `${NESTED}\n  B --> C[[[`;
    const r = check(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.line).toBe(10);
  });

  test("the check source keeps every line in place", () => {
    const src = `%% mehrpele %%\n${NESTED}`;
    const out = mehrpeleCheckSource(src);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out.split("\n")[0]!.trim()).toBe("");
    expect(out).not.toContain("~~~");
    expect(out).toContain('N["flowchart diagram');
  });

  test("the render source has one line per label", () => {
    const out = mehrpeleRenderSource(`%% mehrpele %%\n${NESTED}`);
    expect(out).not.toContain("%% mehrpele");
    expect(out).toContain('N["flowchart diagram"]');
    expect(out.split("\n").length).toBe(3);
  });

  test("state descriptions are neutralised unquoted on one line", () => {
    const src = 'stateDiagram-v2\n  s1: "**a**\nb `c`"\n  [*] --> s1';
    expect(check(src).ok).toBe(true);
  });

  test("CLI check and render are Mehrpele-aware", () => {
    const note = ["# n", "", "```mehrpele", NESTED, "```", "", "```mermaid", OUTER_FENCE, "```", ""].join("\n");
    const s = buildCheckSummary([{ file: "n.md", content: note }]);
    // mehrpele block passes; a plain mermaid block keeps raw semantics.
    expect(s.results.map((r) => r.ok)).toEqual([true, false]);
    const withDirective = buildCheckSummary([{ file: "n.md", content: note.replace("```mermaid\n", "```mermaid\n%% mehrpele %%\n") }]);
    expect(withDirective.invalid).toBe(0);
    const always = buildCheckSummary([{ file: "n.md", content: note }], { isMehrpele: () => true });
    expect(always.invalid).toBe(0);
    const bad = buildCheckSummary([{ file: "n.md", content: note.replace("~~~\"]\n  O[", "~~~\"]\n  Z --> [[[\n  O[") }]);
    expect(bad.errors[0]?.line).toBe(9); // note line of `Z --> [[[`
    expect(diagramRenderSource({ lang: "mehrpele", code: NESTED })).not.toContain("~~~");
    expect(diagramRenderSource({ lang: "mermaid", code: OUTER_FENCE })).toBe(OUTER_FENCE);
  });
});

describe("clampResize", () => {
  const bounds = { min: { width: 100, height: 50 }, max: { width: 600, height: 400 } };

  test("free resize: width moves twice the pointer (centred content), height once", () => {
    expect(clampResize({ width: 200, height: 100 }, { x: 30, y: 20 }, bounds)).toEqual({ width: 260, height: 120 });
  });

  test("free resize clamps both axes", () => {
    expect(clampResize({ width: 200, height: 100 }, { x: 1000, y: 1000 }, bounds)).toEqual({ width: 600, height: 400 });
    expect(clampResize({ width: 200, height: 100 }, { x: -1000, y: -1000 }, bounds)).toEqual({ width: 100, height: 50 });
  });

  test("aspect-locked resize keeps the ratio inside both bounds", () => {
    const o = { ...bounds, aspect: 2 };
    expect(clampResize({ width: 200, height: 100 }, { x: 50, y: 0 }, o)).toEqual({ width: 300, height: 150 });
    // Height would exceed 400 at width 600 (aspect 1): width re-clamped.
    expect(clampResize({ width: 200, height: 200 }, { x: 1000, y: 0 }, { ...bounds, aspect: 1 })).toEqual({ width: 400, height: 400 });
    expect(clampResize({ width: 200, height: 100 }, { x: -1000, y: 0 }, o)).toEqual({ width: 100, height: 50 });
  });
});

describe("node sizing settings", () => {
  test("defaults", () => {
    expect(DEFAULT_MEHRPELE_SETTINGS.embedSizing).toBe("legible");
    expect(DEFAULT_MEHRPELE_SETTINGS.minEmbedScale).toBe(0.5);
    expect(DEFAULT_MEHRPELE_SETTINGS.nestedDiagrams).toBe(true);
    expect(DEFAULT_MEHRPELE_SETTINGS.maxNestingDepth).toBe(3);
  });

  test("invalid values fall back; ranges are clamped", () => {
    const s = normalizeMehrpeleSettings({
      embedSizing: "huge" as never,
      minEmbedScale: -1,
      nestedDiagrams: "yes" as never,
      maxNestingDepth: 2.5,
    });
    expect(s.embedSizing).toBe("legible");
    expect(s.minEmbedScale).toBe(0.5);
    expect(s.nestedDiagrams).toBe(true);
    expect(s.maxNestingDepth).toBe(3);
    const t = normalizeMehrpeleSettings({ embedSizing: "exact", minEmbedScale: 4, nestedDiagrams: false, maxNestingDepth: 99 });
    expect(t.embedSizing).toBe("exact");
    expect(t.minEmbedScale).toBe(1);
    expect(t.nestedDiagrams).toBe(false);
    expect(t.maxNestingDepth).toBe(8);
    expect(normalizeMehrpeleSettings({ maxNestingDepth: 0 }).maxNestingDepth).toBe(0);
  });
});

describe("per-anchor re-measure caps", () => {
  test("images and nested diagrams use their own maximum, not the Markdown label cap", () => {
    const d = decideRemeasure(
      [
        { anchorId: "img", size: { width: 100, height: 100 }, max: { width: 958, height: 950 } },
        { anchorId: "md", size: { width: 100, height: 20 } },
      ],
      [
        { anchorId: "img", size: { width: 684, height: 678 } },
        { anchorId: "md", size: { width: 700, height: 20 } },
      ],
      0,
      { maxWidth: 480, maxHeight: 320 },
    );
    expect(d.next.find((n) => n.anchorId === "img")?.size).toEqual({ width: 684, height: 678 });
    expect(d.next.find((n) => n.anchorId === "md")?.size).toEqual({ width: 480, height: 20 });
  });
});
