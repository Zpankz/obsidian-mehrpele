import type { Plugin } from "obsidian";

/** Track main and popout documents without retaining closed windows. */
export function watchViewDocuments(plugin: Plugin, attach: (doc: Document) => () => void): void {
  const cleanups = new Map<Document, () => void>();
  let live = true;
  const watch = (doc: Document): void => {
    if (live && !cleanups.has(doc)) cleanups.set(doc, attach(doc));
  };
  const scan = (): void => {
    watch(document);
    plugin.app.workspace.iterateAllLeaves((leaf) => watch(leaf.view.containerEl.ownerDocument));
  };
  scan();
  plugin.app.workspace.onLayoutReady(scan);
  plugin.registerEvent(plugin.app.workspace.on("window-open", (win) => watch(win.doc)));
  plugin.registerEvent(plugin.app.workspace.on("window-close", (win) => {
    cleanups.get(win.doc)?.();
    cleanups.delete(win.doc);
  }));
  plugin.register(() => {
    live = false;
    for (const cleanup of cleanups.values()) cleanup();
    cleanups.clear();
  });
}
