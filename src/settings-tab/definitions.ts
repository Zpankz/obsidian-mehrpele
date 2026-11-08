/**
 * The settings tab as declarative definitions: plain data plus closures over
 * a `TabContext`. Obsidian builds these at `addSettingTab` time to index them
 * for search, so this module must stay cheap and must not import feature code;
 * every action goes through the context.
 */
import {
  type App, type ExtraButtonComponent, Platform, requireApiVersion, SecretComponent, type Setting, type SettingDefinition,
  type SettingDefinitionGroup, type SettingDefinitionItem, type SettingDefinitionPage, type SettingGroupItem,
} from "obsidian";
import { type Companion, COMPANIONS, companionStatus, detectCompanion, missingCompanion, type PluginManagerLike } from "../features/companions";
import { detectFlows, FLOWS, type FlowStatus } from "../features/companions";
import { parseConfigJson } from "../render-policy";
import type { ToggleId } from "../settings/schema";
import { FOLDED_CLASS, type FoldState } from "./folds";

export interface TabContext {
  app: App;
  /** Current value of a dotted v3 key, as its control shows it. */
  value(key: string): unknown;
  /** Write a key the way a control would (for imperative rows). */
  set(key: string, value: unknown): Promise<void>;
  enabled(id: ToggleId): boolean;
  /** Turned off but still running until the plugin reloads. */
  pendingReload(id: ToggleId): boolean;
  /** Does turning this feature off need a plugin reload? */
  needsReload(id: ToggleId): boolean;
  plugins(): PluginManagerLike | undefined;
  flows?(): FlowStatus;
  watchFlows?(el: HTMLElement, paint: () => void): void;
  folds: FoldState;
  ollamaModels(): string[];
  excalidrawStandsDown(): boolean;
  run: {
    rerender(): void;
    testJev(): void;
    testLlm(): void;
    useOllama(): Promise<void>;
    reloadPlugin(): Promise<void>;
    installTour(): Promise<void>;
    removeTour(): Promise<void>;
    openCommunityPlugins(): void;
    openPluginPage(id: string): void;
    enablePlugin(id: string): Promise<void>;
    openPluginSettings?(id: string): void;
    updateHost?(): void;
  };
}

/** The v3 key of a feature's enable toggle. */
export function enableKey(id: ToggleId): string {
  return id.startsWith("integrations.")
    ? `features.integrations.${id.slice("integrations.".length)}.enabled`
    : `features.${id}.enabled`;
}

/** Search words a page carries (Obsidian's page type has no `aliases`; the Features filter reads this). */
export type PageDef = SettingDefinitionPage & { aliases: string[]; featureId?: ToggleId };

/** Badge text appended to desktop-only rows. */
export const DESKTOP_ONLY = "Desktop only";
const desktopOnly = (): boolean => Platform.isMobile;
const badge = (desc: string, b: string): string => `${desc} ${b}.`;

/** The top-level sections that fold. */
export const SECTIONS = ["appearance", "features", "addons", "security", "learn", "advanced"] as const;
export type SectionId = (typeof SECTIONS)[number];

// -- small builders -------------------------------------------------------------

type Def = SettingDefinition;
type Extra = Partial<Pick<SettingDefinition, "aliases" | "visible">> & { disabled?: () => boolean };

function toggle(key: string, name: string, desc: string, extra: Extra = {}): Def {
  const { disabled, ...rest } = extra;
  return { name, desc, ...rest, control: { type: "toggle", key, ...(disabled ? { disabled } : {}) } };
}

function text(key: string, name: string, desc: string, placeholder = "", extra: Extra = {}): Def {
  const { disabled, ...rest } = extra;
  return { name, desc, ...rest, control: { type: "text", key, placeholder, ...(disabled ? { disabled } : {}) } };
}

function num(key: string, name: string, desc: string, min?: number, max?: number, extra: Extra & { step?: number } = {}): Def {
  const { step, ...rest } = extra;
  return { name, desc, ...rest, control: { type: "number", key, min, max, ...(step ? { step } : {}) } };
}

/**
 * A text row for a list the schema can rewrite (an emptied list falls back to
 * the defaults): it saves as the user types, like a text control, and shows
 * the stored list once it loses focus.
 */
