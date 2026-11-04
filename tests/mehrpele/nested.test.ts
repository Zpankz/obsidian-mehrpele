import { describe, expect, test } from "bun:test";
import {
  diagramFileLang,
  embedAlias,
  embedRequestedSize,
  fitContentSize,
  isNoteTarget,
  labelsInRawSource,
  maxContentSize,
  minContentWidth,
  parseSoleDiagramFence,
  rawLabelInner,
  rewriteLabel,
  soleDiagramInSection,
  withEmbedSize,
  withFenceBody,
  withFenceWidth,
  type FitOptions,
} from "../../src/mehrpele/nested";
import { extractLabels } from "../../src/mehrpele/extract";
import { diagramFenceSummary, markdownToFallback, unescapeLabelMarkdown } from "../../src/mehrpele/model";

describe("parseSoleDiagramFence", () => {
  test("tilde fence with a diagram lang", () => {
    expect(parseSoleDiagramFence("~~~mermaid\nflowchart TD\n  A --> B\n~~~")).toEqual({
      lang: "mermaid",
      code: "flowchart TD\n  A --> B",
    });
  });

  test("backtick fence, surrounding blank lines, width in the info string", () => {
    expect(parseSoleDiagramFence("\n```pele width=240\nsequenceDiagram\n  A->>B: hi\n```\n\n")).toEqual({
      lang: "pele",
      code: "sequenceDiagram\n  A->>B: hi",
      width: 240,
    });
  });

  test("closer must use the opener's character and be at least as long", () => {
    expect(parseSoleDiagramFence("````mehrpele\nflowchart LR\n```")).toBeNull();
    expect(parseSoleDiagramFence("~~~mermaid\nflowchart LR\n```")).toBeNull();
    expect(parseSoleDiagramFence("```mermaid\nflowchart LR\n`````")?.lang).toBe("mermaid");
  });

  test("a closing fence inside means it is not one fence", () => {
    expect(parseSoleDiagramFence("~~~mermaid\nA\n~~~\ntext\n~~~")).toBeNull();
  });

  test("an inner shorter fence of the other kind is body text", () => {
    const d = parseSoleDiagramFence("````mehrpele\nflowchart TD\n  A[\"```pele\nx\n```\"]\n````");
    expect(d?.lang).toBe("mehrpele");
    expect(d?.code).toContain("```pele");
  });

  test("non-diagram langs, prose around the fence, single lines", () => {
    expect(parseSoleDiagramFence("```js\nx\n```")).toBeNull();
    expect(parseSoleDiagramFence("Intro\n```mermaid\nA\n```")).toBeNull();
    expect(parseSoleDiagramFence("```mermaid```")).toBeNull();
    expect(parseSoleDiagramFence("**bold**")).toBeNull();
  });

  test("backtick fences may not carry backticks in the info string", () => {
    expect(parseSoleDiagramFence("```mermaid `x`\nA\n```")).toBeNull();
  });
});

describe("soleDiagramInSection", () => {
  test("heading section that is one diagram", () => {
    const d = soleDiagramInSection("## Sequence\n\n```mermaid width=470\nsequenceDiagram\n  A->>B: hi\n```\n\n");
    expect(d).toEqual({ lang: "mermaid", code: "sequenceDiagram\n  A->>B: hi", width: 470 });
  });

  test("whole note with frontmatter", () => {
    expect(soleDiagramInSection("---\ntags: [x]\n---\n```pele\nflowchart LR\n  A-->B\n```\n")?.lang).toBe("pele");
  });

  test("block reference after the fence", () => {
    expect(soleDiagramInSection("```mermaid\nflowchart LR\n  A-->B\n```\n^pele-abc123\n")?.code).toBe("flowchart LR\n  A-->B");
  });

  test("sections with prose are ordinary embeds", () => {
    expect(soleDiagramInSection("## H\n\nSome text\n\n```mermaid\nA\n```")).toBeNull();
    expect(soleDiagramInSection("## H\n\nJust text")).toBeNull();
  });
});

