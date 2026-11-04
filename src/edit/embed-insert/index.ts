/**
 * "Insert embed": the popover plus the pickers that turn a choice into label
 * text. The caller (edit toolbar, or the inline editor of a "+"-created
 * node) applies the text as one edit — only after a genuine pick.
 */
import { Notice, TFile, TFolder, parseYaml, type App } from "obsidian";
import { basesViewTypes, basesViewName } from "../../mehrpele/views/folder";
import {
  CALLOUT_TYPES,
  FOLDER_SUBS,
  GRAPH_SUBS,
  LATEX_STUB,
  MERMAID_STUB,
  baseSubs,
  baseViewOf,
  calloutOf,
  combineLabel,
  editsAfter,
  embedOf,
  filteredGraphOf,
  folderEmbedOf,
  localGraphOf,
  placementOf,
  tableOf,
  viewOf,
  webEmbedOf,
  wikilinkOf,
  type ItemId,
  type SubItem,
  type GroupId,
} from "./catalog";
import { IMAGE_EXT, pickChoice, pickFile, prompt, type Picked } from "./pickers";
import { openPopover, type Box, type PopoverHandle } from "./popover";

export interface InsertResult {
  /** The whole new label text. */
  text: string;
  /** Open the inline editor afterwards (templates to fill in). */
  edit: boolean;
  /** The genuine event that made the choice. */
  evt: MouseEvent | KeyboardEvent;
}

export interface EmbedInsertOptions {
  app: App;
  doc: Document;
  anchor: HTMLElement;
  parent: HTMLElement;
  avoid: () => Box | null;
  sourcePath: string;
  /** The label's current text and the node id (placeholders are replaced). */
  current(): string;
  nodeId: string;
  /** Default local graph depth (view-node settings). */
  graphDepth: number;
  onInsert(r: InsertResult): void;
  /** The popover went away (picked, Esc, or the toolbar closed it). */
  onClose?(): void;
  /** Host placement (see PopoverOptions.place). */
  place?: (el: HTMLElement) => void;
  /** Just one group's items (see PopoverOptions.group). */
  group?: GroupId;
}

function linktext(app: App, f: TFile, sourcePath: string): string {
  return app.metadataCache.fileToLinktext(f, sourcePath, f.extension === "md");
}

/** Views of `type` in a .base file (name order). */
async function baseViews(app: App, file: TFile, type: string): Promise<string[]> {
  try {
    const y = parseYaml(await app.vault.cachedRead(file)) as { views?: { type?: string; name?: string }[] } | null;
    return (y?.views ?? []).filter((v) => v && v.type === type && typeof v.name === "string").map((v) => v.name!);
  } catch {
    return [];
  }
}

