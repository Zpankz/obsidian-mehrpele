import { describe, expect, test } from "bun:test";
import { fenceWidthChanges, type TextChange } from "../src/fence-change";

function change(oldText: string, newText: string, needleOld: string, needleNew: string): TextChange {
  const fromA = oldText.indexOf(needleOld);
  const fromB = newText.indexOf(needleNew);
  return { fromA, toA: fromA + needleOld.length, fromB, toB: fromB + needleNew.length };
}

const BASE = "# T\n\n```mermaid\ngraph LR\n A-->B\n```\n";

describe("fenceWidthChanges", () => {
  test("detects width added by hand-editing the fence", () => {
    const next = BASE.replace("```mermaid", "```mermaid width=250");
    const changes = fenceWidthChanges(BASE, next, [change(BASE, next, "```mermaid", "```mermaid width=250")]);
    expect(changes).toEqual([{ line: 2, width: 250, height: undefined, zoom: undefined }]);
  });

  test("detects width removal (back to natural)", () => {
    const before = BASE.replace("```mermaid", "```mermaid width=250");
    const changes = fenceWidthChanges(before, BASE, [change(before, BASE, "```mermaid width=250", "```mermaid")]);
    expect(changes).toEqual([{ line: 2, width: undefined, height: undefined, zoom: undefined }]);
  });

  test("detects width value change", () => {
    const before = BASE.replace("```mermaid", "```mermaid width=250");
    const after = BASE.replace("```mermaid", "```mermaid width=400");
    const changes = fenceWidthChanges(before, after, [change(before, after, "width=250", "width=400")]);
    expect(changes).toEqual([{ line: 2, width: 400, height: undefined, zoom: undefined }]);
  });

  test("ignores edits to code lines and prose", () => {
    const next = BASE.replace("graph LR", "graph TD");
    expect(fenceWidthChanges(BASE, next, [change(BASE, next, "graph LR", "graph TD")])).toEqual([]);
    const next2 = BASE.replace("# T", "# Title");
    expect(fenceWidthChanges(BASE, next2, [change(BASE, next2, "# T", "# Title")])).toEqual([]);
  });
});

import { fenceWidthChangesIn, stringLineDoc, type LineDoc } from "../src/fence-change";

describe("fenceWidthChangesIn reads only changed lines", () => {
  test("a keystroke in a 10k-line note reads O(1) lines, never the whole doc", () => {
    const body = Array.from({ length: 10_000 }, (_, i) => `line ${i}`);
    const oldText = ["```mermaid", "graph TD", "```", ...body].join("\n");
    const newText = ["```mermaid width=300", "graph TD", "```", ...body].join("\n");
    const counted = (doc: LineDoc) => {
      let reads = 0;
      return {
        doc: { lines: doc.lines, lineAt: (p: number) => doc.lineAt(p), line: (n: number) => (reads++, doc.line(n)) },
        reads: () => reads,
      };
    };
    const o = counted(stringLineDoc(oldText));
    const n = counted(stringLineDoc(newText));
    const at = "```mermaid".length;
    const changes = [{ fromA: at, toA: at, fromB: at, toB: at + " width=300".length }];
    expect(fenceWidthChangesIn(o.doc, n.doc, changes)).toEqual([{ line: 0, width: 300, height: undefined, zoom: undefined }]);
    expect(o.reads() + n.reads()).toBeLessThanOrEqual(2);
  });

  test("stringLineDoc maps offsets to 1-based lines", () => {
    const d = stringLineDoc("ab\ncd\n");
    expect([0, 2, 3, 5, 6].map((p) => d.lineAt(p).number)).toEqual([1, 1, 2, 2, 3]);
    expect(d.line(2).text).toBe("cd");
  });
});

describe("fenceWidthChanges: zoom", () => {
  test("a zoom-only hand edit is a change", () => {
    const before = "```mermaid width=400\ngraph TD\n```";
    const after = "```mermaid width=400 zoom=1.5\ngraph TD\n```";
    const at = "```mermaid width=400".length;
    expect(fenceWidthChanges(before, after, [{ fromA: at, toA: at, fromB: at, toB: at + 9 }])).toEqual([{ line: 0, width: 400, height: undefined, zoom: 1.5 }]);
  });
});

describe("fenceWidthChanges: height", () => {
  test("a height edit (a corner dragged down) is a change", () => {
    const before = "```mermaid width=400\ngraph TD\n```";
    const after = "```mermaid width=400 height=320\ngraph TD\n```";
    const at = "```mermaid width=400".length;
    expect(fenceWidthChanges(before, after, [{ fromA: at, toA: at, fromB: at, toB: at + 11 }])).toEqual([{ line: 0, width: 400, height: 320, zoom: undefined }]);
  });
});

import { fenceLayoutChanged } from "../src/fence-change";
import { fenceLineAt } from "../src/info-width";

describe("fenceLayoutChanged (companion keys may be stale)", () => {
  const at = (doc: string, needle: string) => doc.indexOf(needle);
  test("a line added or removed anywhere: fences below moved", () => {
    const next = BASE.replace("# T\n", "# T\nAdded.\n");
    const p = at(BASE, "\n") + 1;
    expect(fenceLayoutChanged(stringLineDoc(BASE), stringLineDoc(next), [{ fromA: p, toA: p, fromB: p, toB: p + 7 }])).toBe(true);
    expect(fenceLayoutChanged(stringLineDoc(next), stringLineDoc(BASE), [{ fromA: p, toA: p + 7, fromB: p, toB: p }])).toBe(true);
  });
  test("an edit on an opening fence line: its info-string rest may have changed", () => {
    const next = BASE.replace("```mermaid", "```mermaid cannoli");
    const p = at(BASE, "```mermaid") + "```mermaid".length;
    expect(fenceLayoutChanged(stringLineDoc(BASE), stringLineDoc(next), [{ fromA: p, toA: p, fromB: p, toB: p + 8 }])).toBe(true);
  });
  test("typing on a prose or code line: nothing to resync", () => {
    const next = BASE.replace("# T", "# Tx");
    const p = at(BASE, "# T") + 3;
    expect(fenceLayoutChanged(stringLineDoc(BASE), stringLineDoc(next), [{ fromA: p, toA: p, fromB: p, toB: p + 1 }])).toBe(false);
    const next2 = BASE.replace("A-->B", "A-->BC");
    const q = at(BASE, "A-->B") + 5;
    expect(fenceLayoutChanged(stringLineDoc(BASE), stringLineDoc(next2), [{ fromA: q, toA: q, fromB: q, toB: q + 1 }])).toBe(false);
  });
  test("a line removed above and one added below in one transaction: the fence moved", () => {
    const before = "# T\nGone.\n\n```mermaid\ngraph LR\n A-->B\n```\nEnd.\n";
    const after = "# T\n\n```mermaid\ngraph LR\n A-->B\n```\nEnd.\nNew.\n";
    const p = at(before, "Gone.\n");
    const q = at(before, "End.\n") + 5;
    const changes = [
      { fromA: p, toA: p + 6, fromB: p, toB: p },
      { fromA: q, toA: q, fromB: q - 6, toB: q - 6 + 5 },
    ];
    expect(fenceLayoutChanged(stringLineDoc(before), stringLineDoc(after), changes)).toBe(true);
  });
});

describe("fenceLineAt", () => {
  test("the n-th line, as split would give it", () => {
    const text = "a\n```mermaid x\nb\n";
    for (const n of [-1, 0, 1, 2, 3, 4]) expect(fenceLineAt(text, n)).toBe(text.split("\n")[n]);
    expect(fenceLineAt("", 0)).toBe("");
  });
});
