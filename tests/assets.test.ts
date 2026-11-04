import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ASSET_HOST,
  ASSET_PINS,
  AssetFetchError,
  assetUrl,
  ensureAsset,
  fetchPinned,
  installTourNotes,
  parseTourPack,
  removeTourNotes,
  requestUrlGet,
  sha256Hex,
  type AssetPin,
  type BinaryAdapter,
  type HttpGet,
  type TourVault,
} from "../src/features/assets";

const enc = new TextEncoder();

// assets.ts uses window timers, as Obsidian requires; bun has no `window`, so alias it for this file.
const g = globalThis as { window?: unknown };
const hadWindow = "window" in g;
beforeAll(() => { if (!hadWindow) g.window = globalThis; });
afterAll(() => { if (!hadWindow) delete g.window; });
const bytes = (s: string) => enc.encode(s).buffer as ArrayBuffer;
const CLIP = bytes("pretend this is a webm clip");
const CLIP_SHA = await sha256Hex(CLIP);
const PINS: Record<string, AssetPin> = {
  "clip.webm": { sha256: CLIP_SHA, bytes: CLIP.byteLength },
  "flaky.webm": { sha256: CLIP_SHA, bytes: CLIP.byteLength },
  "down.webm": { sha256: CLIP_SHA, bytes: CLIP.byteLength },
  "tampered.webm": { sha256: CLIP_SHA, bytes: CLIP.byteLength },
  "gone.webm": { sha256: CLIP_SHA, bytes: CLIP.byteLength },
};

// A loopback stub standing in for the GitHub release host: real HTTP, real sockets.
const hits = new Map<string, number>();
let server: ReturnType<typeof Bun.serve>;
let base = "";
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.set(path, (hits.get(path) ?? 0) + 1);
      const n = hits.get(path)!;
      if (path === "/0.2.0/clip.webm") return new Response(CLIP);
      if (path === "/0.2.0/flaky.webm") return n < 3 ? new Response("busy", { status: 503 }) : new Response(CLIP);
      if (path === "/0.2.0/down.webm") return new Response("bad gateway", { status: 502 });
      if (path === "/0.2.0/tampered.webm") return new Response(bytes("pretend this is a webm clix"));
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

/** HttpGet over fetch: the same contract requestUrl gives with throw:false. */
const get: HttpGet = async (url) => {
  const r = await fetch(url);
  return { status: r.status, arrayBuffer: await r.arrayBuffer() };
};
const noSleep = async () => {};
const opts = { get, version: "0.2.0", pins: PINS, sleep: noSleep };

/** A port nothing listens on: connecting is refused, like being offline. */
async function deadBase(): Promise<string> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port;
  await s.stop(true);
  return `http://127.0.0.1:${port}`;
}

function memAdapter(seed: Record<string, ArrayBuffer> = {}) {
  const files = new Map(Object.entries(seed));
  const dirs = new Set<string>();
  const writes: string[] = [];
  const adapter: BinaryAdapter = {
    exists: async (p) => files.has(p) || dirs.has(p),
    readBinary: async (p) => {
      const f = files.get(p);
      if (!f) throw new Error(`ENOENT ${p}`);
      return f;
    },
    writeBinary: async (p, d) => {
      writes.push(p);
      files.set(p, d);
    },
    mkdir: async (p) => {
      dirs.add(p);
    },
  };
  return { adapter, files, dirs, writes };
}

