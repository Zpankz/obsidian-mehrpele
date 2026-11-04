import { describe, expect, test } from "bun:test";
import { applyPlan, undoMaterialise } from "../../src/materialise/apply";
import { planFromSource, type MaterialiseOptions, type MaterialisePlan } from "../../src/materialise/planner";
import { applySourceEdit, minimalChange, revertSourceEdit } from "../../src/materialise/source-edit";
import { FakeVault } from "./fake-vault";

const OPTS: MaterialiseOptions = { root: "Notes/Demo", defaultKey: "canvas-link", keyStyle: "slug", rewrite: true, onExisting: "link" };

function plan(source: string, vault: FakeVault, opts: Partial<MaterialiseOptions> = {}): MaterialisePlan {
  const r = planFromSource({ source, isMehrpele: false, notePath: "Notes/Demo.md", blockId: "pele-abc", options: { ...OPTS, ...opts }, vault: vault.view() });
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
}

const SRC = `flowchart LR
  subgraph S["Group"]
    subgraph T["Inner"]
      A[Alpha]
    end
  end
  A -->|uses| B[Existing]
  B --> C[Gamma]
  A --> X["![[Pre]]"]`;

describe("apply + undo", () => {
  test("apply creates folders parents-first, notes, then properties", async () => {
    const v = new FakeVault({ "Notes/Demo/Existing.md": { status: "keep" }, "Pre.md": "---\na: 1\n---\nbody" }, ["Notes"]);
    const p = plan(SRC, v);
    const rec = await applyPlan(p, v.ops());
    expect(rec.errors).toEqual([]);
    expect(rec.createdFolders).toEqual(["Notes/Demo/Group", "Notes/Demo/Group/Inner"]);
    expect(rec.createdFiles).toEqual(["Notes/Demo/Group/Inner/Alpha.md", "Notes/Demo/Gamma.md"]);
    expect(v.note("Notes/Demo/Group/Inner/Alpha.md")!.frontmatter).toEqual({
      "pele-materialised": "[[Notes/Demo#^pele-abc]]",
      "pele-node": "A",
      uses: "[[Notes/Demo/Existing]]",
      "canvas-link": "[[Pre]]",
    });
    expect(v.note("Notes/Demo/Existing.md")!.frontmatter).toEqual({ status: "keep", "canvas-link": "[[Notes/Demo/Gamma]]" });
    expect(v.log.slice(0, 2)).toEqual(["mkdir Notes/Demo/Group", "mkdir Notes/Demo/Group/Inner"]);
  });

  test("undo restores the vault exactly and never trashes a file that existed before", async () => {
    const v = new FakeVault({ "Notes/Demo/Existing.md": { status: "keep" }, "Pre.md": "---\na: 1\n---\nbody", "Notes/Other.md": {} }, ["Notes"]);
    const before = v.snapshot();
    const rec = await applyPlan(plan(SRC, v), v.ops());
    const report = await undoMaterialise(rec, v.ops());
    expect(v.snapshot()).toBe(before);
    expect(report.trashedFiles.sort()).toEqual(["Notes/Demo/Gamma.md", "Notes/Demo/Group/Inner/Alpha.md"]);
    expect(report.trashedFolders).toEqual(["Notes/Demo/Group/Inner", "Notes/Demo/Group"]);
    expect(report.restoredProperties).toBe(1);
    for (const t of v.trashed) expect(["Notes/Demo/Existing.md", "Pre.md", "Notes/Other.md", "Notes"]).not.toContain(t);
  });

  test("a file that appears between preview and apply is not overwritten nor trashed by undo", async () => {
    const v = new FakeVault({}, ["Notes"]);
    const p = plan("flowchart LR\n  A --> B", v);
    await v.ops().createFolder("Notes/Demo");
    await v.ops().createNote("Notes/Demo/B.md", "---\nmine: yes\n---\nhands off");
    const rec = await applyPlan(p, v.ops());
    expect(rec.createdFiles).toEqual(["Notes/Demo/A.md"]);
    expect(rec.createdFolders).toEqual([]);
    expect(rec.errors.join()).toContain("Notes/Demo/B.md: appeared after the preview");
    expect(v.note("Notes/Demo/B.md")!.body).toBe("hands off");
    await undoMaterialise(rec, v.ops());
    expect(v.note("Notes/Demo/B.md")!.frontmatter).toEqual({ mine: "yes" });
    expect(v.folders.has("Notes/Demo")).toBe(true);
  });

  test("undo keeps a created folder the user put files in, and a property the user edited", async () => {
    const v = new FakeVault({ "Notes/Demo/B.md": {} }, ["Notes"]);
    const rec = await applyPlan(plan("flowchart LR\n  subgraph S\n    A\n  end\n  B --> A", v), v.ops());
    await v.ops().createNote("Notes/Demo/S/User note.md", "x");
    await v.ops().editFrontmatter("Notes/Demo/B.md", (fm) => {
      fm["canvas-link"] = ["[[Notes/Demo/S/A]]", "[[Mine]]"];
    });
    const report = await undoMaterialise(rec, v.ops());
    expect(v.note("Notes/Demo/S/User note.md")).not.toBeNull();
    expect(v.folders.has("Notes/Demo/S")).toBe(true);
    expect(v.note("Notes/Demo/B.md")!.frontmatter).toEqual({ "canvas-link": ["[[Notes/Demo/S/A]]", "[[Mine]]"] });
    expect(report.kept.join("\n")).toContain("not empty");
    expect(report.kept.join("\n")).toContain("edited since");
    expect(report.trashedFiles).toEqual(["Notes/Demo/S/A.md"]);
  });

  test("undo keeps a created note whose provenance changed", async () => {
    const v = new FakeVault({}, ["Notes"]);
    const rec = await applyPlan(plan("flowchart LR\n  A", v), v.ops());
    await v.ops().editFrontmatter("Notes/Demo/A.md", (fm) => {
      delete fm["pele-materialised"];
    });
    const report = await undoMaterialise(rec, v.ops());
    expect(report.trashedFiles).toEqual([]);
    expect(v.note("Notes/Demo/A.md")).not.toBeNull();
  });

  test("property write re-merges against the note's current value", async () => {
    const v = new FakeVault({ "Notes/Demo/B.md": {} }, ["Notes"]);
    const p = plan("flowchart LR\n  B --> A", v);
    await v.ops().editFrontmatter("Notes/Demo/B.md", (fm) => {
      fm["canvas-link"] = "[[Notes/Demo/A]]";
    });
    const rec = await applyPlan(p, v.ops());
    expect(rec.properties).toEqual([]);
    expect(v.note("Notes/Demo/B.md")!.frontmatter).toEqual({ "canvas-link": "[[Notes/Demo/A]]" });
  });
});

