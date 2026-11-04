// Exercises the Excalidraw converter (feature "excalidraw") against a minimal
// stand-in for the "obsidian" module (the real package ships types only).
import "../helpers/dom-globals";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const notices: string[] = [];
class FakeEl {
  value = "";
  classList = { contains: (c: string) => c === "theme-light" }; // a light-theme body
  createEl(): FakeEl { return new FakeEl(); }
  createDiv(): FakeEl { return new FakeEl(); }
  createSpan(): FakeEl { return new FakeEl(); }
  setText(): void {}
  empty(): void {}
  remove(): void {}
  addEventListener(): void {}
}
class TFile { constructor(public path: string, public basename = path) {} }

mock.module("obsidian", () => ({
  App: class {},
  Editor: class {},
  MarkdownView: class {},
  Notice: class { constructor(msg: string) { notices.push(msg); } },
  TFile,
  Modal: class {
    titleEl = new FakeEl();
    contentEl = new FakeEl();
    constructor(public app: unknown) {}
    open(): void { (this as unknown as { onOpen(): void }).onOpen(); }
    close(): void { (this as unknown as { onClose?(): void }).onClose?.(); }
  },
  Setting: class {
    constructor(_el: unknown) {}
    addButton(cb: (b: unknown) => void) {
      const b = { setButtonText: () => b, setCta: () => b, onClick: () => b };
      cb(b);
      return this;
    }
  },
}));

const g = globalThis as Record<string, unknown>;
g.document = { body: new FakeEl() };
g.getComputedStyle = () => ({ getPropertyValue: () => "" });

type Mod = typeof import("../../src/excalidraw/converter");
let M: Mod;
beforeAll(async () => { M = await import("../../src/excalidraw/converter"); });
beforeEach(() => { notices.length = 0; });

function fakeApp(files: Record<string, string> = {}) {
  const created: string[] = [];
  const trashed: string[] = [];
  const opened: string[] = [];
  const store = new Map(Object.entries(files).map(([p, c]) => [p, { file: new TFile(p), content: c }]));
  const ea = {
    verifyMinimumPluginVersion: () => true,
    create: async (o: { exactPath: string }) => { created.push(o.exactPath); store.set(o.exactPath, { file: new TFile(o.exactPath), content: "" }); return o.exactPath; },
    addElementsToView: async () => true,
    elementsDict: {}, imagesDict: {}, clear() {},
  };
  g.ExcalidrawAutomate = { getAPI: () => ea };
  const app = {
    plugins: { manifests: { "obsidian-excalidraw-plugin": {} }, plugins: { "obsidian-excalidraw-plugin": {} } },
    vault: {
      getAbstractFileByPath: (p: string) => store.get(p)?.file ?? null,
      cachedRead: async (f: TFile) => store.get(f.path)?.content ?? "",
    },
    fileManager: { trashFile: async (f: TFile) => { trashed.push(f.path); store.delete(f.path); } },
    workspace: { getActiveFile: () => null, getLeaf: () => ({ openFile: async (f: TFile) => { opened.push(f.path); } }) },
  };
  return { app, created, trashed, opened };
}

const converter = (app: unknown, opts?: () => { palette: Record<string, string>; scale: number }) =>
  new M.ExcalidrawConverter(app as never, opts);

describe("conversion errors", () => {
  test("non-diagram source resolves with a Notice instead of rejecting", async () => {
    const { app } = fakeApp();
    const c = converter(app);
    const ins = await c.insertIntoView("just some clipboard prose, not a diagram");
    expect(ins.ok).toBe(false);
    expect(ins.error).toContain("not a valid Pele diagram");
    const cd = await c.createDrawing("still not a diagram");
    expect(cd.ok).toBe(false);
    expect(notices.length).toBe(2);
    expect(notices.every((n) => n.startsWith("Pele: Excalidraw: ") && n.includes("not a valid Pele diagram"))).toBe(true);
  });
  test("promptAndInsert with non-diagram clipboard text shows one Notice and settles", async () => {
    const { app } = fakeApp();
    g.navigator = { clipboard: { readText: async () => "hello there" } };
    await expect(converter(app).promptAndInsert()).resolves.toBeUndefined();
    expect(notices).toHaveLength(1);
  });
  test("missing Excalidraw is reported, nothing is created", async () => {
    const { app, created } = fakeApp();
    (app as { plugins: unknown }).plugins = { manifests: {}, plugins: {} };
    const r = await converter(app).createDrawing("flowchart LR\n  A-->B");
    expect(r.ok).toBe(false);
    expect(created).toHaveLength(0);
  });
});

