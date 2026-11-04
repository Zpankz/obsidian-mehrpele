/**
 * Execute a materialise plan, and undo it, through a small vault port, so
 * the safety rules are unit-tested without Obsidian (obsidian.ts implements
 * the port with vault.create / createFolder / processFrontMatter / trashFile).
 *
 * Safety: nothing that existed before is ever overwritten or trashed — a
 * file is only recorded as created after the port created it; undo trashes
 * only recorded files that still carry this run's provenance, only empty
 * recorded folders, and restores a property only while it still holds the
 * value this run wrote.
 */
import { mergeLinks, NODE_KEY, PROVENANCE_KEY, scalarText, type MaterialisePlan, type VaultView } from "./planner";

export interface VaultOps {
  kind(path: string): "file" | "folder" | null;
  createFolder(path: string): Promise<void>;
  /** Must fail when a file exists at `path` (never overwrite). */
  createNote(path: string, content: string): Promise<void>;
  /** Atomic frontmatter edit (Obsidian: fileManager.processFrontMatter). */
  editFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void>;
  readFrontmatter(path: string): Promise<Record<string, unknown> | null>;
  /** Folder with no children. */
  isEmptyFolder(path: string): boolean;
  trash(path: string): Promise<void>;
  resolve: VaultView["resolve"];
}

export interface PropertyRecord {
  path: string;
  key: string;
  had: boolean;
  before: unknown;
  after: unknown;
}

export interface MaterialiseRecord {
  notePath: string;
  provenance: string;
  createdFolders: string[];
  createdFiles: string[];
  /** Created file → node id (provenance check on undo). */
  nodeOf: Record<string, string>;
  properties: PropertyRecord[];
  errors: string[];
}

export interface UndoReport {
  trashedFiles: string[];
  trashedFolders: string[];
  restoredProperties: number;
  kept: string[];
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Create folders and notes, then write properties. The block rewrite is the caller's (last) step. */
export async function applyPlan(plan: MaterialisePlan, ops: VaultOps): Promise<MaterialiseRecord> {
  const rec: MaterialiseRecord = {
    notePath: plan.notePath,
    provenance: plan.provenance,
    createdFolders: [],
    createdFiles: [],
    nodeOf: {},
    properties: [],
    errors: [],
  };
  const failedFolders = new Set<string>();
  for (const f of plan.folders) {
    if (f.status !== "create") continue;
    const k = ops.kind(f.path);
    if (k === "folder") continue; // appeared meanwhile: not ours
    if (k === "file") {
      rec.errors.push(`${f.path}: a file is in the way; its notes were not created`);
      failedFolders.add(f.path);
      continue;
    }
    try {
      await ops.createFolder(f.path);
      rec.createdFolders.push(f.path);
    } catch (e) {
      rec.errors.push(`${f.path}: ${e instanceof Error ? e.message : String(e)}`);
      failedFolders.add(f.path);
    }
  }
  const inFailed = (path: string) => [...failedFolders].some((f) => path.startsWith(`${f}/`));
  for (const n of plan.notes) {
    if (n.action !== "create" || n.content === undefined) continue;
    if (inFailed(n.path)) continue;
    if (ops.kind(n.path)) {
      rec.errors.push(`${n.path}: appeared after the preview; not overwritten`);
      continue;
    }
    try {
      await ops.createNote(n.path, n.content);
      rec.createdFiles.push(n.path);
      rec.nodeOf[n.path] = n.nodeId;
    } catch (e) {
      rec.errors.push(`${n.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const w of plan.properties) {
    if (ops.kind(w.path) !== "file") {
      rec.errors.push(`${w.path}: missing; property "${w.key}" not written`);
      continue;
    }
    try {
      await ops.editFrontmatter(w.path, (fm) => {
        // Re-merge against the current value: the note may have changed since the preview.
        const had = Object.prototype.hasOwnProperty.call(fm, w.key);
        const before = clone(fm[w.key]);
        const merged = mergeLinks(fm[w.key], w.add, w.path, ops.resolve);
        if (!merged) {
          rec.errors.push(`${w.path}: property "${w.key}" changed to a non-link value; left alone`);
          return;
        }
        if (!merged.changed) return;
        fm[w.key] = merged.value;
        rec.properties.push({ path: w.path, key: w.key, had, before, after: clone(merged.value) });
      });
    } catch (e) {
      rec.errors.push(`${w.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return rec;
}

/** Undo one run: properties, then created files, then empty created folders (deepest first). */
export async function undoMaterialise(rec: MaterialiseRecord, ops: VaultOps): Promise<UndoReport> {
  const report: UndoReport = { trashedFiles: [], trashedFolders: [], restoredProperties: 0, kept: [] };
  for (const p of [...rec.properties].reverse()) {
    if (ops.kind(p.path) !== "file") continue;
    await ops.editFrontmatter(p.path, (fm) => {
      if (!same(fm[p.key], p.after)) {
        report.kept.push(`${p.path}: "${p.key}" was edited since; left as is`);
        return;
      }
      if (p.had) fm[p.key] = clone(p.before);
      else delete fm[p.key];
      report.restoredProperties++;
    });
  }
  for (const path of [...rec.createdFiles].reverse()) {
    if (ops.kind(path) !== "file") continue;
    const fm = await ops.readFrontmatter(path);
    if (!fm || fm[PROVENANCE_KEY] !== rec.provenance || scalarText(fm[NODE_KEY]) !== rec.nodeOf[path]) {
      report.kept.push(`${path}: no longer carries this run's provenance; kept`);
      continue;
    }
    await ops.trash(path);
    report.trashedFiles.push(path);
  }
  for (const path of [...rec.createdFolders].sort((a, b) => b.split("/").length - a.split("/").length)) {
    if (ops.kind(path) !== "folder") continue;
    if (!ops.isEmptyFolder(path)) {
      report.kept.push(`${path}/: not empty; kept`);
      continue;
    }
    await ops.trash(path);
    report.trashedFolders.push(path);
  }
  return report;
}
