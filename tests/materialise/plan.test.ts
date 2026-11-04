import { describe, expect, test } from "bun:test";
import { applyPlan } from "../../src/materialise/apply";
import {
  expandRoot,
  mergeLinks,
  planFromSource,
  propertyKey,
  safeName,
  type MaterialiseOptions,
  type MaterialisePlan,
} from "../../src/materialise/planner";
import { FakeVault } from "./fake-vault";

const OPTS: MaterialiseOptions = { root: "Notes/Demo", defaultKey: "canvas-link", keyStyle: "slug", rewrite: true, onExisting: "link" };

function plan(source: string, vault = new FakeVault({}, ["Notes"]), opts: Partial<MaterialiseOptions> = {}, isMehrpele = false): MaterialisePlan {
  const r = planFromSource({ source, isMehrpele, notePath: "Notes/Demo.md", blockId: "pele-abc", options: { ...OPTS, ...opts }, vault: vault.view() });
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
}

function note(p: MaterialisePlan, id: string) {
  const n = p.notes.find((x) => x.nodeId === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
}

/** Plan, apply to the fake vault, return the rewritten source (as the next run sees it). */
async function run(source: string, vault: FakeVault, opts: Partial<MaterialiseOptions> = {}, isMehrpele = false): Promise<{ plan: MaterialisePlan; next: string }> {
  const p = plan(source, vault, opts, isMehrpele);
  await applyPlan(p, vault.ops());
  return { plan: p, next: p.rewrite?.after ?? source };
}

describe("names", () => {
  test("safeName strips characters Obsidian and filesystems forbid", () => {
    expect(safeName("A/B testing: v2?")).toBe("A-B testing- v2");
    expect(safeName('quote "x" <y> | z * #tag ^id [k]')).toBe("quote x y z tag id k");
    expect(safeName("  ...hidden. ")).toBe("hidden");
    expect(safeName("line1<br>line2")).toBe("line1 line2");
    // C0 controls and DEL become spaces (then collapse); C1 controls (U+0085 here) are kept as is.
    expect(safeName("a\u0000\u001fb\u007fc")).toBe("a b c");
    expect(safeName("a\u0085b c")).toBe("a\u0085b c");
    expect(safeName("CON")).toBe("CON_");
    expect(safeName("???", "N1")).toBe("N1");
    expect([...safeName("x".repeat(300))].length).toBe(120);
    expect(safeName("Café ☕ 日本")).toBe("Café ☕ 日本");
  });
  test("propertyKey slugs or keeps labels, guards reserved keys", () => {
    expect(propertyKey("Depends On", "slug", "canvas-link")).toBe("depends-on");
    expect(propertyKey("Depends On", "verbatim", "canvas-link")).toBe("Depends On");
    expect(propertyKey("**uses** it", "slug", "canvas-link")).toBe("uses-it");
    expect(propertyKey("", "slug", "canvas-link")).toBe("canvas-link");
    expect(propertyKey("→", "slug", "rel")).toBe("rel");
    expect(propertyKey("tags", "slug", "canvas-link")).toBe("tags-link");
    expect(propertyKey("a: b", "verbatim", "canvas-link")).toBe("a b");
  });
  test("expandRoot", () => {
    expect(expandRoot("{{folder}}/{{note}}", "Notes/Demo.md")).toBe("Notes/Demo");
    expect(expandRoot("{{folder}}/{{note}}", "Demo.md")).toBe("Demo");
    expect(expandRoot("Materialised/{{note}}", "a/b/Demo.md")).toBe("Materialised/Demo");
    expect(expandRoot("../x/./y/", "Demo.md")).toBe("x/y");
  });
});

describe("planner", () => {
  test("nested subgraphs become nested folders, nodes notes in their innermost folder", () => {
    const p = plan(`flowchart TD
  subgraph Outer["Outer **group**"]
    A --> B
    subgraph Inner
      C
      subgraph Deepest
        D
      end
    end
  end
  E --> A`);
    expect(p.folders.map((f) => [f.path, f.status])).toEqual([
      ["Notes", "exists"],
      ["Notes/Demo", "create"],
      ["Notes/Demo/Outer group", "create"],
      ["Notes/Demo/Outer group/Inner", "create"],
      ["Notes/Demo/Outer group/Inner/Deepest", "create"],
    ]);
    expect(note(p, "A").path).toBe("Notes/Demo/Outer group/A.md");
    expect(note(p, "C").path).toBe("Notes/Demo/Outer group/Inner/C.md");
    expect(note(p, "D").path).toBe("Notes/Demo/Outer group/Inner/Deepest/D.md");
    expect(note(p, "E").path).toBe("Notes/Demo/E.md");
  });

  test("labelled edges → slug keys; unlabelled → default key; several targets → list; one → scalar", () => {
    const p = plan(`flowchart LR
  A[Start] -->|Depends On| B[Lib]
  A -->|Depends On| C[Other]
  A --> D[Plain]
  A -->|Depends On| B`);
    const a = note(p, "A");
    expect(a.properties).toEqual({
      "depends-on": ["[[Notes/Demo/Lib]]", "[[Notes/Demo/Other]]"],
      "canvas-link": ["[[Notes/Demo/Plain]]"],
    });
    expect(a.content).toContain('depends-on:\n  - "[[Notes/Demo/Lib]]"\n  - "[[Notes/Demo/Other]]"');
    expect(a.content).toContain('canvas-link: "[[Notes/Demo/Plain]]"');
  });

  test("verbatim keys and a custom default key", () => {
    const p = plan("flowchart LR\n  A -->|Depends On| B\n  A --> C", undefined, { keyStyle: "verbatim", defaultKey: "related" });
    expect(Object.keys(note(p, "A").properties!)).toEqual(["Depends On", "related"]);
  });

  test("self-loops and multi-edges", () => {
    const p = plan("flowchart LR\n  A -->|next| A\n  A --> B\n  A --> B\n  A -.-> B");
    expect(note(p, "A").properties).toEqual({ next: ["[[Notes/Demo/A]]"], "canvas-link": ["[[Notes/Demo/B]]"] });
  });

  test("duplicate labels in one folder get suffixes; in different folders they don't", () => {
    const p = plan(`flowchart LR
  A[Step] --> B[Step] --> C[step]
  subgraph S
    D[Step]
  end`);
    expect(["A", "B", "C", "D"].map((id) => note(p, id).path)).toEqual([
      "Notes/Demo/Step.md",
      "Notes/Demo/Step 2.md",
      "Notes/Demo/step 3.md",
      "Notes/Demo/S/Step.md",
    ]);
  });

  test("odd characters in labels: safe filenames, original kept as alias and body", () => {
    const p = plan('flowchart LR\n  A["What? Why/How: **now**"] --> B["#tag [x] ^y"]', undefined, {}, true);
    const a = note(p, "A");
    expect(a.path).toBe("Notes/Demo/What Why-How- now.md");
    expect(a.content).toContain('aliases:\n  - "What? Why/How: **now**"');
    // The filename lost "?", "/" and ":", so the body shows the label as written.
    expect(a.content!.endsWith("---\nWhat? Why/How: **now**\n")).toBe(true);
    expect(note(p, "B").path).toBe("Notes/Demo/tag x y.md");
  });

  test("no duplicate title in embeds: the body only says what the file name can't", () => {
    const p = plan('flowchart LR\n  A[Raw data] --> B["**Bold** idea"] --> C[Step] --> D[Step] --> E["Long ? name"]\n  F', undefined, {}, true);
    const body = (id: string) => note(p, id).content!.replace(/^---\n[\s\S]*?\n---\n/, "");
    const aliases = (id: string) => /aliases:\n((?:  - .*\n)+)/.exec(note(p, id).content!)?.[1]?.trim() ?? null;
    // Plain label = title: frontmatter only; the embed shows the file name.
    expect(body("A")).toBe("");
    expect(aliases("A")).toBeNull();
    expect(body("F")).toBe("");
    // Formatting only: the title says it; the Markdown is kept as an alias.
    expect(body("B")).toBe("");
    expect(aliases("B")).toBe('- "**Bold** idea"');
    // Suffixed duplicate: body empty, original label as alias.
    expect(note(p, "D").path).toBe("Notes/Demo/Step 2.md");
    expect(body("D")).toBe("");
    expect(aliases("D")).toBe('- "Step"');
    // Characters the filename dropped: the body shows the label as written.
    expect(note(p, "E").path).toBe("Notes/Demo/Long name.md");
    expect(body("E")).toBe("Long ? name\n");
  });

  test("provenance on every created note", () => {
    const p = plan("flowchart LR\n  A --> B");
    for (const n of p.notes) {
      expect(n.content).toContain('pele-materialised: "[[Notes/Demo#^pele-abc]]"');
      expect(n.content).toContain(`pele-node: "${n.nodeId}"`);
    }
    expect(p.provenance).toBe("[[Notes/Demo#^pele-abc]]");
  });

  test("existing note: link (default) never overwrites and gets the properties", () => {
    const v = new FakeVault({ "Notes/Demo/B.md": { status: "draft", "canvas-link": "[[Somewhere]]" } });
    const p = plan("flowchart LR\n  B --> C\n  A --> B", v);
    const b = note(p, "B");
    expect(b.action).toBe("link");
    expect(b.content).toBeUndefined();
    expect(p.properties).toEqual([
      {
        path: "Notes/Demo/B.md",
        key: "canvas-link",
        add: [{ link: "[[Notes/Demo/C]]", target: "notes/demo/c" }],
        before: "[[Somewhere]]",
        after: ["[[Somewhere]]", "[[Notes/Demo/C]]"],
      },
    ]);
    expect(note(p, "A").properties).toEqual({ "canvas-link": ["[[Notes/Demo/B]]"] });
  });

  test("existing note: skip leaves the node, its label and its edges alone", () => {
    const v = new FakeVault({ "Notes/Demo/B.md": {} });
    const p = plan("flowchart LR\n  A --> B[B]\n  B --> C", v, { onExisting: "skip" });
    expect(note(p, "B").action).toBe("skip");
    expect(p.properties).toEqual([]);
    expect(note(p, "A").properties).toBeUndefined();
    expect(p.rewrite!.after).toContain("B[B]");
    expect(p.warnings.join("\n")).toContain("B is skipped");
  });

  test("existing note: suffix creates Name 2 (case-insensitive clash)", () => {
    const v = new FakeVault({ "Notes/Demo/b.md": {} });
    const p = plan("flowchart LR\n  A --> B", v, { onExisting: "suffix" });
    expect(note(p, "B")).toMatchObject({ action: "create", path: "Notes/Demo/B 2.md" });
    expect(note(p, "B").reason).toContain("exists");
  });

  test("a folder name taken by a file gets a suffix", () => {
    const v = new FakeVault({ "Notes/Demo/S": null });
    const p = plan("flowchart LR\n  subgraph S\n    A\n  end", v);
    expect(note(p, "A").path).toBe("Notes/Demo/S 2/A.md");
  });

  test("labels that embed an existing note use it; media embeds are left alone", () => {
    const v = new FakeVault({ "Ref/Existing.md": { tags: ["x"] }, "img.png": null });
    const p = plan('flowchart LR\n  A["![[Existing]]"] --> I["![[img.png|200]]"]\n  B["[[Existing]]"] --> A\n  I --> B', v, {}, true);
    expect(note(p, "A")).toMatchObject({ action: "link", path: "Ref/Existing.md" });
    expect(note(p, "I")).toMatchObject({ action: "media", path: "img.png" });
    expect(note(p, "B")).toMatchObject({ action: "link", path: "Ref/Existing.md" });
    expect(p.properties.map((w) => [w.path, w.key, w.after])).toEqual([["Ref/Existing.md", "canvas-link", ["[[img.png]]", "[[Ref/Existing]]"]]]);
    expect(p.warnings.join("\n")).toContain("I is a media node");
    // A already embeds its note: untouched. B's wikilink becomes an embed.
    expect(p.rewrite!.after).toContain('A["![[Existing]]"]');
    expect(p.rewrite!.after).toContain('B["![[Ref/Existing]]"]');
    expect(p.notes.some((n) => n.action === "create")).toBe(false);
  });

  test("an unresolved embed label creates the note named after its link", () => {
    const p = plan('flowchart LR\n  A["![[Missing note]]"]', undefined, {}, true);
    expect(note(p, "A")).toMatchObject({ action: "create", path: "Notes/Demo/Missing note.md" });
    // The title (file name) already says it: no body, no alias.
    expect(note(p, "A").content!.endsWith("---\n")).toBe(true);
    expect(note(p, "A").content).not.toContain("aliases");
  });

  test("edges to subgraphs are skipped with a warning", () => {
    const p = plan("flowchart LR\n  subgraph S\n    A\n  end\n  B --> S\n  S --> A");
    expect(p.notes.map((n) => n.nodeId).sort()).toEqual(["A", "B"]);
    expect(note(p, "B").properties).toBeUndefined();
    expect(p.warnings.join("\n")).toContain("2 edge(s) to or from a subgraph");
  });

  test("a root that is a file aborts with a warning", () => {
    const v = new FakeVault({ "Notes/Demo": null });
    const p = plan("flowchart LR\n  A", v);
    expect(p.empty).toBe(true);
    expect(p.warnings[0]).toContain("is a file");
  });

  test("rewrite off: no rewrite in the plan", () => {
    expect(plan("flowchart LR\n  A --> B", undefined, { rewrite: false }).rewrite).toBeNull();
  });

  test("Mehrpele blocks: label Markdown from quoted labels, directive not duplicated", () => {
    const p = plan('```\n'.slice(0, 0) + '%% mehrpele %%\nflowchart LR\n  A["**Bold** _idea_"] -->|"uses **it**"| B', undefined, {}, true);
    expect(note(p, "A").path).toBe("Notes/Demo/Bold idea.md");
    expect(note(p, "A").properties).toEqual({ "uses-it": ["[[Notes/Demo/B]]"] });
    expect(p.rewrite!.after.match(/%% mehrpele %%/g)!.length).toBe(1);
  });

  test("plain mermaid blocks get the %% mehrpele %% directive", () => {
    expect(plan("flowchart LR\n  A --> B").rewrite!.after.startsWith("%% mehrpele %%\nflowchart LR")).toBe(true);
  });
});

describe("state diagrams", () => {
  const SRC = `stateDiagram-v2
  [*] --> Idle
  state "Waiting room" as Idle
  Idle --> Busy : start
  Busy : working hard
  state Composite {
    [*] --> Inner
    Inner --> Done : finish
  }
  Busy --> Composite
  Composite --> [*]`;
  test("composites are folders, pseudo-states and group edges skipped", () => {
    const p = plan(SRC);
    expect(p.notes.map((n) => [n.nodeId, n.path])).toEqual([
      ["Idle", "Notes/Demo/Waiting room.md"],
      ["Busy", "Notes/Demo/working hard.md"],
      ["Inner", "Notes/Demo/Composite/Inner.md"],
      ["Done", "Notes/Demo/Composite/Done.md"],
    ]);
    expect(note(p, "Idle").properties).toEqual({ start: ["[[Notes/Demo/working hard]]"] });
    expect(note(p, "Inner").properties).toEqual({ finish: ["[[Notes/Demo/Composite/Done]]"] });
    expect(p.warnings.join("\n")).toMatch(/pseudo-state/);
  });
  test("state rewrite: descriptions become embeds, labels stay in scope", () => {
    const after = plan(SRC).rewrite!.after;
    expect(after).toContain("  state Idle\n  Idle : \"![[Notes/Demo/Waiting room]]\"");
    expect(after).toContain('  Busy : "![[Notes/Demo/working hard]]"');
    expect(after).toContain('    [*] --> Inner\n    Inner : "![[Notes/Demo/Composite/Inner]]"');
    expect(after).not.toContain("working hard\n");
  });
});

describe("refusals", () => {
  const refuse = (src: string) => planFromSource({ source: src, isMehrpele: false, notePath: "N.md", blockId: "pele-x", options: OPTS, vault: new FakeVault().view() });
  test("class, sequence, mindmap and pie are refused with a clear message", () => {
    const c = refuse("classDiagram\n  A <|-- B");
    expect(c.ok).toBe(false);
    expect(!c.ok && c.reason).toContain("class diagrams can't be materialised");
    for (const src of ["sequenceDiagram\n  A->>B: hi", "mindmap\n  root\n    a", 'pie\n  "a" : 1']) {
      const r = refuse(src);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toContain("only flowcharts and state diagrams");
    }
  });
  test("unparsable diagrams are refused", () => {
    const r = refuse("flowchart LR\n  A -->");
    expect(r.ok).toBe(false);
  });
});

describe("idempotency", () => {
  const SRC = `flowchart LR
  subgraph In["Inputs"]
    A[Alpha] -->|feeds| B[Beta]
  end
  B --> C[Gamma]
  C -->|feeds| A`;

  test("re-running on a materialised diagram is a no-op", async () => {
    const v = new FakeVault({}, ["Notes"]);
    const first = await run(SRC, v);
    expect(first.plan.notes.every((n) => n.action === "create")).toBe(true);
    const before = v.snapshot();
    const second = plan(first.next, v, {}, true);
    expect(second.notes.map((n) => n.action)).toEqual(["reuse", "reuse", "reuse"]);
    expect(second.empty).toBe(true);
    expect(second.rewrite).toBeNull();
    await applyPlan(second, v.ops());
    expect(v.snapshot()).toBe(before);
  });

  test("re-running with rewrite off finds its notes by provenance", async () => {
    const v = new FakeVault({}, ["Notes"]);
    await run(SRC, v, { rewrite: false });
    const again = plan(SRC, v, { rewrite: false });
    expect(again.notes.map((n) => n.action)).toEqual(["reuse", "reuse", "reuse"]);
    expect(again.empty).toBe(true);
  });

  test("suffix policy re-run stays stable", async () => {
    const v = new FakeVault({ "Notes/Demo/Step.md": { mine: true } });
    const src = "flowchart LR\n  A[Step] --> B[Step]";
    const first = await run(src, v, { onExisting: "suffix", rewrite: false });
    expect(first.plan.notes.map((n) => n.path)).toEqual(["Notes/Demo/Step 2.md", "Notes/Demo/Step 3.md"]);
    const again = plan(src, v, { onExisting: "suffix", rewrite: false });
    expect(again.notes.map((n) => [n.path, n.action])).toEqual([["Notes/Demo/Step 2.md", "reuse"], ["Notes/Demo/Step 3.md", "reuse"]]);
    expect(again.empty).toBe(true);
  });

  test("after a diagram edit, only what is new is added", async () => {
    const v = new FakeVault({}, ["Notes"]);
    const first = await run(SRC, v);
    const edited = `${first.next}\n  C --> D[Delta]\n  A -->|feeds| D`;
    const p = plan(edited, v, {}, true);
    expect(p.notes.map((n) => [n.nodeId, n.action])).toEqual([["A", "reuse"], ["B", "reuse"], ["C", "reuse"], ["D", "create"]]);
    expect(p.folders.filter((f) => f.status === "create")).toEqual([]);
    expect(p.properties.map((w) => [w.path, w.key, w.after])).toEqual([
      ["Notes/Demo/Inputs/Alpha.md", "feeds", ["[[Notes/Demo/Inputs/Beta]]", "[[Notes/Demo/Delta]]"]],
      ["Notes/Demo/Gamma.md", "canvas-link", "[[Notes/Demo/Delta]]"],
    ]);
    expect(p.rewrite!.after).toContain('D["![[Notes/Demo/Delta]]"]');
    expect(p.rewrite!.after.match(/%% mehrpele %%/g)!.length).toBe(1);
  });

  test("links already present by another spelling are not repeated", () => {
    const v = new FakeVault({ "Notes/Demo/A.md": { "canvas-link": ["[[B|bee]]"] }, "Notes/Demo/B.md": {} });
    const p = plan("flowchart LR\n  A --> B", v);
    expect(p.properties).toEqual([]);
  });
});

describe("mergeLinks", () => {
  const resolve = (l: string) => (l === "X" ? "Folder/X.md" : null);
  const add = [{ link: "[[Folder/X]]", target: "folder/x" }];
  test("absent → scalar; scalar → list; list → appended; duplicate → unchanged", () => {
    expect(mergeLinks(undefined, add, "n.md", resolve)).toEqual({ value: "[[Folder/X]]", changed: true });
    expect(mergeLinks("[[Y]]", add, "n.md", resolve)).toEqual({ value: ["[[Y]]", "[[Folder/X]]"], changed: true });
    expect(mergeLinks(["[[Y]]"], add, "n.md", resolve)).toEqual({ value: ["[[Y]]", "[[Folder/X]]"], changed: true });
    expect(mergeLinks(["[[X]]"], add, "n.md", resolve)).toEqual({ value: ["[[X]]"], changed: false });
    expect(mergeLinks([], add, "n.md", resolve)).toEqual({ value: ["[[Folder/X]]"], changed: true });
  });
  test("non-link values are never clobbered", () => {
    expect(mergeLinks(3, add, "n.md", resolve)).toBeUndefined();
    expect(mergeLinks({ a: 1 }, add, "n.md", resolve)).toBeUndefined();
    expect(mergeLinks([1], add, "n.md", resolve)).toBeUndefined();
  });
});

describe("sized and reflowing diagrams", () => {
  test("a block with %% pele-size %% / %% pele-reflow %% plans normally and keeps both lines", () => {
    const src = "%% pele-reflow direction=fixed floor=0.7 %%\nflowchart LR\n  A[Alpha] --> B[Beta]\n%% pele-size A=240x120 B=180 %%";
    const p = plan(src);
    expect(p.notes.map((n) => n.path)).toEqual(["Notes/Demo/Alpha.md", "Notes/Demo/Beta.md"]);
    expect(p.rewrite!.after.endsWith("\n%% pele-size A=240x120 B=180 %%")).toBe(true);
    expect(p.rewrite!.after).toContain("%% pele-reflow direction=fixed floor=0.7 %%\nflowchart LR");
  });
});
