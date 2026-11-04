/**
 * Folder embeds: a folder's files as an interactive Bases view inside a
 * node. The base is generated (pele-render canvas/folder.ts) and rendered as
 * an inline `base` code block — never written. Sorting, filters and the view
 * switcher work in memory; "Save as .base" materialises the generated base
 * next to the note on request.
 */
import { Component, MarkdownRenderer, Notice, TFolder, normalizePath, type App } from "obsidian";
import { applyFolderTokens, folderBaseBlock, folderBaseYaml, normalizeFolderPath, type FolderSpec } from "pele-render/canvas";
import { HostError, type LiveView } from "./hosts";
import type { MehrpeleEmbedTarget } from "../model";

/** Bases view types registered right now (table, cards, list, kanban, plugin views…). */
export function basesViewTypes(app: App): string[] {
  const inst = (app as unknown as { internalPlugins?: { getEnabledPluginById?(id: string): { registrations?: Record<string, unknown> } | null } })
    .internalPlugins?.getEnabledPluginById?.("bases");
  return inst?.registrations ? Object.keys(inst.registrations) : [];
}

export function basesViewName(app: App, type: string): string {
  const inst = (app as unknown as { internalPlugins?: { getEnabledPluginById?(id: string): { registrations?: Record<string, { name?: string }> } | null } })
    .internalPlugins?.getEnabledPluginById?.("bases");
  return inst?.registrations?.[type]?.name ?? type;
}

export function folderOf(app: App, path: string): TFolder | null {
  const p = normalizeFolderPath(path);
  const f = p ? app.vault.getAbstractFileByPath(normalizePath(p)) : app.vault.getRoot();
  return f instanceof TFolder ? f : null;
}

/**
 * `![[Projects]]` (no slash) that names a folder, not a file: a folder spec
 * (alias tokens `recursive` and a view type apply), else null.
 */
export function bareFolderTarget(app: App, target: MehrpeleEmbedTarget, sourcePath: string): FolderSpec | null {
  const lp = target.linkpath.trim();
  if (!lp || lp.endsWith("/") || target.subpath || lp.startsWith("view:") || /^[a-z][a-z0-9+.-]*:/i.test(lp)) return null;
  if (app.metadataCache.getFirstLinkpathDest(lp, sourcePath)) return null;
  if (!folderOf(app, lp)) return null;
  return applyFolderTokens({ path: normalizeFolderPath(lp), recursive: false, view: "table" }, target.aliasOrSize);
}

/** Mount the generated base for a folder into `parent`. */
export async function mountFolder(app: App, spec: FolderSpec, sourcePath: string, parent: HTMLElement, owner: Component): Promise<LiveView> {
  const folder = folderOf(app, spec.path);
  if (!folder) throw new HostError(`Folder not found: ${spec.path || "/"}`);
  if (!basesViewTypes(app).length) throw new HostError("Folder views need the Bases core plugin (Settings › Core plugins)");
  const el = parent.createDiv({ cls: "mehrpele-view-folder" });
  // A child per mount: the Base unloads (and stops watching the vault) when this view is released.
  const component = new Component();
  owner.addChild(component);
  await MarkdownRenderer.render(app, folderBaseBlock(spec, basesViewTypes(app)), el, sourcePath, component);
  return {
    el,
    title: () => `${folder.isRoot() ? "Vault" : folder.name}${spec.recursive ? " (with subfolders)" : ""}`,
    destroy: () => {
      owner.removeChild(component);
      el.remove();
    },
  };
}

/** Write the generated base next to the note (never overwrites); returns the new path. */
export async function saveFolderBase(app: App, spec: FolderSpec, sourcePath: string): Promise<string | null> {
  const folder = folderOf(app, spec.path);
  const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
  const stem = `${folder && !folder.isRoot() ? folder.name : "Vault"} files`;
  let path = normalizePath(`${dir ? `${dir}/` : ""}${stem}.base`);
  for (let i = 2; app.vault.getAbstractFileByPath(path) && i < 100; i++) path = normalizePath(`${dir ? `${dir}/` : ""}${stem} ${i}.base`);
  try {
    await app.vault.create(path, `${folderBaseYaml(spec, basesViewTypes(app))}\n`);
    new Notice(`Pele: saved ${path} — embed it with ![[${path}]]`, 8000);
    return path;
  } catch (e) {
    new Notice(`Pele: could not save the base: ${(e as Error).message ?? e}`);
    return null;
  }
}

/** Reveal the folder in the file explorer ("open original"). */
export function revealFolder(app: App, spec: FolderSpec): void {
  const folder = folderOf(app, spec.path);
  const fe = (app as unknown as { internalPlugins?: { getEnabledPluginById?(id: string): { revealInFolder?(f: unknown): void } | null } })
    .internalPlugins?.getEnabledPluginById?.("file-explorer");
  if (folder && fe?.revealInFolder) fe.revealInFolder(folder);
}
