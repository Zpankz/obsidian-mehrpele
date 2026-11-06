/**
 * Diagram → Excalidraw conversion (feature "excalidraw"; was the
 * pele-excalidraw plugin). Talks to the Excalidraw plugin through
 * ExcalidrawAutomate; needs Excalidraw ≥ MIN_EXCALIDRAW_VERSION.
 */
import { App, Editor, MarkdownView, Modal, Notice, Setting, TFile } from "obsidian";
import { peleToExcalidraw, type PeleToExcalidrawResult } from "pele-render/excalidraw";
import { extractBlocks, blockAtLine, diagramIndexOf, drawingPathFor, drawingPathError, parseIndex } from "./extract";
import { resolvePalette } from "./palette";
import { checkExcalidraw, getExcalidrawPlugin, EXCALIDRAW_INSTALL_URL, MIN_EXCALIDRAW_VERSION, type EaLike, type ExcalidrawElementLike } from "./ea";
import { cliResultJson, errorMessage, failed, succeeded, type ConvertOptions, type DrawingResult, type InsertResult } from "./result";
import { cliFlag } from "../cli/params";

export type { ConvertOptions, DrawingResult, InsertResult } from "./result";

/** What the core (diagram menu, CLI) calls while the feature runs. */
export interface ExcalidrawApi {
  convert(source: string, opts?: ConvertOptions): PeleToExcalidrawResult;
  /**
   * `path`: vault-relative `.excalidraw.md`/`.excalidraw`; an existing file is only replaced with `force`.
   * Without `path` the drawing is named after `sourcePath` (the file holding the diagram), else the active note.
   */
  createDrawing(source: string, opts?: DrawingOptions): Promise<DrawingResult>;
  insertIntoView(source: string): Promise<InsertResult>;
  cliConvert(params: Record<string, string>): Promise<string>;
}

export interface DrawingOptions { path?: string; sourcePath?: string; open?: boolean; force?: boolean }

const PREFIX = "Pele: Excalidraw: ";
/** Placeholder diagram source (Mermaid code, not UI prose). */
const SAMPLE_SOURCE = "flowchart TD\n  A --> B";
const notice = (msg: string, ms?: number): void => void new Notice(PREFIX + msg, ms);
/** A failure the user sees as a Notice; `result` is the conversion, when it had run. */
const notifyFailure = (error: string, result?: PeleToExcalidrawResult): DrawingResult => {
  notice(error, 8000);
  return failed(error, result);
};

export class SourcePromptModal extends Modal {
  private resolveFn: ((v: string | null) => void) | null = null;
  private value = "";
  constructor(app: App) { super(app); }
  onOpen(): void {
    this.titleEl.setText("Insert diagram into Excalidraw drawing");
    const ta = this.contentEl.createEl("textarea", { cls: "pele-excalidraw-source", attr: { rows: "10", placeholder: SAMPLE_SOURCE } });
    ta.addEventListener("input", () => { this.value = ta.value; });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("Insert").setCta().onClick(() => { this.settle(this.value || null); this.close(); }))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => { this.close(); }));
  }
  /** Esc, the close button and Cancel all end here: an unsubmitted prompt resolves null. */
  onClose(): void {
    this.contentEl.empty();
    this.settle(null);
  }
  private settle(v: string | null): void {
    const r = this.resolveFn;
    this.resolveFn = null;
    r?.(v);
  }
  prompt(): Promise<string | null> { return new Promise((r) => { this.resolveFn = r; this.open(); }); }
}

export class ExcalidrawConverter implements ExcalidrawApi {
  /** `options`: the stored `features.excalidraw` palette overrides and scale, read per conversion. */
  constructor(
    private readonly app: App,
    private readonly options: () => { palette: Record<string, string>; scale: number } = () => ({ palette: {}, scale: 1 }),
  ) {}

