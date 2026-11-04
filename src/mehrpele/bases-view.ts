/**
 * `mehrpele-diagram` Bases view: entries → generated Pele
 * source → the same measure/reserve/overlay mount as code blocks.
 * Uses only public Bases API: `groupedData`, `entry.getValue`,
 * `config.get/getAsPropertyId`. No undocumented internals.
 */
import {
  BasesView,
  Notice,
  type BasesAllOptions,
  type BasesEntry,
  type Plugin,
  type QueryController,
} from "obsidian";
import { generateBasesSource, type BaseEntryLike, type BasesNodeStyle } from "./bases-source";
import type { MehrpeleHost } from "./labels";
import { mountMehrpele, type MehrpeleMounted } from "./mount";
import type { MehrpeleSettings } from "./settings";

export const MEHRPELE_BASES_VIEW_TYPE = "mehrpele-diagram";
export const BASES_OFF = "Turn on Bases view in Mehrpele settings";

export function getDiagramViewOptions(): BasesAllOptions[] {
  return [
    { key: "linkProperty", type: "property", displayName: "Link property" },
    { key: "labelProperty", type: "property", displayName: "Label property" },
    {
      key: "kind",
      type: "dropdown",
      displayName: "Diagram kind",
      default: "flowchart",
      options: { flowchart: "Flowchart", mindmap: "Mindmap" },
    },
    {
      key: "direction",
      type: "dropdown",
      displayName: "Direction",
      default: "TD",
      options: { TD: "Top → bottom", LR: "Left → right", BT: "Bottom → top", RL: "Right → left" },
    },
    { key: "groupIntoSubgraphs", type: "toggle", displayName: "Group into subgraphs", default: true },
    { key: "maxNodes", type: "slider", displayName: "Max nodes", default: 100, min: 10, max: 500, step: 10 },
  ];
}

export interface MehrpeleBasesDeps {
  settings(): MehrpeleSettings;
  renderOptions(): unknown;
  /** The view's mount went live (true) or away (false): it renders with these options' math resolver. */
  liveMount?(mounted: MehrpeleMounted, live: boolean): void;
  /** Optional node styling (Extended Graph colours), resolved per rebuild. */
  nodeStyle?(): BasesNodeStyle | null;
  /** Nested diagrams in nodes (notes that are one diagram); see MehrpeleHost. */
  renderNestedDiagram?: MehrpeleHost["renderNestedDiagram"];
  /** The view loaded (true) or unloaded (false): a toggle refreshes live views. */
  liveView?(view: MehrpeleDiagramView, live: boolean): void;
}

export class MehrpeleDiagramView extends BasesView {
  type = MEHRPELE_BASES_VIEW_TYPE;
  private container: HTMLElement;
  private deps: MehrpeleBasesDeps;
  private mounted: MehrpeleMounted | null = null;
  private mountEl: HTMLElement | null = null;
  private statusEl: HTMLElement;
  private hostComponent = this;

  constructor(controller: QueryController, containerEl: HTMLElement, deps: MehrpeleBasesDeps) {
    super(controller);
    this.container = containerEl;
    this.deps = deps;
    containerEl.classList.add("mehrpele-bases-view");
    this.statusEl = createDiv();
    this.statusEl.className = "mehrpele-bases-status";
    containerEl.appendChild(this.statusEl);
    const copyBtn = createEl("button");
    copyBtn.className = "mehrpele-copy-source";
    copyBtn.textContent = "Copy diagram source";
    copyBtn.addEventListener("click", () => {
      const src = this.lastSource;
      if (!src) return;
      void navigator.clipboard
        .writeText(src)
        .then(() => new Notice("Mehrpele: diagram source copied."));
    });
    containerEl.appendChild(copyBtn);
  }

  private lastSource = "";

  onDataUpdated(): void {
    void this.rebuild();
  }

  /** Re-read the toggle (settings change). */
  refresh(): void {
    void this.rebuild();
  }

  onload(): void {
    this.deps.liveView?.(this, true);
  }

  private entryLikes(): BaseEntryLike[] {
    const labelProp = this.config.getAsPropertyId("labelProperty");
    const linkProp = this.config.getAsPropertyId("linkProperty");
    const out: BaseEntryLike[] = [];
    const groups = this.data?.groupedData ?? [];
    groups.forEach((group) => {
      const groupName = group.hasKey() ? safeText(group.key?.toString()) : null;
      for (const entry of group.entries) {
        out.push({
          path: entry.file.path,
          basename: entry.file.basename,
          label: labelProp ? safeValueText(entry, labelProp) : entry.file.basename,
          links: this.linksFor(entry, linkProp),
          group: groupName,
        });
      }
    });
    return out;
  }

