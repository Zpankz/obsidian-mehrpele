/**
 * The plugin's settings tab, declarative (Obsidian 1.13+). Obsidian reads the
 * definitions when the tab is added, for app-wide search, so they are cheap
 * data; the tab parts load through `lazy.settingsTab()` and import no feature
 * code. Controls read and write dotted v3 keys through this class.
 */
import { Modal, Notice, PluginSettingTab, requestUrl, type SettingDefinitionItem, type TAbstractFile, TFile } from "obsidian";
import { forgetTextWidths } from "pele-render/pele";
import type PeleMermaidPlugin from "../../main";
import { isEnabledV3, normalizeInPlace, TOGGLE_IDS, type ToggleId } from "../settings/schema";
import { requestUrlGet } from "./assets";
import { FLOWS, type PluginManagerLike } from "./companions";
import { INTEGRATION_BLOCKS } from "./integration-blocks";
import { settingsTab } from "./lazy";
import { FEATURES } from "./registry";

interface PluginManager extends PluginManagerLike {
  enablePluginAndSave?(id: string): Promise<unknown>;
  disablePlugin?(id: string): Promise<unknown>;
  enablePlugin?(id: string): Promise<unknown>;
}

/** Feature options whose change re-lays out Mehrpele label layers too. */
const MEHRPELE_FEATURES = ["reflow", "live-view", "nested", "view-nodes"];

export class LazySettingTab extends PluginSettingTab {
  private parts: ReturnType<typeof settingsTab> | null = null;
  private folds: InstanceType<ReturnType<typeof settingsTab>["FoldState"]> | null = null;
  private readonly toggleKeys: Map<string, ToggleId>;
  private readonly flowRows = new Map<HTMLElement, () => void>();
  private readonly enabling = new Map<string, Promise<void>>();
  private flowDefinition: SettingDefinitionItem | null = null;

  constructor(private readonly plugin: PeleMermaidPlugin) {
    super(plugin.app, plugin);
    this.toggleKeys = new Map();
  }

  private tab(): ReturnType<typeof settingsTab> {
    if (!this.parts) {
      this.parts = settingsTab();
      for (const id of TOGGLE_IDS) this.toggleKeys.set(this.parts.enableKey(id), id);
    }
    return this.parts;
  }

  private get pluginManager(): PluginManager | undefined {
    return (this.app as unknown as { plugins?: PluginManager }).plugins;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const t = this.tab();
    this.folds ??= new t.FoldState(this.app);
    const app = this.app as unknown as { setting?: { openTabById?(id: string): unknown } };
    const definitions = t.buildDefinitions({
      app: this.app,
      value: (key) => this.getControlValue(key),
      set: (key, v) => this.setControlValue(key, v),
      enabled: (id) => isEnabledV3(this.plugin.settings, id),
      pendingReload: (id) => this.plugin.features?.pendingReload.has(id) ?? false,
      needsReload: (id) => FEATURES.some((d) => d.id === id && d.kind === "module" && d.reload === "needed"),
      plugins: () => this.pluginManager,
      flows: () => this.plugin.flowStatus(),
      watchFlows: (el, paint) => this.flowRows.set(el, paint),
      folds: this.folds,
      ollamaModels: () => this.plugin.ollamaModels,
      excalidrawStandsDown: () => this.plugin.excalidrawStandsDown(),
      run: {
        rerender: () => {
          this.plugin.rerenderAllMarkdownViews();
          new Notice("Mehrpele: re-rendering diagrams in open notes.");
        },
        testJev: () => void this.plugin.testJevConnection(),
        testLlm: () => void this.plugin.testLlmConnection(),
        useOllama: async () => {
          const llm = this.plugin.settings.llm;
          llm.baseUrl = "http://localhost:11434/v1";
          // Local reasoning models take minutes when they "think"; off answers in about a second.
          llm.reasoningEffort = "none";
          await this.plugin.saveSettings();
          await this.plugin.fetchOllamaModels();
          this.update();
        },
        reloadPlugin: async () => {
          const pm = this.pluginManager, id = this.plugin.manifest.id;
          await pm?.disablePlugin?.(id);
          await pm?.enablePlugin?.(id);
        },
        installTour: () => this.tour("install"),
        removeTour: () => this.tour("remove"),
        openCommunityPlugins: () => void app.setting?.openTabById?.("community-plugins"),
        openPluginPage: (id) => this.openPluginPage(id),
        enablePlugin: (id) => this.enableAddon(id),
        openPluginSettings: (id) => void this.openPluginSettings(id),
        updateHost: () => this.openPluginPage(this.plugin.manifest.id),
      },
    });
    const addons = definitions.find((d) => "heading" in d && d.heading === "Add-ons");
    this.flowDefinition = addons && "items" in addons ? addons.items?.[0] ?? null : null;
    return definitions;
  }

