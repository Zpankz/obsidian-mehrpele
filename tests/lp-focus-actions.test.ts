/**
 * Live Preview route to a diagram's actions and back, on a small fake editor:
 * - "Focus diagram actions" is there only in Live Preview with a rendered
 *   diagram widget, and focuses the first action of the diagram nearest the
 *   cursor (the one holding the cursor line, else the next below, else the
 *   closest above);
 * - Escape on a focused action gives focus back to the editor, cursor kept.
 */
import { describe, expect, mock, test } from "bun:test";
import { obsidianStub } from "./helpers/obsidian-stub";

mock.module("obsidian", () => obsidianStub);
const { escapeToEditor, focusDiagramActions, nearestDiagram } = await import("../src/lp/focus-actions");
const { floatedActionBars } = await import("../src/action-bar-location");

const FIRST_ACTION = ":scope > [role=button]:not(.pele-hidden)";

class Action {
  focused = 0;
  inBar = true;
  focus(): void {
    this.focused++;
  }
  closest(sel: string): object | null {
    return sel === ".embed-actions" && this.inBar ? {} : null;
  }
}

/** A widget container at block lines [from, to] (1-based); `action` null = not a diagram (another code block). */
function widget(from: number, to: number, action: Action | null = new Action()) {
  const bar = { querySelector: (sel: string) => sel === FIRST_ACTION ? action : null };
  const root = { querySelector: (sel: string) => sel === ":scope > .embed-actions" ? bar : null };
  return { from, to, action, bar, root, querySelector: (sel: string) => (sel === ":scope > .pele-embed" ? root : null) };
}

function editor(widgets: ReturnType<typeof widget>[], cursorLine: number, livePreview = true) {
  // Line n starts at 100 * n; a widget maps to its first line.
  const lineAt = (pos: number) => ({ number: Math.floor(pos / 100) });
  const view = {
    focused: 0,
    contentDOM: { querySelectorAll: (sel: string) => (sel === ".cm-preview-code-block" ? widgets : []) },
    posAtDOM: (el: ReturnType<typeof widget>) => el.from * 100,
    lineBlockAt: (pos: number) => {
      const w = widgets.find((x) => x.from * 100 === pos)!;
      return { from: w.from * 100, to: w.to * 100 + 7 };
    },
    state: {
      doc: { lineAt },
      selection: { main: { head: cursorLine * 100 + 3 } },
      field: (_f: unknown, _require?: boolean) => livePreview,
    },
    focus(): void {
      view.focused++;
    },
  };
  return view;
}

describe("nearest diagram", () => {
  const ds = [
    { from: 3, to: 6 },
    { from: 10, to: 14 },
    { from: 20, to: 22 },
  ];
  test("the one holding the cursor line, else the next below, else the closest above", () => {
    expect(nearestDiagram(ds, 12)).toBe(ds[1]!);
    expect(nearestDiagram(ds, 10)).toBe(ds[1]!);
    expect(nearestDiagram(ds, 14)).toBe(ds[1]!);
    expect(nearestDiagram(ds, 1)).toBe(ds[0]!);
    expect(nearestDiagram(ds, 7)).toBe(ds[1]!);
    expect(nearestDiagram(ds, 15)).toBe(ds[2]!);
    expect(nearestDiagram(ds, 30)).toBe(ds[2]!);
    expect(nearestDiagram([], 5)).toBeNull();
  });
});

describe("focus diagram actions", () => {
  test("finds the owning diagram's floated bar without loading editing features", () => {
    const w = widget(3, 6);
    w.root.querySelector = () => null;
    floatedActionBars.set(w.root as never, w.bar as never);
    expect(focusDiagramActions(editor([w], 4) as never, false)).toBe(true);
    expect(w.action!.focused).toBe(1);
    floatedActionBars.delete(w.root as never);
  });
  test("only in Live Preview with a rendered diagram widget", () => {
    expect(focusDiagramActions(undefined, true)).toBe(false);
    expect(focusDiagramActions(editor([widget(3, 6)], 1, false) as never, true)).toBe(false);
    expect(focusDiagramActions(editor([], 1) as never, true)).toBe(false);
    expect(focusDiagramActions(editor([widget(3, 6, null)], 1) as never, true)).toBe(false);
    const w = widget(3, 6);
    expect(focusDiagramActions(editor([w], 1) as never, true)).toBe(true);
    expect(w.action!.focused).toBe(0);
  });

  test("focuses the first action of the diagram nearest the cursor", () => {
    const a = widget(3, 6);
    const other = widget(8, 9, null);
    const b = widget(10, 14);
    const c = widget(20, 22);
    expect(focusDiagramActions(editor([a, other, b, c], 7) as never, false)).toBe(true);
    expect([a.action!.focused, b.action!.focused, c.action!.focused]).toEqual([0, 1, 0]);
    expect(focusDiagramActions(editor([a, other, b, c], 25) as never, false)).toBe(true);
    expect(c.action!.focused).toBe(1);
    // Block lines come from the editor (lineBlockAt), so a cursor on a block's last line is in it.
    expect(focusDiagramActions(editor([a, other, b, c], 6) as never, false)).toBe(true);
    expect(a.action!.focused).toBe(1);
  });
});

describe("escape to the editor", () => {
  function container() {
    const ls: ((e: any) => void)[] = [];
    return { ls, addEventListener: (type: string, fn: (e: any) => void) => type === "keydown" && ls.push(fn) };
  }
  const key = (k: string, target: Action) => {
    const e = { key: k, target, isComposing: false, prevented: false, stopped: false, preventDefault: () => void (e.prevented = true), stopPropagation: () => void (e.stopped = true) };
    return e;
  };

  test("Escape on a focused action focuses the editor; other keys and targets pass", () => {
    const c = container();
    const view = editor([], 1);
    escapeToEditor(c as never, view as never);
    const action = new Action();
    const e = key("Escape", action);
    c.ls[0]!(e);
    expect(view.focused).toBe(1);
    expect([e.prevented, e.stopped]).toEqual([true, true]);
    // The cursor stays where it was: nothing touches the selection.
    expect(view.state.selection.main.head).toBe(103);
    const enter = key("Enter", action);
    c.ls[0]!(enter);
    const outside = new Action();
    outside.inBar = false;
    const esc2 = key("Escape", outside);
    c.ls[0]!(esc2);
    expect(view.focused).toBe(1);
    expect([enter.prevented, esc2.prevented]).toEqual([false, false]);
  });
});
