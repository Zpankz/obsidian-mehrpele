import { describe, expect, test } from "bun:test";
import { render } from "pele";
import {
  advancedUri,
  diagramBlockId,
  fnv1a,
  openUri,
  planFenceBlockId,
  wikilinkToBlock,
} from "../src/diagram-link";
import { classifyLink, classifyObsidianUri } from "../src/link-classify";
import { guardAnchorClick } from "../src/link-guard";
import { flowchartFromGraph, nodeHref } from "../src/integrations/graph-to-pele";

const SRC = "flowchart TD\n  A --> B";
const NOTE = ["# Title", "", "```mermaid", "flowchart TD", "  A --> B", "```", "", "After."].join("\n");

describe("block id", () => {
  test("FNV-1a matches pele-render's 32-bit hex", () => {
    expect(fnv1a("")).toBe("811c9dc5");
    expect(fnv1a("a")).toBe("e40c292c");
    expect(fnv1a("foobar")).toBe("bf9cf968");
  });

  test("diagram id = pele-<hash8>, trailing newline ignored", () => {
    expect(diagramBlockId(SRC)).toMatch(/^pele-[0-9a-f]{8}$/);
    expect(diagramBlockId(`${SRC}\n`)).toBe(diagramBlockId(SRC));
  });
});

describe("planFenceBlockId", () => {
  test("inserts ^pele-<hash8> on the line right after the closing fence", () => {
    const plan = planFenceBlockId(NOTE, 2, SRC);
    expect(plan.kind).toBe("insert");
    if (plan.kind !== "insert") return;
    const lines = plan.text.split("\n");
    expect(lines[5]).toBe("```");
    expect(lines[6]).toBe(`^${diagramBlockId(SRC)}`);
    expect(lines[7]).toBe("");
    expect(lines[8]).toBe("After.");
    // Single change: offset/insert reproduce the text.
    expect(NOTE.slice(0, plan.offset) + plan.insert + NOTE.slice(plan.offset)).toBe(plan.text);
  });

  test("idempotent: a second plan reuses the id and changes nothing", () => {
    const first = planFenceBlockId(NOTE, 2, SRC);
    if (first.kind !== "insert") throw new Error(first.kind);
    const second = planFenceBlockId(first.text, 2, SRC);
    expect(second).toEqual({ kind: "exists", id: first.id, fenceLine: 2 });
  });

  test("reuses any existing block id after the fence (direct or after one blank line)", () => {
    const direct = NOTE.replace("```\n\nAfter.", "```\n^my-diagram\n\nAfter.");
    expect(planFenceBlockId(direct, 2, SRC)).toMatchObject({ kind: "exists", id: "my-diagram" });
    const spaced = NOTE.replace("```\n\nAfter.", "```\n\n^spaced-id\n\nAfter.");
    expect(planFenceBlockId(spaced, 2, SRC)).toMatchObject({ kind: "exists", id: "spaced-id" });
  });

  test("adds a blank line when a paragraph follows the fence directly", () => {
    const tight = NOTE.replace("```\n\nAfter.", "```\nAfter.");
    const plan = planFenceBlockId(tight, 2, SRC);
    if (plan.kind !== "insert") throw new Error(plan.kind);
    expect(plan.text.split("\n").slice(5, 9)).toEqual(["```", `^${plan.id}`, "", "After."]);
  });

  test("closing fence at end of file (with and without trailing newline)", () => {
    const eof = ["```pele", "flowchart TD", "  A --> B", "```"].join("\n");
    const a = planFenceBlockId(eof, 0, SRC);
    if (a.kind !== "insert") throw new Error(a.kind);
    expect(a.text).toBe(`${eof}\n^${a.id}`);
    const b = planFenceBlockId(`${eof}\n`, 0, SRC);
    if (b.kind !== "insert") throw new Error(b.kind);
    expect(b.text).toBe(`${eof}\n^${b.id}\n`);
  });

  test("relocates a moved block; mehrpele fences are supported", () => {
    const moved = `Intro\n\n${NOTE.replace("```mermaid", "```mehrpele")}`;
    const plan = planFenceBlockId(moved, 2, SRC);
    expect(plan).toMatchObject({ kind: "insert", fenceLine: 4 });
  });

  test("identical diagrams never share an id; ambiguous blocks abort", () => {
    const twice = `${NOTE}\n\n${["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n")}\n`;
    expect(planFenceBlockId(twice, 99, SRC)).toEqual({ kind: "ambiguous" });
    const first = planFenceBlockId(twice, 2, SRC);
    if (first.kind !== "insert") throw new Error(first.kind);
    const second = planFenceBlockId(first.text, 10, SRC);
    if (second.kind !== "insert") throw new Error(second.kind);
    expect(second.id).toBe(`${first.id}-2`);
  });

  test("missing / unclosed blocks are reported, not edited", () => {
    expect(planFenceBlockId(NOTE, 2, "graph LR\n  X --> Y")).toEqual({ kind: "missing" });
    expect(planFenceBlockId("```mermaid\nflowchart TD\n  A --> B\nnot a fence", 0, SRC)).toEqual({ kind: "unclosed" });
  });
});

