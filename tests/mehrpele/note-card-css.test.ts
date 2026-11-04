import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// A `![[Note]]` node is a Canvas-style card (note-card.ts). Its look and its
// resize behaviour live in views.css: without these rules the node shows the
// embed chrome (title row, left border) and a resized node grows back to the
// note's height instead of scrolling inside the card.
const css = readFileSync(
  process.env.PELE_VIEWS_CSS ?? `${import.meta.dir}/../../src/mehrpele/views/views.css`,
  "utf8",
);

/** Declarations of the rule whose selector list is exactly `selector`. */
function rule(selector: string): Record<string, string> | null {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = (m[1] ?? "").trim().replace(/\s+/g, " ");
    if (sel !== selector) continue;
    const decls: Record<string, string> = {};
    for (const d of (m[2] ?? "").split(";")) {
      const i = d.indexOf(":");
      if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    return decls;
  }
  return null;
}

describe("note card CSS", () => {
  test("no embed chrome: no border, padding or link icon", () => {
    const card = rule(".mehrpele-note-card.markdown-embed");
    expect(card).not.toBeNull();
    expect(card?.border).toBe("none");
    expect(card?.padding).toBe("0");
    expect(rule(".mehrpele-note-card.markdown-embed > .markdown-embed-link")?.display).toBe("none");
  });

  test("a sized card clips at the node and scrolls inside, so it can shrink", () => {
    expect(rule(".pele-host .mehrpele-embed.mehrpele-note:not(.mehrpele-embed-auto)")?.overflow).toBe("hidden");
    expect(rule(".mehrpele-embed:not(.mehrpele-embed-auto) > .mehrpele-note-card.markdown-embed")?.height).toBe("100%");
    const content = rule(".mehrpele-embed:not(.mehrpele-embed-auto) > .mehrpele-note-card > .markdown-embed-content");
    expect(content?.height).toBe("100%");
    expect(content?.overflow).toBe("auto");
  });

  test("titles scale with the card: no full-size H1 or mid-word break in a small card", () => {
    // The card is a width container, so its type can scale with it.
    const card = rule(".mehrpele-note-card.markdown-embed");
    expect(card?.["container-type"]).toBe("inline-size");
    expect(card?.["container-name"]).toBe("mehrpele-card");
    const title = rule(".mehrpele-note-card .inline-title");
    expect(title?.["font-size"]).toMatch(/^clamp\(.*cqi.*var\(--inline-title-size\)\)$/);
    expect(title?.["white-space"]).toBe("nowrap");
    expect(title?.overflow).toBe("hidden");
    expect(title?.["text-overflow"]).toBe("ellipsis");
    for (const h of [1, 2, 3]) {
      const heading = rule(`.mehrpele-note-card .markdown-preview-view h${h}`);
      expect(heading?.["font-size"]).toMatch(new RegExp(`^clamp\\(.*cqi.*var\\(--h${h}-size\\)\\)$`));
    }
  });

  test("a small card with a file label above it drops its inline title", () => {
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const block = /@container mehrpele-card \(max-width: (\d+)px\)\s*\{([\s\S]*?)\}\s*\}/.exec(flat);
    expect(block).not.toBeNull();
    expect(Number(block?.[1])).toBeGreaterThanOrEqual(160);
    expect(block?.[2]).toContain(".mehrpele-overlay-item.has-card-label .mehrpele-note-card .inline-title");
    expect(block?.[2]).toMatch(/display:\s*none/);
  });

  test("the note fills the card's width instead of centring at its readable width", () => {
    const sizer = rule(".mehrpele-note-card > .markdown-embed-content > .markdown-preview-view > .markdown-preview-sizer");
    expect(sizer?.["margin-inline"]).toBe("0");
    expect(sizer?.["max-width"]).toBe("none");
  });

  test("a very small card keeps more of its width for the text", () => {
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const block = /@container mehrpele-card \(max-width: 120px\)\s*\{([\s\S]*?)\}\s*\}/.exec(flat);
    expect(block?.[1]).toContain(".mehrpele-note-card > .markdown-embed-content > .markdown-preview-view");
    expect(block?.[1]).toMatch(/padding:\s*0 var\(--size-4-1\)/);
  });
});
