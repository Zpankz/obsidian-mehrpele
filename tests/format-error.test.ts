import { describe, expect, test } from "bun:test";
import { PeleError } from "pele";
import { formatError } from "../src/format-error";

describe("formatError", () => {
  test("includes code, location and message", () => {
    const err = new PeleError("Parse error on line 3", "syntax", {
      type: "flowchart",
      line: 3,
      column: 1,
      snippet: "\n^",
    });
    const out = formatError(err);
    expect(out).toContain("Pele:");
    expect(out).toContain("[syntax]");
    expect(out).toContain("(flowchart)");
    expect(out).toContain("at 3:1");
    expect(out).toContain("Parse error on line 3");
    expect(out).toContain("^");
  });

  test("omits snippet when disabled", () => {
    const err = new PeleError("boom", "semantic", { line: 1, column: 2, snippet: "bad line" });
    const out = formatError(err, { showSnippet: false });
    expect(out).not.toContain("bad line");
    expect(out).toContain("at 1:2");
  });

  test("handles plain Error and strings without throwing", () => {
    expect(formatError(new Error("nope"))).toBe("Pele: nope");
    expect(formatError("oops")).toBe("Pele: oops");
  });
});

describe("snippet de-duplication", () => {
  test("does not repeat a snippet already contained in the message", () => {
    const err = new PeleError("Parse error on line 2:\n A--->>>[[\n------^\nExpecting X", "syntax", {
      type: "flowchart", line: 2, column: 7, snippet: " A--->>>[[\n------^",
    });
    const out = formatError(err);
    expect(out.split(" A--->>>[[").length - 1).toBe(1);
  });
});
