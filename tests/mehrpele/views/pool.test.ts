import { describe, expect, test } from "bun:test";
import { adoptionKey, nextExpiry, planPool, type PoolEntry } from "../../../src/mehrpele/views/pool";
import {
  DEFAULT_VIEW_NODE_SETTINGS,
  isAppOrigin,
  isGuardedScheme,
  normalizeViewNodeSettings,
  parseSchemes,
  webBlockReason,
  webUrlAllowed,
} from "../../../src/mehrpele/views/settings";
import { embedBoxSize } from "../../../src/mehrpele/embeds";
import { normalizeMehrpeleSettings } from "../../../src/mehrpele/settings";
import { readFileSync } from "node:fs";

const e = (id: string, o: Partial<PoolEntry> = {}): PoolEntry => ({ id, near: false, lastNear: 0, live: false, ...o });
const policy = { cap: 2, keepAliveMs: 1000 };

describe("live-view pool", () => {
  test("mounts near entries up to the cap; the rest wait", () => {
    const plan = planPool([e("a", { near: true, lastNear: 3 }), e("b", { near: true, lastNear: 2 }), e("c", { near: true, lastNear: 1 })], policy, 10);
    expect(plan).toEqual({ mount: ["a", "b"], unmount: [], deferred: ["c"] });
  });

  test("pinned (lightbox, panel) and user-activated entries claim slots first", () => {
    const plan = planPool(
      [e("a", { near: true, lastNear: 9, live: true }), e("b", { near: true, lastNear: 8, live: true }), e("p", { pinned: true }), e("c", { near: true, activated: 5 })],
      policy,
      10,
    );
    expect(plan.mount.sort()).toEqual(["c", "p"]);
    expect(plan.unmount.sort()).toEqual(["a", "b"]);
    expect(plan.deferred.sort()).toEqual(["a", "b"]);
  });

  test("off-screen live views stay warm while room remains, then release", () => {
    const warm = [e("a", { live: true, lastNear: 500 }), e("b", { near: true, lastNear: 900 })];
    expect(planPool(warm, policy, 1000)).toEqual({ mount: ["b"], unmount: [], deferred: [] });
    expect(planPool(warm, policy, 1600)).toEqual({ mount: ["b"], unmount: ["a"], deferred: [] });
    // No room: the warm one gives way to a near one at once.
    const full = [e("a", { live: true, lastNear: 900 }), e("b", { near: true }), e("c", { near: true })];
    expect(planPool(full, policy, 1000).unmount).toEqual(["a"]);
    expect(nextExpiry(warm, policy, 1000)).toBe(1500);
    expect(nextExpiry([e("x", { near: true, live: true })], policy, 0)).toBeNull();
  });

  test("adoption: a re-rendered slot takes its dock back; placed twins get their own", () => {
    const docks: Record<string, "free" | "same" | "other" | "none"> = { k: "other", "k#2": "free" };
    expect(adoptionKey("k", (key) => docks[key] ?? "none")).toBe("k#2");
    expect(adoptionKey("k", () => "free")).toBe("k");
    expect(adoptionKey("k", () => "same")).toBe("k");
    expect(adoptionKey("k", (key) => (key === "k" || key === "k#2" ? "other" : "none"))).toBe("k#3");
  });

    test("cap 0 mounts nothing; deterministic order", () => {
    expect(planPool([e("a", { near: true })], { cap: 0, keepAliveMs: 0 }, 0)).toEqual({ mount: [], unmount: [], deferred: ["a"] });
    const es = [e("b", { near: true }), e("a", { near: true })];
    expect(planPool(es, { cap: 1, keepAliveMs: 0 }, 0).mount).toEqual(["a"]);
  });
});