  /** Keep a visible action button intact, so live status changes retain keyboard focus. */
  refreshAddons(): void {
    for (const [el, paint] of this.flowRows) {
      if (el.isConnected) paint();
      else this.flowRows.delete(el);
    }
    if (!this.flowRows.size) this.update();
  }

  override hide(): void {
    this.flowRows.clear();
    super.hide();
  }

  private openPluginPage(id: string): void {
    if (id === FLOWS.id) {
      const modal = new Modal(this.app);
      modal.setTitle(`${FLOWS.name}: installation and updates`);
      for (const paragraph of FLOWS.installationHelp) modal.contentEl.createEl("p", { text: paragraph.replace("{vaultConfig}", this.app.vault.configDir) });
      const links = modal.contentEl.createEl("p");
      links.createEl("a", { text: "Installation instructions", href: FLOWS.installUrl, attr: { target: "_blank", rel: "noopener noreferrer" } });
      links.appendText(" · ");
      links.createEl("a", { text: "Download latest release", href: FLOWS.releaseUrl, attr: { target: "_blank", rel: "noopener noreferrer" } });
      modal.open();
      return;
    }
    const url = `obsidian://show-plugin?id=${encodeURIComponent(id)}`;
    try {
      const win = this.containerEl.ownerDocument.defaultView ?? window;
      if (typeof win.open !== "function") throw new Error("No link opener");
      win.open(url);
    } catch {
      new Notice(`Mehrpele: open ${url} to install or update the plugin.`);
    }
  }

  private openPluginSettings(id: string): boolean {
    const setting = (this.app as unknown as { setting?: { open?(): void; openTabById?(id: string): void } }).setting;
    try {
      if (typeof setting?.open !== "function" || typeof setting.openTabById !== "function") throw new Error("Settings navigation unavailable");
      setting.open();
      setting.openTabById(id);
      return true;
    } catch {
      new Notice(`Mehrpele: open Settings → ${id === FLOWS.id ? FLOWS.name : "Mehrpele"} manually.`);
      return false;
    }
  }

  openFlows(): void {
    if (!this.openPluginSettings(this.plugin.manifest.id)) return;
    try {
      const el = this.flowDefinition && this.getElementForDefinition(this.flowDefinition);
      if (el) { el.click(); return; }
    } catch { /* The private search-navigation hook may change across app versions. */ }
    new Notice("Mehrpele: open add-ons → flows.");
  }

  private enableAddon(id: string): Promise<void> {
    const pending = this.enabling.get(id);
    if (pending) return pending;
    const result = (async () => {
      try {
        const pm = this.pluginManager;
        if (typeof pm?.enablePluginAndSave !== "function") throw new Error("Plugin manager unavailable");
        await pm.enablePluginAndSave(id);
      } catch {
        new Notice(`Mehrpele: enable ${id === FLOWS.id ? FLOWS.name : id} in Settings → Community plugins.`);
      } finally {
        this.enabling.delete(id);
        this.plugin.refreshAddonHints();
        this.refreshAddons();
      }
    })();
    this.enabling.set(id, result);
    // Even a synchronous rejection must clear the entry after it has been stored.
    void result.then(() => this.enabling.delete(id));
    return result;
  }

