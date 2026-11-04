import { describe, expect, test } from "bun:test";
import {
  canonicalViewType,
  encodeParamValue,
  formatViewText,
  isNodeViewTarget,
  isSpecError,
  isViewTarget,
  linkedNoteOf,
  parseNodeViewTarget,
  parseQuery,
  parseSoleWebEmbed,
  parseStateJson,
  parseViewText,
  safeDecode,
  targetText,
  viewSpecKey,
  withWebEmbedSize,
  type ViewNodeSpec,
} from "../../../src/mehrpele/views/syntax";
import { parseSoleEmbed, escapeLabelMarkdown, unescapeLabelMarkdown } from "../../../src/mehrpele/model";
import { extractLabels } from "../../../src/mehrpele/extract";
import { isNoteTarget, withEmbedSize } from "../../../src/mehrpele/nested";

/** The embed target exactly as Mehrpele parses a quoted label. */
const target = (md: string) => parseSoleEmbed(md) ?? parseSoleWebEmbed(md)!;

describe("view-node targets", () => {
  test("web pages: wikilink and Markdown forms", () => {
    expect(parseNodeViewTarget(target("![[https://example.com]]"))).toEqual({ kind: "web", url: "https://example.com" });
    expect(parseNodeViewTarget(target("![](https://example.com/a?b=1)"))).toEqual({ kind: "web", url: "https://example.com/a?b=1" });
    expect(parseNodeViewTarget(target("![](<https://example.com/a(b)>)"))).toEqual({ kind: "web", url: "https://example.com/a(b)" });
    // `#fragment` is split off by Obsidian's embed grammar: joined back.
    expect(parseNodeViewTarget(target("![[https://example.com/page#part|400x300]]"))).toEqual({ kind: "web", url: "https://example.com/page#part" });
  });

  test("image URLs stay images", () => {
    expect(parseSoleWebEmbed("![](https://x.org/a.png)")).toBeUndefined();
    expect(parseNodeViewTarget(target("![[https://x.org/a.webp]]"))).toBeNull();
    expect(isViewTarget({ linkpath: "https://x.org/a.svg", subpath: "" })).toBe(false);
  });

  test("Markdown form keeps the size in the alt text", () => {
    expect(parseSoleWebEmbed("![Wiki|420x300](https://en.wikipedia.org/wiki/Mermaid)")).toEqual({
      linkpath: "https://en.wikipedia.org/wiki/Mermaid",
      subpath: "",
      aliasOrSize: "Wiki|420x300",
    });
    expect(parseSoleWebEmbed("see ![](https://example.com)")).toBeUndefined();
  });

  test("PDFs at a page", () => {
    expect(parseNodeViewTarget(target("![[paper.pdf#page=3]]"))).toEqual({ kind: "pdf", file: "paper.pdf", subpath: "#page=3" });
    expect(parseNodeViewTarget(target("![[docs/Paper.PDF|480x600]]"))).toEqual({ kind: "pdf", file: "docs/Paper.PDF", subpath: "" });
  });

  test("notes, Bases and canvases are not ours", () => {
    for (const md of ["![[Note]]", "![[Note#Heading]]", "![[x.base]]", "![[board.canvas]]", "![[shot.png]]"]) {
      expect(parseNodeViewTarget(target(md))).toBeNull();
      expect(isNodeViewTarget(target(md))).toBe(false);
    }
  });

  test("view: targets with query, aliases, flags and encoded values", () => {
    const s = parseNodeViewTarget(target("![[view:localgraph?file=Some Note&depth=2|360x300]]")) as ViewNodeSpec;
    expect(s).toEqual({ kind: "view", type: "localgraph", params: { file: "Some Note", depth: "2" } });
    expect((parseViewText("view:backlinks?unlinked") as ViewNodeSpec).type).toBe("backlink");
    expect((parseViewText("view:backlinks?unlinked") as ViewNodeSpec).params).toEqual({ unlinked: "true" });
    expect((parseViewText("view:search?query=a%26b%3Dc") as ViewNodeSpec).params.query).toBe("a&b=c");
    expect(canonicalViewType("Local-Graph")).toBe("localgraph");
    expect(canonicalViewType("kanban")).toBe("kanban");
  });

  test("raw `#` in a search query survives the subpath split", () => {
    const t = target("![[view:graph?search=path:Projects tag:#x]]");
    expect(t.subpath).toBe("#x");
    expect(targetText(t)).toBe("view:graph?search=path:Projects tag:#x");
    expect((parseNodeViewTarget(t) as ViewNodeSpec).params.search).toBe("path:Projects tag:#x");
  });

  test("state= is JSON (raw or percent-encoded) and takes the rest of the query", () => {
    const raw = parseViewText('view:my-view?file=A&state={"mode":"week","q":"a&b=c"}') as ViewNodeSpec;
    expect(raw.params).toEqual({ file: "A" });
    expect(raw.state).toEqual({ mode: "week", q: "a&b=c" });
    const enc = parseViewText(`view:my-view?state=${encodeURIComponent('{"n":1}')}`) as ViewNodeSpec;
    expect(enc.state).toEqual({ n: 1 });
    expect(isSpecError(parseViewText("view:my-view?state={nope"))).toBe(true);
    expect(isSpecError(parseViewText("view:my-view?state=[1]"))).toBe(true);
    // Keys that would reach the object's prototype through Object.assign are refused.
    expect(parseStateJson('{"__proto__":{"polluted":1}}')).toEqual({ ok: false, error: "state= can't set __proto__" });
    expect(parseStateJson('{"a":{"constructor":{"prototype":{}}}}')).toEqual({ ok: false, error: "state= can't set constructor" });
    // And the payload stays small.
    expect(parseStateJson(JSON.stringify({ big: "x".repeat(9000) }))).toEqual({ ok: false, error: "state= is too large" });
  });

  test("clear errors for malformed view: targets", () => {
    expect(parseViewText("view:")).toEqual({ error: "view: needs a view type, e.g. view:localgraph" });
    expect(isSpecError(parseViewText("view:bad type!"))).toBe(true);
  });

  test("escaping inside a quoted diagram label round-trips", () => {
    const md = 'view:my-view?state={"title":"say \\"hi\\""}';
    const label = escapeLabelMarkdown(`![[${md}]]`);
    expect(label).toContain('\\"');
    const back = unescapeLabelMarkdown(label);
    const spec = parseNodeViewTarget(target(back)) as ViewNodeSpec;
    expect(spec.state).toEqual({ title: 'say "hi"' });
  });

  test("extractLabels sees view nodes; the Markdown form stays Markdown (decided at render: images stay images)", () => {
    const src = 'flowchart LR\n  A["![[view:outline?file=Note]]"] --> B["![](https://example.com)"]\n  C["![[x.pdf#page=2]]"]';
    const labels = extractLabels(src);
    expect(labels.map((l) => l.embedTarget?.linkpath)).toEqual(["view:outline?file=Note", undefined, "x.pdf"]);
    expect(parseSoleWebEmbed(labels[1]!.markdown)?.linkpath).toBe("https://example.com");
  });

  test("view and web targets are fixed viewports, not auto-height notes", () => {
    expect(isNoteTarget({ linkpath: "view:localgraph?depth=2", subpath: "" })).toBe(false);
    expect(isNoteTarget({ linkpath: "https://example.com/", subpath: "" })).toBe(false);
    expect(isNoteTarget({ linkpath: "Note", subpath: "" })).toBe(true);
  });

  test("resizing writes the size in each form's own syntax", () => {
    expect(withEmbedSize("![[https://example.com]]", { width: 400, height: 300 })).toBe("![[https://example.com|400x300]]");
    expect(withEmbedSize("![Wiki|420x300](https://e.org)", { width: 500, height: 320 })).toBe("![Wiki|500x320](https://e.org)");
    expect(withEmbedSize("![](https://e.org)", { width: 500, height: 320 })).toBe("![500x320](https://e.org)");
    expect(withWebEmbedSize("![Wiki|420x300](https://e.org)", null)).toBe("![Wiki](https://e.org)");
    expect(withWebEmbedSize("plain text", { width: 1 })).toBeNull();
  });

  test("identity ignores size; format/parse round-trip", () => {
    const a = parseNodeViewTarget(target("![[view:localgraph?depth=2&file=N|300x200]]"))!;
    const b = parseNodeViewTarget(target("![[view:localgraph?file=N&depth=2|600x400]]"))!;
    expect(viewSpecKey(a as ViewNodeSpec)).toBe(viewSpecKey(b as ViewNodeSpec));
    const spec: ViewNodeSpec = { kind: "view", type: "graph", params: { search: "a&b|c]" }, state: { x: 1 } };
    expect(parseViewText(formatViewText(spec))).toEqual(spec);
  });

  test("percent helpers never throw", () => {
    expect(safeDecode("100%")).toBe("100%");
    expect(safeDecode("%E0%A4%A")).toBe("%E0%A4%A");
    expect(encodeParamValue("a&b=c|d]")).toBe("a%26b%3Dc%7Cd%5D");
    expect(parseQuery("a=1&&b&state=x=y&z")).toEqual({ params: { a: "1", b: "true" }, state: "x=y&z" });
  });

  test("a node's linked note: its note embed or first wikilink", () => {
    expect(linkedNoteOf("[[Mehrpele]]")).toBe("Mehrpele");
    expect(linkedNoteOf("**See** [[Projects/Hub#Plan|the hub]]")).toBe("Projects/Hub");
    expect(linkedNoteOf("![[Note]]")).toBe("Note");
    expect(linkedNoteOf("![[shot.png]]")).toBeNull();
    expect(linkedNoteOf("![[view:graph]]")).toBeNull();
    expect(linkedNoteOf("plain")).toBeNull();
  });
});