function listText(ctx: TabContext, key: string, name: string, desc: string, placeholder: string, extra: Extra = {}): Def {
  return {
    name, desc, ...extra,
    render: (s: Setting) => {
      s.addText((t) => {
        const stored = () => {
          const v = ctx.value(key);
          return typeof v === "string" ? v : "";
        };
        t.setPlaceholder(placeholder).setValue(stored()).onChange((v) => void ctx.set(key, v));
        t.inputEl.addEventListener("blur", () => void t.setValue(stored()));
      });
    },
  };
}

function dropdown(key: string, name: string, desc: string, options: Record<string, string>, extra: Extra = {}): Def {
  return { name, desc, ...extra, control: { type: "dropdown", key, options } };
}

const percent = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * Secret controls need 1.13.2. Older apps get a SecretComponent row (1.11.1+)
 * writing the same key, so a pasted key never lands in data.json as text.
 */
function secret(ctx: TabContext, key: string, name: string, desc: string, extra: Extra = {}): Def {
  if (requireApiVersion("1.13.2")) return { name, desc, ...extra, control: { type: "secret", key } };
  return {
    name, desc, ...extra,
    render: (s: Setting) => {
      const id = ctx.value(key);
      s.addComponent((el) =>
        new SecretComponent(ctx.app, el).setValue(typeof id === "string" ? id : "").onChange((v) => {
          if (v) void ctx.set(key, v);
        }),
      );
    },
  };
}

function button(name: string, desc: string, label: string, onClick: () => unknown, extra: Extra = {}): Def {
  return {
    name, desc, ...extra,
    render: (s: Setting) => {
      s.addButton((b) => b.setButtonText(label).onClick(() => void onClick()));
    },
  };
}

/** A section with a fold chevron in its heading. Folding is a CSS class, so search still finds every row. */
function section(ctx: TabContext, id: SectionId, heading: string, items: SettingGroupItem[], extra: Partial<SettingDefinitionGroup> = {}): SettingDefinitionGroup {
  const cls = `mehrpele-section-${id}`;
  return {
    type: "group",
    heading,
    cls,
    ...extra,
    items,
    extraButtons: [
      (b: ExtraButtonComponent) => {
        const paint = () => {
          const folded = ctx.folds.isFolded(id);
          b.setIcon(folded ? "chevron-right" : "chevron-down");
          b.setTooltip(folded ? `Show ${heading.toLowerCase()}` : `Hide ${heading.toLowerCase()}`);
          b.extraSettingsEl.setAttribute("aria-expanded", String(!folded));
          b.extraSettingsEl.closest(`.${cls}`)?.classList.toggle(FOLDED_CLASS, folded);
        };
        // Core's extra button is already a tab stop with Enter/Space; it only lacks the role that aria-expanded needs.
        b.extraSettingsEl.setAttribute("role", "button");
        paint();
        // The header may be attached to its group only after this callback.
        window.setTimeout(paint, 0);
        b.onClick(() => {
          ctx.folds.set(id, !ctx.folds.isFolded(id));
          paint();
        });
      },
    ],
  };
}

// -- feature pages -----------------------------------------------------------------

interface PageSpec {
  id: ToggleId;
  name: string;
  desc: string;
  aliases: string[];
  options?: (ctx: TabContext) => Def[];
  /** Rows shown on the page above Options, e.g. a stand-down banner. */
  notes?: (ctx: TabContext) => Def[];
  desktop?: boolean;
}

interface Category {
  name: string;
  pages: PageSpec[];
  /** Extra pages that are not a single feature. */
  extra?: (ctx: TabContext) => PageDef[];
}

const on = (ctx: TabContext, key: string) => () => ctx.value(key) === true;

