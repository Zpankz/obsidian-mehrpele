/**
 * Obsidian CLI glue (src/cli/handlers.ts): which pele:* handlers register and
 * with what flags, the help text, the "feature off" gate, and the vault
 * helpers cliResolveFile / cliWriteFile against a small Obsidian-shaped vault.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { obsidianStub } from "./helpers/obsidian-stub";

mock.module("obsidian", () => obsidianStub);
// The canvas picker (FuzzySuggestModal) and repair providers (requestUrl) need obsidian
// exports that an earlier file's mock may have linked without; these paths are not under test.
mock.module("../src/canvas/convert-ui", () => ({ convertCanvasFile: async () => null }));
mock.module("../src/repair/host", () => ({ buildJevProvider: () => undefined, buildLlmProvider: () => undefined }));

const { CLI_OFF, cliResolveFile, cliWriteFile, registerCliCommands } = await import("../src/cli/handlers");

type Flags = Record<string, { value?: string; description: string }> | null;
type Handler = (p: Record<string, string>) => Promise<string>;

const TFile = obsidianStub.TFile as new () => object;
const TFolder = obsidianStub.TFolder as new () => object;

/** In-memory vault with the subset of Vault/MetadataCache the CLI glue uses. */
class FakeVault {
  files = new Map<string, string | ArrayBuffer>();
  folders = new Set<string>();
  calls: string[] = [];

  file(path: string): object {
    const name = path.split("/").pop()!;
    const dot = name.lastIndexOf(".");
    return Object.assign(new TFile(), {
      path,
      name,
      basename: dot > 0 ? name.slice(0, dot) : name,
      extension: dot > 0 ? name.slice(dot + 1) : "",
      parent: { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" },
    });
  }
  getAbstractFileByPath(path: string): object | null {
    if (this.files.has(path)) return this.file(path);
    if (this.folders.has(path)) return Object.assign(new TFolder(), { path });
    return null;
  }
  getFiles(): object[] {
    return [...this.files.keys()].map((p) => this.file(p));
  }
  async cachedRead(f: { path: string }): Promise<string> {
    return String(this.files.get(f.path));
  }
  async create(path: string, data: string): Promise<void> {
    this.calls.push(`create ${path}`);
    this.files.set(path, data);
  }
  async createBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.calls.push(`createBinary ${path}`);
    this.files.set(path, data);
  }
  async modify(f: { path: string }, data: string): Promise<void> {
    this.calls.push(`modify ${f.path}`);
    this.files.set(f.path, data);
  }
  async modifyBinary(f: { path: string }, data: ArrayBuffer): Promise<void> {
    this.calls.push(`modifyBinary ${f.path}`);
    this.files.set(f.path, data);
  }
  async createFolder(path: string): Promise<void> {
    this.calls.push(`createFolder ${path}`);
    this.folders.add(path);
  }
}

function fakePlugin(opts: { standsDown?: boolean } = {}) {
  const vault = new FakeVault();
  const registered: { id: string; desc: string; flags: Flags }[] = [];
  const handlers = new Map<string, Handler>();
  const plugin = {
    app: {
      vault,
      metadataCache: {
        getFirstLinkpathDest: (name: string) =>
          vault.getFiles().find((f) => (f as { basename: string }).basename === name) ?? null,
      },
    },
    settings: { features: { cli: { enabled: true } } },
    isMehrpeleBlock: (lang: string) => lang === "mehrpele",
    excalidrawStandsDown: () => opts.standsDown ?? false,
    registerCliHandler(id: string, desc: string, flags: Flags, h: Handler) {
      registered.push({ id, desc, flags });
      handlers.set(id, h);
    },
  };
  return { plugin, vault, registered, handlers };
}

// The plugin type is the real PeleMermaidPlugin; the fake covers what these paths touch.
const asPlugin = (p: unknown) => p as Parameters<typeof registerCliCommands>[0];

