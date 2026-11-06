/**
 * Mod+Enter / Mod+Space on a focused frame action, on a small fake DOM:
 * Obsidian's keymap sees keys first (capture, on the window) and runs Mod+Enter
 * hotkeys before the action's own keydown, so while focus is in the bar a
 * scope is pushed that turns those keys into the action's modified click.
 * The scope goes when focus leaves the bar and when the frame lets go.
 */
import { describe, expect, mock, test } from "bun:test";
import { obsidianStub, Scope } from "./helpers/obsidian-stub";

mock.module("obsidian", () => obsidianStub);
const { bindActionKeys } = await import("../src/action-bar");

type Handler = (e: any) => void;

class Click {
  constructor(
    public type: string,
    public init: Record<string, unknown>,
  ) {}
}

const doc = { defaultView: { MouseEvent: Click } };

class FakeEl {
  parent: FakeEl | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Handler[]> = {};
  clicks: Click[] = [];
  ownerDocument = doc;
  add(...cs: FakeEl[]): this {
    for (const c of cs) c.parent = this;
    return this;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  addEventListener(type: string, fn: Handler): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: Handler): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  dispatchEvent(e: Click): boolean {
    this.clicks.push(e);
    return true;
  }
  fire(type: string, e: Record<string, unknown> = {}): void {
    for (const fn of [...(this.listeners[type] ?? [])]) fn({ type, ...e });
  }
  count(): number {
    return (this.listeners.focusin?.length ?? 0) + (this.listeners.focusout?.length ?? 0);
  }
  contains(o: FakeEl | null): boolean {
    for (let n = o; n; n = n.parent) if (n === this) return true;
    return false;
  }
}

function setup() {
  const bar = new FakeEl();
  const zoom = new FakeEl();
  const code = new FakeEl();
  for (const b of [zoom, code]) b.setAttribute("role", "button");
  bar.add(zoom, code);
  const pushed: Scope[] = [];
  const popped: Scope[] = [];
  const app = { scope: new Scope(), keymap: { pushScope: (s: Scope) => void pushed.push(s), popScope: (s: Scope) => void popped.push(s) } };
  const keys = bindActionKeys(bar as unknown as HTMLElement, app as never);
  return { bar, zoom, code, app, pushed, popped, keys };
}

const press = (target: FakeEl, key: string, mods: Record<string, boolean>) => ({ key, target, repeat: false, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("action bar keys", () => {
  test("focus in the bar pushes one scope (on app.scope) with Mod, Mod+Alt and Mod+Alt+Shift Enter/Space", () => {
    const { bar, zoom, code, app, pushed, popped } = setup();
    expect(pushed.length).toBe(0);
    bar.fire("focusin", { target: zoom });
    bar.fire("focusout", { target: zoom, relatedTarget: code });
    bar.fire("focusin", { target: code });
    expect(pushed.length).toBe(1);
    expect(popped.length).toBe(0);
    const scope = pushed[0]!;
    expect(scope.parent).toBe(app.scope);
    expect(scope.keys.map((k) => `${k.modifiers?.join("+")} ${k.key}`).sort()).toEqual(
      ["Mod Enter", "Mod  ", "Mod+Alt Enter", "Mod+Alt  ", "Mod+Alt+Shift Enter", "Mod+Alt+Shift  "].sort(),
    );
  });

  test("a scoped key clicks the focused action with the key's modifiers and stops there", () => {
    const { bar, zoom, code, pushed } = setup();
    bar.fire("focusin", { target: code });
    const scope = pushed[0]!;
    const run = (mods: string, key: string, e: Record<string, unknown>) => scope.keys.find((k) => k.modifiers?.join("+") === mods && k.key === key)!.func(e, {});
    expect(run("Mod+Alt", "Enter", press(code, "Enter", { metaKey: true, altKey: true }))).toBe(false);
    expect(code.clicks.length).toBe(1);
    expect(code.clicks[0]!.type).toBe("click");
    expect(code.clicks[0]!.init).toMatchObject({ bubbles: true, cancelable: true, metaKey: true, altKey: true, shiftKey: false, ctrlKey: false });
    expect(run("Mod", " ", press(code, " ", { ctrlKey: true }))).toBe(false);
    expect(code.clicks[1]!.init).toMatchObject({ ctrlKey: true });
    // A held key repeats: no second click, still kept from the hotkeys.
    expect(run("Mod", "Enter", { ...press(code, "Enter", { metaKey: true }), repeat: true })).toBe(false);
    expect(code.clicks.length).toBe(2);
    expect(zoom.clicks.length).toBe(0);
  });

  test("focus leaving the bar pops it once; the frame letting go pops it and drops the listeners", () => {
    const { bar, zoom, pushed, popped, keys } = setup();
    bar.fire("focusin", { target: zoom });
    bar.fire("focusout", { target: zoom, relatedTarget: null });
    expect(popped).toEqual([pushed[0]!]);
    bar.fire("focusout", { target: zoom, relatedTarget: null });
    expect(popped.length).toBe(1);
    // Suspended (the DOM went away with focus in it): popped, listeners kept for a revive.
    bar.fire("focusin", { target: zoom });
    keys.release();
    expect(popped).toEqual([pushed[0]!, pushed[1]!]);
    expect(bar.count()).toBe(2);
    bar.fire("focusin", { target: zoom });
    keys.dispose();
    expect(popped.length).toBe(3);
    expect(popped[2]).toBe(pushed[2]!);
    expect(bar.count()).toBe(0);
    keys.dispose();
    expect(popped.length).toBe(3);
  });
});
