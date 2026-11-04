import { describe, expect, test } from "bun:test";
import { parse, render } from "pele";
import { resolveZoom, toMountOptions } from "../src/settings";
import { defaultSettingsV3, type SettingsV3 } from "../src/settings/schema";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings/v2";

const v3 = (edit: (s: SettingsV3) => void = () => {}): SettingsV3 => {
  const s = defaultSettingsV3();
  edit(s);
  return s;
};

describe("settings → mount options", () => {
  test("zoom modes map to pele zoom values", () => {
    expect(resolveZoom("off")).toBe(false);
    expect(resolveZoom("auto")).toBe("auto");
    expect(resolveZoom("always")).toBe(true);
  });

  test("zero/empty values are omitted so pele defaults apply", () => {
    const o = toMountOptions(v3());
    expect(o.zoom).toBe(false);
    expect(o.maxWidth).toBeUndefined();
    expect(o.fontFamily).toBeUndefined();
    expect(o.fontSize).toBeUndefined();
  });

  test("set values pass through", () => {
    const o = toMountOptions(
      v3((s) => {
        s.features["pan-zoom"] = { enabled: true, mode: "always" };
        s.core.appearance = { maxWidth: 640, fontFamily: "Inter", fontSize: 14 };
      }),
    );
    expect(o.zoom).toBe(true);
    expect(o.maxWidth).toBe(640);
    expect(o.fontFamily).toBe("Inter");
    expect(o.fontSize).toBe(14);
    expect(o.links).toBe(true);
    expect(o.linkSchemes).toContain("obsidian");
  });

  test("render policy maps to mount options", () => {
    const o = toMountOptions(
      v3((s) => {
        s.core.security.allowLinks = false;
        s.core.security.allowRemoteImages = false;
        s.core.ganttToday = false;
        s.core.advanced = { maxSourceLength: 1234, defaultConfigJson: '{"flowchart":{"curve":"linear"}}' };
      }),
    );
    expect(o.links).toBe(false);
    expect(o.images).toBe(false);
    expect(o.now).toBeUndefined();
    expect(o.limit).toBe(1234);
    expect(o.config).toEqual({ flowchart: { curve: "linear" } });
    const bad = toMountOptions(v3((s) => (s.core.advanced.defaultConfigJson = "{bad")));
    expect(bad.config).toBeUndefined();
  });

  test("normalizeSettings fills defaults over partial data", () => {
    const s = normalizeSettings({ maxWidth: 100 });
    expect(s.maxWidth).toBe(100);
    expect(s.overrideMermaid).toBe(true);
    expect(s.zoomMode).toBe("off");
  });
});

describe("pele integration (headless)", () => {
  test("valid diagram parses and renders svg", () => {
    expect(() => parse("graph TD\n A-->B")).not.toThrow();
    const r = render('pie title T\n "a": 1\n "b": 2');
    expect(r.type).toBe("pie");
    expect(r.svg).toContain("<svg");
    expect(r.svg).toContain("pele-pie");
  });

  test("invalid diagram throws PeleError with location", () => {
    try {
      parse("graph TD\n A-->");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as { code?: string; line?: number };
      expect(err.code).toBe("syntax");
      expect(typeof err.line).toBe("number");
    }
  });
});

describe("settings migration", () => {
  test("v1 zoomMode auto is reset to off", () => {
    const s = normalizeSettings({ overrideMermaid: true, zoomMode: "auto" });
    expect(s.zoomMode).toBe("off");
    expect(s.settingsVersion).toBe(2);
  });
  test("v2 explicit auto is kept", () => {
    expect(normalizeSettings({ zoomMode: "auto", settingsVersion: 2 }).zoomMode).toBe("auto");
  });
  test("fresh install uses defaults", () => {
    expect(normalizeSettings(null).zoomMode).toBe("off");
  });
});

import { svgElementFromMarkup } from "../src/sanitize-svg";

describe("lightbox SVG honours Sanitize SVG", () => {
  test("markup goes through the sanitizer when it is on", () => {
    const seen: string[] = [];
    const cleaned = { nodeType: 1, localName: "svg", id: "clean" };
    const out = svgElementFromMarkup('<svg><script>alert(1)</script></svg>', (m) => {
      seen.push(m);
      return cleaned as unknown as Node;
    });
    expect(seen).toEqual(['<svg><script>alert(1)</script></svg>']);
    expect(out as unknown).toBe(cleaned);
  });
  test("a sanitizer that returns a wrapper still yields the inner svg", () => {
    const inner = { localName: "svg" };
    const wrapper = { nodeType: 1, localName: "div", querySelector: () => inner };
    expect(svgElementFromMarkup("<svg/>", () => wrapper as unknown as Node) as unknown).toBe(inner);
  });
});

describe("default settings ship no machine-specific paths", () => {
  test("no default string points at a home folder or source checkout", () => {
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") strings.push(v);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(DEFAULT_SETTINGS);
    expect(strings.filter((s) => /^~|\/Users\/|\/home\/|packages\//.test(s))).toEqual([]);
  });

  test("installer source paths default to empty", () => {
    expect(DEFAULT_SETTINGS.excalidrawSourceFolder).toBe("");
    expect(DEFAULT_SETTINGS.cliBundleSource).toBe("");
  });
});