describe("stored options", () => {
  test("stored scale and palette overrides are read on every conversion", () => {
    const { app } = fakeApp();
    let scale = 1;
    const c = converter(app, () => ({ palette: {}, scale }));
    const width = (r: ReturnType<typeof c.convert>) => Math.max(...r.elements.map((e) => Number((e as { width?: number }).width ?? 0)));
    const one = width(c.convert("flowchart LR\n  A-->B"));
    scale = 2;
    const two = width(c.convert("flowchart LR\n  A-->B"));
    expect(two).toBeGreaterThan(one);
  });
});

describe("palette probe (dark-on-dark labels)", () => {
  const LIGHT: Record<string, string> = { "--pele-surface": "#f6f6f6", "--pele-border": "#e0e0e0", "--pele-fg": "#222222" };
  const DARK: Record<string, string> = { "--pele-surface": "#262626", "--pele-border": "#363636", "--pele-fg": "#dadada" };
  // Stand-in DOM. As with Obsidian's `body{}` rules, colours resolve from the nearest `body` element's theme class.
  class El {
    children: El[] = [];
    constructor(public tag: string, public className = "", public parent: El | null = null, public attrs: Record<string, string> = {}) {}
    classList = { contains: (c: string) => this.className.split(/\s+/).includes(c) };
    createDiv(o?: { cls?: string }): El { return this.createEl("div", o); }
    createEl(tag: string, o?: { cls?: string; attr?: Record<string, string> }): El {
      const e = new El(tag, o?.cls ?? "", this, o?.attr ?? {});
      this.children.push(e);
      return e;
    }
    remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
    getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  }
  const saved = { document: g.document, getComputedStyle: g.getComputedStyle };
  let probedBody: El | null = null;
  function themedDom(theme: "light" | "dark") {
    const html = new El("html");
    const body = html.createEl("body", { cls: `theme-${theme} mod-macos minimal-tonal my-theme-dark-x`, attr: { style: "--accent-h: 200;" } });
    g.document = { documentElement: html, body };
    g.getComputedStyle = (el: El) => {
      let b: El | null = el;
      while (b && b.tag !== "body") b = b.parent;
      probedBody = b;
      const vars = b?.classList.contains("theme-light") ? LIGHT : DARK;
      return { getPropertyValue: (n: string) => vars[n] ?? "" };
    };
    return { html, body };
  }
  afterEach(() => { g.document = saved.document; g.getComputedStyle = saved.getComputedStyle; probedBody = null; });

  const nodeA = (theme: "light" | "dark") => {
    const dom = themedDom(theme);
    const r = converter(fakeApp().app).convert("flowchart LR\n  A-->B");
    return { a: r.elements.find((e) => e.id === "node_A")!, ...dom };
  };

  test("a dark theme converts with the light palette, which Excalidraw inverts for its dark mode", () => {
    const { a, html, body } = nodeA("dark");
    expect(a.backgroundColor).toBe(LIGHT["--pele-surface"]);
    expect(a.strokeColor).toBe(LIGHT["--pele-border"]);
    expect(a.label?.strokeColor).toBe(LIGHT["--pele-fg"]);
    // the stand-in light body keeps the real body's classes and inline variables, and is removed again
    expect(probedBody).not.toBe(body);
    // only the exact `theme-dark` class is swapped; a class that merely contains it stays intact
    expect(probedBody!.className.split(/\s+/).sort()).toEqual(["minimal-tonal", "mod-macos", "my-theme-dark-x", "theme-light"]);
    expect(probedBody!.getAttribute("style")).toContain("--accent-h: 200;");
    expect(html.children).toEqual([body]);
    expect(body.children).toEqual([]);
  });

  test("a light theme probes inside the real body, as before", () => {
    const { a, body } = nodeA("light");
    expect(probedBody).toBe(body);
    expect(a.backgroundColor).toBe(LIGHT["--pele-surface"]);
    expect(a.label?.strokeColor).toBe(LIGHT["--pele-fg"]);
    expect(body.children).toEqual([]);
  });
});