describe("source edit", () => {
  const NOTE = "# Demo\n\n```mermaid\nflowchart LR\n  A --> B\n```\nAfter\n";
  test("rewrite plus a new block id, then an exact revert", () => {
    const r = applySourceEdit(NOTE, 2, "flowchart LR\n  A --> B", 'flowchart LR\n  A["![[x]]"] --> B');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toMatch(/^# Demo\n\n```mermaid\nflowchart LR\n {2}A\["!\[\[x\]\]"\] --> B\n```\n\^pele-[0-9a-f]{8}\n\nAfter\n$/);
    const back = revertSourceEdit(r.text, r.edit);
    expect(back).toEqual({ ok: true, text: NOTE });
    const c = minimalChange(NOTE, r.text)!;
    expect(NOTE.slice(0, c.from) + c.insert + NOTE.slice(c.to)).toBe(r.text);
  });
  test("an existing block id is reused and kept on revert", () => {
    const withId = "```mermaid\nflowchart LR\n  A\n```\n^mine\n";
    const r = applySourceEdit(withId, 0, "flowchart LR\n  A", 'flowchart LR\n  A["![[a]]"]');
    expect(r.ok && r.text).toBe('```mermaid\nflowchart LR\n  A["![[a]]"]\n```\n^mine\n');
    if (r.ok) expect(revertSourceEdit(r.text, r.edit)).toEqual({ ok: true, text: withId });
  });
  test("block id at the end of the file", () => {
    const eof = "```mermaid\nflowchart LR\n  A\n```";
    const r = applySourceEdit(eof, 0, "flowchart LR\n  A", null);
    expect(r.ok && r.text).toMatch(/```\n\^pele-[0-9a-f]{8}$/);
    if (r.ok) expect(revertSourceEdit(r.text, r.edit)).toEqual({ ok: true, text: eof });
  });
  test("a block already back to its original (editor undo) counts as reverted", () => {
    const r = applySourceEdit(NOTE, 2, "flowchart LR\n  A --> B", 'flowchart LR\n  A["![[x]]"] --> B');
    if (!r.ok) throw new Error();
    expect(revertSourceEdit(NOTE, r.edit)).toEqual({ ok: true, text: NOTE });
  });
  test("a changed block is neither written nor reverted", () => {
    expect(applySourceEdit(NOTE, 2, "flowchart LR\n  A --> C", "x").ok).toBe(false);
    const r = applySourceEdit(NOTE, 2, "flowchart LR\n  A --> B", 'flowchart LR\n  A["![[x]]"] --> B');
    if (!r.ok) throw new Error();
    const edited = r.text.replace("--> B", "--> Z");
    expect(revertSourceEdit(edited, r.edit).ok).toBe(false);
  });
});
