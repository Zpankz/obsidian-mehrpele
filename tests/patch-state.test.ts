import { describe, expect, test } from "bun:test";
import {
  HOST_MARK,
  ORIG_MARK,
  PATCH_MARK,
  patchWidgetPrototype,
  restoreWidgetPrototype,
  type PatchHost,
  type WidgetProto,
} from "../src/patch-state";

interface Call {
  method: string;
  args: unknown[];
  self?: unknown;
}

function makeHost(name: string, calls: Call[]): PatchHost {
  return {
    isOverrideOn: () => true,
    buildWidgetDOM: (widget: { lang: string }) => {
      calls.push({ method: `${name}.build`, args: [widget.lang] });
      return { builtBy: name } as never;
    },
    onWidgetDestroy: (widget: unknown, dom?: unknown) => {
      calls.push({ method: `${name}.destroyed`, args: [dom], self: widget });
    },
    onWidgetReuse: () => false,
  };
}

class FakeWidget {
  lang: string;
  code = "x";
  calls: Call[] = [];
  constructor(lang = "mermaid") {
    this.lang = lang;
  }
  initDOM(...args: unknown[]): unknown {
    this.calls.push({ method: "native.initDOM", args });
    return "native-dom";
  }
  destroy(...args: unknown[]): unknown {
    this.calls.push({ method: "native.destroy", args });
    return "destroyed";
  }
  eq(other: unknown): boolean {
    this.calls.push({ method: "native.eq", args: [other] });
    return true;
  }
  updateDOM(...args: unknown[]): boolean {
    this.calls.push({ method: "native.updateDOM", args });
    return false;
  }
}

class NoDestroyWidget {
  lang = "mermaid";
  initDOM(): string {
    return "native";
  }
}

