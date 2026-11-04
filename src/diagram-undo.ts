/**
 * Mod+Z / Mod+Shift+Z (and Mod+Y off macOS) for every diagram edit.
 *
 * - Live Preview: edits are single CodeMirror transactions, so the editor's
 *   own history undoes them. When a diagram (not the editor text) was the
 *   last thing clicked, focus sits outside the editor and the key would do
 *   nothing: it is routed to that editor's undo / redo.
 * - Reading view has no editor: edits written to the file are recorded here
 *   (edit-history.ts, per file, capped) and undone / redone with one
 *   vault.process each, refusing with a notice when the note changed at that
 *   place since. The keys act while focus or the pointer is in a note's
 *   Reading view (with nothing recorded they pass through silently); the
 *   commands "Undo / Redo last diagram edit (Reading view)" do the same for
 *   the active note. The "Undo" button of a saved-edit notice uses the stack.
 *   Steps run one at a time, in the order asked.
 * - The two histories are separate: an edit made in Reading view is undone
 *   from Reading view; after switching to Live Preview, Mod+Z is the editor's.
 *
 * Text fields, the inline label editor and the editor's own text keep their
 * native undo: the handlers step aside whenever focus is in something
 * editable.
 */
import { MarkdownView, Notice, Platform, TFile, type App, type Plugin, type WorkspaceLeaf } from "obsidian";
import { EditHistory, type HistoryEntry } from "./edit-history";
import { recentDiagram } from "./undo-recent";

type Dir = "undo" | "redo";

/** What Mod+Z should act on now. */
type UndoTarget = { kind: "editor"; view: MarkdownView } | { kind: "file"; path: string };

const DIAGRAM = ".pele-embed, .pele-host";
/** The edit UI floats on the body: it stands for the diagram it was opened on. */
const EDIT_UI = ".pele-edit-menu, .pele-edit-submenu, .pele-edit-plus, .pele-edit-outlines";

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el.closest("input, textarea, select")) return true;
  return el.instanceOf(HTMLElement) && el.isContentEditable;
}

export class DiagramUndo {
  readonly history = new EditHistory();
  /** The element under the pointer, per window document. */
  private pointerAt = new WeakMap<Document, Element>();
  /** The diagram last pressed in (its frame), with when. */
  private lastDiagram: { el: Element; at: number } | null = null;
  /** Undo / redo steps, one at a time (each reads what the previous one wrote). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly plugin: Plugin,
    private readonly app: App,
  ) {}

  load(): void {
    const p = this.plugin;
    const watch = (doc: Document): void => {
      p.registerDomEvent(doc, "pointerover", (e) => {
        if (e.target instanceof Element) this.pointerAt.set(doc, e.target);
      });
      p.registerDomEvent(
        doc,
        "pointerdown",
        (e) => {
          const t = e.target instanceof Element ? e.target.closest(DIAGRAM) : null;
          if (t) this.lastDiagram = { el: t, at: Date.now() };
        },
        { capture: true },
      );
    };
    watch(document);
    p.registerEvent(this.app.workspace.on("window-open", (win) => watch(win.doc)));
    const keys: Array<[string[], string, Dir]> = [
      [["Mod"], "z", "undo"],
      [["Mod", "Shift"], "z", "redo"],
    ];
    if (!Platform.isMacOS) keys.push([["Mod"], "y", "redo"]);
    for (const [mods, key, dir] of keys) {
      const handler = this.app.scope.register(mods as never, key, (evt) => this.onKey(evt, dir));
      p.register(() => this.app.scope.unregister(handler));
    }
    p.addCommand({ id: "undo-diagram-edit", name: "Undo last diagram edit (reading view)", checkCallback: (checking) => this.command("undo", checking) });
    p.addCommand({ id: "redo-diagram-edit", name: "Redo last diagram edit (reading view)", checkCallback: (checking) => this.command("redo", checking) });
    p.registerEvent(this.app.vault.on("rename", (f, old) => this.history.rename(old, f.path)));
    p.registerEvent(this.app.vault.on("delete", (f) => this.history.forget(f.path)));
  }

  /** Record an edit written straight to `path` (Reading view). Returns the entry. */
  record(path: string, before: string, after: string, label: string): HistoryEntry | null {
    return this.history.record(path, before, after, label);
  }

