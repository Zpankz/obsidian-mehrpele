import { describe, expect, test } from "bun:test";
import { completionPrompt, parseSuggestions, suggestLabels } from "../../src/edit/autocomplete";

describe("autocomplete replies", () => {
  test("one JSON array", () => {
    expect(parseSuggestions('Sure: ["Alpha", "Beta", "Beta", "Gamma"]')).toEqual(["Alpha", "Beta", "Gamma"]);
  });
  test("one array per line (seen from qwen3.5)", () => {
    expect(parseSuggestions('["Specific example"]\n["Supporting evidence"]')).toEqual(["Specific example", "Supporting evidence"]);
  });
  test("fenced JSON", () => {
    expect(parseSuggestions('```json\n["A", "B"]\n```')).toEqual(["A", "B"]);
  });
  test("bullets and numbers", () => {
    expect(parseSuggestions('- "One"\n2) Two\n• Three,')).toEqual(["One", "Two", "Three"]);
  });
  test("prompt carries the diagram and the node", async () => {
    const p = completionPrompt("flowchart TD\n  A[Topic]", "A", "Topic", "child");
    expect(p).toContain("flowchart TD");
    expect(p).toContain('"Topic"');
    const got = await suggestLabels({ complete: async () => '["x","y"]' }, { source: "flowchart TD", nodeId: "A", nodeText: "Topic", relation: "child" });
    expect(got).toEqual(["x", "y"]);
  });
});