describe("embed targets", () => {
  test("diagram files", () => {
    expect(diagramFileLang({ linkpath: "flows/a.mmd", subpath: "" })).toBe("mermaid");
    expect(diagramFileLang({ linkpath: "a.MERMAID", subpath: "" })).toBe("mermaid");
    expect(diagramFileLang({ linkpath: "a.pele", subpath: "" })).toBe("pele");
    expect(diagramFileLang({ linkpath: "a.png", subpath: "" })).toBeNull();
  });

  test("note targets", () => {
    expect(isNoteTarget({ linkpath: "Diagrams", subpath: "#Sequence" })).toBe(true);
    expect(isNoteTarget({ linkpath: "dir/Note.md", subpath: "" })).toBe(true);
    expect(isNoteTarget({ linkpath: "Projects.base", subpath: "" })).toBe(false);
  });

  test("requested size and alias", () => {
    expect(embedRequestedSize({ linkpath: "a.png", subpath: "", aliasOrSize: "100" })).toEqual({ width: 100 });
    expect(embedRequestedSize({ linkpath: "a.png", subpath: "", aliasOrSize: "320x200" })).toEqual({ width: 320, height: 200 });
    expect(embedRequestedSize({ linkpath: "a.png", subpath: "", aliasOrSize: "x90" })).toEqual({ height: 90 });
    expect(embedRequestedSize({ linkpath: "a.png", subpath: "", aliasOrSize: "Caption|240" })).toEqual({ width: 240 });
    expect(embedRequestedSize({ linkpath: "a.png", subpath: "", aliasOrSize: "Caption" })).toEqual({});
    expect(embedAlias({ linkpath: "a.png", subpath: "", aliasOrSize: "Caption|240" })).toBe("Caption");
    expect(embedAlias({ linkpath: "a.png", subpath: "", aliasOrSize: "240" })).toBe("");
  });
});

describe("fitContentSize", () => {
  const legible: FitOptions = { cap: { width: 640, height: 480 }, mode: "legible", minScale: 0.5 };
  const exact: FitOptions = { ...legible, mode: "exact" };
  const shot = { width: 958, height: 950 }; // the pasted screenshot

  test("no explicit size: natural, shrunk to fit the cap (aspect kept)", () => {
    expect(fitContentSize(shot, {}, legible)).toEqual({ width: 484, height: 480 });
    expect(fitContentSize({ width: 200, height: 100 }, {}, legible)).toEqual({ width: 200, height: 100 });
  });

  test("legible mode lifts a tiny explicit size to the floor", () => {
    expect(fitContentSize(shot, { width: 100 }, legible)).toEqual({ width: 479, height: 475 });
  });

  test("exact mode honours the written size", () => {
    expect(fitContentSize(shot, { width: 100 }, exact)).toEqual({ width: 100, height: 99 });
  });

  test("explicit sizes may exceed the cap up to the natural size", () => {
    expect(fitContentSize(shot, { width: 800 }, legible)).toEqual({ width: 800, height: 793 });
    expect(fitContentSize(shot, { width: 5000 }, legible)).toEqual({ width: 958, height: 950 });
  });

  test("a small written size never comes out larger than no size", () => {
    const huge = { width: 4000, height: 4000 };
    expect(fitContentSize(huge, { width: 100 }, legible)).toEqual(fitContentSize(huge, {}, legible));
  });

  test("small content may be enlarged up to the cap", () => {
    expect(fitContentSize({ width: 100, height: 50 }, { width: 900 }, legible)).toEqual({ width: 640, height: 320 });
  });

  test("width and height: the smaller scale wins", () => {
    expect(fitContentSize({ width: 400, height: 400 }, { width: 300, height: 250 }, exact)).toEqual({ width: 250, height: 250 });
  });

  test("unknown natural size falls back to the request within the cap", () => {
    expect(fitContentSize({ width: 0, height: 0 }, { width: 900 }, legible)).toEqual({ width: 640, height: 480 });
  });

  test("drag bounds", () => {
    expect(minContentWidth(shot, legible)).toBe(479);
    expect(minContentWidth(shot, exact)).toBe(16);
    // The floor never exceeds the cap fit for content much larger than the cap.
    expect(minContentWidth({ width: 4000, height: 4000 }, legible)).toBe(480);
    expect(minContentWidth({ width: 4000, height: 4000 }, { ...legible, minScale: 0.05 })).toBe(200);
    expect(maxContentSize(shot, legible.cap)).toEqual({ width: 958, height: 950 });
    expect(maxContentSize({ width: 100, height: 50 }, legible.cap)).toEqual({ width: 640, height: 320 });
  });
});

