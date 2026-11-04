/**
 * A diagram block in its own tab or window (zoom button, Mod-click): the full
 * interactive frame, mounted as the note's Markdown processor would (Mehrpele
 * overlays, view nodes, reflow, edit toolbar), following its block through
 * edits to the note and closing when the block or the note is deleted. A
 * diagram that can't be followed (nested in a Mehrpele label) is shown as it
 * was when opened.
 */
import { Component, ItemView, MarkdownView, Notice, TFile, type App, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { findBlock, refOf, relocate, type BlockRef } from "./block-locate";
import { extractBlocks, type CodeBlock } from "./extract-blocks";

export const DIAGRAM_VIEW = "pele-diagram";
const LANGS = ["mermaid", "pele", "mehrpele"];

export interface DiagramViewHost {
  /** Mount one block into `el`, owned by `owner`; `fenceLine` undefined = never written back. */
  mountDiagram(el: HTMLElement, owner: Component, source: string, sourcePath: string, lang: string, fenceLine: number | undefined): void;
}

interface DiagramViewState {
  file: string;
  lang: string;
  /** The source when opened (all an unfollowed view shows). */
  source: string;
  /** The block being followed; null = a fixed snapshot. */
  ref: BlockRef | null;
}

/** Diagram blocks of the note at `path`, or null when there is no such note. */
async function blocksOf(app: App, path: string): Promise<CodeBlock[] | null> {
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? extractBlocks(await app.vault.cachedRead(file), LANGS) : null;
}

export class DiagramView extends ItemView {
  private st: DiagramViewState | null = null;
  private owner: Component | null = null;
  /** What is mounted now (lang, fence line, source): re-mount only on change. */
  private mounted = "";
  private timer: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private host: DiagramViewHost,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return DIAGRAM_VIEW;
  }

  getDisplayText(): string {
    if (!this.st) return "Diagram";
    const name = this.st.file.split("/").pop()?.replace(/\.md$/, "") ?? "Diagram";
    return `${name} (diagram${this.st.ref ? "" : ", snapshot"})`;
  }

  getIcon(): string {
    return "workflow";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("pele-diagram-view");
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (this.st?.ref && f.path === this.st.file) this.schedule();
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, old) => {
        if (this.st && old === this.st.file) {
          this.st.file = f.path;
          this.mounted = ""; // the frame writes back to the old path
          this.schedule();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => {
        if (this.st?.ref && f.path === this.st.file) this.dismiss("its note was deleted");
      }),
    );
  }

  async onClose(): Promise<void> {
    if (this.timer !== null) window.clearTimeout(this.timer);
  }

  getState(): Record<string, unknown> {
    return { ...(this.st ?? {}) };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = state as Partial<DiagramViewState> | null;
    if (s && typeof s.file === "string" && typeof s.source === "string") {
      this.st = { file: s.file, lang: s.lang ?? "mermaid", source: s.source, ref: s.ref ?? null };
      this.mounted = "";
      await this.refresh();
    }
    await super.setState(state, result);
    (this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
    (this as unknown as { titleEl?: HTMLElement }).titleEl?.setText(this.getDisplayText()); // the view header
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, 120);
  }

  private async refresh(): Promise<void> {
    const st = this.st;
    if (!st) return;
    if (!st.ref) {
      this.mount(st.source, st.lang, undefined);
      return;
    }
    const blocks = await blocksOf(this.app, st.file);
    if (!blocks) return this.dismiss("its note is gone");
    const i = relocate(blocks, st.ref);
    if (i === null) return this.dismiss("its block was removed");
    st.ref = refOf(blocks, i);
    const b = blocks[i];
    this.mount(b.code, b.lang, b.startLine);
  }

  private mount(source: string, lang: string, fenceLine: number | undefined): void {
    const key = `${lang}\n${fenceLine ?? ""}\n${source}`;
    if (key === this.mounted || !this.st) return;
    this.mounted = key;
    if (this.owner) this.removeChild(this.owner);
    this.contentEl.empty();
    this.owner = this.addChild(new Component());
    const el = this.contentEl.createDiv({ cls: "pele-diagram-view-block" });
    this.host.mountDiagram(el, this.owner, source, this.st.file, lang, fenceLine);
  }

  /** Close this view, saying why (not `close`: View.close is what leaf.detach calls). */
  private dismiss(why: string): void {
    new Notice(`Pele: closed the diagram view — ${why}.`);
    this.leaf.detach();
  }
}