describe("drawing name (diagram menu inside an embed)", () => {
  const EMBEDDED = "intro\n```mermaid\nflowchart LR\n  X-->Y\n```\n\n```mermaid\nflowchart LR\n  A-->B\n```\n";
  const withActive = (files: Record<string, string>, active: string) => {
    const fx = fakeApp(files);
    fx.app.workspace.getActiveFile = (() => new TFile(active)) as never;
    return fx;
  };

  test("names the drawing after the diagram's source file and block, not the active note", async () => {
    const fx = withActive({ "Notes/Embedded.md": EMBEDDED }, "Host.md");
    const r = await converter(fx.app).createDrawing("flowchart LR\n  A-->B", { sourcePath: "Notes/Embedded.md", open: false });
    expect(r.out).toBe("Notes/Embedded-diagram-1.excalidraw.md");
    expect(fx.created).toEqual(["Notes/Embedded-diagram-1.excalidraw.md"]);
  });

  // The menu passes the source as Obsidian hands it to the block processor: quote markers and list indent removed.
  const NESTED = [
    "```mermaid", "flowchart LR", "  T-->U", "```",
    "> [!note] In a callout", "> ```mermaid", "> flowchart LR", ">   Q-->R", "> ```",
    "- a list item", "  ```mermaid", "  flowchart LR", "    L-->M", "  ```",
    "- outer", "  - inner", "    ```mermaid", "    flowchart LR", "      N-->O", "    ```",
    "> - quoted item", ">   ```mermaid", ">   flowchart LR", ">     P-->S", ">   ```",
    "",
  ].join("\n");
  test.each([
    ["a callout", "flowchart LR\n  Q-->R", "Notes/Nested-diagram-1.excalidraw.md"],
    ["a list item", "flowchart LR\n  L-->M", "Notes/Nested-diagram-2.excalidraw.md"],
    ["a nested list item (4+ space indent)", "flowchart LR\n  N-->O", "Notes/Nested-diagram-3.excalidraw.md"],
    ["a list item inside a callout", "flowchart LR\n  P-->S", "Notes/Nested-diagram-4.excalidraw.md"],
    ["a top-level fence (unchanged)", "flowchart LR\n  T-->U", "Notes/Nested-diagram.excalidraw.md"],
  ])("a diagram in %s is named after its own position in the file", async (_where, source, out) => {
    const fx = withActive({ "Notes/Nested.md": NESTED }, "Host.md");
    const r = await converter(fx.app).createDrawing(source, { sourcePath: "Notes/Nested.md", open: false });
    expect(r.out).toBe(out);
  });

  test("a canvas source drops its extension; an unknown block counts as the first", async () => {
    const fx = withActive({ "Boards/Plan.canvas": "{}" }, "Host.md");
    const r = await converter(fx.app).createDrawing("flowchart LR\n  A-->B", { sourcePath: "Boards/Plan.canvas", open: false });
    expect(r.out).toBe("Boards/Plan-diagram.excalidraw.md");
  });

  test("pele:excalidraw without out= names the drawing after path= and index=, not the active note", async () => {
    const fx = withActive({ "Notes/Embedded.md": EMBEDDED }, "Daily.md");
    const res = JSON.parse(await converter(fx.app).cliConvert({ path: "Notes/Embedded.md", index: "1" }));
    expect(res.out).toBe("Notes/Embedded-diagram-1.excalidraw.md");
    expect(fx.created).toEqual(["Notes/Embedded-diagram-1.excalidraw.md"]);
  });

  test("the EA path opens the new drawing unless open is false (ea.create runs silent)", async () => {
    const fx = withActive({}, "Host.md");
    const r = await converter(fx.app).createDrawing("flowchart LR\n  A-->B", { open: true });
    expect(fx.opened).toEqual([r.out!]);
    const quiet = withActive({}, "Host.md");
    await converter(quiet.app).createDrawing("flowchart LR\n  A-->B", { open: false });
    expect(quiet.opened).toEqual([]);
  });

  test("without a source path the active note still names it", async () => {
    const fx = withActive({}, "Host.md");
    const r = await converter(fx.app).createDrawing("flowchart LR\n  A-->B", { open: false });
    expect(r.out).toBe("Host-diagram.excalidraw.md");
  });
});