describe("registerCliCommands", () => {
  let env: ReturnType<typeof fakePlugin>;
  beforeEach(() => {
    env = fakePlugin();
    registerCliCommands(asPlugin(env.plugin));
  });

  test("registers every pele:* handler in order, with descriptions and flag names", () => {
    expect(env.registered.map((r) => [r.id, r.desc, r.flags ? Object.keys(r.flags) : null])).toEqual([
      ["pele", "Pele diagram tools (see: help pele)", null],
      ["pele:types", "List supported diagram types", ["format"]],
      ["pele:check", "Validate mermaid/pele diagrams in a note or folder", ["path", "file", "folder", "format", "strict", "out", "force"]],
      ["pele:render", "Render a diagram to SVG/PNG", ["path", "file", "index", "out", "format", "theme", "force"]],
      ["pele:export", "Export every diagram in a note to a folder", ["path", "file", "folder", "format", "theme", "force"]],
      ["pele:repair", "Repair broken diagrams (uses configured providers)", ["path", "file", "index", "tiers", "write", "format"]],
      ["pele:canvas", "Convert a diagram to a .canvas file", ["path", "file", "index", "out", "advanced", "force"]],
      ["pele:from-canvas", "Convert a .canvas file to a diagram block", ["path", "lang", "mehrpele", "portals", "portal-depth", "layout", "scale"]],
      ["pele:materialise", "Materialise a diagram as notes (JSON; dry-run supported)", expect.any(Array)],
      ["pele:excalidraw", "Convert a diagram in a note to an Excalidraw drawing", ["path", "index", "out", "force", "format"]],
    ]);
  });

  test("help lists every command, aligned in two columns", async () => {
    expect(await env.handlers.get("pele")!({})).toBe(
      [
        "pele:types     List supported diagram types",
        "pele:check     Validate diagrams in a note or folder",
        "pele:render    Render a diagram to SVG/PNG",
        "pele:export    Export every diagram in a note to a folder",
        "pele:repair    Repair broken diagrams (dry-run unless write)",
        "pele:canvas    Convert a diagram to a .canvas file",
        "pele:from-canvas  Convert a .canvas file to a diagram block",
        "pele:materialise  Turn a diagram into notes (JSON; dry-run)",
        "pele:excalidraw   Convert a diagram to an Excalidraw drawing",
      ].join("\n"),
    );
  });

  test("pele:excalidraw is left to the retired plugin while it stands down; help still lists it", async () => {
    const down = fakePlugin({ standsDown: true });
    registerCliCommands(asPlugin(down.plugin));
    expect(down.handlers.has("pele:excalidraw")).toBe(false);
    expect(await down.handlers.get("pele")!({})).toContain("pele:excalidraw   Convert");
  });

  test("handlers answer CLI_OFF while the CLI feature is off", async () => {
    env.plugin.settings.features.cli.enabled = false;
    expect(await env.handlers.get("pele:types")!({})).toBe(CLI_OFF);
  });

  test("pele:types prints text or JSON", async () => {
    const text = await env.handlers.get("pele:types")!({});
    expect(text.split("\n")[0]).toBe("flowchart");
    expect(JSON.parse(await env.handlers.get("pele:types")!({ format: "json" }))[0]).toBe("flowchart");
  });

  test("pele:check reports a note and writes the report to out=", async () => {
    env.vault.files.set("a.md", "```mermaid\nflowchart LR\n  A --> B\n```\n");
    expect(await env.handlers.get("pele:check")!({ path: "a.md" })).toBe("1/1 valid");
    expect(await env.handlers.get("pele:check")!({ path: "a.md", out: "r/report.txt" })).toBe("Wrote r/report.txt (1/1 valid)");
    expect(env.vault.files.get("r/report.txt")).toBe("1/1 valid");
    await expect(env.handlers.get("pele:check")!({ path: "a.md", out: "r/report.txt" })).rejects.toThrow(
      "pele: r/report.txt exists; pass force to overwrite",
    );
  });

  test("pele:render/export/canvas reject a note without diagrams", async () => {
    env.vault.files.set("empty.md", "# nothing\n");
    for (const id of ["pele:render", "pele:export", "pele:canvas"]) {
      await expect(env.handlers.get(id)!({ path: "empty.md" })).rejects.toThrow("pele: no mermaid/pele diagrams in empty.md");
    }
  });
});

describe("cliResolveFile", () => {
  const { plugin, vault } = fakePlugin();
  vault.files.set("notes/a.md", "x");
  vault.folders.add("notes");

  test("resolves path= and file= (linkpath)", () => {
    expect((cliResolveFile(asPlugin(plugin), { path: "notes/a.md" }) as { path: string }).path).toBe("notes/a.md");
    expect((cliResolveFile(asPlugin(plugin), { file: "a" }) as { path: string }).path).toBe("notes/a.md");
  });

  test("rejects missing files, folders and missing params", () => {
    expect(() => cliResolveFile(asPlugin(plugin), { path: "nope.md" })).toThrow('File "nope.md" not found.');
    expect(() => cliResolveFile(asPlugin(plugin), { path: "notes" })).toThrow('"notes" is a folder, not a file.');
    expect(() => cliResolveFile(asPlugin(plugin), { file: "nope" })).toThrow('File "nope" not found.');
    expect(() => cliResolveFile(asPlugin(plugin), {})).toThrow("Missing required parameter: path=<path> (or file=<name>)");
  });
});

describe("cliWriteFile", () => {
  test("creates the file and its missing parent folder", async () => {
    const { plugin, vault } = fakePlugin();
    await cliWriteFile(asPlugin(plugin), "out/x.svg", "<svg/>", false);
    expect(vault.calls).toEqual(["createFolder out", "create out/x.svg"]);
    expect(vault.files.get("out/x.svg")).toBe("<svg/>");
  });

  test("writes binary data with createBinary / modifyBinary", async () => {
    const { plugin, vault } = fakePlugin();
    const bytes = new ArrayBuffer(4);
    await cliWriteFile(asPlugin(plugin), "x.png", bytes, false);
    await cliWriteFile(asPlugin(plugin), "x.png", bytes, true);
    expect(vault.calls).toEqual(["createBinary x.png", "modifyBinary x.png"]);
  });

  test("refuses to replace an existing file unless overwrite, and never replaces a folder", async () => {
    const { plugin, vault } = fakePlugin();
    vault.files.set("x.md", "old");
    vault.folders.add("dir");
    await expect(cliWriteFile(asPlugin(plugin), "x.md", "new", false)).rejects.toThrow("pele: x.md exists; pass force to overwrite");
    await expect(cliWriteFile(asPlugin(plugin), "dir", "new", true)).rejects.toThrow("pele: dir is a folder");
    await cliWriteFile(asPlugin(plugin), "x.md", "new", true);
    expect(vault.calls).toEqual(["modify x.md"]);
    expect(vault.files.get("x.md")).toBe("new");
  });

  test("a folder created concurrently does not fail the write", async () => {
    const { plugin, vault } = fakePlugin();
    vault.createFolder = async () => {
      throw new Error("Folder already exists.");
    };
    await cliWriteFile(asPlugin(plugin), "late/x.txt", "ok", false);
    expect(vault.files.get("late/x.txt")).toBe("ok");
  });
});
