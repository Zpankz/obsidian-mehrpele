/**
 * "Materialise diagram as notes": command, preview, apply, undo and the
 * `pele:materialise` CLI handler. Obsidian glue only; planning is pure
 * (plan.ts), safety rules live in apply.ts. See docs/materialise.md.
 */
import type { EditorView } from "@codemirror/view";
import {
  App,
  getFrontMatterInfo,
  MarkdownView,
  Notice,
  parseYaml,
  SuggestModal,
  TAbstractFile,
  TFile,
  TFolder,
  type Command,
} from "obsidian";
import { blockAtLine, extractBlocks, type CodeBlock } from "../extract-blocks";
import { applyPlan, undoMaterialise, type MaterialiseRecord, type VaultOps } from "./apply";
import { MaterialisePreviewModal, type PreviewChoices } from "./modal";
import { expandRoot, normaliseRoot, planFromSource, type MaterialisePlan, type VaultView } from "./planner";
import type { SettingsV3 } from "../settings/schema";
import { materialiseOptions } from "./settings";
import { applySourceEdit, blockIdFor, minimalChange, revertSourceEdit, type SourceEdit } from "./source-edit";

export { DEFAULT_MATERIALISE_SETTINGS, normalizeMaterialiseSettings, type MaterialiseSettings } from "./settings";

const LANGS = ["mermaid", "pele", "mehrpele"];

/** What the plugin provides (PeleMermaidPlugin satisfies it). */
export interface MaterialiseHost {
  app: App;
  settings: SettingsV3;
  isMehrpeleBlock(lang: string, code: string): boolean;
  addCommand(command: Command): Command;
}

interface LastRun {
  record: MaterialiseRecord;
  source?: SourceEdit;
}

// -- vault adapters -----------------------------------------------------------

function fileAt(app: App, path: string): TAbstractFile | null {
  const v = app.vault as unknown as { getAbstractFileByPathInsensitive?: (p: string) => TAbstractFile | null };
  return app.vault.getAbstractFileByPath(path) ?? v.getAbstractFileByPathInsensitive?.(path) ?? null;
}

function resolver(app: App): VaultView["resolve"] {
  return (linkpath, sourcePath) => app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path ?? null;
}

export function obsidianVaultView(app: App): VaultView {
  return {
    lookup(path) {
      const f = fileAt(app, path);
      if (f instanceof TFolder) return { kind: "folder" };
      if (!(f instanceof TFile)) return null;
      if (f.extension.toLowerCase() !== "md") return { kind: "file" };
      const fm = app.metadataCache.getFileCache(f)?.frontmatter;
      return { kind: "note", frontmatter: fm ? { ...fm } : null };
    },
    resolve: resolver(app),
  };
}

