import { describe, expect, test } from "bun:test";
import { makeIconResolver, resolveLucideName } from "../src/icons";
import { createIdPrefixer } from "../src/id-prefix";
import { classifyLink } from "../src/link-classify";
import { buildPlaygroundUrl, extractAccTitle, parseConfigJson } from "../src/render-policy";

describe("icon names", () => {
  test("maps fa/lucide/bare names through the alias map", () => {
    expect(resolveLucideName("fa:fa-car")).toBe("car");
    expect(resolveLucideName("fa:fa-envelope")).toBe("mail");
    expect(resolveLucideName("fa:fa-cog")).toBe("settings");
    expect(resolveLucideName("fa:fa-times")).toBe("x");
    expect(resolveLucideName("fa:fa-github")).toBe("github");
    expect(resolveLucideName("fa:fa-database")).toBe("database");
    expect(resolveLucideName("lucide:rocket")).toBe("rocket");
    expect(resolveLucideName("car")).toBe("car");
    expect(resolveLucideName("")).toBeNull();
  });

  test("resolver only returns markup the lookup resolves", () => {
    const resolve = makeIconResolver((n) => (n === "car" ? "<svg>car</svg>" : null));
    expect(resolve("fa:fa-car")).toBe("<svg>car</svg>");
    expect(resolve("fa:fa-nonexistent-thing")).toBeUndefined();
    expect(resolve("lucide:unknown-icon")).toBeUndefined();
  });
});

describe("link classification", () => {
  test("classifies internal/obsidian/external/blocked", () => {
    expect(classifyLink("My Note", true)).toBe("internal");
    expect(classifyLink("My Note")).toBe("internal");
    expect(classifyLink("obsidian://open?vault=x")).toBe("obsidian");
    expect(classifyLink("https://example.com")).toBe("external");
    expect(classifyLink("mailto:a@b.c")).toBe("external");
    expect(classifyLink("javascript:alert(1)")).toBe("blocked");
    expect(classifyLink("data:text/html;base64,x")).toBe("blocked");
  });
});

describe("id prefixes", () => {
  test("are unique per call", () => {
    const next = createIdPrefixer();
    const seen = new Set(Array.from({ length: 50 }, () => next()));
    expect(seen.size).toBe(50);
    expect(next()).toMatch(/^pele-\d+-$/);
  });
});

describe("config JSON + playground + accTitle", () => {
  test("validates config JSON objects", () => {
    expect(parseConfigJson("")).toEqual({ ok: true, config: {} });
    expect(parseConfigJson('{"theme":"dark"}')).toEqual({ ok: true, config: { theme: "dark" } });
    expect(parseConfigJson("[1,2]").ok).toBe(false);
    expect(parseConfigJson("{nope").ok).toBe(false);
  });

  test("builds playground URLs within limits only", () => {
    const url = buildPlaygroundUrl("graph TD\n A-->B");
    expect(url).toStartWith("https://pele.run/playground#source=");
    expect(buildPlaygroundUrl("x".repeat(100_001))).toBeNull();
  });

  test("extracts accTitle", () => {
    expect(extractAccTitle("graph TD\naccTitle: My Diagram\n A-->B")).toBe("My Diagram");
    expect(extractAccTitle("graph TD\n A-->B")).toBeNull();
  });
});
