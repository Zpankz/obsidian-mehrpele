/** In-memory vault implementing the planner's VaultView and apply's VaultOps (case-insensitive paths). */
import type { VaultOps } from "../../src/materialise/apply";
import type { VaultView } from "../../src/materialise/plan";

export interface FakeNote {
  frontmatter: Record<string, unknown> | null;
  body: string;
}

function parseNote(content: string): FakeNote {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!m) return { frontmatter: null, body: content };
  return { frontmatter: (Bun.YAML.parse(m[1]!) as Record<string, unknown>) ?? {}, body: content.slice(m[0].length) };
}

export class FakeVault {
  files = new Map<string, FakeNote | { binary: true }>();
  folders = new Set<string>();
  trashed: string[] = [];
  log: string[] = [];

  constructor(init: Record<string, string | Record<string, unknown> | null> = {}, folders: string[] = []) {
    for (const f of folders) this.addFolder(f);
    for (const [path, v] of Object.entries(init)) {
      if (!/\.md$/i.test(path)) this.files.set(path, { binary: true });
      else if (typeof v === "string") this.files.set(path, parseNote(v));
      else this.files.set(path, { frontmatter: v ? structuredClone(v) : null, body: "" });
      this.addFolder(path.split("/").slice(0, -1).join("/"));
    }
  }

  private addFolder(path: string): void {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
  }

  private real(path: string): string | null {
    const lower = path.toLowerCase();
    for (const k of this.files.keys()) if (k.toLowerCase() === lower) return k;
    for (const k of this.folders) if (k.toLowerCase() === lower) return k;
    return null;
  }

  note(path: string): FakeNote | null {
    const r = this.real(path);
    const f = r ? this.files.get(r) : undefined;
    return f && !("binary" in f) ? f : null;
  }

  resolve: VaultView["resolve"] = (linkpath) => {
    const want = linkpath.toLowerCase();
    const paths = [...this.files.keys()];
    const exact = paths.find((p) => p.toLowerCase() === want || p.toLowerCase() === `${want}.md`);
    if (exact) return exact;
    const byName = paths.filter((p) => {
      const name = p.split("/").pop()!.toLowerCase();
      return name === want || name === `${want}.md`;
    });
    return byName[0] ?? null;
  };

  view(): VaultView {
    return {
      lookup: (path) => {
        const r = this.real(path);
        if (!r) return null;
        if (this.folders.has(r)) return { kind: "folder" };
        const f = this.files.get(r)!;
        return "binary" in f ? { kind: "file" } : { kind: "note", frontmatter: f.frontmatter ? structuredClone(f.frontmatter) : null };
      },
      resolve: this.resolve,
    };
  }

  ops(): VaultOps {
    return {
      kind: (path) => {
        const r = this.real(path);
        return !r ? null : this.folders.has(r) ? "folder" : "file";
      },
      createFolder: async (path) => {
        if (this.real(path)) throw new Error("Folder already exists.");
        this.log.push(`mkdir ${path}`);
        this.folders.add(path);
      },
      createNote: async (path, content) => {
        if (this.real(path)) throw new Error("File already exists.");
        this.log.push(`create ${path}`);
        this.files.set(path, parseNote(content));
      },
      editFrontmatter: async (path, fn) => {
        const n = this.note(path);
        if (!n) throw new Error("missing");
        const fm = structuredClone(n.frontmatter ?? {});
        fn(fm);
        n.frontmatter = fm;
        this.log.push(`fm ${path}`);
      },
      readFrontmatter: async (path) => this.note(path)?.frontmatter ?? null,
      isEmptyFolder: (path) => {
        const pre = `${path.toLowerCase()}/`;
        return ![...this.files.keys(), ...this.folders].some((p) => p.toLowerCase().startsWith(pre));
      },
      trash: async (path) => {
        const r = this.real(path)!;
        this.trashed.push(r);
        this.log.push(`trash ${r}`);
        this.files.delete(r);
        this.folders.delete(r);
      },
      resolve: this.resolve,
    };
  }

  /** Deterministic dump for equality checks. */
  snapshot(): string {
    const files = [...this.files.entries()].map(([k, v]) => [k, "binary" in v ? "binary" : v]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return JSON.stringify({ files, folders: [...this.folders].sort() });
  }
}