export function obsidianVaultOps(app: App): VaultOps {
  const file = (path: string): TFile => {
    const f = fileAt(app, path);
    if (!(f instanceof TFile)) throw new Error(`${path} is not a file`);
    return f;
  };
  return {
    kind(path) {
      const f = fileAt(app, path);
      return f instanceof TFolder ? "folder" : f instanceof TFile ? "file" : null;
    },
    async createFolder(path) {
      await app.vault.createFolder(path);
    },
    async createNote(path, content) {
      // vault.create throws when the file exists: never an overwrite.
      await app.vault.create(path, content);
    },
    editFrontmatter(path, fn) {
      return app.fileManager.processFrontMatter(file(path), fn);
    },
    async readFrontmatter(path) {
      // Read the file, not the metadata cache: a note created a moment ago may not be indexed yet.
      const info = getFrontMatterInfo(await app.vault.read(file(path)));
      if (!info.exists) return null;
      try {
        const fm = parseYaml(info.frontmatter) as unknown;
        return fm && typeof fm === "object" ? (fm as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },
    isEmptyFolder(path) {
      const f = fileAt(app, path);
      return f instanceof TFolder && f.children.length === 0;
    },
    async trash(path) {
      const f = fileAt(app, path);
      if (f) await app.fileManager.trashFile(f);
    },
    resolve: resolver(app),
  };
}

// -- block picking --------------------------------------------------------------

class BlockPicker extends SuggestModal<CodeBlock> {
  constructor(app: App, private blocks: CodeBlock[], private onPick: (b: CodeBlock) => void) {
    super(app);
    this.setPlaceholder("Which diagram?");
  }
  getSuggestions(query: string): CodeBlock[] {
    const q = query.toLowerCase();
    return this.blocks.filter((b) => b.code.toLowerCase().includes(q));
  }
  renderSuggestion(b: CodeBlock, el: HTMLElement): void {
    const first = b.code.split("\n").find((l) => l.trim() && !/^\s*%%/.test(l))?.trim() ?? b.lang;
    el.createDiv({ text: `${b.lang} · line ${b.startLine + 1}` });
    el.createEl("small", { text: first.slice(0, 80) });
  }
  onChooseSuggestion(b: CodeBlock): void {
    this.onPick(b);
  }
}

function editorView(view: MarkdownView): EditorView | null {
  if (view.getMode() !== "source") return null;
  return (view.editor as unknown as { cm?: EditorView }).cm ?? null;
}

// -- controller -------------------------------------------------------------------

export class MaterialiseController {
  private last: LastRun | null = null;

  constructor(private host: MaterialiseHost) {}

  private get app(): App {
    return this.host.app;
  }

  /** `on`: where the commands live (the materialise feature's scoped plugin). */
  registerCommands(on: Pick<MaterialiseHost, "addCommand"> = this.host): void {
    on.addCommand({
      id: "materialise-diagram-as-notes",
      name: "Materialise diagram as notes",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (!checking) void this.runFromView(view);
        return true;
      },
    });
    on.addCommand({
      id: "undo-last-materialise",
      name: "Undo last materialise",
      checkCallback: (checking) => {
        if (!this.last) return false;
        if (!checking) void this.undoLast();
        return true;
      },
    });
  }

  /** Plan for one block of a note (pure planner fed with live vault lookups). */
  plan(
    notePath: string,
    text: string,
    block: CodeBlock,
    choices: Partial<PreviewChoices> = {},
  ): { ok: true; plan: MaterialisePlan; choices: PreviewChoices } | { ok: false; reason: string } {
    const id = blockIdFor(text, block.startLine, block.code);
    if (!id.ok) return { ok: false, reason: `Pele: can't materialise: ${id.reason}.` };
    const s = materialiseOptions(this.host.settings);
    const full: PreviewChoices = {
      onExisting: choices.onExisting ?? s.onExisting,
      rewrite: choices.rewrite ?? s.rewriteBlock,
      root: choices.root ?? expandRoot(s.rootFolder, notePath),
    };
    const r = planFromSource({
      source: block.code,
      isMehrpele: this.host.isMehrpeleBlock(block.lang, block.code),
      notePath,
      blockId: id.id,
      options: { root: normaliseRoot(full.root), defaultKey: s.defaultKey, keyStyle: s.keyStyle, rewrite: full.rewrite, onExisting: full.onExisting },
      vault: obsidianVaultView(this.app),
    });
    return r.ok ? { ok: true, plan: r.plan, choices: full } : r;
  }

  private notices(plan: MaterialisePlan): string[] {
    const out: string[] = [];
    if (!plan.rewrite) return out;
    const lv = this.host.settings.features["live-view"];
    if (!lv.enabled) out.push("Mehrpele is off (Settings › Mehrpele): the rewritten block shows link text instead of note embeds until it is enabled.");
    else if (!lv.embeds) out.push("Mehrpele embeds are off: nodes will show link text, not their notes.");
    const nodes = plan.notes.filter((n) => n.action !== "skip").length;
    if (nodes > lv.maxLabels) out.push(`${nodes} nodes exceed Mehrpele's label limit (${lv.maxLabels}); raise it in Settings › Mehrpele.`);
    return out;
  }

  async runFromView(view: MarkdownView): Promise<void> {
    const file = view.file;
    if (!file || file.extension !== "md") return;
    const cm = editorView(view);
    const text = cm ? cm.state.doc.toString() : await this.app.vault.read(file);
    const blocks = extractBlocks(text, LANGS);
    if (!blocks.length) {
      new Notice("Pele: no Mermaid/pele/mehrpele diagram in this note.");
      return;
    }
    const atCursor = cm ? blockAtLine(blocks, view.editor.getCursor().line) : undefined;
    const go = (b: CodeBlock) => this.preview(file, text, b);
    if (atCursor) go(atCursor);
    else if (blocks.length === 1) go(blocks[0]);
    else new BlockPicker(this.app, blocks, go).open();
  }

  private preview(file: TFile, text: string, block: CodeBlock): void {
    const first = this.plan(file.path, text, block);
    if (!first.ok) {
      new Notice(first.reason, 8000);
      return;
    }
    new MaterialisePreviewModal(this.app, first.plan, first.choices, {
      replan: (choices) => {
        const r = this.plan(file.path, text, block, choices);
        return r.ok ? r.plan : r.reason;
      },
      notices: (plan) => this.notices(plan),
      confirm: (plan) => void this.execute(file, block, plan),
    }).open();
  }

  /** Apply a plan: folders, notes, properties, then the block (one undoable edit). */
  async execute(file: TFile, block: CodeBlock, plan: MaterialisePlan, opts: { notify?: boolean } = {}): Promise<{ record: MaterialiseRecord; sourceError?: string }> {
    const record = await applyPlan(plan, obsidianVaultOps(this.app));
    const edited = await this.editSource(file, block, plan.rewrite?.after ?? null);
    this.last = { record, ...(edited.ok ? { source: edited.edit } : {}) };
    const sourceError = edited.ok ? undefined : edited.reason;
    if (opts.notify !== false) this.notifyDone(record, plan, sourceError);
    return { record, ...(sourceError ? { sourceError } : {}) };
  }

  /** Live Preview/Source: one CodeMirror change (one Cmd/Ctrl+Z). Otherwise one vault.process. */
  private async editSource(file: TFile, block: CodeBlock, after: string | null): Promise<{ ok: true; edit: SourceEdit } | { ok: false; reason: string }> {
    const cm = this.openEditor(file.path);
    if (cm) {
      const text = cm.state.doc.toString();
      const r = applySourceEdit(text, block.startLine, block.code, after);
      if (!r.ok) return r;
      const change = minimalChange(text, r.text);
      if (change) cm.dispatch({ changes: change, scrollIntoView: false, userEvent: "input.pele-materialise" });
      return { ok: true, edit: r.edit };
    }
    let result: { ok: true; edit: SourceEdit } | { ok: false; reason: string } = { ok: false, reason: "note not found" };
    await this.app.vault.process(file, (data) => {
      const r = applySourceEdit(data, block.startLine, block.code, after);
      result = r.ok ? { ok: true, edit: r.edit } : r;
      return r.ok ? r.text : data;
    });
    return result;
  }

  private openEditor(path: string): EditorView | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const v = leaf.view;
      if (v instanceof MarkdownView && v.file?.path === path) {
        const cm = editorView(v);
        if (cm) return cm;
      }
    }
    return null;
  }

  private notifyDone(record: MaterialiseRecord, plan: MaterialisePlan, sourceError?: string): void {
    const frag = createFragment();
    const files = record.createdFiles;
    const head = `Pele: materialised ${files.length} note(s), ${record.createdFolders.length} folder(s), ${record.properties.length} property write(s)${plan.rewrite && !sourceError ? ", block rewritten" : ""}.`;
    frag.createDiv({ text: head });
    if (files.length) {
      const ul = frag.createEl("ul");
      for (const f of files.slice(0, 8)) ul.createEl("li", { text: f });
      if (files.length > 8) ul.createEl("li", { text: `… ${files.length - 8} more` });
    }
    for (const e of record.errors.slice(0, 4)) frag.createDiv({ text: `⚠ ${e}` });
    if (sourceError) frag.createDiv({ text: `⚠ Block not rewritten: ${sourceError}` });
    const notice = new Notice(frag, 20000);
    if (!files.length && !record.createdFolders.length && !record.properties.length && !this.last?.source) return;
    const btn = frag.createEl("button", { text: "Undo materialise" });
    notice.messageEl.appendChild(btn);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      notice.hide();
      void this.undoLast();
    });
  }

  /** Undo the last run: the block first, then properties, created files and empty folders. */
  async undoLast(): Promise<void> {
    const last = this.last;
    if (!last) {
      new Notice("Pele: nothing to undo.");
      return;
    }
    this.last = null;
    let blockNote = "";
    if (last.source && (last.source.after !== last.source.before || last.source.idInsert)) {
      const ok = await this.revertSource(last.record.notePath, last.source);
      if (!ok) blockNote = " The diagram block was edited since and was left as is.";
    }
    const report = await undoMaterialise(last.record, obsidianVaultOps(this.app));
    const kept = report.kept.length ? ` Kept: ${report.kept.slice(0, 3).join("; ")}${report.kept.length > 3 ? "; …" : ""}` : "";
    new Notice(
      `Pele: undid materialise — ${report.trashedFiles.length} note(s) and ${report.trashedFolders.length} folder(s) trashed, ${report.restoredProperties} property write(s) reverted.${blockNote}${kept}`,
      12000,
    );
  }

  private async revertSource(path: string, edit: SourceEdit): Promise<boolean> {
    const cm = this.openEditor(path);
    if (cm) {
      const text = cm.state.doc.toString();
      const r = revertSourceEdit(text, edit);
      if (!r.ok) return false;
      const change = minimalChange(text, r.text);
      if (change) cm.dispatch({ changes: change, scrollIntoView: false, userEvent: "input.pele-materialise" });
      return true;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    let ok = false;
    await this.app.vault.process(file, (data) => {
      const r = revertSourceEdit(data, edit);
      ok = r.ok;
      return r.ok ? r.text : data;
    });
    return ok;
  }

  // -- CLI -----------------------------------------------------------------------

  static readonly cliFlags: Record<string, { value?: string; description: string }> = {
    path: { value: "<path>", description: "Vault-relative note path" },
    file: { value: "<name>", description: "Note name (linkpath)" },
    index: { value: "<n>", description: "0-based diagram index (default: the only diagram)" },
    "dry-run": { description: "Only print the plan (JSON); write nothing" },
    root: { value: "<folder>", description: "Root folder (default: the Materialise setting)" },
    "on-existing": { value: "link|skip|suffix", description: "When a note already exists (default: setting)" },
    "no-rewrite": { description: "Leave the diagram block as is" },
  };

  /** `pele:materialise` → JSON of what was (or would be) created. */
  async cli(file: TFile, index: number, params: Record<string, string | undefined>, flag: (v: string | undefined) => boolean): Promise<string> {
    const text = await this.app.vault.read(file);
    const block = extractBlocks(text, LANGS)[index];
    if (!block) throw new Error(`pele: no diagram ${index} in ${file.path}`);
    const onExisting = params["on-existing"];
    if (onExisting !== undefined && onExisting !== "link" && onExisting !== "skip" && onExisting !== "suffix") throw new Error(`pele: on-existing must be link|skip|suffix`);
    if (params.root !== undefined && (/^[\\/~]/.test(params.root) || params.root.split(/[\\/]+/).includes(".."))) throw new Error(`pele: root=${params.root} must be a vault-relative folder`);
    const r = this.plan(file.path, text, block, {
      ...(params.root !== undefined ? { root: params.root } : {}),
      ...(onExisting ? { onExisting: onExisting } : {}),
      ...(flag(params["no-rewrite"]) ? { rewrite: false } : {}),
    });
    if (!r.ok) throw new Error(r.reason);
    const plan = r.plan;
    const dryRun = flag(params["dry-run"]);
    const out: Record<string, unknown> = {
      dryRun,
      note: file.path,
      index,
      type: plan.type,
      blockId: plan.blockId,
      root: plan.root,
      empty: plan.empty,
      folders: plan.folders.filter((f) => f.status === "create").map((f) => f.path),
      notes: plan.notes.map((n) => ({
        node: n.nodeId,
        path: n.path,
        action: n.action,
        ...(n.reason ? { reason: n.reason } : {}),
        ...(n.properties ? { properties: n.properties } : {}),
      })),
      properties: plan.properties.map((p) => ({ path: p.path, key: p.key, add: p.add.map((a) => a.link), after: p.after })),
      rewrite: plan.rewrite ? plan.rewrite.after : null,
      warnings: plan.warnings,
    };
    if (!dryRun && !plan.empty) {
      const done = await this.execute(file, block, plan, { notify: false });
      out.created = { files: done.record.createdFiles, folders: done.record.createdFolders, properties: done.record.properties.length };
      out.errors = [...done.record.errors, ...(done.sourceError ? [`block not rewritten: ${done.sourceError}`] : [])];
    }
    return JSON.stringify(out, null, 2);
  }
}

const controllers = new WeakMap<object, MaterialiseController>();

/**
 * The plugin's controller (one per plugin instance). Keyed by `app`, not by
 * `host`: features get different scoped proxies of the same plugin, and the
 * commands and the CLI must share one "last run" for undo. Each plugin load
 * evaluates this module afresh, so `app` is per plugin instance.
 */
export function materialiseFor(host: MaterialiseHost): MaterialiseController {
  let c = controllers.get(host.app);
  if (!c) controllers.set(host.app, (c = new MaterialiseController(host)));
  return c;
}
