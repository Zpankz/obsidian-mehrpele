/**
 * The Bases view while its toggle is off: the status line says how to turn it
 * on and stays (with the copy button) for when it comes back; the diagram mount
 * goes. The view reports itself live/away so a toggle can refresh it.
 */
import "../helpers/dom-globals";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { obsidianStub } from "../helpers/obsidian-stub";

mock.module("obsidian", () => obsidianStub);
// The real mount needs a DOM; record mount targets instead. No other test imports this module.
const mounts: El[] = [];
let destroyed = 0;
// When set, mounts wait for it (a mount still in flight).
let gate: Promise<void> | null = null;
mock.module("../../src/mehrpele/mount", () => ({
  mountMehrpele: async (target: El) => {
    mounts.push(target);
    if (gate) await gate;
    return { destroy: () => void destroyed++, update: async () => {} };
  },
}));

class El {
  className = "";
  textContent = "";
  parent: El | null = null;
  children: El[] = [];
  classList = { add: (c: string) => void (this.className = `${this.className} ${c}`.trim()) };
  constructor(public tag: string) {}
  appendChild(c: El): El {
    c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }
  replaceChildren(): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  addEventListener(): void {}
}

const savedDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
beforeAll(() => {
  Object.defineProperty(globalThis, "document", {
    value: { createElement: (t: string) => new El(t) },
    configurable: true,
    writable: true,
  });
});
afterAll(() => {
  if (savedDoc) Object.defineProperty(globalThis, "document", savedDoc);
  else delete (globalThis as Record<string, unknown>).document;
});

async function makeView() {
  mounts.length = 0;
  const { MehrpeleDiagramView, BASES_OFF } = await import("../../src/mehrpele/bases-view");
  let enabled = true;
  const live: [unknown, boolean][] = [];
  const container = new El("div");
  const liveMounts: boolean[] = [];
  const deps = {
    settings: () => ({ basesViewEnabled: enabled }) as never,
    renderOptions: () => ({}),
    liveView: (v: unknown, on: boolean) => void live.push([v, on]),
    liveMount: (_m: unknown, on: boolean) => void liveMounts.push(on),
  };
  const view = new MehrpeleDiagramView({} as never, container as never, deps) as any;
  Object.assign(view, {
    app: { metadataCache: { getCache: () => null } },
    config: { get: () => undefined, getAsPropertyId: () => null },
    data: { groupedData: [] },
  });
  const rebuild = (): Promise<void> => view.rebuild();
  return { view, container, mounts, live, liveMounts, BASES_OFF, rebuild, set: (on: boolean) => void (enabled = on) };
}

describe("Mehrpele Bases view", () => {
  test("off keeps the status line (with the hint) and the copy button; on brings the diagram back", async () => {
    const { container, mounts, rebuild, set, BASES_OFF } = await makeView();
    await rebuild();
    const status = container.children.find((c) => c.className === "mehrpele-bases-status")!;
    const copy = container.children.find((c) => c.className === "mehrpele-copy-source")!;
    expect(status.textContent).toBe("0 notes · 0 links");
    expect(mounts).toHaveLength(1);

    set(false);
    await rebuild();
    expect(container.children).toEqual([status, copy]);
    expect(status.textContent).toBe(BASES_OFF);

    set(true);
    await rebuild();
    expect(container.children.slice(0, 2)).toEqual([status, copy]);
    expect(status.textContent).toBe("0 notes · 0 links");
    expect(mounts).toHaveLength(2);
    expect(container.children[2]).toBe(mounts[1]!);
  });

  test("a mount that finishes after off (or unload) is destroyed and never goes live", async () => {
    for (const end of ["off", "unload"] as const) {
      const { view, container, liveMounts, rebuild, set, BASES_OFF } = await makeView();
      destroyed = 0;
      let open!: () => void;
      gate = new Promise((r) => (open = r));
      const first = rebuild();
      await Promise.resolve();
      if (end === "off") {
        set(false);
        await rebuild();
        expect(container.children[0]!.textContent).toBe(BASES_OFF);
      } else view.onunload();
      open();
      await first;
      gate = null;
      expect(destroyed).toBe(1);
      expect(liveMounts).toEqual([]);
      expect(view.mounted).toBeNull();
    }
  });

  test("the view reports itself live on load and away on unload; refresh() rebuilds", async () => {
    const { view, container, live, set, BASES_OFF } = await makeView();
    view.onload();
    expect(live).toEqual([[view, true]]);
    set(false);
    view.refresh();
    await Promise.resolve();
    expect(container.children[0]!.textContent).toBe(BASES_OFF);
    view.onunload();
    expect(live).toEqual([
      [view, true],
      [view, false],
    ]);
  });
});