const CATEGORIES: readonly Category[] = [
  {
    name: "Viewing",
    pages: [{
      id: "pan-zoom",
      name: "Pan and zoom inside diagrams",
      desc: "Drag and scroll to move around a diagram where it sits, instead of opening the lightbox.",
      aliases: ["pan", "zoom", "pan and zoom", "lightbox", "in-place zoom"],
      options: () => [
        dropdown("features.pan-zoom.mode", "When to pan and zoom", "Auto starts once you click into a diagram; always makes every diagram pannable.", {
          auto: "Auto", always: "Always",
        }),
      ],
    }],
  },
  {
    name: "Layout",
    pages: [{
      id: "reflow",
      name: "Fit diagrams to the column",
      desc: "Lay wide diagrams out again so they fit the note's width.",
      aliases: ["reflow", "responsive layout", "fit to width", "narrow notes", "text scale"],
      options: () => [
        toggle("features.reflow.switchDirection", "Switch direction to fit", "Turn a left-to-right flowchart top-to-bottom when that fits the column better.", {
          aliases: ["switch direction", "auto turn", "rotate"],
        }),
        {
          name: "Smallest text size",
          desc: "Fitting never shrinks text below this share of its normal size.",
          control: { type: "slider", key: "features.reflow.minTextScale", min: 0.3, max: 1, step: 0.05, displayFormat: percent },
        },
      ],
    }],
  },
  {
    name: "Editing",
    pages: [
      {
        id: "toolbar",
        name: "Editing toolbar",
        desc: "Hover or select a node to restyle, add, connect or delete it.",
        aliases: ["toolbar", "edit", "edit toolbar", "canvas menu", "quick add", "add node", "drag to connect", "colour", "color", "palette"],
      },
      {
        id: "inline-edit",
        name: "Edit labels in place",
        desc: "Double-click a node or edge label to type over it in the diagram.",
        aliases: ["edit in place", "inline text editing", "label editor", "double-click", "rename node"],
      },
      {
        id: "autocomplete",
        name: "Suggest labels for new nodes",
        desc: "An AI model suggests a label when you add a node; it sends the diagram source to your AI provider.",
        aliases: ["autocomplete", "label suggestions", "node autocomplete", "AI", "LLM"],
        options: () => [
          text("features.autocomplete.model", "Autocomplete model", "Empty uses the model set under AI model provider.", "", {
            aliases: ["model"],
          }),
        ],
      },
      {
        id: "resize",
        name: "Resize nodes by dragging",
        desc: "Hover a node and drag its corner handle to size it; double-click the handle to reset.",
        aliases: ["node resize", "resize handles", "pele-size", "node size"],
      },
    ],
  },
  {
    name: "Markdown labels",
    pages: [
      {
        id: "live-view",
        name: "Markdown in diagram labels",
        desc: "Labels render as Markdown, with links, embeds and note cards.",
        aliases: ["mehrpele", "markdown labels", "live view", "embeds", "note cards", "wikilinks"],
        options: (ctx) => [
          dropdown("features.live-view.mermaidLabelMode", "Markdown labels in mermaid blocks", "Mehrpele blocks always use Markdown labels; this sets what plain mermaid blocks do.", {
            directive: "Only with the mehrpele directive", always: "Always",
          }),
          toggle("features.live-view.embeds", "Show embeds in labels", "A label that is only an embed shows the note, base or canvas itself."),
          toggle("features.live-view.noteCardLabels", "Show note names on note nodes", "A node that embeds a note shows the note's name above it, as Canvas file cards do."),
          num("features.live-view.maxLabelWidth", "Widest label", "In pixels.", 1),
          num("features.live-view.maxLabelHeight", "Tallest label", "In pixels.", 1),
          num("features.live-view.maxEmbedWidth", "Widest embed", "In pixels.", 1, undefined, { visible: on(ctx, "features.live-view.embeds") }),
          num("features.live-view.maxEmbedHeight", "Tallest embed", "In pixels.", 1, undefined, { visible: on(ctx, "features.live-view.embeds") }),
          num("features.live-view.maxLabels", "Most Markdown labels per diagram", "Past this, the remaining labels show as plain text.", 1),
          {
            name: "Smallest embed size",
            desc: "At 0% embeds keep their written size exactly; above it, they never shrink below this share of their natural size.",
            aliases: ["legible", "exact", "embed sizing"],
            control: { type: "slider", key: "features.live-view.minEmbedScale", min: 0, max: 1, step: 0.05, displayFormat: percent },
          },
        ],
      },
      {
        id: "nested",
        name: "Diagrams inside nodes",
        desc: "A node that embeds a diagram draws that diagram inside itself.",
        aliases: ["nested diagrams", "nesting", "diagram in diagram", "depth"],
        options: () => [
          num("features.nested.maxDepth", "Deepest nesting", "Diagram levels allowed inside a diagram, from 0 to 8; deeper ones show as a plain label.", 0, 8, { step: 1 }),
        ],
      },
      {
        id: "bases",
        name: "Diagram view for Bases",
        desc: "Adds a Diagram view type to Bases that draws the base's notes as a diagram.",
        aliases: ["bases", "bases view", "diagram view", "mehrpele-diagram"],
      },
      {
        id: "view-nodes",
        name: "Live views inside nodes",
        desc: "A node can show a live Obsidian view, such as a graph, search or web page.",
        aliases: ["view nodes", "pele-view", "live views", "attached views", "web pages"],
        options: (ctx) => [
          toggle("features.view-nodes.attachedViews", "Attached-view button", "Hovering a node with attached views shows a button that opens them in a panel."),
          num("features.view-nodes.maxLiveViews", "Most live views at once", "From 1 to 32; further views wait as a placeholder until clicked.", 1, 32),
          toggle("features.view-nodes.webEnabled", "Web pages in nodes", badge("A node can load a web page from an allowed scheme.", DESKTOP_ONLY), {
            disabled: desktopOnly,
            aliases: ["web", "webview", "browser"],
          }),
          listText(ctx, "features.view-nodes.allowedSchemes", "Allowed URL schemes", "Comma-separated, and empty means https, http; obsidian, file, javascript and data are never loaded.", "https, http", {
            visible: on(ctx, "features.view-nodes.webEnabled"),
          }),
        ],
      },
    ],
  },
  {
    name: "Repair",
    pages: [{
      id: "repair",
      name: "Repair broken diagrams",
      desc: "A diagram that fails to render shows a button that offers a fix, checked with Pele before it is applied.",
      aliases: ["repair", "fix", "validate", "linter", "wrench", "Jev"],
      options: (ctx) => {
        const jev = on(ctx, "features.repair.jev.enabled");
        return [
          toggle("features.repair.preview", "Preview before applying", "Show the change and ask before a repair edits the note."),
          toggle("features.repair.jev.enabled", "Rank fixes with Jev", "Sends the diagram source to the Jev service to choose between tied local fixes."),
          secret(ctx, "features.repair.jev.keySecretId", "Jev API key", "Kept in Obsidian's secret storage.", { visible: jev }),
          text("features.repair.jev.baseUrl", "Jev base URL", "The Jev service address.", "https://api.typesafe.ai", { visible: jev }),
          text("features.repair.jev.model", "Jev model", "The Jev model name.", "jev-latest", { visible: jev }),
          button("Test Jev connection", "Sends a small request with the key above.", "Test", () => ctx.run.testJev(), { visible: jev }),
          toggle("features.repair.llm", "Rewrite with an AI model", "When local fixes fail, sends the diagram source to your AI provider for a minimal rewrite."),
        ];
      },
    }],
    extra: (ctx) => [llmPage(ctx)],
  },
  {
    name: "Convert",
    pages: [
      {
        id: "canvas",
        name: "Convert diagrams to and from Canvas",
        desc: "Commands turn a diagram into a canvas file and a canvas back into a diagram.",
        aliases: ["canvas", "canvas conversion", "convert", "portals", "Advanced Canvas"],
        options: () => [
          dropdown("features.canvas.portals", "Nested diagrams on a canvas", "A link opens the nested canvas; inline expands it in place.", {
            link: "Link (portal node)", inline: "Inline (expand)",
          }),
          dropdown("features.canvas.layout", "Canvas layout", "Keep the diagram's positions or lay the canvas out again.", {
            canvas: "Canvas positions", auto: "Automatic layout",
          }),
          num("features.canvas.portalDepth", "Nesting depth on a canvas", "From 0 to 5.", 0, 5, { step: 1 }),
          text("features.canvas.outputFolder", "Canvas folder", "Empty puts the canvas next to its note.", "Next to the note"),
        ],
      },
      {
        id: "materialise",
        name: "Turn diagrams into notes",
        desc: "A command writes one note per node, linked by properties that follow the edges.",
        aliases: ["materialise", "materialize", "diagram to notes", "node notes", "edge properties"],
        options: () => [
          text("features.materialise.rootFolder", "Notes folder", "Where node notes go; {{folder}} is the note's folder and {{note}} its name.", "{{folder}}/{{note}}"),
          text("features.materialise.defaultKey", "Default edge property", "The property that holds links for edges without a label."),
          dropdown("features.materialise.keyStyle", "Edge property names", "Slugified (depends-on) or the label verbatim (depends on).", {
            slug: "Slugified", verbatim: "Verbatim",
          }),
        ],
      },
      {
        id: "excalidraw",
        name: "Convert diagrams to Excalidraw",
        desc: "A command turns a diagram into an editable Excalidraw drawing.",
        aliases: ["excalidraw", "excalidraw conversion", "drawing", "sketch"],
        notes: (ctx) => [
          button("Pele Excalidraw is still on", "Excalidraw conversion is now built in; disable Pele Excalidraw, then reload Mehrpele.", "Open community plugins",
            () => ctx.run.openCommunityPlugins(), { visible: () => ctx.excalidrawStandsDown() }),
        ],
        options: () => [
          num("features.excalidraw.scale", "Drawing scale", "Size of converted drawings, from 0.1 to 10.", 0.1, 10),
        ],
      },
    ],
  },
  {
    name: "Integrations",
    pages: [
      {
        id: "integrations.datacore",
        name: "Datacore diagrams",
        desc: "Query blocks and Datacore views draw your notes as diagrams.",
        aliases: ["datacore", "pele-datacore", "queries", "datacorejsx"],
      },
      {
        id: "integrations.breadcrumbs",
        name: "Breadcrumbs hierarchy diagrams",
        desc: "A block draws a note's Breadcrumbs neighbours as a flowchart.",
        aliases: ["breadcrumbs", "hierarchy", "pele-breadcrumbs", "typed edges"],
        options: () => [
          toggle("features.integrations.breadcrumbs.showImplied", "Show implied links", "Include implied edges, dimmed, instead of leaving them out."),
        ],
      },
      {
        id: "integrations.tasknotes",
        name: "TaskNotes task diagrams",
        desc: "A block draws TaskNotes tasks as a Gantt chart, dependency graph or board.",
        aliases: ["tasknotes", "tasks", "pele-tasks", "gantt", "kanban"],
      },
      {
        id: "integrations.extended-graph",
        name: "Extended Graph colours",
        desc: "Nodes for notes take the colours Extended Graph gives them.",
        aliases: ["extended graph", "graph colours", "graph colors", "node colours"],
      },
    ],
  },
  {
    name: "Desktop",
    pages: [{
      id: "cli",
      name: "Obsidian CLI commands",
      desc: "The Obsidian command line can render, check and convert diagrams in this vault.",
      aliases: ["cli", "command line", "terminal", "handlers"],
      desktop: true,
      options: () => [
        { name: "Standalone pele-render CLI", desc: "A separate tool for terminals and CI that Mehrpele does not install; the README's command-line section has the steps." },
      ],
    }],
  },
];