describe("patch/restore state machine", () => {
  test("fresh patch dispatches mermaid to host, forwards other langs + args", () => {
    const proto = FakeWidget.prototype as unknown as WidgetProto;
    const calls: Call[] = [];
    const handle = patchWidgetPrototype(proto, makeHost("h1", calls));
    expect(handle.adopted).toBe(false);
    expect(proto[PATCH_MARK]).toBe(true);

    const w = new FakeWidget("mermaid");
    expect((w.initDOM as (...a: unknown[]) => unknown)("view", "extra")).toEqual({ builtBy: "h1" });

    const q = new FakeWidget("query");
    expect((q.initDOM as (...a: unknown[]) => unknown)("view", 42)).toBe("native-dom");
    expect(q.calls[0]).toEqual({ method: "native.initDOM", args: ["view", 42] });

    restoreWidgetPrototype(proto, handle.uninstall);
    expect(proto[PATCH_MARK]).toBeUndefined();
    expect(proto[ORIG_MARK]).toBeUndefined();
    expect(proto[HOST_MARK]).toBeUndefined();
  });

  test("destroy forwards dom arg and notifies host; eq forces rebuild for our langs", () => {
    const proto = FakeWidget.prototype as unknown as WidgetProto;
    const calls: Call[] = [];
    const handle = patchWidgetPrototype(proto, makeHost("h1", calls));
    const w = new FakeWidget("mermaid");
    expect((w.destroy as (...a: unknown[]) => unknown)("dom-el")).toBe("destroyed");
    expect(calls.some((c) => c.method === "h1.destroyed" && c.args[0] === "dom-el")).toBe(true);
    expect(w.calls[0]).toEqual({ method: "native.destroy", args: ["dom-el"] });

    const other = new FakeWidget("mermaid");
    expect(w.eq(other)).toBe(false); // distinct mermaid widgets never eq-equal
    expect(w.eq(w)).toBe(true); // identity delegates to original
    expect(w.updateDOM("d", "v")).toBe(false); // host reuse false → original
    restoreWidgetPrototype(proto, handle.uninstall);
  });

  test("adopted patch swaps the host holder (new instance owns dispatch)", () => {
    const proto = FakeWidget.prototype as unknown as WidgetProto;
    const c1: Call[] = [];
    const c2: Call[] = [];
    const h1 = patchWidgetPrototype(proto, makeHost("h1", c1));
    const h2 = patchWidgetPrototype(proto, makeHost("h2", c2));
    expect(h2.adopted).toBe(true);
    expect(h2.uninstall).toBeNull();

    const w = new FakeWidget("mermaid");
    expect((w.initDOM as (...a: unknown[]) => unknown)("view")).toEqual({ builtBy: "h2" });
    expect(c1.some((c) => c.method === "h1.build")).toBe(false);

    // Adopted restore (no uninstaller) still restores originals + clears marks.
    restoreWidgetPrototype(proto, h2.uninstall ?? h1.uninstall);
    expect(proto[PATCH_MARK]).toBeUndefined();
    expect(proto[ORIG_MARK]).toBeUndefined();
    expect(proto[HOST_MARK]).toBeUndefined();
    const fresh = new FakeWidget("mermaid");
    expect((fresh.initDOM as (...a: unknown[]) => unknown)("view")).toBe("native-dom");
  });

  test("restore deletes proto.destroy when the original was undefined", () => {
    const proto = NoDestroyWidget.prototype as unknown as WidgetProto;
    expect("destroy" in proto).toBe(false);
    const calls: Call[] = [];
    const handle = patchWidgetPrototype(proto, makeHost("h1", calls));
    const w = new NoDestroyWidget();
    expect(typeof (w as { destroy?: unknown }).destroy).toBe("function"); // wrapper installed
    expect(((w as never as FakeWidget).destroy as (...a: unknown[]) => unknown)("dom")).toBeUndefined();
    expect(calls.some((c) => c.method === "h1.destroyed")).toBe(true);

    restoreWidgetPrototype(proto, handle.uninstall);
    expect(Object.prototype.hasOwnProperty.call(proto, "destroy")).toBe(false);
    expect(proto[PATCH_MARK]).toBeUndefined();
    expect(proto[ORIG_MARK]).toBeUndefined();
    expect(proto[HOST_MARK]).toBeUndefined();
  });

  test("restore leaves another plugin's wrapper on top intact and goes inert", () => {
    class W extends FakeWidget {}
    const proto = W.prototype as unknown as WidgetProto;
    // Give the subclass own methods so patching targets it, not FakeWidget.
    for (const k of ["initDOM", "destroy", "eq", "updateDOM"]) (proto as Record<string, unknown>)[k] = (FakeWidget.prototype as unknown as Record<string, unknown>)[k];
    const calls: Call[] = [];
    const handle = patchWidgetPrototype(proto, makeHost("h1", calls));
    // Another plugin wraps initDOM after us.
    const below = proto["initDOM"] as (...a: unknown[]) => unknown;
    const foreign = function (this: unknown, ...args: unknown[]) {
      calls.push({ method: "foreign.initDOM", args });
      return below.apply(this, args);
    };
    proto["initDOM"] = foreign;

    expect(restoreWidgetPrototype(proto, handle.uninstall)).toBe(false);
    expect(proto["initDOM"]).toBe(foreign); // not clobbered
    expect(proto[PATCH_MARK]).toBeUndefined();
    // Our wrapper below now passes through to native.
    const w = new W("mermaid");
    expect((w.initDOM as (...a: unknown[]) => unknown)("view")).toBe("native-dom");
    expect(calls.map((c) => c.method)).toEqual(["foreign.initDOM"]);
    // Methods nobody else wrapped are fully restored.
    expect(proto["destroy"]).toBe(FakeWidget.prototype.destroy);
  });

  test("adopted (un-uninstallable) wrapper under a foreign one also goes inert", () => {
    class W2 extends FakeWidget {}
    const proto = W2.prototype as unknown as WidgetProto;
    for (const k of ["initDOM", "destroy", "eq", "updateDOM"]) (proto as Record<string, unknown>)[k] = (FakeWidget.prototype as unknown as Record<string, unknown>)[k];
    const calls: Call[] = [];
    patchWidgetPrototype(proto, makeHost("old", calls));
    const below = proto["initDOM"] as (...a: unknown[]) => unknown;
    proto["initDOM"] = function (this: unknown, ...a: unknown[]) {
      return below.apply(this, a);
    };
    const h2 = patchWidgetPrototype(proto, makeHost("new", calls));
    expect(h2.adopted).toBe(true);
    expect(restoreWidgetPrototype(proto, null)).toBe(false);
    const w = new W2("mermaid");
    expect((w.initDOM as (...a: unknown[]) => unknown)("view")).toBe("native-dom");
    expect(calls.some((c) => c.method.endsWith(".build"))).toBe(false);
  });
});
