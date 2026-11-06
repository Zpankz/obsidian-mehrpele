import { expect, test } from "bun:test";
import type { Plugin } from "obsidian";
import { watchViewDocuments } from "../../../src/mehrpele/views/documents";

test("tracks existing and new popouts once and removes listeners on close and feature unload", () => {
  const main = {} as Document;
  const existing = {} as Document;
  const opened = {} as Document;
  const seen: Document[] = [];
  const removed: Document[] = [];
  const events = new Map<string, (win: { doc: Document }) => void>();
  const cleanup: Array<() => void> = [];
  let ready: () => void = () => {};
  const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: main, configurable: true });
  try {
    const plugin = {
      app: { workspace: {
        iterateAllLeaves: (cb: (leaf: unknown) => void) => {
          for (const doc of [main, existing, existing]) cb({ view: { containerEl: { ownerDocument: doc } } });
        },
        onLayoutReady: (cb: () => void) => { ready = cb; },
        on: (event: string, cb: (win: { doc: Document }) => void) => { events.set(event, cb); },
      } },
      registerEvent() {},
      register: (fn: () => void) => cleanup.push(fn),
    } as unknown as Plugin;
    watchViewDocuments(plugin, (doc) => { seen.push(doc); return () => { removed.push(doc); }; });
    ready();
    expect(seen).toEqual([main, existing]);
    events.get("window-open")!({ doc: opened });
    events.get("window-open")!({ doc: opened });
    expect(seen).toEqual([main, existing, opened]);
    events.get("window-close")!({ doc: opened });
    expect(removed).toEqual([opened]);
    for (const fn of cleanup) fn();
    expect(removed).toEqual([opened, main, existing]);
    ready();
    events.get("window-open")!({ doc: opened });
    expect(seen).toHaveLength(3);
  } finally {
    if (saved) Object.defineProperty(globalThis, "document", saved);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