describe("label rewrites", () => {
  test("withFenceWidth sets, replaces and removes width= on the inner fence", () => {
    const raw = "~~~mermaid\nflowchart TD\n  A --> B\n~~~";
    expect(withFenceWidth(raw, 240)).toBe("~~~mermaid width=240\nflowchart TD\n  A --> B\n~~~");
    expect(withFenceWidth("~~~mermaid width=240\nA\n~~~", 300)).toBe("~~~mermaid width=300\nA\n~~~");
    expect(withFenceWidth("~~~mermaid width=240\nA\n~~~", null)).toBe("~~~mermaid\nA\n~~~");
    expect(withFenceWidth("plain", 10)).toBeNull();
  });

  test("withEmbedSize keeps the alias and replaces only a trailing size", () => {
    expect(withEmbedSize("![[a.png]]", { width: 300 })).toBe("![[a.png|300]]");
    expect(withEmbedSize("![[a.png|100]]", { width: 300 })).toBe("![[a.png|300]]");
    expect(withEmbedSize("![[a.png|Cap|100]]", { width: 300 })).toBe("![[a.png|Cap|300]]");
    expect(withEmbedSize("![[Note#H]]", { width: 320, height: 200 })).toBe("![[Note#H|320x200]]");
    expect(withEmbedSize("![[a.png|Cap|100]]", null)).toBe("![[a.png|Cap]]");
    expect(withEmbedSize(" ![[a.png]] ", null)).toBe(" ![[a.png]] ");
    expect(withEmbedSize("text ![[a.png]]", { width: 1 })).toBeNull();
  });

  test("withFenceBody re-escapes only the changed middle", () => {
    const raw = '~~~mehrpele\nflowchart TD\n  a[\\"**bold**\\"] --> b[\\"\\\\nabla\\"]\n~~~';
    const code = unescapeLabelMarkdown(raw.slice(raw.indexOf("\n") + 1, raw.lastIndexOf("\n")));
    expect(code).toBe('flowchart TD\n  a["**bold**"] --> b["\\nabla"]');
    const next = withFenceBody(raw, code.replace('**bold**', '**bolder** "q"'))!;
    expect(next).toBe('~~~mehrpele\nflowchart TD\n  a[\\"**bolder** \\"q\\"\\"] --> b[\\"\\\\nabla\\"]\n~~~');
    // Round trip: unescaping the new body gives exactly the new code.
    expect(unescapeLabelMarkdown(next.slice(next.indexOf("\n") + 1, next.lastIndexOf("\n")))).toBe(
      code.replace('**bold**', '**bolder** "q"'),
    );
    expect(withFenceBody(raw, code)).toBeNull();
  });

  test("rewriteLabel uses raw offsets with the %% mehrpele %% directive present", () => {
    const src = 'flowchart LR\n%% mehrpele %%\n  A["![[a.png|100]]"] --> B["**b**"]';
    const next = rewriteLabel(src, "A", (raw) => withEmbedSize(raw, { width: 480 }));
    expect(next).toBe('flowchart LR\n%% mehrpele %%\n  A["![[a.png|480]]"] --> B["**b**"]');
    expect(rewriteLabel(src, "missing", () => "x")).toBeNull();
    expect(rewriteLabel(src, "A", (raw) => raw)).toBeNull();
  });

  test("labelsInRawSource spans index the raw text", () => {
    const src = '%% mehrpele %%\ngraph LR\n  N["~~~mermaid\nA-->B\n~~~"]';
    const [label] = labelsInRawSource(src);
    expect(rawLabelInner(src, label!)).toBe("~~~mermaid\nA-->B\n~~~");
    // extractLabels (directive stripped) spans differ: the raw variant exists for rewrites.
    expect(extractLabels(src)[0]!.span.start).toBeLessThan(label!.span.start);
  });
});

describe("fallback text for nested diagrams", () => {
  test("a sole diagram fence reads as its kind", () => {
    expect(diagramFenceSummary("~~~mermaid\nflowchart TD\n  A-->B\n~~~")).toBe("flowchart diagram");
    expect(diagramFenceSummary("```pele\nsequenceDiagram\n  A->>B: x\n```")).toBe("sequence diagram");
    expect(diagramFenceSummary("~~~mermaid\n---\ntitle: T\n---\nstateDiagram-v2\n  [*] --> A\n~~~")).toBe("state diagram");
    expect(diagramFenceSummary("~~~mermaid\n%% c\ngraph LR\n~~~")).toBe("flowchart diagram");
    expect(diagramFenceSummary("**bold**")).toBeNull();
    expect(markdownToFallback("~~~mermaid\nflowchart TD\n  A-->B\n~~~")).toBe("flowchart diagram");
    expect(markdownToFallback("**bold** text")).toBe("bold text");
  });
});
