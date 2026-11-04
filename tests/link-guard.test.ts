import { describe, expect, test } from "bun:test";
import { guardAnchorClick } from "../src/link-guard";

function click(href: string | null, inScope = true, props: Record<string, unknown> = {}) {
  const anchor = {
    closest: (sel: string) => (sel === "a" ? anchor : inScope ? {} : null),
    getAttribute: (name: string) => (name === "href" ? href : null),
    ...props,
  };
  const target = { closest: (sel: string) => (sel === "a" ? anchor : null) };
  const evt = {
    target: target as unknown as EventTarget,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
  return evt;
}

describe("guardAnchorClick", () => {
  const notes: string[] = [];
  const notify = (m: string) => notes.push(m);

  test("blocks Advanced URI command links by default", () => {
    const evt = click("obsidian://adv-uri?vault=V&commandid=app%3Areload");
    expect(guardAnchorClick(evt, {}, notify)).toBe(true);
    expect(evt.prevented && evt.stopped).toBe(true);
    expect(notes.at(-1)).toContain("blocked");
  });

  test("blocks write URIs even when command URIs are allowed", () => {
    const evt = click("obsidian://adv-uri?vault=V&filepath=a.md&data=x&mode=overwrite");
    expect(guardAnchorClick(evt, { allowCommandUris: true, commandAllowlist: ["app:reload"] }, notify)).toBe(true);
  });

  test("allows an allowlisted command when enabled", () => {
    const evt = click("obsidian://adv-uri?vault=V&commandid=editor%3Atoggle-bold");
    expect(guardAnchorClick(evt, { allowCommandUris: true, commandAllowlist: ["editor:toggle-bold"] }, notify)).toBe(false);
    expect(evt.prevented).toBe(false);
  });

  test("lets navigation and non-obsidian links through", () => {
    expect(guardAnchorClick(click("obsidian://open?vault=V&file=Note"), {}, notify)).toBe(false);
    expect(guardAnchorClick(click("https://pele.run"), {}, notify)).toBe(false);
    expect(guardAnchorClick(click("Diagrams"), {}, notify)).toBe(false);
  });

  test("ignores links outside Pele diagrams", () => {
    expect(guardAnchorClick(click("obsidian://adv-uri?commandid=app%3Areload", false), {}, notify)).toBe(false);
  });

  // Browsers strip leading/trailing C0 controls + spaces before parsing the
  // scheme, so these navigate to obsidian:// even though they don't start with it.
  const C0_VARIANTS = ["\u0001", "\u0000", "\u001f", "\u0008\u0001 ", "\u000b", "\u000c"];
  for (const prefix of C0_VARIANTS) {
    test(`blocks C0-prefixed command URI (${JSON.stringify(prefix)})`, () => {
      const evt = click(`${prefix}obsidian://adv-uri?commandid=app%3Areload`);
      expect(guardAnchorClick(evt, {}, notify)).toBe(true);
      expect(evt.prevented && evt.stopped).toBe(true);
    });
  }

  test("blocks a C0 suffix/embedded tab variant", () => {
    expect(guardAnchorClick(click("ob\tsidian://adv-uri?commandid=x\u0002"), {}, notify)).toBe(true);
  });

  test("blocks entity-encoded &#1; once the HTML parser decodes it", () => {
    // `<a href="&#1;obsidian://…">`: getAttribute returns the decoded U+0001.
    const decoded = "&#1;obsidian://adv-uri?commandid=app%3Areload".replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n)),
    );
    expect(decoded.charCodeAt(0)).toBe(1);
    expect(guardAnchorClick(click(decoded), {}, notify)).toBe(true);
  });

  test("blocks mixed-case schemes", () => {
    expect(guardAnchorClick(click("ObSiDiAn://adv-uri?commandid=app%3Areload"), {}, notify)).toBe(true);
    expect(guardAnchorClick(click("\u0001OBSIDIAN://adv-uri?data=x&filepath=a.md"), {}, notify)).toBe(true);
  });

  test("classifies the browser-parsed HTMLAnchorElement.href", () => {
    // Attribute looks harmless to a naive check; the parsed URL is obsidian:.
    const evt = click("\u0001obsidian://adv-uri?commandid=app%3Areload", true, {
      href: "obsidian://adv-uri?commandid=app%3Areload",
    });
    expect(guardAnchorClick(evt, {}, notify)).toBe(true);
  });

  test("resolves SVG anchors from href.baseVal", () => {
    const evt = click(null, true, { href: { baseVal: "\u0001obsidian://adv-uri?commandid=app%3Areload" } });
    expect(guardAnchorClick(evt, {}, notify)).toBe(true);
  });

  test("blocks normalised-looking actions (o.pen is not open)", () => {
    expect(guardAnchorClick(click("obsidian://o.pen?vault=V&file=Note"), {}, notify)).toBe(true);
    expect(guardAnchorClick(click("obsidian://adv_uri?commandid=app%3Areload"), {}, notify)).toBe(true);
  });

  test("still lets C0-prefixed navigation through", () => {
    expect(guardAnchorClick(click("\u0001obsidian://open?vault=V&file=Note"), {}, notify)).toBe(false);
  });
});

import { createDocumentGuard } from "../src/link-guard";

describe("createDocumentGuard", () => {
  test("attaches once per document (existing popouts + window-open dedupe)", () => {
    const attached: object[] = [];
    const guard = createDocumentGuard<object>((d) => attached.push(d));
    const main = {};
    const popout = {};
    expect(guard(main)).toBe(true);
    expect(guard(popout)).toBe(true);
    expect(guard(main)).toBe(false);
    expect(guard(popout)).toBe(false);
    expect(guard(null)).toBe(false);
    expect(attached).toEqual([main, popout]);
  });
});
