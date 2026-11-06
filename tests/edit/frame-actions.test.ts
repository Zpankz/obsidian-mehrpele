/**
 * Modified clicks on a frame's zoom / code buttons (src/edit/frame-actions.ts):
 * attaching tags both buttons and lists the variants in their tooltips;
 * detaching puts them back as the action bar built them (classes, tooltip,
 * aria-label) and removes the bar's capture listener.
 */
import { describe, expect, mock, test } from "bun:test";
import { obsidianStub } from "../helpers/obsidian-stub";

mock.module("obsidian", () => obsidianStub);
const { attachFrameActions } = await import("../../src/edit/frame-actions");

type Listener = { type: string; fn: unknown; capture: boolean };

class FakeEl {
  classes = new Set<string>();
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  listeners: Listener[] = [];
  constructor(private picks: Record<string, FakeEl> = {}) {}
  addClass(c: string): void {
    this.classes.add(c);
  }
  removeClass(...cs: string[]): void {
    for (const c of cs) this.classes.delete(c);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  querySelector(sel: string): FakeEl | null {
    const hit = Object.keys(this.picks).find((k) => sel.includes(k));
    return hit ? this.picks[hit]! : null;
  }
  addEventListener(type: string, fn: unknown, capture?: boolean): void {
    this.listeners.push({ type, fn, capture: !!capture });
  }
  removeEventListener(type: string, fn: unknown, capture?: boolean): void {
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === !!capture));
  }
}

function frame() {
  const zoom = new FakeEl();
  zoom.attrs["aria-label"] = "Zoom in";
  const code = new FakeEl();
  code.attrs["aria-label"] = "Edit block";
  const bar = new FakeEl({ "lucide-zoom-in": zoom, "edit-block-button": code });
  const root = new FakeEl({ "embed-actions": bar });
  const target = { root: root as unknown as HTMLElement, lang: "mermaid", sourcePath: "x.md", source: () => "graph TD\n" };
  return { zoom, code, bar, target };
}

describe("attachFrameActions", () => {
  test("detach untags zoom and code and restores their tooltips", () => {
    const { zoom, code, bar, target } = frame();
    const detach = attachFrameActions({ app: {} as never }, target);
    expect([...zoom.classes]).toEqual(["pele-zoom-action"]);
    expect([...code.classes]).toEqual(["pele-code-action"]);
    expect(zoom.attrs["aria-label"]).not.toBe("Zoom in");
    expect(zoom.attrs["aria-label"]!.startsWith("Zoom in (")).toBe(true);
    expect(bar.listeners.length).toBe(1);
    // The mod-icons watcher's remembered base tooltip goes too.
    zoom.dataset.peleBaseTip = zoom.attrs["aria-label"]!;
    zoom.dataset.peleIcon = "square-arrow-out-up-right";
    code.dataset.peleIcon = "panels-top-left";
    zoom.addClass("pele-mod-swap");
    detach();
    expect(zoom.classes.size).toBe(0);
    expect(code.classes.size).toBe(0);
    expect(zoom.attrs["aria-label"]).toBe("Zoom in");
    expect(code.attrs["aria-label"]).toBe("Edit block");
    expect(zoom.dataset.peleBaseTip).toBeUndefined();
    expect(zoom.dataset.peleIcon).toBeUndefined();
    expect(code.dataset.peleIcon).toBeUndefined();
    expect(zoom.attrs["data-icon"]).toBe("zoom-in");
    expect(code.attrs["data-icon"]).toBe("code-2");
    expect(bar.listeners.length).toBe(0);
    // Attach again: the hints are added once, not stacked on the old ones.
    const again = attachFrameActions({ app: {} as never }, target);
    expect(zoom.attrs["aria-label"]!.match(/\(/g)?.length).toBe(1);
    again();
  });
});
