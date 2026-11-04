import { describe, expect, test } from "bun:test";
import { makeFetchLike, type RequestUrlLike } from "../src/repair-fetch";
import { DEFAULT_REPAIR_SETTINGS, enabledTiers, repairNeedsReview, toRepairOptions } from "../src/repair-settings";
import { replaceBlockBody } from "../src/replace-block";

describe("repair options mapping", () => {
  test("tiers keep fixed order and include only enabled", () => {
    expect(enabledTiers(DEFAULT_REPAIR_SETTINGS)).toEqual(["linter"]);
    expect(enabledTiers({ ...DEFAULT_REPAIR_SETTINGS, tierJev: true, tierLlm: true })).toEqual([
      "linter",
      "jev",
      "llm",
    ]);
    const o = toRepairOptions({ ...DEFAULT_REPAIR_SETTINGS, tierLlm: true });
    expect(o.tiers).toEqual(["linter", "llm"]);
    expect(o.jevMinConfidence).toBe(0.2);
    expect(o.llmMaxAttempts).toBe(2);
  });
});

describe("FetchLike adapter", () => {
  test("maps init to requestUrl and returns status/json/text", async () => {
    const seen: unknown[] = [];
    const mock: RequestUrlLike = async (req) => {
      seen.push(req);
      return { status: 201, json: { ok: true }, text: '{"ok":true}' };
    };
    const fetchLike = makeFetchLike(mock);
    const res = await fetchLike("https://x.test/v1", {
      method: "POST",
      headers: { Authorization: "Bearer k" },
      body: "{}",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen[0]).toMatchObject({ url: "https://x.test/v1", method: "POST", throw: false });
  });

  test("rejects when the signal aborts", async () => {
    const mock: RequestUrlLike = () =>
      new Promise(() => {
        /* never resolves */
      });
    const fetchLike = makeFetchLike(mock);
    const ctrl = new AbortController();
    const p = fetchLike("https://x.test", { method: "GET", headers: {}, body: "", signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow("Aborted");
  });
});

describe("replaceBlockBody", () => {
  const doc = ["# T", "```mermaid width=320", "graph TD", "  A-->", "```", "after"].join("\n");
  test("replaces body, preserves fence incl. width", () => {
    const r = replaceBlockBody(doc, 1, "graph TD\n  A-->", "graph TD\n  A-->B");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("```mermaid width=320");
      expect(r.text).toContain("graph TD\n  A-->B");
      expect(r.text).not.toContain("A-->\n");
    }
  });

  test("relocates after line shifts; aborts when missing/ambiguous", () => {
    expect(replaceBlockBody(`x\ny\n${doc}`, 1, "graph TD\n  A-->", "graph TD\n  A-->B").ok).toBe(true);
    expect(replaceBlockBody(doc, 1, "graph LR\n X-->Y", "z")).toEqual({ ok: false, reason: "missing" });
  });
});

describe("replaceBlockBody never overwrites part of a longer block", () => {
  test("head-only match is refused", () => {
    const doc = "```mermaid\ngraph TD\n  A-->\n  C-->D\n```";
    expect(replaceBlockBody(doc, 0, "graph TD\n  A-->", "graph TD\n  A-->B")).toEqual({ ok: false, reason: "missing" });
  });

  test("replaces the exact block when another block shares its head", () => {
    const doc = "```mermaid\ngraph TD\n  A-->\n  C-->D\n```\n\n```mermaid\ngraph TD\n  A-->\n```\n";
    const r = replaceBlockBody(doc, 0, "graph TD\n  A-->", "graph TD\n  A-->B");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fenceLine).toBe(6);
      expect(r.text).toBe("```mermaid\ngraph TD\n  A-->\n  C-->D\n```\n\n```mermaid\ngraph TD\n  A-->B\n```\n");
    }
  });

  test("mehrpele blocks can be repaired", () => {
    const r = replaceBlockBody("```mehrpele\ngraph TD\n  A-->\n```", 0, "graph TD\n  A-->", "graph TD\n  A-->B");
    expect(r.ok).toBe(true);
  });
});

describe("repairNeedsReview", () => {
  const off = { previewBeforeApplying: false };
  test("Jev/LLM results are always reviewed, even with preview off (the default)", () => {
    expect(DEFAULT_REPAIR_SETTINGS.previewBeforeApplying).toBe(false);
    expect(repairNeedsReview({ tier: "jev" }, off)).toBe(true);
    expect(repairNeedsReview({ tier: "llm" }, off)).toBe(true);
  });
  test("linter fixes keep the 1-click path unless lossy or preview is on", () => {
    expect(repairNeedsReview({ tier: "linter" }, off)).toBe(false);
    expect(repairNeedsReview({ tier: "linter", lossy: true }, off)).toBe(true);
    expect(repairNeedsReview({ tier: "linter" }, { previewBeforeApplying: true })).toBe(true);
  });
});

describe("jev settings", () => {
  test("settings default has no confirmed path", () => {
    expect(DEFAULT_REPAIR_SETTINGS.jevBinConfirmed).toBe("");
  });
});
