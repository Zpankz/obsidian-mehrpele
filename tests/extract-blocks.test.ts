import { describe, expect, test } from "bun:test";
import { blockAtLine, extractBlocks } from "../src/extract-blocks";

const MD = [
  "# Note",
  "",
  "```mermaid",
  "graph TD",
  "  A-->B",
  "```",
  "",
  "text",
  "```pele",
  "pie title P",
  ' "a": 1',
  "```",
  "",
  "```js",
  "console.log(1)",
  "```",
].join("\n");

describe("extractBlocks", () => {
  test("finds mermaid and pele blocks with line ranges", () => {
    const blocks = extractBlocks(MD);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.lang).toBe("mermaid");
    expect(blocks[0]!.code).toContain("A-->B");
    expect(blocks[0]!.startLine).toBe(2);
    expect(blocks[0]!.endLine).toBe(5);
    expect(blocks[1]!.lang).toBe("pele");
  });

  test("blockAtLine hits inside fence and misses outside", () => {
    const blocks = extractBlocks(MD);
    expect(blockAtLine(blocks, 3)?.lang).toBe("mermaid");
    expect(blockAtLine(blocks, 7)).toBeUndefined();
  });

  test("ignores other languages and unterminated fences still yield block", () => {
    expect(extractBlocks("```js\nx\n```")).toHaveLength(0);
    const open = extractBlocks("```mermaid\ngraph TD\n A-->B");
    expect(open).toHaveLength(1);
    expect(open[0]!.code).toContain("A-->B");
  });
});