export type Pane = "tab" | "split" | "window";

function leafFor(app: App, pane: Pane): WorkspaceLeaf {
  if (pane === "window") return app.workspace.openPopoutLeaf();
  return pane === "split" ? app.workspace.getLeaf("split", "vertical") : app.workspace.getLeaf("tab");
}

/**
 * The 0-based line where a rendered frame's block starts, from the view that
 * shows its note (Live Preview: the editor's position of the widget; Reading
 * view: its section), so of identical blocks the frame's own is meant.
 * Undefined when no open view of the note can tell (an embed, a canvas).
 */
export function frameLine(app: App, root: HTMLElement, sourcePath: string): number | undefined {
  let line: number | undefined;
  app.workspace.iterateAllLeaves((leaf) => {
    const v = leaf.view;
    if (line !== undefined || !(v instanceof MarkdownView) || v.file?.path !== sourcePath || !v.containerEl.contains(root)) return;
    try {
      if (v.getMode() === "source") {
        const cm = (v.editor as unknown as { cm?: { posAtDOM(n: Node): number; state: { doc: { lineAt(p: number): { number: number } } } } }).cm;
        if (cm) line = cm.state.doc.lineAt(cm.posAtDOM(root)).number - 1;
      } else {
        const sections = (v.previewMode as unknown as { renderer?: { sections?: Array<{ el: HTMLElement; start?: { line: number } }> } }).renderer?.sections;
        line = sections?.find((x) => x.el.contains(root))?.start?.line;
      }
    } catch {
      /* private API changed: the first matching block is used */
    }
  });
  return line;
}

/** Open a frame's diagram in its own tab, split or window (`nearLine`: the frame's own line, see frameLine). */
export async function openDiagramView(app: App, sourcePath: string, lang: string, source: string, pane: Pane, nearLine?: number): Promise<void> {
  const blocks = sourcePath ? await blocksOf(app, sourcePath) : null;
  const i = blocks ? findBlock(blocks, source, nearLine ?? 0) : null;
  const state: DiagramViewState = { file: sourcePath, lang, source, ref: blocks && i !== null ? refOf(blocks, i) : null };
  const leaf = leafFor(app, pane);
  await leaf.setViewState({ type: DIAGRAM_VIEW, active: true, state: state as unknown as Record<string, unknown> });
  void app.workspace.revealLeaf(leaf);
}

/** Open the note in a split or window with the cursor on the block's fence. */
export async function editSourceIn(app: App, sourcePath: string, source: string, pane: Exclude<Pane, "tab">, nearLine?: number): Promise<void> {
  const file = app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) {
    new Notice("Pele: this diagram has no note to edit.");
    return;
  }
  const text = await app.vault.cachedRead(file);
  const blocks = extractBlocks(text, LANGS);
  const i = findBlock(blocks, source, nearLine ?? 0);
  // Not a block of its own (nested in a Mehrpele label): its first line.
  const first = source.split("\n").find((l) => l.trim())?.trim();
  const line = i !== null ? blocks[i].startLine : Math.max(0, first ? text.split("\n").findIndex((l) => l.includes(first)) : 0);
  const leaf = leafFor(app, pane);
  await leaf.openFile(file, { active: true, state: { mode: "source" }, eState: { line } });
  const view = leaf.view;
  if (view instanceof MarkdownView) {
    view.editor.setCursor({ line, ch: 0 });
    view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
    view.editor.focus();
  }
}
