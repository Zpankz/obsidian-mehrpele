import { describe, expect, test } from "bun:test";
import { findBlock, refOf, relocate } from "../src/block-locate";
import { extractBlocks } from "../src/extract-blocks";

const LANGS = ["mermaid", "pele", "mehrpele"];
const note = (...parts: string[]) => parts.join("\n");
const A = "```mermaid\nflowchart LR\n  A --> B\n```";
const B = "```mermaid\nflowchart TB\n  X --> Y\n```";
const blocks = (md: string) => extractBlocks(md, LANGS);

describe("following a diagram block through note edits", () => {
  const before = blocks(note("# Note", A, "text", B));
  const refB = refOf(before, 1);

  test("found by its text", () => {
    expect(findBlock(before, "flowchart TB\n  X --> Y")).toBe(1);
    expect(findBlock(before, "nothing")).toBeNull();
  });
  test("moves with the text when lines are added above", () => {
    expect(relocate(blocks(note("# Note", "", "new para", "", A, "text", B)), refB)).toBe(1);
  });
  test("stays put when a block is inserted before it", () => {
    expect(relocate(blocks(note("# Note", B.replace("TB", "RL"), A, "text", B)), refB)).toBe(2);
  });
  test("edited in place: the same block, new text", () => {
    const after = blocks(note("# Note", A, "text", B.replace("X --> Y", "X --> Y --> Z")));
    expect(relocate(after, refB)).toBe(1);
    expect(after[1]!.code).toContain("Z");
  });
  test("deleted: null", () => {
    expect(relocate(blocks(note("# Note", A, "text")), refB)).toBeNull();
    expect(relocate(blocks("# empty"), refB)).toBeNull();
  });
  test("another block deleted: still found by its text", () => {
    expect(relocate(blocks(note("# Note", "text", B)), refB)).toBe(0);
  });
  test("of twins, the one nearest the old place", () => {
    const twins = blocks(note(B, "a", "b", "c", "d", B));
    expect(findBlock(twins, "flowchart TB\n  X --> Y", 6)).toBe(1);
    expect(findBlock(twins, "flowchart TB\n  X --> Y", 0)).toBe(0);
  });
});