/** The label syntax for a choice (pickers included); null when dismissed. */
export async function resolveChoice(o: EmbedInsertOptions, id: ItemId, sub: string | null, ev: MouseEvent | KeyboardEvent): Promise<InsertResult | null> {
  const { app, sourcePath } = o;
  const done = (inserted: string, evt: MouseEvent | KeyboardEvent): InsertResult => ({
    text: combineLabel(o.current(), inserted, placementOf(id), o.nodeId),
    edit: editsAfter(id),
    evt,
  });
  const file = async (filter: (f: TFile | TFolder) => boolean, placeholder: string): Promise<Picked<TFile | TFolder> | null> => pickFile(app, filter, placeholder);
  switch (id) {
    case "graph": {
      if (sub === "localgraph") return done(localGraphOf(o.graphDepth), ev);
      if (sub === "backlink" || sub === "outline") return done(viewOf(sub), ev);
      if (sub === "graph") {
        const p = await prompt(app, { title: "Filtered graph", placeholder: "path:Projects tag:#todo", button: "Embed graph" });
        return p ? done(filteredGraphOf(p.value), p.evt) : null;
      }
      const reg = (app as unknown as { viewRegistry?: { viewByType?: Record<string, unknown> } }).viewRegistry?.viewByType ?? {};
      const skip = new Set(["markdown", "image", "audio", "video", "pdf", "canvas", "bases", "release-notes", "empty"]);
      const types = Object.keys(reg).filter((t) => !skip.has(t)).sort();
      const p = await pickChoice(app, types.map((t) => ({ id: t, label: t })), "View type (core and plugin views)");
      return p ? done(viewOf(p.value), p.evt) : null;
    }
    case "canvas": {
      const p = await file((f) => f instanceof TFile && f.extension === "canvas", "Embed a canvas…");
      return p && p.value instanceof TFile ? done(embedOf(linktext(app, p.value, sourcePath)), p.evt) : null;
    }
    case "base": {
      const p = await file((f) => f instanceof TFile && f.extension === "base", sub && sub !== "any" ? `Base with a ${basesViewName(app, sub)} view…` : "Embed a base…");
      if (!p || !(p.value instanceof TFile)) return null;
      const lt = linktext(app, p.value, sourcePath);
      if (!sub || sub === "any") return done(baseViewOf(lt), p.evt);
      const names = await baseViews(app, p.value, sub);
      if (names.length === 0) {
        new Notice(`Pele: ${p.value.name} has no ${basesViewName(app, sub)} view; embedding its first view.`, 6000);
        return done(baseViewOf(lt), p.evt);
      }
      if (names.length === 1) return done(baseViewOf(lt, names[0]), p.evt);
      const v = await pickChoice(app, names.map((n) => ({ id: n, label: n })), "Which view?");
      return v ? done(baseViewOf(lt, v.value), v.evt) : null;
    }
    case "folder": {
      const p = await file((f) => f instanceof TFolder, sub === "recursive" ? "Folder (with subfolders)…" : "Folder…");
      return p && p.value instanceof TFolder ? done(folderEmbedOf(p.value.path, sub === "recursive"), p.evt) : null;
    }
    case "callout": {
      const p = await pickChoice(app, CALLOUT_TYPES.map((t) => ({ id: t, label: t[0].toUpperCase() + t.slice(1) })), "Callout type");
      return p ? done(calloutOf(p.value), p.evt) : null;
    }
    case "table":
      return done(tableOf(), ev);
    case "latex":
      return done(LATEX_STUB, ev);
    case "mermaid":
      return done(MERMAID_STUB, ev);
    case "webpage": {
      const p = await prompt(app, {
        title: "Embed a web page",
        placeholder: "https://example.com",
        button: "Embed",
        validate: (v) => (webEmbedOf(v) ? null : "Enter an http(s) address"),
      });
      const t = p ? webEmbedOf(p.value) : null;
      return p && t ? done(t, p.evt) : null;
    }
    case "pdf": {
      const p = await file((f) => f instanceof TFile && f.extension.toLowerCase() === "pdf", "Embed a PDF…");
      return p && p.value instanceof TFile ? done(embedOf(linktext(app, p.value, sourcePath)), p.evt) : null;
    }
    case "image": {
      const p = await file((f) => f instanceof TFile && IMAGE_EXT.test(f.extension), "Embed an image…");
      return p && p.value instanceof TFile ? done(embedOf(linktext(app, p.value, sourcePath)), p.evt) : null;
    }
    case "wikilink": {
      const p = await file((f) => f instanceof TFile, "Link to a note or file…");
      return p && p.value instanceof TFile ? done(wikilinkOf(linktext(app, p.value, sourcePath)), p.evt) : null;
    }
  }
}

/** Open the popover; a pick runs its picker, then `onInsert` (only for genuine events). */
export function openEmbedInsert(o: EmbedInsertOptions): PopoverHandle {
  const subsFor = (id: ItemId): SubItem[] => {
    if (id === "graph") return GRAPH_SUBS;
    if (id === "folder") return FOLDER_SUBS;
    if (id === "base") {
      const types = basesViewTypes(o.app);
      return baseSubs(types.map((t) => ({ type: t, name: basesViewName(o.app, t) })));
    }
    return [];
  };
  const pop = openPopover({
    doc: o.doc,
    anchor: o.anchor,
    parent: o.parent,
    avoid: o.avoid,
    subsFor,
    ...(o.place ? { place: o.place } : {}),
    ...(o.group ? { group: o.group } : {}),
    onClose: () => o.onClose?.(),
    onPick: (id, sub, ev) => {
      // The popover steps aside for modal pickers (Esc there closes the picker only).
      pop.close();
      void resolveChoice(o, id, sub, ev).then((r) => {
        if (r && r.evt.isTrusted) o.onInsert(r);
      });
    },
  });
  return pop;
}