describe("asset urls and pins", () => {
  test("release asset url: host / version / name", () => {
    expect(assetUrl("clip.webm", "0.2.0")).toBe(`${ASSET_HOST}/0.2.0/clip.webm`);
    expect(assetUrl("clip.webm", "0.2.0", "http://127.0.0.1:1/")).toBe("http://127.0.0.1:1/0.2.0/clip.webm");
  });
  test("the host is the public repo's GitHub releases", () => {
    expect(ASSET_HOST).toBe("https://github.com/Zpankz/obsidian-mehrpele/releases/download");
  });
  test("sha256 of known bytes", async () => {
    expect(await sha256Hex(bytes("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  test("every shipped pin is a sha256 and a positive size", () => {
    for (const [name, pin] of Object.entries(ASSET_PINS)) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.bytes).toBeGreaterThan(0);
    }
  });
  test("the pins cover the tour pack and the editing-toolbar clip", () => {
    const names = Object.keys(ASSET_PINS);
    expect(names.some((n) => /^tour-\d+\.\d+\.\d+\.json$/.test(n))).toBe(true);
    for (const ext of ["webm", "mp4", "webp"]) expect(names).toContain(`editing-toolbar.${ext}`);
  });
});

describe("fetchPinned against a loopback stub", () => {
  test("ok: returns the verified bytes in one try", async () => {
    const data = await fetchPinned("clip.webm", { ...opts, base });
    expect(new Uint8Array(data)).toEqual(new Uint8Array(CLIP));
    expect(hits.get("/0.2.0/clip.webm")).toBe(1);
  });

  test("5xx: retried, succeeds on the third try", async () => {
    const data = await fetchPinned("flaky.webm", { ...opts, base });
    expect(new Uint8Array(data)).toEqual(new Uint8Array(CLIP));
    expect(hits.get("/0.2.0/flaky.webm")).toBe(3);
  });

  test("5xx every time: gives up after exactly 3 tries", async () => {
    const err = await fetchPinned("down.webm", { ...opts, base }).catch((e) => e);
    expect(err).toBeInstanceOf(AssetFetchError);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(502);
    expect(err.attempts).toBe(3);
    expect(hits.get("/0.2.0/down.webm")).toBe(3);
  });

  test("4xx: not retried", async () => {
    const err = await fetchPinned("gone.webm", { ...opts, base }).catch((e) => e);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(404);
    expect(hits.get("/0.2.0/gone.webm")).toBe(1);
  });

  test("hash mismatch: no retry, verification error", async () => {
    const err = await fetchPinned("tampered.webm", { ...opts, base }).catch((e) => e);
    expect(err).toBeInstanceOf(AssetFetchError);
    expect(err.kind).toBe("mismatch");
    expect(err.message).toBe("Download failed verification");
    expect(hits.get("/0.2.0/tampered.webm")).toBe(1);
  });

  test("offline (connection refused): 3 tries, then offline", async () => {
    let calls = 0;
    const counting: HttpGet = (url) => {
      calls++;
      return get(url);
    };
    const err = await fetchPinned("clip.webm", { ...opts, get: counting, base: await deadBase() }).catch((e) => e);
    expect(err).toBeInstanceOf(AssetFetchError);
    expect(err.kind).toBe("offline");
    expect(err.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  test("a request that never settles times out, counts as offline and is retried", async () => {
    let calls = 0;
    const hang: HttpGet = () => {
      calls++;
      return new Promise(() => {});
    };
    const err = await fetchPinned("clip.webm", { ...opts, get: hang, timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(AssetFetchError);
    expect(err.kind).toBe("offline");
    expect(err.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  test("unpinned names never touch the network", async () => {
    let calls = 0;
    const counting: HttpGet = (url) => {
      calls++;
      return get(url);
    };
    const err = await fetchPinned("unknown.webm", { ...opts, get: counting, base }).catch((e) => e);
    expect(err.kind).toBe("unpinned");
    expect(calls).toBe(0);
  });

  test("waits between tries (backoff), not after the last one", async () => {
    const waits: number[] = [];
    await fetchPinned("down.webm", { ...opts, base, sleep: async (ms) => void waits.push(ms) }).catch(() => {});
    expect(waits.length).toBe(2);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
  });
});

describe("ensureAsset: cache in the plugin folder", () => {
  const dir = ".obsidian/plugins/mehrpele";

  test("downloads, verifies and writes once", async () => {
    const { adapter, files, writes, dirs } = memAdapter();
    const r = await ensureAsset("clip.webm", { ...opts, base, adapter, dir });
    expect(r.fromCache).toBe(false);
    expect(r.path).toBe(`${dir}/assets/clip.webm`);
    expect(writes).toEqual([`${dir}/assets/clip.webm`]);
    expect(dirs.has(`${dir}/assets`)).toBe(true);
    expect(new Uint8Array(files.get(r.path)!)).toEqual(new Uint8Array(CLIP));
  });

  test("a verified cached copy is used without the network", async () => {
    const { adapter, writes } = memAdapter({ [`${dir}/assets/clip.webm`]: CLIP });
    let calls = 0;
    const r = await ensureAsset("clip.webm", { ...opts, get: async (u) => (calls++, get(u)), base, adapter, dir });
    expect(r.fromCache).toBe(true);
    expect(calls).toBe(0);
    expect(writes).toEqual([]);
  });

  test("a corrupt cached copy is fetched again and replaced", async () => {
    const { adapter, files } = memAdapter({ [`${dir}/assets/clip.webm`]: bytes("corrupt") });
    const r = await ensureAsset("clip.webm", { ...opts, base, adapter, dir });
    expect(r.fromCache).toBe(false);
    expect(new Uint8Array(files.get(r.path)!)).toEqual(new Uint8Array(CLIP));
  });

  test("hash mismatch: nothing is written", async () => {
    const { adapter, writes, files } = memAdapter();
    const err = await ensureAsset("tampered.webm", { ...opts, base, adapter, dir }).catch((e) => e);
    expect(err.kind).toBe("mismatch");
    expect(writes).toEqual([]);
    expect(files.size).toBe(0);
  });

  test("offline: nothing is written", async () => {
    const { adapter, writes } = memAdapter();
    const err = await ensureAsset("clip.webm", { ...opts, base: await deadBase(), adapter, dir }).catch((e) => e);
    expect(err.kind).toBe("offline");
    expect(writes).toEqual([]);
  });

  test("names that could leave the assets folder are refused", async () => {
    const { adapter, writes } = memAdapter();
    for (const name of ["../data.json", "a/b.webm", ".hidden", "x\\y", ""]) {
      const err = await ensureAsset(name, { ...opts, pins: { [name]: PINS["clip.webm"]! }, base, adapter, dir }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(AssetFetchError);
      expect(err.kind).toBe("unpinned");
    }
    expect(writes).toEqual([]);
  });
});

describe("requestUrlGet adapter", () => {
  test("asks requestUrl not to throw on HTTP errors and passes status + bytes", async () => {
    const seen: unknown[] = [];
    const g = requestUrlGet(async (req) => {
      seen.push(req);
      return { status: 503, arrayBuffer: CLIP };
    });
    const r = await g("https://example.invalid/x");
    expect(seen).toEqual([{ url: "https://example.invalid/x", method: "GET", throw: false }]);
    expect(r.status).toBe(503);
    expect(r.arrayBuffer).toBe(CLIP);
  });
});

function memVault(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const folders = new Set<string>();
  const trashed: string[] = [];
  const vault: TourVault = {
    getAbstractFileByPath: (p) => (files.has(p) ? { path: p, kind: "file" } : folders.has(p) ? { path: p } : null),
    getFiles: () => [...files.keys()].map((p) => ({ path: p, kind: "file" })),
    createFolder: async (p) => {
      if (folders.has(p) || files.has(p)) throw new Error("Folder already exists.");
      folders.add(p);
    },
    create: async (p, data) => {
      if (files.has(p)) throw new Error("File already exists.");
      files.set(p, data);
    },
    read: async (f) => files.get((f as { path: string }).path)!,
    trash: async (f) => {
      const p = (f as { path: string }).path;
      trashed.push(p);
      files.delete(p);
    },
  };
  return { vault, files, folders, trashed };
}

const PACK = {
  version: "0.2.0",
  notes: [
    { path: "00 Intro.md", content: "# Start" },
    { path: "07 Tour notes.base", content: "views: []" },
  ],
};
const packBytes = (p: unknown) => bytes(JSON.stringify(p));

describe("tour pack", () => {
  test("parses a valid pack", () => {
    expect(parseTourPack(packBytes(PACK))).toEqual(PACK);
  });
  test("rejects paths that escape the tour folder or are not notes", () => {
    for (const path of ["../x.md", "/abs.md", "a/../../x.md", "x.js", "a\\b.md", ".obsidian/app.json", "./x.md"]) {
      expect(() => parseTourPack(packBytes({ version: "0.2.0", notes: [{ path, content: "" }] }))).toThrow();
    }
  });
  test("rejects malformed json and shapes", () => {
    expect(() => parseTourPack(bytes("{"))).toThrow();
    expect(() => parseTourPack(packBytes({ version: 1, notes: [] }))).toThrow();
    expect(() => parseTourPack(packBytes({ version: "0.2.0", notes: [{ path: "a.md" }] }))).toThrow();
  });

  test("install creates the folder and every note", async () => {
    const { vault, files, folders } = memVault();
    const r = await installTourNotes(vault, PACK);
    expect(folders.has("Mehrpele tour")).toBe(true);
    expect(r.created).toEqual(["Mehrpele tour/00 Intro.md", "Mehrpele tour/07 Tour notes.base"]);
    expect(files.get("Mehrpele tour/00 Intro.md")).toBe("# Start");
  });

  test("install never overwrites: existing names get a (2) suffix", async () => {
    const { vault, files } = memVault({ "Mehrpele tour/00 Intro.md": "my edits" });
    const r = await installTourNotes(vault, PACK);
    expect(files.get("Mehrpele tour/00 Intro.md")).toBe("my edits");
    expect(r.created[0]).toBe("Mehrpele tour/00 Intro (2).md");
    expect(files.get("Mehrpele tour/00 Intro (2).md")).toBe("# Start");
    const again = await installTourNotes(vault, PACK);
    expect(again.created[0]).toBe("Mehrpele tour/00 Intro (3).md");
  });

  test("remove trashes only notes that are unchanged from the pack", async () => {
    const { vault, files, trashed } = memVault();
    await installTourNotes(vault, PACK);
    files.set("Mehrpele tour/00 Intro.md", "# Start\n\nmy notes");
    const r = await removeTourNotes(vault, PACK);
    expect(trashed).toEqual(["Mehrpele tour/07 Tour notes.base"]);
    expect(r.kept).toEqual(["Mehrpele tour/00 Intro.md"]);
    expect(files.has("Mehrpele tour/00 Intro.md")).toBe(true);
  });

  test("remove also trashes unchanged (2) copies from a repeat install", async () => {
    const { vault, files } = memVault();
    await installTourNotes(vault, PACK);
    await installTourNotes(vault, PACK);
    expect(files.has("Mehrpele tour/00 Intro (2).md")).toBe(true);
    const r = await removeTourNotes(vault, PACK);
    expect(r.removed.sort()).toEqual([
      "Mehrpele tour/00 Intro (2).md",
      "Mehrpele tour/00 Intro.md",
      "Mehrpele tour/07 Tour notes (2).base",
      "Mehrpele tour/07 Tour notes.base",
    ]);
    expect([...files.keys()].filter((p) => p.startsWith("Mehrpele tour/"))).toEqual([]);
  });

  test("remove finds numbered copies past a gap, and keeps edited or unrelated files", async () => {
    const { vault, files } = memVault();
    for (let i = 0; i < 4; i++) await installTourNotes(vault, PACK);
    files.delete("Mehrpele tour/00 Intro.md");
    files.delete("Mehrpele tour/00 Intro (3).md");
    files.set("Mehrpele tour/00 Intro (4).md", "my edits");
    files.set("Mehrpele tour/00 Intro (x).md", "# Start");
    files.set("Mehrpele tour/sub/00 Intro (5).md", "# Start");
    const r = await removeTourNotes(vault, PACK);
    expect(r.removed.filter((p) => p.includes("Intro")).sort()).toEqual(["Mehrpele tour/00 Intro (2).md"]);
    expect(r.kept).toEqual(["Mehrpele tour/00 Intro (4).md"]);
    expect([...files.keys()].sort()).toEqual([
      "Mehrpele tour/00 Intro (4).md",
      "Mehrpele tour/00 Intro (x).md",
      "Mehrpele tour/sub/00 Intro (5).md",
    ]);
  });
});