/** The shared AI provider block: one home for `llm.*`, shown while anything uses it. */
function llmPage(ctx: TabContext): PageDef {
  const openai = () => ctx.value("llm.provider") === "openai";
  const used = () => (ctx.enabled("repair") && ctx.value("features.repair.llm") === true) || ctx.enabled("autocomplete");
  return {
    type: "page",
    name: "AI model provider",
    desc: "The provider and model that repair and label suggestions use.",
    aliases: ["LLM", "AI", "provider", "API key", "Ollama", "OpenAI"],
    displayValue: () => (openai() ? "OpenAI-compatible" : "Anthropic"),
    visible: used,
    items: [
      dropdown("llm.provider", "Provider", "Who runs the model.", { anthropic: "Anthropic", openai: "OpenAI-compatible (incl. Ollama)" }),
      secret(ctx, "llm.anthropicKeySecretId", "Anthropic API key", "Kept in Obsidian's secret storage.", { visible: () => !openai() }),
      text("llm.baseUrl", "API base URL", "The address of the OpenAI-compatible API.", "https://api.openai.com/v1", { visible: openai }),
      secret(ctx, "llm.openaiKeySecretId", "OpenAI API key", "Kept in Obsidian's secret storage; not needed for a local Ollama server.", { visible: openai }),
      button("Use local Ollama", "Points the provider at Ollama on this computer and lists its models.", "Use Ollama + fetch models", () => ctx.run.useOllama(), { visible: openai }),
      {
        name: "Ollama model",
        desc: "Pick one of the models Ollama reported.",
        searchable: false,
        visible: () => openai() && ctx.ollamaModels().length > 0,
        render: (s: Setting) => {
          s.addDropdown((d) => {
            for (const m of ctx.ollamaModels()) d.addOption(m, m);
            const model = ctx.value("llm.model");
            d.setValue(typeof model === "string" ? model : "").onChange((v) => void ctx.set("llm.model", v));
          });
        },
      },
      text("llm.model", "Model", "The model name the provider expects."),
      dropdown("llm.reasoningEffort", "Model reasoning", "Sent as reasoning_effort; none makes local reasoning models answer in seconds.", {
        default: "Provider default", none: "None (fastest)", low: "Low", medium: "Medium", high: "High",
      }, { visible: openai }),
      num("llm.timeoutSec", "Request timeout", "In seconds.", 1, undefined, { visible: openai }),
      button("Test AI connection", "Sends a small request with the settings above.", "Test", () => ctx.run.testLlm()),
    ],
  };
}

