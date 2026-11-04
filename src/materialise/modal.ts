/** Preview modal: what a materialise run would create, write and rewrite. Confirm or cancel. */
import { App, Modal, Setting } from "obsidian";
import type { ExistingPolicy, MaterialisePlan, NoteAction } from "./plan";

export interface PreviewChoices {
  onExisting: ExistingPolicy;
  rewrite: boolean;
  root: string;
}

export interface PreviewHooks {
  /** Re-plan with new choices; returns the new plan or an error message. */
  replan(choices: PreviewChoices): MaterialisePlan | string;
  confirm(plan: MaterialisePlan): void;
  /** Extra warnings shown above the plan (e.g. Mehrpele is off). */
  notices?: (plan: MaterialisePlan) => string[];
}

const ACTION_TEXT: Record<NoteAction, string> = {
  create: "create",
  reuse: "already there",
  link: "link existing",
  skip: "skip",
  media: "media, left as is",
};

/** Scrolling, wrapped source pane (styles.css: `.pele-materialise-pre`). */
function preStyle(pre: HTMLElement): void {
  pre.addClass("pele-materialise-pre");
}

export class MaterialisePreviewModal extends Modal {
  private plan: MaterialisePlan;
  private choices: PreviewChoices;
  private body!: HTMLElement;
  private confirmed = false;

  constructor(app: App, plan: MaterialisePlan, choices: PreviewChoices, private hooks: PreviewHooks) {
    super(app);
    this.plan = plan;
    this.choices = { ...choices };
  }

  onOpen(): void {
    // Wide modal (styles.css: `.pele-materialise-modal`).
    this.modalEl.addClass("pele-materialise-modal");
    this.titleEl.setText("Materialise diagram as notes");
    const controls = this.contentEl.createDiv({ cls: "pele-materialise-controls" });
    new Setting(controls).setName("Root folder").addText((t) => {
      t.setValue(this.choices.root);
      t.inputEl.addEventListener("change", () => this.update({ root: t.getValue() }));
    });
    new Setting(controls).setName("When a note already exists").addDropdown((d) =>
      d
        .addOption("link", "Link to it")
        .addOption("skip", "Skip the node")
        .addOption("suffix", "Create with a suffix")
        .setValue(this.choices.onExisting)
        .onChange((v) => this.update({ onExisting: v as ExistingPolicy })),
    );
    new Setting(controls).setName("Rewrite the diagram block").addToggle((t) =>
      t.setValue(this.choices.rewrite).onChange((v) => this.update({ rewrite: v })),
    );
    this.body = this.contentEl.createDiv({ cls: "pele-materialise-body" });
    this.renderPlan();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private update(patch: Partial<PreviewChoices>): void {
    this.choices = { ...this.choices, ...patch };
    const next = this.hooks.replan(this.choices);
    if (typeof next === "string") {
      this.body.empty();
      this.body.createEl("p", { text: next, cls: "mod-warning" });
      return;
    }
    this.plan = next;
    this.renderPlan();
  }

  private renderPlan(): void {
    const plan = this.plan;
    const el = this.body;
    el.empty();
    const warn = [...(this.hooks.notices?.(plan) ?? []), ...plan.warnings];
    if (warn.length) {
      const box = el.createDiv({ cls: "pele-materialise-warnings" });
      for (const w of warn) box.createDiv({ text: `⚠ ${w}` });
    }
    const creates = plan.notes.filter((n) => n.action === "create");
    const newFolders = plan.folders.filter((f) => f.status === "create");
    el.createEl("p", {
      text: plan.empty
        ? "Nothing to do: this diagram is already materialised."
        : `${newFolders.length} folder(s) and ${creates.length} note(s) to create, ${plan.properties.length} property write(s) on existing notes${plan.rewrite ? ", block rewrite" : ""}.`,
    });

    if (newFolders.length) {
      el.createEl("h4", { text: "Folders" });
      const ul = el.createEl("ul");
      for (const f of newFolders) ul.createEl("li", { text: `${f.path}/` });
    }

    el.createEl("h4", { text: "Notes" });
    const table = el.createEl("table", { cls: "pele-materialise-table" });
    const head = table.createEl("tr");
    for (const h of ["Node", "Note", "Action", "Properties"]) head.createEl("th", { text: h });
    for (const n of plan.notes) {
      const tr = table.createEl("tr", { cls: `pele-materialise-${n.action}` });
      tr.createEl("td", { text: n.nodeId });
      tr.createEl("td", { text: n.path || "—" });
      const act = tr.createEl("td", { text: ACTION_TEXT[n.action] });
      if (n.reason) act.setAttr("title", n.reason);
      const props = Object.entries(n.properties ?? {}).map(([k, v]) => `${k}: ${v.join(", ")}`);
      tr.createEl("td", { text: props.join("; ") });
    }

    if (plan.properties.length) {
      el.createEl("h4", { text: "Properties on existing notes" });
      const ul = el.createEl("ul");
      for (const p of plan.properties) ul.createEl("li", { text: `${p.path} · ${p.key} += ${p.add.map((a) => a.link).join(", ")}` });
    }

    if (plan.rewrite) {
      el.createEl("h4", { text: "Diagram block" });
      const cols = el.createDiv({ cls: "pele-materialise-diff" });
      const before = cols.createDiv();
      before.createDiv({ text: "Before", cls: "pele-materialise-diff-title" });
      preStyle(before.createEl("pre", { text: plan.rewrite.before }));
      const after = cols.createDiv();
      after.createDiv({ text: "After", cls: "pele-materialise-diff-title" });
      preStyle(after.createEl("pre", { text: plan.rewrite.after }));
    }

    const buttons = new Setting(el);
    if (plan.empty) {
      buttons.addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
      return;
    }
    buttons
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Materialise")
          .setCta()
          .onClick(() => {
            if (this.confirmed) return;
            this.confirmed = true;
            this.close();
            this.hooks.confirm(this.plan);
          }),
      );
  }
}
