/** Confirmation and repair review modals. */
import {
  Modal, Setting, type App
} from "obsidian";
import {
  diffLines,
  playgroundUrl as enginePlaygroundUrl
} from "pele-render/repair";
import { buildPlaygroundUrl } from "./render-policy";

export class ConfirmModal extends Modal {
  private done = false;
  constructor(
    app: App,
    private title: string,
    private body: string,
    private onConfirm: () => void,
    private onCancel?: () => void,
  ) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("pre", { text: this.body, cls: "pele-config-preview" });
    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Continue")
          .setCta()
          .onClick(() => {
            this.done = true;
            this.close();
            this.onConfirm();
          }),
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }
  onClose(): void {
    if (!this.done) this.onCancel?.();
    this.contentEl.empty();
  }
}

export class RepairPreviewModal extends Modal {
  private settled = false;
  constructor(
    app: App,
    private oldSource: string,
    private newSource: string,
    private resolve: (apply: boolean) => void,
    private dropped?: string[],
    private modelTier?: "jev" | "llm",
  ) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Repair preview" });
    if (this.modelTier) {
      contentEl.createEl("p", {
        cls: "pele-settings-note",
        text: `This fix came from the ${this.modelTier === "llm" ? "LLM" : "Jev"} tier (model output), so it is always shown for review before it edits the note.`,
      });
    }
    if (this.dropped) {
      contentEl.createEl("p", {
        cls: "pele-lossy-note",
        text: `This repair is lossy — it removes or comments out: ${this.dropped.length > 0 ? this.dropped.join(", ") : "content"}. Review the diff before applying.`,
      });
    }
    const pre = contentEl.createEl("pre", { cls: "pele-diff" });
    for (const line of diffLines(this.oldSource, this.newSource).split("\n")) {
      const div = pre.createDiv({
        cls: line.startsWith("+")
          ? "pele-diff-add"
          : line.startsWith("-")
            ? "pele-diff-del"
            : "pele-diff-ctx",
      });
      div.textContent = line;
    }
    const row = contentEl.createDiv({ cls: "pele-modal-buttons" });
    const apply = row.createEl("button", { text: "Apply", cls: "mod-cta" });
    apply.addEventListener("click", () => {
      this.settled = true;
      this.resolve(true);
      this.close();
    });
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
  }
  onClose(): void {
    if (!this.settled) this.resolve(false);
    this.contentEl.empty();
  }
}

export class RepairFailureModal extends Modal {
  constructor(
    app: App,
    private message: string,
    private tiersRan: string,
    private source: string,
  ) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Repair failed" });
    contentEl.createEl("p", {
      text: `No tier could fix this diagram (tried: ${this.tiersRan}). Last error: ${this.message}`,
    });
    const row = contentEl.createDiv({ cls: "pele-modal-buttons" });
    const open = row.createEl("button", { text: "Open in playground", cls: "mod-cta"});
    open.addEventListener("click", () => {
      const url = enginePlaygroundUrl(this.source) ?? buildPlaygroundUrl(this.source);
      if (url) window.open(url);
      this.close();
    });
    const close = row.createEl("button", { text: "Close" });
    close.addEventListener("click", () => this.close());
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