function companionRow(ctx: TabContext, c: Companion): Def {
  return {
    name: c.optional ? `${c.name} (optional)` : c.name,
    desc: "",
    render: (s: Setting) => {
      const paint = () => {
        const state = detectCompanion(ctx.plugins(), c.id);
        s.setDesc(companionStatus(c, state));
        s.controlEl.empty();
        const tooOld = !!(c.minVersion && state.version && companionStatus(c, state).includes("too old"));
        if (!state.installed || tooOld) {
          s.addButton((b) => b.setButtonText(state.installed ? "Update" : "Install").onClick(() => ctx.run.openPluginPage(c.id)));
        } else if (!state.enabled) {
          s.addButton((b) => b.setButtonText("Enable").onClick(async () => {
            await ctx.run.enablePlugin(c.id);
            paint();
          }));
        }
      };
      paint();
    },
  };
}

function featurePage(ctx: TabContext, p: PageSpec): PageDef {
  const key = enableKey(p.id);
  const enabled = () => ctx.enabled(p.id);
  const companions = COMPANIONS[p.id] ?? [];
  const missing = () => missingCompanion(ctx.plugins(), p.id);
  const needs = companions.find((c) => !c.optional);
  let desc = p.desc;
  if (p.desktop) desc = badge(desc, DESKTOP_ONLY);
  if (needs) desc = badge(desc, `Needs ${needs.name}`);
  const items: SettingDefinitionItem[] = [
    toggle(key, p.name, desc, { aliases: p.aliases, ...(p.desktop ? { disabled: desktopOnly } : {}) }),
  ];
  if (ctx.needsReload(p.id)) {
    items.push(button("Reload needed", "Off now; its registration is removed when the plugin reloads.", "Reload", () => ctx.run.reloadPlugin(), {
      visible: () => ctx.pendingReload(p.id),
    }));
  }
  items.push(...(p.notes?.(ctx) ?? []));
  if (companions.length) {
    items.push({ type: "group", heading: "Requires", items: companions.map((c) => companionRow(ctx, c)) });
  }
  const options = p.options?.(ctx) ?? [];
  if (options.length) items.push({ type: "group", heading: "Options", visible: enabled, items: options });
  return {
    type: "page",
    name: p.name,
    desc: p.desc,
    aliases: p.aliases,
    featureId: p.id,
    displayValue: () => {
      if (ctx.pendingReload(p.id)) return "Reload needed";
      if (!enabled()) return "Off";
      const m = missing();
      return m ? `On · Needs ${m.name}` : "On";
    },
    status: () => (enabled() && missing() ? "warning" : null),
    items,
  };
}