  /**
   * Obsidian's search navigation asks for the row to scroll to (not in the
   * public API, so feature-detected); a folded section opens first so the row shows.
   */
  getElementForDefinition(def: unknown): HTMLElement | undefined {
    const base = (PluginSettingTab.prototype as unknown as { getElementForDefinition?: (d: unknown) => HTMLElement | undefined })
      .getElementForDefinition;
    const el = base?.call(this, def);
    this.tab().revealFolded(el);
    return el;
  }

  getControlValue(key: string): unknown {
    return this.tab().readControl(this.plugin.settings, key);
  }

  /** Write the v3 key, save (which syncs the feature registry), then apply the change live. */
  async setControlValue(key: string, value: unknown): Promise<void> {
    this.tab().writeControl(this.plugin.settings, key, value);
    // In place, so references held by live views stay current.
    normalizeInPlace(this.plugin.settings);
    await this.plugin.saveSettings();
    this.applyLive(key);
    // A feature toggle or the provider changes page summaries (On/Off, warnings, Reload needed, provider name): rebuild.
    if (this.toggleKeys.has(key) || key === "llm.provider") this.update();
    // A number field keeps showing what was typed; when the schema rounded or clamped it, rebuild to show the stored value.
    else if (typeof value === "number" && this.getControlValue(key) !== value) this.update();
    this.refreshDomState();
  }

  private applyLive(key: string): void {
    const p = this.plugin;
    if (key === "core.showAddonHints") return; // saveData already refreshed hints without rebuilding SVG.
    if (key === "core.overrideMermaid") {
      new Notice("Mehrpele: reload the plugin (or restart Obsidian) for the Mermaid change to take effect.", 6000);
      return;
    }
    if (key.startsWith("core.appearance.")) forgetTextWidths();
    if (key.startsWith("core.") || key.startsWith("features.")) p.refreshLiveMounts();
    const feature = key.split(".")[1] ?? "";
    if (key.startsWith("features.") && MEHRPELE_FEATURES.includes(feature)) p.refreshMehrpele();
    if (this.toggleKeys.get(key) === "bases") p.refreshBasesViews();
    if (key === "features.live-view.enabled") p.rerenderAllMarkdownViews();
    // Integration blocks: re-render so blocks (and their listeners) follow the toggle, Live Preview widgets included.
    const block = INTEGRATION_BLOCKS.find((b) => b.id === this.toggleKeys.get(key));
    if (block) p.rerenderAllMarkdownViews([block.lang]);
  }

  private async tour(op: "install" | "remove"): Promise<void> {
    const { app, plugin } = this;
    const vault = app.vault;
    // Obsidian sets the plugin folder for every installed plugin; the asset cache lives there.
    const dir = plugin.manifest.dir;
    if (!dir) {
      new Notice(`Mehrpele: couldn't ${op} the tour notes: the plugin folder is unknown.`);
      return;
    }
    const deps = {
      vault: {
        getAbstractFileByPath: (p: string) => vault.getAbstractFileByPath(p),
        getFiles: () => vault.getFiles(),
        createFolder: (p: string) => vault.createFolder(p),
        create: (p: string, data: string) => vault.create(p, data),
        read: (f: unknown) => (f instanceof TFile ? vault.read(f) : Promise.reject(new Error("Not a file"))),
        trash: (f: unknown) => app.fileManager.trashFile(f as TAbstractFile),
      },
      adapter: vault.adapter,
      dir,
      version: plugin.manifest.version,
      get: requestUrlGet(requestUrl),
    };
    const t = this.tab();
    try {
      if (op === "install") {
        const r = await t.installTour(deps);
        new Notice(`Mehrpele: added ${r.created.length} tour notes to the “Mehrpele tour” folder.`);
      } else {
        new Notice(t.removedMessage(await t.removeTour(deps)));
      }
    } catch (e) {
      new Notice(`Mehrpele: couldn't ${op} the tour notes: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