  async cliConvert(params: Record<string, string>): Promise<string> {
    const format = params.format === "text" ? "text" : "json";
    const fail = (error: string) => format === "json" ? cliResultJson({ ok: false, error }) : `error: ${error}`;
    const file = this.app.vault.getAbstractFileByPath(params.path ?? "");
    if (!(file instanceof TFile)) return fail(`File "${params.path ?? ""}" not found.`);
    if (params.out !== undefined) {
      const bad = drawingPathError(params.out);
      if (bad) return fail(bad);
    }
    const content = await this.app.vault.cachedRead(file);
    const blocks = extractBlocks(content);
    const index = parseIndex(params.index);
    if (index === null) return fail(`index must be a non-negative integer (got "${params.index}").`);
    const block = blocks[index];
    if (!block) return fail(`No mermaid/pele diagram at index ${index} in "${file.path}" (${blocks.length} diagram(s)).`);
    const out = params.out ?? drawingPathFor(file.path, index, (p) => !!this.app.vault.getAbstractFileByPath(p));
    const res = await this.createDrawing(block.code, { path: out, open: false, force: cliFlag(params.force) });
    if (format === "text") return res.ok ? `ok ${res.out} ${res.fidelity} ${res.elements}` : `error: ${res.error ?? "conversion failed"}`;
    return cliResultJson({ ok: res.ok, out: res.out, fidelity: res.fidelity, elements: res.elements, dropped: res.dropped, ...(res.error ? { error: res.error } : {}) });
  }

  /**
   * The live theme's light --pele-* colours, from a hidden `.pele-host` (styles.css maps them to Obsidian's
   * variables). Excalidraw stores light colours and draws its dark mode by inverting them, so a drawing always
   * takes the light palette. Obsidian resolves its colour variables in `body{}` rules from the `.theme-light` /
   * `.theme-dark` base colours, so in a dark theme the probe sits in a hidden stand-in `body.theme-light` that
   * copies the real body's classes and inline variables (accent colour, theme settings).
   */
  resolveLivePalette(): Record<string, string> {
    const body = document.body;
    const standIn = body.classList.contains("theme-light") ? null : document.documentElement.createEl("body", {
      cls: [...body.className.split(/\s+/).filter((c) => c && c !== "theme-dark"), "theme-light"].join(" "),
      attr: { style: `${body.getAttribute("style") ?? ""};display:none;` },
    });
    const host = (standIn ?? body).createDiv({ cls: "pele-host pele-excalidraw-probe" });
    try {
      const cs = getComputedStyle(host);
      return resolvePalette((name) => cs.getPropertyValue(name));
    } finally {
      host.remove();
      standIn?.remove();
    }
  }

  convert(source: string, opts?: ConvertOptions): PeleToExcalidrawResult {
    const stored = this.options();
    const palette = opts?.palette ?? { ...this.resolveLivePalette(), ...stored.palette };
    return peleToExcalidraw(source, { palette, scale: opts?.scale ?? stored.scale, fontFamily: opts?.fontFamily });
  }

  private requireEA(): { ok: true; ea: EaLike } | { ok: false; error: string } {
    const check = checkExcalidraw(this.app);
    if (check.ok) return check;
    const error = check.reason === "missing"
      ? `the Excalidraw plugin is not installed. Install it: ${EXCALIDRAW_INSTALL_URL}`
      : check.reason === "disabled"
        ? "the Excalidraw plugin is installed but not enabled. Enable it in Settings → Community plugins."
        : `the Excalidraw plugin is too old. Conversion needs Excalidraw ${MIN_EXCALIDRAW_VERSION} or later.`;
    notice(error, 8000);
    return { ok: false, error };
  }

  private materialise(ea: EaLike, result: PeleToExcalidrawResult): ExcalidrawElementLike[] {
    const runtime = getExcalidrawPlugin(this.app)?.getCLIRuntime?.() ?? ea.getCLIRuntime?.();
    if (runtime?.convertToExcalidrawElements) return runtime.convertToExcalidrawElements(result.elements, { regenerateIds: false });
    return result.elements;
  }

  private stage(ea: EaLike, result: PeleToExcalidrawResult): void {
    ea.clear();
    for (const el of this.materialise(ea, result)) ea.elementsDict[el.id] = el;
    for (const [key, f] of Object.entries(result.files)) {
      ea.imagesDict[key] = { mimeType: f.mimeType, dataURL: f.dataURL, id: f.id, created: Date.now(), isHyperLink: false, hyperlink: null, file: null, hasSVGwithBitmap: false, latex: null };
    }
  }

  /** Conversion failure (e.g. clipboard text that is not a diagram) as a Notice + result, never a throw. */
  private tryConvert(source: string): { ok: true; result: PeleToExcalidrawResult } | { ok: false; error: string } {
    try {
      return { ok: true, result: this.convert(source) };
    } catch (e) {
      const error = `not a valid Pele diagram: ${errorMessage(e)}`;
      notice(error, 8000);
      return { ok: false, error };
    }
  }