// -- search -------------------------------------------------------------------------

/** Every name and alias under an item, for the Features filter. */
export function searchWords(item: unknown): string[] {
  const out: string[] = [];
  const walk = (it: unknown) => {
    if (!it || typeof it !== "object") return;
    const o = it as { name?: unknown; heading?: unknown; aliases?: unknown; items?: unknown };
    if (typeof o.name === "string") out.push(o.name);
    if (typeof o.heading === "string") out.push(o.heading);
    if (Array.isArray(o.aliases)) for (const a of o.aliases) if (typeof a === "string") out.push(a);
    if (Array.isArray(o.items)) o.items.forEach(walk);
  };
  walk(item);
  return out;
}

function matches(item: unknown, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || searchWords(item).some((w) => w.toLowerCase().includes(q));
}

/** A muted category heading inside the Features list. */
function categoryRow(name: string, pages: PageDef[]): Def & { categoryPages: PageDef[] } {
  return {
    name,
    searchable: false,
    categoryPages: pages,
    render: (s: Setting) => {
      s.settingEl.addClass("mehrpele-category");
    },
  };
}

function featuresList(ctx: TabContext): SettingDefinitionGroup {
  const items: SettingGroupItem[] = [];
  for (const cat of CATEGORIES) {
    const pages = [...cat.pages.map((p) => featurePage(ctx, p)), ...(cat.extra?.(ctx) ?? [])];
    items.push(categoryRow(cat.name, pages), ...pages);
  }
  return {
    ...section(ctx, "features", "Features", items),
    type: "list",
    search: {
      placeholder: "Filter features…",
      match: (def, query) => {
        const cat = (def as { categoryPages?: PageDef[] }).categoryPages;
        return cat ? !query.trim() || cat.some((p) => matches(p, query)) : matches(def, query);
      },
    },
  };
}