  /** An "Undo" for a saved-edit notice: undoes the latest edit of `path` while it is still the latest. */
  undoLatest(path: string): (() => void) | null {
    const entry = this.history.peekUndo(path);
    if (!entry) return null;
    return () => {
      if (this.history.peekUndo(path)?.id !== entry.id) {
        new Notice("Pele: newer edits since; use Cmd/Ctrl+Z to step back through them.");
        return;
      }
      void this.apply(path, "undo");
    };
  }

  private onKey(evt: KeyboardEvent, dir: Dir): boolean {
    const doc = (evt.target instanceof Node ? evt.target.ownerDocument : null) ?? document;
    // Inputs, the inline editor and the editor's own text: native undo.
    if (isEditable(doc.activeElement) || (evt.target instanceof Element && isEditable(evt.target))) return true;
    const target = this.target(doc);
    if (!target) return true;
    if (target.kind === "editor") {
      if (dir === "undo") target.view.editor.undo();
      else target.view.editor.redo();
    } else {
      // Nothing recorded for this note: let the key through, no notice.
      if (!this.peek(target.path, dir)) return true;
      void this.apply(target.path, dir);
    }
    return false;
  }

  /**
   * Focus, then the pointer, then (when nothing has focus) the diagram last
   * pressed in: a note's Reading view acts on its file's history; a diagram
   * in Live Preview on its editor.
   */
  private target(doc: Document): UndoTarget | null {
    const focus = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    const recent = recentDiagram(this.lastDiagram, Date.now());
    // Focus in another kind of view (Canvas, a plugin's view): its key, not ours.
    if (focus && !focus.closest(EDIT_UI)) {
      const leaf = this.leafOf(focus);
      if (leaf && !(leaf.view instanceof MarkdownView)) return null;
    }
    const candidates = [focus, this.pointerAt.get(doc) ?? null, focus ? null : recent];
    for (let el of candidates) {
      if (el?.closest(EDIT_UI)) el = recent;
      if (!el) continue;
      const view = this.viewOf(el);
      if (!view?.file) continue;
      if (view.getMode() === "preview") return { kind: "file", path: view.file.path };
      if (el.closest(DIAGRAM)) return { kind: "editor", view };
    }
    return null;
  }

  private leafOf(el: Element): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      // The view's .workspace-leaf, header included (the leaf element itself can hold focus).
      if (!found && leaf.view.containerEl.closest(".workspace-leaf")?.contains(el)) found = leaf;
    });
    return found;
  }

    private viewOf(el: Element): MarkdownView | null {
    let found: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!found && leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(el)) found = leaf.view;
    });
    return found;
  }

  /** Commands: the active note in Reading view, when it has something to step. */
  private command(dir: Dir, checking: boolean): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || view.getMode() !== "preview" || !this.peek(view.file.path, dir)) return false;
    if (!checking) void this.apply(view.file.path, dir);
    return true;
  }

  private peek(path: string, dir: Dir): HistoryEntry | null {
    return dir === "undo" ? this.history.peekUndo(path) : this.history.peekRedo(path);
  }

  /** Undo / redo the latest recorded edit of `path` with one checked file write, after any step already asked for. */
  apply(path: string, dir: Dir): Promise<boolean> {
    const run = this.queue.then(() => this.step(path, dir));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async step(path: string, dir: Dir): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    if (!this.peek(path, dir)) {
      new Notice(`Pele: no diagram edit to ${dir} in this note.`);
      return false;
    }
    let step: ReturnType<EditHistory["undo"]> = null;
    try {
      await this.app.vault.process(file, (data) => {
        step = dir === "undo" ? this.history.undo(path, data) : this.history.redo(path, data);
        return step && "text" in step ? step.text : data;
      });
    } catch {
      // Not written: the entry goes back.
      const s = step as ReturnType<EditHistory["undo"]>;
      if (s && "text" in s) this.history.restore(s, dir);
      new Notice(`Pele: could not ${dir} that diagram edit.`);
      return false;
    }
    const s = step as ReturnType<EditHistory["undo"]>;
    if (!s) return false;
    if ("conflict" in s) {
      new Notice(`Pele: the note changed where that ${s.conflict.label} was made; it can't be ${dir === "undo" ? "undone" : "redone"}.`, 6000);
      return false;
    }
    new Notice(`Pele: ${dir === "undo" ? "undid" : "redid"} ${s.entry.label}.`, 2500);
    return true;
  }
}
