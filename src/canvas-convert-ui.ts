/**
 * Obsidian side of Canvas → Mermaid: the commands, the .canvas file-menu
 * item, the destination modal (new note / insert into a note / copy) and the
 * canvas reading (the open view's live data when there is one, so unsaved
 * moves count). The conversion itself is canvas-convert.ts.
 */
import { FuzzySuggestModal, MarkdownView, Modal, Notice, Setting, TFile, type App, type Plugin } from "obsidian";
import type { CanvasData } from "pele-render/canvas";
import { canvasReferences, canvasToBlock, insertBlock, mermaidNoteBody, mermaidNoteName, type CanvasBlock, type CanvasLayoutMode } from "./canvas-convert";
import type { SettingsV3 } from "./settings/schema";

export interface CanvasConvertHost extends Plugin {
  settings: SettingsV3;
}

type CanvasViewLike = { getViewType(): string; file?: TFile | null; canvas?: { getData?: () => CanvasData } };

/** Canvas data: the open view's live state, else the file. */
export async function readCanvasData(app: App, file: TFile): Promise<CanvasData | null> {
  for (const leaf of app.workspace.getLeavesOfType("canvas")) {
    const view = leaf.view as unknown as CanvasViewLike;
    if (view.file?.path === file.path && typeof view.canvas?.getData === "function") {
      try {
        const data = view.canvas.getData();
        if (data && Array.isArray(data.nodes)) return data;
      } catch {
        /* fall back to the file */
      }
    }
  }
  try {
    const data = JSON.parse(await app.vault.read(file)) as CanvasData;
    return data && Array.isArray(data.nodes) ? data : null;
  } catch {
    return null;
  }
}

/** Canvases referenced by portals, read up front (the converter's resolver is sync). */
async function preloadCanvases(app: App, data: CanvasData, depth: number): Promise<Map<string, CanvasData>> {
  const out = new Map<string, CanvasData>();
  let frontier = canvasReferences(data);
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const p of frontier) {
      if (out.has(p)) continue;
      const f = app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) continue;
      const inner = await readCanvasData(app, f);
      if (inner) {
        out.set(p, inner);
        next.push(...canvasReferences(inner));
      }
    }
    frontier = next;
  }
  return out;
}

/** Convert a canvas file to a fenced block (null + notice when unreadable). */
export async function convertCanvasFile(
  host: CanvasConvertHost,
  file: TFile,
  opts: { layout?: CanvasLayoutMode; lang?: "mermaid" | "mehrpele" | "pele"; portals?: "link" | "inline"; portalDepth?: number; scale?: number } = {},
): Promise<CanvasBlock | null> {
  const data = await readCanvasData(host.app, file);
  if (!data) {
    new Notice("Pele: could not parse that canvas.");
    return null;
  }
  const f = host.settings.features;
  const settings = { ...f.canvas, ...(opts.portals ? { portals: opts.portals } : {}), ...(opts.portalDepth !== undefined ? { portalDepth: opts.portalDepth } : {}) };
  const preloaded = settings.portals === "inline" ? await preloadCanvases(host.app, data, settings.portalDepth) : new Map<string, CanvasData>();
  return canvasToBlock(data, settings, {
    lang: opts.lang,
    layout: opts.layout,
    scale: opts.scale,
    mehrpeleByDefault: f["live-view"].enabled,
    resolveCanvas: (p) => preloaded.get(p) ?? null,
    // view-nodes: web link cards land on live web-view nodes when those can render.
    webNodes: f["live-view"].enabled && f["view-nodes"].enabled && f["view-nodes"].webEnabled,
  });
}

/** Write the block to a new note beside the canvas and open it. */
async function toNewNote(app: App, canvas: TFile, block: CanvasBlock): Promise<TFile> {
  let path = mermaidNoteName(canvas.path);
  for (let n = 2; app.vault.getAbstractFileByPath(path) && n < 1000; n++) path = mermaidNoteName(canvas.path, n);
  const note = await app.vault.create(path, mermaidNoteBody(canvas.path, block.block));
  await app.workspace.getLeaf(true).openFile(note);
  return note;
}

