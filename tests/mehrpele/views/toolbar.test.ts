import { describe, expect, test } from "bun:test";
import { analyse, applyEdit, type EditContext } from "../../../src/edit/ops";
import { isViewNodeLabel } from "../../../src/mehrpele/views/syntax";

const ctx = (source: string): EditContext => ({ source, type: "flowchart", markdownBlock: true, canSwitch: false });
const SRC = 'flowchart LR\n  W["![[https://example.com|440x320]]"] --> L["![[view:localgraph?depth=2]]"]\n  L --> T["Text"]\n  L --> P["![[x.pdf#page=2]]"]';

describe("edit toolbar on view nodes", () => {
  test("view nodes: box colour and shape, structure edits, no text editing", () => {
    for (const id of ["W", "L", "P"]) {
      const c = analyse(ctx(SRC), { kind: "node", id })!;
      expect(c.viewNode).toBe(true);
      expect(c.editText).toBe(false);
      expect(c.color).toBe(true);
      expect(c.shapes?.length).toBeGreaterThan(0);
      expect(c.delete).toBe(true);
    }
    const t = analyse(ctx(SRC), { kind: "node", id: "T" })!;
    expect(t.viewNode).toBeUndefined();
    expect(t.editText).toBe(true);
  });

  test("colour and shape rewrite the node box, never the view's label", () => {
    const colored = applyEdit(ctx(SRC), { kind: "node", id: "L" }, { op: "color", value: { preset: 1 } });
    expect(colored.ok).toBe(true);
    if (colored.ok) expect(colored.source).toContain('L["![[view:localgraph?depth=2]]"]');
    const shaped = applyEdit(ctx(SRC), { kind: "node", id: "W" }, { op: "shape", key: "rounded" });
    expect(shaped.ok).toBe(true);
    if (shaped.ok) expect(shaped.source).toContain('W("![[https://example.com|440x320]]")');
  });

  test("view-node label detection (raw, as written)", () => {
    expect(isViewNodeLabel('"![[view:outline]]"')).toBe(true);
    expect(isViewNodeLabel('"![[https://e.org|300x200]]"')).toBe(true);
    expect(isViewNodeLabel('"![[x.pdf#page=3]]"')).toBe(true);
    expect(isViewNodeLabel('"![[view:my-view?state={\\"a\\":1}]]"')).toBe(true);
    expect(isViewNodeLabel('"![[Note]]"')).toBe(false);
    expect(isViewNodeLabel('"![[https://e.org/a.png]]"')).toBe(false);
    expect(isViewNodeLabel('"![](https://e.org)"')).toBe(false);
    expect(isViewNodeLabel("Text")).toBe(false);
    expect(isViewNodeLabel(null)).toBe(false);
  });
});
