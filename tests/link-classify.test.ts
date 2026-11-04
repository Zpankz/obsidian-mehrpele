import { describe, expect, test } from "bun:test";
import { classifyObsidianUri } from "../src/link-classify";

describe("legacy advanced-uri whole-query decoding stays strict", () => {
  test("unknown name hidden in a double-encoded legacy query is blocked", () => {
    const href = "obsidian://advanced-uri?vault%3DV%26filepath%3Da.md%26frobnicate%3D1";
    expect(classifyObsidianUri(href).outcome).toBe("blocked");
  });
  test("modern adv-uri filename containing & and = is navigation", () => {
    const href = "obsidian://adv-uri?vault=V&filepath=" + encodeURIComponent("Plan & Do = Win.md");
    expect(classifyObsidianUri(href).outcome).toBe("navigation");
  });
  test("legacy advanced-uri pure navigation still allowed", () => {
    const href = "obsidian://advanced-uri?vault%3DV%26filepath%3Da.md";
    expect(classifyObsidianUri(href).outcome).toBe("navigation");
  });
});

import { isSvgAnchor, routeDiagramLink } from "../src/link-classify";

describe("routeDiagramLink (frames, lightbox, Mehrpele SVG anchors)", () => {
  const run = (href: string, internal = false, policy = {}) => {
    const calls: string[] = [];
    const kind = routeDiagramLink(href, internal, policy, {
      internal: (h) => calls.push(`internal:${h}`),
      open: (h) => calls.push(`open:${h}`),
    });
    return { kind, calls };
  };
  test("internal links open in Obsidian once", () => {
    expect(run("Note", true)).toEqual({ kind: "internal", calls: ["internal:Note"] });
  });
  test("web and navigation obsidian links open via window.open", () => {
    expect(run("https://pele.run").calls).toEqual(["open:https://pele.run"]);
    expect(run("obsidian://open?vault=V&file=N").calls).toEqual(["open:obsidian://open?vault=V&file=N"]);
  });
  test("blocked links never navigate", () => {
    expect(run("javascript:alert(1)").calls).toEqual([]);
    expect(run("\u0001obsidian://adv-uri?commandid=app%3Areload").calls).toEqual([]);
    expect(run("ftp://x").calls).toEqual([]);
  });
  test("SVG anchors are told apart from overlay HTML anchors", () => {
    expect(isSvgAnchor({ namespaceURI: "http://www.w3.org/2000/svg" })).toBe(true);
    expect(isSvgAnchor({ namespaceURI: "http://www.w3.org/1999/xhtml" })).toBe(false);
    expect(isSvgAnchor(null)).toBe(false);
  });
});
