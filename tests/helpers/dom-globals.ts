/**
 * Globals Obsidian defines in the app that a bare test runtime lacks: `window` and the DOM
 * helpers `createEl`, `createDiv`, `createSpan` and `createFragment`. Like Obsidian's, the
 * helpers create through the current global `document`, so per-test document stubs still apply.
 * Import this module before the code under test.
 */
type Info = { cls?: string | string[]; text?: string; attr?: Record<string, string | number | boolean | null> };

const g = globalThis as Record<string, unknown>;

function make(tag: string, o?: Info | string): HTMLElement {
  const el = (g.document as Document).createElement(tag);
  const info: Info = typeof o === "string" ? { cls: o } : (o ?? {});
  const cls = Array.isArray(info.cls) ? info.cls : info.cls ? info.cls.split(" ") : [];
  for (const c of cls) if (c) el.classList.add(c);
  if (info.text !== undefined) el.textContent = info.text;
  for (const [k, v] of Object.entries(info.attr ?? {})) if (v !== null && v !== false) el.setAttribute(k, String(v));
  return el;
}

g.window ??= globalThis;
g.createEl ??= (tag: string, o?: Info | string) => make(tag, o);
g.createDiv ??= (o?: Info | string) => make("div", o);
g.createSpan ??= (o?: Info | string) => make("span", o);
g.createFragment ??= () => (g.document as Document).createDocumentFragment();