  private linksFor(entry: BasesEntry, linkProp: string | null): string[] {
    const links: string[] = [];
    try {
      const cache = this.app.metadataCache.getCache(entry.file.path);
      const frontmatterLinks = (cache as unknown as {
        frontmatterLinks?: { key: string; link: string }[];
      } | null)?.frontmatterLinks;
      if (Array.isArray(frontmatterLinks)) {
        for (const fl of frontmatterLinks) {
          if (linkProp) {
            const wanted = propertyName(linkProp);
            if (fl.key !== wanted && !fl.key.startsWith(`${wanted}.`)) continue;
          }
          const dest = this.app.metadataCache.getFirstLinkpathDest(fl.link, entry.file.path);
          links.push(dest ? dest.path : fl.link);
        }
      }
    } catch {
      /* malformed cache: entry renders without links */
    }
    return links;
  }

  private async rebuild(): Promise<void> {
    // Registered once per plugin life (no Bases unregister): inert while the toggle is off.
    if (!this.deps.settings().basesViewEnabled) {
      if (this.mounted) this.deps.liveMount?.(this.mounted, false);
      this.mounted?.destroy();
      this.mounted = null;
      // Only the diagram goes: the status line and copy button stay for when it comes back.
      this.mountEl?.remove();
      this.mountEl = null;
      this.lastSource = "";
      this.statusEl.textContent = BASES_OFF;
      return;
    }
    const kind = (this.config.get("kind") as string) === "mindmap" ? "mindmap" : "flowchart";
    const direction = (this.config.get("direction") as string) || "TD";
    const groupIntoSubgraphs = this.config.get("groupIntoSubgraphs") !== false;
    const maxNodesRaw = Number(this.config.get("maxNodes"));
    const maxNodes = Number.isFinite(maxNodesRaw) && maxNodesRaw > 0 ? maxNodesRaw : 100;

    const style = this.deps.nodeStyle?.() ?? undefined;
    const result = generateBasesSource(this.entryLikes(), {
      kind, direction, groupIntoSubgraphs, maxNodes, style,
    });
    this.lastSource = result.source;
    this.statusEl.textContent = result.truncated
      ? `${result.nodeCount} notes · ${result.edgeCount} links · truncated at ${maxNodes}`
      : `${result.nodeCount} notes · ${result.edgeCount} links`;

    const deps = this.deps;
    const host: MehrpeleHost = {
      app: this.app,
      component: this.hostComponent,
      sourcePath: "",
      get settings() {
        return deps.settings();
      },
      renderOptions: () => this.deps.renderOptions(),
      ...(this.deps.renderNestedDiagram ? { renderNestedDiagram: this.deps.renderNestedDiagram } : {}),
    };
    if (this.mounted) {
      await this.mounted.update(result.source);
    } else {
      const mountTarget = createDiv();
      mountTarget.className = "mehrpele-bases-mount";
      this.container.appendChild(mountTarget);
      this.mountEl = mountTarget;
      const mounted = await mountMehrpele(mountTarget, result.source, host);
      // Turned off (or rebuilt) while mounting: this mount is stale.
      if (this.mountEl !== mountTarget) {
        mounted.destroy();
        return;
      }
      this.mounted = mounted;
      this.deps.liveMount?.(this.mounted, true);
    }
  }

  onunload(): void {
    this.deps.liveView?.(this, false);
    if (this.mounted) this.deps.liveMount?.(this.mounted, false);
    this.mounted?.destroy();
    this.mounted = null;
    this.mountEl = null;
    this.container.replaceChildren();
  }
}

function propertyName(propertyId: string): string {
  const dot = propertyId.indexOf(".");
  return dot >= 0 ? propertyId.slice(dot + 1) : propertyId;
}

function safeText(v: string | undefined | null): string | null {
  const t = (v ?? "").trim();
  return t ? t : null;
}

function safeValueText(entry: BasesEntry, prop: Parameters<BasesEntry["getValue"]>[0]): string {
  try {
    const v = entry.getValue(prop);
    const text = v?.toString().trim();
    return text ? text : entry.file.basename;
  } catch {
    return entry.file.basename;
  }
}

/**
 * Register the `mehrpele-diagram` Bases view (gated by settings).
 * Returns false when Bases is disabled or the setting is off.
 */
export function registerMehrpeleBasesView(plugin: Plugin, deps: MehrpeleBasesDeps): boolean {
  if (!deps.settings().basesViewEnabled) return false;
  let registered = false;
  try {
    registered = plugin.registerBasesView(MEHRPELE_BASES_VIEW_TYPE, {
      name: "Diagram",
      icon: "workflow",
      factory: (controller, containerEl) => new MehrpeleDiagramView(controller, containerEl, deps),
      options: getDiagramViewOptions,
    });
  } catch (e) {
    console.warn("[mehrpele] could not register Bases view", e);
    return false;
  }
  if (!registered) {
    new Notice("Mehrpele: Bases is not enabled in this vault; the diagram view is unavailable.");
  }
  return registered;
}