  async createDrawing(source: string, opts?: DrawingOptions): Promise<DrawingResult> {
    if (opts?.path !== undefined) {
      const bad = drawingPathError(opts.path);
      if (bad) return notifyFailure(bad);
    }
    const eaCheck = this.requireEA();
    if (!eaCheck.ok) return failed(eaCheck.error);
    const ea = eaCheck.ea;
    const conv = this.tryConvert(source);
    if (!conv.ok) return failed(conv.error);
    const result = conv.result;
    const exists = (p: string) => !!this.app.vault.getAbstractFileByPath(p);
    const out = opts?.path ?? drawingPathFor(...await this.nameSource(source, opts?.sourcePath), exists);
    const existing = this.app.vault.getAbstractFileByPath(out);
    if (existing) {
      // Conversion ran, but nothing was written: keep its fidelity, report no elements.
      if (!opts?.force || !(existing instanceof TFile)) return { ...notifyFailure(`"${out}" already exists; pass force to overwrite.`), fidelity: result.fidelity };
      await this.app.fileManager.trashFile(existing);
    }
    // Preferred: Excalidraw's CLI "create" (validates skeletons, materialises with the installed version).
    if (result.fidelity === "native" && ea.executeCLI) {
      try {
        const res = await ea.executeCLI({ apiVersion: 1, command: "create", requestId: `pele-${Date.now()}`, path: out, elements: result.elements });
        if (res?.ok) {
          if (opts?.open !== false) await this.openDrawing(out);
          this.report(result);
          return succeeded(result, out);
        }
      } catch { /* fall through to the EA workbench path */ }
    }
    try {
      this.stage(ea, result);
      const created = await ea.create({ exactPath: out, silent: true, onNewPane: opts?.open !== false });
      // `silent` keeps ea.create from opening the file, so open it here as the CLI path does.
      if (opts?.open !== false) await this.openDrawing(created ?? out);
      this.report(result);
      return succeeded(result, created ?? out);
    } catch (e) {
      return notifyFailure(errorMessage(e), result);
    }
  }

  async insertIntoView(source: string): Promise<InsertResult> {
    const eaCheck = this.requireEA();
    if (!eaCheck.ok) return failed(eaCheck.error);
    const ea = eaCheck.ea;
    const conv = this.tryConvert(source);
    if (!conv.ok) return failed(conv.error);
    const result = conv.result;
    try {
      this.stage(ea, result);
      // addElementsToView needs ea.targetView; a fresh EA has none.
      ea.setView?.();
      const inserted = await ea.addElementsToView(true, true);
      if (!inserted) return notifyFailure("no active Excalidraw drawing. Open a drawing first, or create a new one instead.", result);
      this.report(result);
      return succeeded(result);
    } catch (e) {
      return notifyFailure(errorMessage(e), result);
    }
  }

  /** File and block index a new drawing is named after: the diagram's own file when known, else the active note. */
  private async nameSource(source: string, sourcePath: string | undefined): Promise<[string, number]> {
    const file = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : null;
    if (!(file instanceof TFile)) return [this.app.workspace.getActiveFile()?.path ?? "Pele.md", 0];
    // A top-level diagram keeps its `index=`; one in a callout or list item gets its own document position.
    const index = diagramIndexOf(await this.app.vault.cachedRead(file), source);
    return [file.path, Math.max(index, 0)];
  }

  private report(result: PeleToExcalidrawResult): void {
    if (result.fidelity === "image") notice("inserted as an image (this diagram type is not natively editable yet).", 6000);
    else if (result.dropped.length) notice(`converted with losses: ${result.dropped.slice(0, 3).join("; ")}${result.dropped.length > 3 ? ` (+${result.dropped.length - 3} more)` : ""}`, 8000);
  }

  private async openDrawing(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
  }

  async convertUnderCursor(editor: Editor, view: MarkdownView): Promise<void> {
    if (!this.requireEA().ok) return;
    const content = editor.getValue();
    const blocks = extractBlocks(content);
    const block = blockAtLine(blocks, editor.getCursor().line);
    if (!block || !view.file) { notice("no mermaid/pele diagram under the cursor."); return; }
    const index = blocks.indexOf(block);
    const out = drawingPathFor(view.file.path, index, (p) => !!this.app.vault.getAbstractFileByPath(p));
    await this.createDrawing(block.code, { path: out, open: true }); // failures are shown as a Notice
  }

  async promptAndInsert(): Promise<void> {
    let source: string | null = null;
    try { source = (await navigator.clipboard.readText()).trim() || null; } catch { source = null; }
    if (!source) source = await new SourcePromptModal(this.app).prompt();
    if (!source) return;
    await this.insertIntoView(source); // failures are shown as a Notice
  }
}