// -- the tab --------------------------------------------------------------------------

export function flowsPage(ctx: TabContext): PageDef {
  const status = () => ctx.flows?.() ?? detectFlows(ctx.plugins(), 1);
  return {
    type: "page", name: "Flows", aliases: ["flows", "cannoli", "add-ons"],
    desc: "Run diagrams with the optional Mehrpele Flows add-on.",
    displayValue: () => status().label,
    status: () => status().kind === "ready" ? null : "warning",
    items: [{
      name: "Mehrpele Flows", desc: "",
      render: (s: Setting) => {
        let busy = false;
        s.addButton((b) => {
          const paint = () => {
            const state = status();
            s.setDesc(`${state.label} — ${state.detail}`);
            b.setButtonText(state.kind === "missing" ? "Installation guide" : state.kind === "disabled" ? "Enable" : state.kind === "ready" ? "Open settings" : state.updateTarget === "host" ? "Update Mehrpele" : "Update guide");
          };
          paint();
          ctx.watchFlows?.(s.settingEl, paint);
          b.onClick(async () => {
            if (busy) return;
            busy = true;
            b.buttonEl.setAttribute("aria-disabled", "true");
            try {
              const state = status();
              if (state.kind === "missing") ctx.run.openPluginPage(FLOWS.id);
              else if (state.kind === "disabled") await ctx.run.enablePlugin(FLOWS.id);
              else if (state.kind === "ready") ctx.run.openPluginSettings?.(FLOWS.id);
              else if (state.updateTarget === "host") ctx.run.updateHost?.();
              else ctx.run.openPluginPage(FLOWS.id);
            } finally { busy = false; b.buttonEl.removeAttribute("aria-disabled"); paint(); }
          });
        });
      },
    }, {
      name: "Availability", desc: "Available as a separate plugin through BRAT or manual download; the installation guide includes the public repository and release links.",
    }, {
      name: "Requires", desc: "Mehrpele API 1.1 or later provides diagram integration.",
    }, {
      name: "Network use", desc: "Provider keys, network permissions and run records belong to the add-on.",
    }],
  };
}