describe("URI encoding", () => {
  test("Advanced URI block link is single-encoded", () => {
    expect(advancedUri({ vault: "My Vault", filepath: "Folder/Note & more #1.md", block: "pele-0123abcd" })).toBe(
      "obsidian://adv-uri?vault=My%20Vault&filepath=Folder%2FNote%20%26%20more%20%231.md&block=pele-0123abcd",
    );
  });

  test("heading link; block wins over heading; leading ^ stripped", () => {
    expect(advancedUri({ vault: "V", filepath: "a.md", heading: "Ünï = x?" })).toBe(
      "obsidian://adv-uri?vault=V&filepath=a.md&heading=%C3%9Cn%C3%AF%20%3D%20x%3F",
    );
    expect(advancedUri({ vault: "V", filepath: "a.md", heading: "H", block: "^b1" })).toBe(
      "obsidian://adv-uri?vault=V&filepath=a.md&block=b1",
    );
  });

  test("core open fallback + wikilink", () => {
    expect(openUri("My Vault", "Notes/a b.md")).toBe("obsidian://open?vault=My%20Vault&file=Notes%2Fa%20b.md");
    expect(wikilinkToBlock("Notes/Plan", "pele-0123abcd")).toBe("[[Notes/Plan#^pele-0123abcd]]");
  });

  test("copied Advanced URI links classify as navigation", () => {
    const uri = advancedUri({ vault: "V", filepath: "a.md", block: "pele-0123abcd" });
    expect(classifyObsidianUri(uri).outcome).toBe("navigation");
  });
});

describe("graph-to-pele href passthrough (Advanced URI deep links)", () => {
  const node = { href: "Projects/Plan & Do.md", heading: "Next steps #2" };

  test("Advanced URI enabled → adv-uri heading/block link", () => {
    expect(nodeHref(node, { advancedUriVault: "My Vault" })).toBe(
      "obsidian://adv-uri?vault=My%20Vault&filepath=Projects%2FPlan%20%26%20Do.md&heading=Next%20steps%20%232",
    );
    expect(nodeHref({ href: "a.md", block: "^b1" }, { advancedUriVault: "V" })).toBe(
      "obsidian://adv-uri?vault=V&filepath=a.md&block=b1",
    );
  });

  test("Advanced URI absent → internal link form; no heading/block → plain path", () => {
    expect(nodeHref(node)).toBe("Projects/Plan & Do.md#Next steps #2");
    expect(nodeHref({ href: "a.md", block: "b1" })).toBe("a.md#^b1");
    expect(nodeHref({ href: "a.md" }, { advancedUriVault: "V" })).toBe("a.md");
    expect(nodeHref({ href: "https://x.y/z", heading: "H" }, { advancedUriVault: "V" })).toBe("https://x.y/z");
  });

  test("rendered <a href> is exactly the intended URI (Pele 1.12+ keeps click hrefs verbatim)", () => {
    const intended = nodeHref(node, { advancedUriVault: "My Vault" })!;
    const generated = flowchartFromGraph(
      { nodes: [{ id: "p", label: "Plan", ...node }], edges: [] },
      { advancedUriVault: "My Vault" },
    );
    expect(generated.source).toContain(`click p "${intended}"`);
    const r = render(generated.source, { linkSchemes: ["http", "https", "mailto", "tel", "obsidian"] } as never);
    expect(r.links[0]?.href).toBe(intended);
  });

  test("decoded value text never smuggles parameters, but stays fail-closed for dangerous ones", () => {
    // `&`/`=` inside an encoded filename/heading is text, not parameters…
    expect(classifyObsidianUri("obsidian://adv-uri?vault=V&filepath=a%26b%3Dc.md").outcome).toBe("navigation");
    // …while a nested dangerous name is still blocked (legacy double-decoding).
    expect(classifyObsidianUri("obsidian://adv-uri?vault=V&filepath=a%26commandid%3Dapp%253Areload").outcome).toBe("blocked");
    expect(classifyObsidianUri("obsidian://adv-uri?vault=V&filepath=x%26data%3Dpwn%26mode%3Doverwrite").outcome).toBe("blocked");
    // Visible unknown parameters are still blocked.
    expect(classifyObsidianUri("obsidian://adv-uri?vault=V&filepath=a.md&bogus=1").outcome).toBe("blocked");
  });

  test("link guard + classifier treat generated deep links as navigation", () => {
    const intended = nodeHref(node, { advancedUriVault: "My Vault" })!;
    expect(classifyObsidianUri(intended).outcome).toBe("navigation");
    expect(classifyLink(intended)).toBe("obsidian");
    const anchor = {
      closest: (sel: string) => (sel === "a" ? anchor : {}),
      getAttribute: (name: string) => (name === "href" ? intended : null),
    };
    const evt = {
      target: { closest: (sel: string) => (sel === "a" ? anchor : null) } as unknown as EventTarget,
      prevented: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() {},
    };
    expect(guardAnchorClick(evt, {}, () => undefined)).toBe(false);
    expect(evt.prevented).toBe(false);
  });
});