/** Insert the block into `note`: at the cursor when the note is open in an editor, else at the end. */
async function intoNote(app: App, note: TFile, block: CanvasBlock): Promise<void> {
  const leaf = app.workspace.getLeavesOfType("markdown").find((l) => (l.view as MarkdownView).file?.path === note.path);
  const view = leaf?.view as MarkdownView | undefined;
  if (view?.editor) {
    const ed = view.editor;
    const { text, line } = insertBlock(ed.getValue(), block.block, ed.getCursor().line);
    ed.setValue(text);
    ed.setCursor({ line, ch: 0 });
    app.workspace.setActiveLeaf(leaf!, { focus: true });
    return;
  }
  await app.vault.process(note, (text) => insertBlock(text, block.block).text);
  await app.workspace.getLeaf(true).openFile(note);
}

function report(block: CanvasBlock, what: string): void {
  new Notice(`Pele: ${what} (${block.lang})${block.dropped.length ? ` — ${block.dropped.length} dropped: ${block.dropped[0]}` : ""}`, 8000);
}

class NotePicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly done: (f: TFile) => void) {
    super(app);
    this.setPlaceholder("Insert the diagram into which note?");
  }
  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    this.done(f);
  }
}

/** Destination + layout chooser for one canvas. */
export class CanvasToMermaidModal extends Modal {
  private layout: CanvasLayoutMode;
  constructor(private readonly host: CanvasConvertHost, private readonly canvas: TFile) {
    super(host.app);
    this.layout = host.settings.features.canvas.layout;
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: `Convert ${this.canvas.basename} to Mermaid` });
    new Setting(contentEl)
      .setName("Layout")
      .setDesc("Canvas positions: Pele draws every card where it is on the canvas. Automatic: Pele lays the diagram out (the positions still travel in the block, so converting back restores them).")
      .addDropdown((d) =>
        d
          .addOption("canvas", "Canvas positions")
          .addOption("auto", "Automatic layout")
          .setValue(this.layout)
          .onChange((v) => (this.layout = v === "auto" ? "auto" : "canvas")),
      );
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("New note").setCta().onClick(() => void this.run("note")))
      .addButton((b) => b.setButtonText("Insert into note…").onClick(() => void this.run("insert")))
      .addButton((b) => b.setButtonText("Copy").onClick(() => void this.run("copy")));
  }
  onClose(): void {
    this.contentEl.empty();
  }
  private async run(dest: "note" | "insert" | "copy"): Promise<void> {
    this.close();
    await canvasToMermaidTo(this.host, this.canvas, dest, this.layout);
  }
}

/** Convert `canvas` and deliver it. */
export async function canvasToMermaidTo(host: CanvasConvertHost, canvas: TFile, dest: "note" | "insert" | "copy", layout?: CanvasLayoutMode): Promise<void> {
  const block = await convertCanvasFile(host, canvas, { layout });
  if (!block) return;
  if (dest === "note") {
    const note = await toNewNote(host.app, canvas, block);
    report(block, `wrote ${note.path}`);
  } else if (dest === "insert") {
    new NotePicker(host.app, (note) => {
      void intoNote(host.app, note, block).then(() => report(block, `inserted into ${note.path}`));
    }).open();
  } else {
    await navigator.clipboard.writeText(block.block);
    report(block, "copied the diagram block");
  }
}

function activeCanvas(app: App): TFile | null {
  const f = app.workspace.getActiveFile();
  return f && f.extension === "canvas" ? f : null;
}

/** Commands (available while a canvas is active) and the .canvas file-menu entry. */
export function registerCanvasToMermaid(host: CanvasConvertHost): void {
  const withCanvas = (run: (f: TFile) => void) => (checking: boolean): boolean => {
    const f = activeCanvas(host.app);
    if (!f) return false;
    if (!checking) run(f);
    return true;
  };
  host.addCommand({
    id: "convert-canvas-to-mermaid",
    name: "Convert canvas to Mermaid…",
    checkCallback: withCanvas((f) => new CanvasToMermaidModal(host, f).open()),
  });
  host.addCommand({
    id: "convert-canvas-to-mermaid-note",
    name: "Convert canvas to a new Mermaid note",
    checkCallback: withCanvas((f) => void canvasToMermaidTo(host, f, "note")),
  });
  host.addCommand({
    id: "insert-canvas-as-mermaid",
    name: "Insert canvas as Mermaid into a note…",
    checkCallback: withCanvas((f) => void canvasToMermaidTo(host, f, "insert")),
  });
  host.registerEvent(
    host.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "canvas") return;
      menu.addItem((i) => i.setTitle("Convert to Mermaid…").setIcon("workflow").onClick(() => new CanvasToMermaidModal(host, file).open()));
    }),
  );
}