describe("SourcePromptModal", () => {
  test("closing without submitting (Esc) resolves null", async () => {
    const modal = new M.SourcePromptModal({} as never);
    const pending = modal.prompt();
    modal.close(); // what Obsidian does on Esc / the X button
    expect(await pending).toBeNull();
  });
});

describe("pele:excalidraw out= handling", () => {
  const NOTE = "```mermaid\nflowchart LR\n  A-->B\n```\n```pele\nflowchart LR\n  C-->D\n```\n";
  const run = async (params: Record<string, string>, files: Record<string, string> = {}) => {
    const fx = fakeApp({ "Note.md": NOTE, ...files });
    const out = JSON.parse(await converter(fx.app).cliConvert({ path: "Note.md", ...params }));
    return { out, ...fx };
  };
  test("rejects bad extensions, absolute paths and '..'", async () => {
    for (const bad of ["x.md", "x.json", "/abs/x.excalidraw.md", "C:\\x.excalidraw", "../x.excalidraw.md", "a/../../x.excalidraw", ""]) {
      const { out, created } = await run({ out: bad });
      expect(out.ok, bad).toBe(false);
      expect(created, bad).toHaveLength(0);
    }
  });
  test("accepts .excalidraw.md and .excalidraw", async () => {
    for (const good of ["Dir/x.excalidraw.md", "x.excalidraw"]) {
      const { out, created } = await run({ out: good });
      expect(out.ok, good).toBe(true);
      expect(created).toEqual([good]);
    }
  });
  test("refuses to overwrite an existing file unless force", async () => {
    const refused = await run({ out: "x.excalidraw.md" }, { "x.excalidraw.md": "old" });
    expect(refused.out.ok).toBe(false);
    expect(refused.out.error).toContain("already exists");
    expect(refused.trashed).toHaveLength(0);
    expect(refused.created).toHaveLength(0);
    const forced = await run({ out: "x.excalidraw.md", force: "true" }, { "x.excalidraw.md": "old" });
    expect(forced.out.ok).toBe(true);
    expect(forced.trashed).toEqual(["x.excalidraw.md"]);
    expect(forced.created).toEqual(["x.excalidraw.md"]);
    // A bare `force` flag (Obsidian passes "") counts too, as in the other pele: handlers.
    const bare = await run({ out: "x.excalidraw.md", force: "" }, { "x.excalidraw.md": "old" });
    expect(bare.out.ok).toBe(true);
    expect(bare.trashed).toEqual(["x.excalidraw.md"]);
  });
  test("index is strict and counts mermaid/pele fences in document order", async () => {
    expect((await run({ index: "abc" })).out.ok).toBe(false);
    expect((await run({ index: "2" })).out.ok).toBe(false);
    expect((await run({ index: "1", out: "one.excalidraw.md" })).out.ok).toBe(true);
  });
});
