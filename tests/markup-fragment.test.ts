import "./helpers/dom-globals";
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { markupFragment, svgElementFromMarkup } from "../src/sanitize-svg";

const g = globalThis as Record<string, unknown>;
const saved = { DOMParser: g.DOMParser, document: g.document };
afterEach(() => {
  g.DOMParser = saved.DOMParser;
  g.document = saved.document;
});

/** Minimal DOM stub: records the parse call and tags imported nodes. */
function stubDom(bodyNodes: { localName: string }[]) {
  const calls: { markup: string; type: string }[] = [];
  g.DOMParser = class {
    parseFromString(markup: string, type: string) {
      calls.push({ markup, type });
      return { body: { childNodes: bodyNodes } };
    }
  };
  g.document = {
    importNode: (n: { localName: string }, deep: boolean) => ({ ...n, imported: deep }),
    createDocumentFragment: () => {
      const kids: { localName: string }[] = [];
      return {
        kids,
        appendChild: (n: { localName: string }) => kids.push(n),
        querySelector: (sel: string) => kids.find((k) => k.localName === sel) ?? null,
      };
    },
  };
  return calls;
}

describe("markupFragment parses without innerHTML", () => {
  test("parses as an inert HTML document, in body mode", () => {
    const calls = stubDom([{ localName: "svg" }]);
    markupFragment('<svg class="pele"></svg>');
    expect(calls).toEqual([{ markup: '<!doctype html><body><svg class="pele"></svg>', type: "text/html" }]);
  });

  test("moves the parsed nodes into the live document", () => {
    stubDom([{ localName: "style" }, { localName: "svg" }]);
    const frag = markupFragment("<style></style><svg></svg>") as unknown as { kids: unknown[] };
    expect(frag.kids).toEqual([
      { localName: "style", imported: true },
      { localName: "svg", imported: true },
    ]);
  });

  test("svgElementFromMarkup without a sanitizer returns the imported svg", () => {
    stubDom([{ localName: "svg" }]);
    expect(svgElementFromMarkup("<svg></svg>", null) as unknown).toEqual({ localName: "svg", imported: true });
  });
});

describe("plugin source never assigns HTML strings to the DOM", () => {
  const root = join(import.meta.dir, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
    });

  test("no innerHTML, outerHTML or insertAdjacentHTML in main.ts or src/", () => {
    const hits = [join(root, "main.ts"), ...files(join(root, "src"))].flatMap((p) =>
      readFileSync(p, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\(/.test(line) ? [`${p.slice(root.length + 1)}:${i + 1}`] : [],
        ),
    );
    expect(hits).toEqual([]);
  });
});