describe("view-node settings", () => {
  test("defaults and normalisation", () => {
    expect(normalizeViewNodeSettings(undefined)).toEqual(DEFAULT_VIEW_NODE_SETTINGS);
    const n = normalizeViewNodeSettings({ maxLiveViews: 99, defaultLocalGraphDepth: 0, allowedSchemes: ["HTTPS:", "obsidian", "file", "ftp"], webEnabled: false });
    expect(n.maxLiveViews).toBe(32);
    expect(n.defaultLocalGraphDepth).toBe(1);
    expect(n.allowedSchemes).toEqual(["https", "ftp"]);
    expect(n.webEnabled).toBe(false);
    expect(normalizeViewNodeSettings({ allowedSchemes: ["obsidian"] }).allowedSchemes).toEqual(["https", "http"]);
    expect(normalizeMehrpeleSettings({}).viewNodes).toEqual(DEFAULT_VIEW_NODE_SETTINGS);
  });

  test("URL scheme guard: http(s) only by default, obsidian:/file: never", () => {
    const s = { allowedSchemes: ["https", "http"] };
    expect(webUrlAllowed("https://example.com", s)).toBe(true);
    expect(webUrlAllowed("obsidian://advanced-uri?commandid=x", s)).toBe(false);
    expect(webUrlAllowed("file:///etc/hosts", s)).toBe(false);
    expect(webUrlAllowed("javascript:alert(1)", s)).toBe(false);
    expect(webUrlAllowed("ftp://x.org", s)).toBe(false);
    expect(webUrlAllowed("obsidian://open", { allowedSchemes: ["obsidian"] })).toBe(false);
    expect(webUrlAllowed("not a url", s)).toBe(false);
    expect(parseSchemes("https, http://, data, a b")).toEqual(["https", "http", "a", "b"]);
  });

  test("open actions and loads share one gate; sub-frames and the app origin are guarded", () => {
    const on = { webEnabled: true, allowedSchemes: ["https", "http"] };
    expect(webBlockReason("https://e.org", on)).toBeNull();
    expect(webBlockReason("file:///Applications/Calculator.app", on)).toBe("Blocked URL scheme: file:");
    expect(webBlockReason("obsidian://advanced-uri?commandid=x", on)).toBe("Blocked URL scheme: obsidian:");
    expect(webBlockReason("https://e.org", { ...on, webEnabled: false })).toContain("off");
    for (const u of ["obsidian://open", "file:///x", "app://obsidian.md/x", "javascript:alert(1)", "chrome://gpu"]) expect(isGuardedScheme(u)).toBe(true);
    for (const u of ["https://e.org/f", "about:blank", "data:text/html,x", "blob:https://e.org/1"]) expect(isGuardedScheme(u)).toBe(false);
    expect(isAppOrigin("http://localhost/index.html", "http://localhost")).toBe(true);
    expect(isAppOrigin("http://localhost:3000/", "http://localhost")).toBe(false);
    expect(isAppOrigin("https://e.org", "app://obsidian.md")).toBe(false);
  });

  test("embed box size reads the last alias segment (the one resizes write)", () => {
    const st = normalizeMehrpeleSettings({});
    expect(embedBoxSize({ linkpath: "https://e.org", subpath: "", aliasOrSize: "Wiki|420x300" }, st)).toEqual({ width: 420, height: 300 });
    expect(embedBoxSize({ linkpath: "Note", subpath: "", aliasOrSize: "alias|400x200" }, st)).toEqual({ width: 400, height: 200 });
    expect(embedBoxSize({ linkpath: "Note", subpath: "", aliasOrSize: "alias" }, st)).toEqual({ width: 320, height: 240 });
  });

    test("styles.css carries views.css verbatim", () => {
    const root = new URL("../../../", import.meta.url).pathname;
    const css = readFileSync(`${root}src/mehrpele/views/views.css`, "utf8");
    expect(readFileSync(`${root}styles.css`, "utf8")).toContain(css);
    expect(readFileSync(`${root}styles.css`, "utf8")).toContain(readFileSync(`${root}src/edit/embed-insert/embed-insert.css`, "utf8"));
  });
});
