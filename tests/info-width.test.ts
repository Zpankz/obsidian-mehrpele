import { describe, expect, test } from "bun:test";
import { parseFenceInfo, parseInfoWidth, serializeFenceWidth } from "../src/info-width";

describe("info-string width", () => {
  test("parses width from full fence lines and bare info", () => {
    expect(parseInfoWidth("```mermaid width=480")).toBe(480);
    expect(parseInfoWidth("~~~pele width=320")).toBe(320);
    expect(parseInfoWidth("mermaid width=200")).toBe(200);
    expect(parseInfoWidth("```mermaid")).toBeUndefined();
    expect(parseInfoWidth(null)).toBeUndefined();
  });

  test("parseFenceInfo keeps lang, fence and other tokens", () => {
    const f = parseFenceInfo("```mermaid foo width=480 bar");
    expect(f.fence).toBe("```");
    expect(f.lang).toBe("mermaid");
    expect(f.width).toBe(480);
    expect(f.rest).toEqual(["foo", "bar"]);
  });

  test("serialize sets, replaces and removes width preserving other tokens", () => {
    expect(serializeFenceWidth("```mermaid", 480)).toBe("```mermaid width=480");
    expect(serializeFenceWidth("```mermaid width=480", 200)).toBe("```mermaid width=200");
    expect(serializeFenceWidth("```mermaid width=480", null)).toBe("```mermaid");
    expect(serializeFenceWidth("~~~pele foo width=1", 90)).toBe("~~~pele foo width=90");
  });

  test("round-trips", () => {
    const line = serializeFenceWidth("```mermaid", 333);
    expect(parseInfoWidth(line)).toBe(333);
    expect(parseInfoWidth(serializeFenceWidth(line, null))).toBeUndefined();
  });
});

import { normaliseZoom, parseInfoZoom, serializeFenceSize } from "../src/info-width";

describe("zoom= token", () => {
  test("parses alongside width and keeps other tokens", () => {
    const info = parseFenceInfo("```mermaid title=x width=420 zoom=1.5");
    expect(info.width).toBe(420);
    expect(info.zoom).toBe(1.5);
    expect(info.rest).toEqual(["title=x"]);
    expect(parseInfoZoom("```mermaid zoom=2")).toBe(2);
    expect(parseInfoZoom("```mermaid width=300")).toBeUndefined();
  });

  test("clamps hand-written values and drops zoom=1", () => {
    expect(parseInfoZoom("```mermaid zoom=9")).toBe(4);
    expect(parseInfoZoom("```mermaid zoom=1")).toBeUndefined();
    expect(parseInfoZoom("```mermaid zoom=0.5")).toBeUndefined();
    expect(normaliseZoom(1.234)).toBe(1.23);
  });

  test("serializes width and zoom independently", () => {
    expect(serializeFenceSize("```mermaid", { width: 400, zoom: 1.4 })).toBe("```mermaid width=400 zoom=1.4");
    expect(serializeFenceSize("```mermaid width=400 zoom=1.4", { zoom: null })).toBe("```mermaid width=400");
    expect(serializeFenceSize("```mermaid width=400 zoom=1.4", { width: null, zoom: null })).toBe("```mermaid");
    // Width-only writes keep a zoom the fence already has.
    expect(serializeFenceWidth("~~~pele zoom=2 width=300", 500)).toBe("~~~pele width=500 zoom=2");
    expect(serializeFenceSize("  ```mermaid foo", { width: 10 })).toBe("  ```mermaid foo width=10");
  });
});