export function buildDefinitions(ctx: TabContext): SettingDefinitionItem[] {
  const allowCommands = on(ctx, "core.security.allowCommandUris");
  const anyIntegration = () => ctx.enabled("integrations.breadcrumbs") || ctx.enabled("integrations.datacore") || ctx.enabled("integrations.tasknotes");
  return [
    toggle("core.overrideMermaid", "Render Mermaid blocks with Pele", "Pele draws mermaid code blocks in Reading view and Live Preview; a change takes effect after a plugin reload.", {
      aliases: ["override mermaid", "mermaid", "renderer"],
    }),
    toggle("core.showAddonHints", "Show add-on hints on diagrams", "Flow diagrams offer help when Mehrpele Flows is missing or unavailable."),
    section(ctx, "appearance", "Appearance", [
      text("core.appearance.fontFamily", "Font", "A CSS font family; empty uses the theme's diagram font.", "var(--font-mermaid)", { aliases: ["font family", "typeface"] }),
      num("core.appearance.fontSize", "Text size", "In pixels; 0 uses the theme size.", 0, undefined, { aliases: ["font size"] }),
      num("core.appearance.maxWidth", "Max width", "In pixels; 0 lets a diagram use the note's full width.", 0, undefined, { aliases: ["width"] }),
      toggle("core.iconsEnabled", "Show icons", "Icon names such as fa:book or lucide:star draw with Obsidian's built-in Lucide icons.", {
        aliases: ["icons", "font awesome", "Lucide"],
      }),
      toggle("core.ganttToday", "Mark today on Gantt charts", "Gantt charts draw a line at today's date.", { aliases: ["gantt", "today line"] }),
    ]),
    featuresList(ctx),
    section(ctx, "addons", "Add-ons", [flowsPage(ctx)]),
    section(ctx, "security", "Security", [
      toggle("core.security.allowLinks", "Allow links in diagrams", "Clicking a linked node opens its link; off makes every diagram inert.", { aliases: ["links", "link handling"] }),
      toggle("core.security.allowCommandUris", "Allow obsidian:// command links", "A diagram link can run one of the commands you list below.", { aliases: ["command links", "commands", "uri"] }),
      {
        name: "Allowed commands",
        desc: "One command id per line; only these can run from a diagram link.",
        aliases: ["command allowlist", "allowlist"],
        visible: allowCommands,
        control: { type: "textarea", key: "core.security.commandAllowlist", placeholder: "plugin-id:command-id", rows: 4 },
      },
      toggle("core.security.sanitize", "Sanitise SVG output", "Strip scripts and unknown markup from the SVG Pele draws, as Obsidian does for Mermaid.", {
        aliases: ["sanitize", "sanitizer", "svg", "safety"],
      }),
      {
        name: "SVG sanitising is off",
        desc: "Diagrams can carry scripts and styles into your notes; turn sanitising back on unless you trust every diagram.",
        visible: () => ctx.value("core.security.sanitize") === false,
        render: (s: Setting) => {
          s.settingEl.addClass("mehrpele-warning");
        },
      },
      toggle("core.security.allowRemoteImages", "Load remote images", "Images in labels may load from the web, which tells those sites you opened the note.", {
        aliases: ["remote images", "web images", "privacy"],
      }),
    ]),
    section(ctx, "learn", "Learn", [
      {
        name: "Tour notes",
        desc: "Creates a “Mehrpele tour” folder of example notes, about 14 KB downloaded from GitHub.",
        aliases: ["tour", "examples", "tutorial", "help"],
        render: (s: Setting) => {
          s.addButton((b) => b.setButtonText("Install").onClick(() => void ctx.run.installTour()));
          s.addButton((b) => b.setButtonText("Remove").onClick(() => void ctx.run.removeTour()));
        },
      },
    ]),
    section(ctx, "advanced", "Advanced", [
      {
        name: "Default Pele config (JSON)",
        desc: "A JSON object merged into every diagram's config.",
        aliases: ["config", "json", "theme variables"],
        control: {
          type: "textarea", key: "core.advanced.defaultConfigJson", placeholder: "{}", rows: 4,
          validate: (v: string) => {
            const r = parseConfigJson(v);
            return r.ok ? undefined : r.error;
          },
        },
      },
      num("core.advanced.maxSourceLength", "Longest diagram source", "In characters; 0 uses Pele's default (50,000).", 0),
      num("features.integrations.maxNodes", "Most nodes in generated diagrams", "Datacore, Breadcrumbs and TaskNotes diagrams collapse the rest into one node.", 1, 1000, {
        visible: anyIntegration,
      }),
      button("Re-render open notes", "Draws every diagram in open notes again.", "Re-render", () => ctx.run.rerender(), { aliases: ["refresh", "redraw"] }),
    ]),
  ];
}

/** The feature pages, for tests. */
export function featurePages(ctx: TabContext): PageDef[] {
  return CATEGORIES.flatMap((c) => c.pages.map((p) => featurePage(ctx, p)));
}
