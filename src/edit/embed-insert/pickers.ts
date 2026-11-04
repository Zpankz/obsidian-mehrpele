/**
 * Pickers for the insert-embed popover, on Obsidian's own modals: file and
 * folder suggests (FuzzySuggestModal), a choice list (SuggestModal) and a
 * one-line prompt. Each resolves with the choice and the event that made it
 * (only a genuine event writes), or null when dismissed.
 */
import { App, FuzzySuggestModal, Modal, Setting, SuggestModal, TFile, TFolder, type FuzzyMatch } from "obsidian";

export interface Picked<T> {
  value: T;
  evt: MouseEvent | KeyboardEvent;
}

/** Resolve null on close unless a choice arrived (Obsidian closes before it chooses). */
function settle<T>(resolve: (v: Picked<T> | null) => void): { choose(v: Picked<T>): void; closed(): void } {
  let done = false;
  return {
    choose: (v) => {
      done = true;
      resolve(v);
    },
    closed: () => window.setTimeout(() => !done && resolve(null), 0),
  };
}

class FilePick extends FuzzySuggestModal<TFile | TFolder> {
  constructor(
    app: App,
    private items: (TFile | TFolder)[],
    placeholder: string,
    private s: ReturnType<typeof settle<TFile | TFolder>>,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
    this.emptyStateText = "Nothing to embed here yet";
  }
  getItems(): (TFile | TFolder)[] {
    return this.items;
  }
  getItemText(f: TFile | TFolder): string {
    return f instanceof TFolder ? `${f.path || "/"}/` : f.path;
  }
  renderSuggestion(m: FuzzyMatch<TFile | TFolder>, el: HTMLElement): void {
    super.renderSuggestion(m, el);
    el.addClass("pele-embed-insert-suggestion");
  }
  onChooseItem(f: TFile | TFolder, evt: MouseEvent | KeyboardEvent): void {
    this.s.choose({ value: f, evt });
  }
  onClose(): void {
    super.onClose();
    this.s.closed();
  }
}

/** Pick a file (by extension filter) or a folder. */
export function pickFile(app: App, filter: (f: TFile | TFolder) => boolean, placeholder: string): Promise<Picked<TFile | TFolder> | null> {
  return new Promise((resolve) => {
    const items = app.vault.getAllLoadedFiles().filter((f): f is TFile | TFolder => (f instanceof TFile || f instanceof TFolder) && filter(f));
    new FilePick(app, items, placeholder, settle(resolve)).open();
  });
}

class ChoicePick extends SuggestModal<{ id: string; label: string; detail?: string }> {
  constructor(
    app: App,
    private choices: { id: string; label: string; detail?: string }[],
    placeholder: string,
    private s: ReturnType<typeof settle<string>>,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }
  getSuggestions(q: string): { id: string; label: string; detail?: string }[] {
    const l = q.toLowerCase();
    return this.choices.filter((c) => c.label.toLowerCase().includes(l) || c.id.toLowerCase().includes(l));
  }
  renderSuggestion(c: { id: string; label: string; detail?: string }, el: HTMLElement): void {
    el.createDiv({ text: c.label });
    if (c.detail) el.createEl("small", { text: c.detail, cls: "pele-embed-insert-detail" });
  }
  onChooseSuggestion(c: { id: string }, evt: MouseEvent | KeyboardEvent): void {
    this.s.choose({ value: c.id, evt });
  }
  onClose(): void {
    super.onClose();
    this.s.closed();
  }
}

/** Pick one of `choices` (ids). */
export function pickChoice(app: App, choices: { id: string; label: string; detail?: string }[], placeholder: string): Promise<Picked<string> | null> {
  return new Promise((resolve) => new ChoicePick(app, choices, placeholder, settle(resolve)).open());
}

class Prompt extends Modal {
  private value = "";
  constructor(
    app: App,
    private opts: { title: string; placeholder: string; button: string; initial?: string; validate?: (v: string) => string | null },
    private s: ReturnType<typeof settle<string>>,
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    this.value = this.opts.initial ?? "";
    let input: HTMLInputElement | null = null;
    const err = this.contentEl.createDiv({ cls: "pele-embed-insert-error" });
    const submit = (evt: MouseEvent | KeyboardEvent): void => {
      const problem = this.opts.validate?.(this.value) ?? null;
      if (problem) {
        err.setText(problem);
        return;
      }
      this.s.choose({ value: this.value, evt });
      this.close();
    };
    new Setting(this.contentEl)
      .addText((t) => {
        input = t.inputEl;
        t.setPlaceholder(this.opts.placeholder).setValue(this.value).onChange((v) => (this.value = v));
        t.inputEl.addClass("pele-embed-insert-input");
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.isComposing) {
            e.preventDefault();
            submit(e);
          }
        });
      })
      .addButton((b) => b.setButtonText(this.opts.button).setCta().onClick((e) => submit(e)));
    window.setTimeout(() => (input)?.focus(), 0);
  }
  onClose(): void {
    this.contentEl.empty();
    this.s.closed();
  }
}

/** A one-line prompt (URL, search query). */
export function prompt(app: App, opts: { title: string; placeholder: string; button: string; initial?: string; validate?: (v: string) => string | null }): Promise<Picked<string> | null> {
  return new Promise((resolve) => new Prompt(app, opts, settle(resolve)).open());
}

export const IMAGE_EXT = /^(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
