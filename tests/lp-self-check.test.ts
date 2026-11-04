import { describe, expect, test } from "bun:test";
import type { EditorView } from "@codemirror/view";
import { LpTakeover, type LpHost } from "../src/lp-patch";

// 1.15-shaped widgets (see widget-discovery.test.ts): the fenced-code class has
// static canRenderLang; a callout-style sibling does not.
class LP {
  constructor(public lang = "mermaid") {}
  initDOM(): object {
    return {};
  }
  static canRenderLang(): boolean {
    return true;
  }
}
class Callout {
  initDOM(): object {
    return {};
  }
}

/** Fake EditorView: no decoration facets, `.cm-preview-code-block` elements carrying cmView.widget. */
function view(widgets: unknown[]): EditorView {
  const els = widgets.map((w) => ({ cmView: { widget: w } }));
  return {
    state: { facet: () => [] },
    dom: { querySelectorAll: () => els },
  } as unknown as EditorView;
}

function takeover() {
  const calls = { unavailable: [] as string[], firstPatch: 0 };
  const host: LpHost = {
    isOverrideOn: () => true,
    buildWidgetDOM: () => null,
    onWidgetDestroy: () => {},
    onWidgetReuse: () => false,
    onFenceWidthChanges: () => {},
    onFirstPatch: () => void calls.firstPatch++,
    onUnavailable: (r) => void calls.unavailable.push(r),
  };
  return { lp: new LpTakeover(host), calls };
}

describe("LpTakeover.selfCheck (layout-ready)", () => {
  test("finds and patches the 1.15 widget class: ok, no report", () => {
    const { lp, calls } = takeover();
    const err = console.error;
    console.error = () => {};
    try {
      expect(lp.selfCheck([view([new Callout()]), view([new Callout(), new LP()])])).toBe("ok");
    } finally {
      console.error = err;
      lp.restore();
    }
    expect(lp.isPatched).toBe(false);
    expect(calls.firstPatch).toBe(1);
    expect(calls.unavailable).toEqual([]);
  });

  test("code blocks on screen, no matching class: failed, reported once", () => {
    const { lp, calls } = takeover();
    const logged: unknown[] = [];
    const err = console.error;
    console.error = (...a: unknown[]) => void logged.push(a);
    try {
      expect(lp.selfCheck([view([new Callout()])])).toBe("failed");
      expect(lp.selfCheck([view([new Callout()])])).toBe("failed");
    } finally {
      console.error = err;
    }
    expect(calls.unavailable.length).toBe(1);
    expect(logged.length).toBe(1);
    expect(lp.isPatched).toBe(false);
  });

  test("no code blocks open: pending, nothing reported", () => {
    const { lp, calls } = takeover();
    expect(lp.selfCheck([view([]), view([])])).toBe("pending");
    expect(lp.selfCheck([])).toBe("pending");
    expect(calls.unavailable).toEqual([]);
  });
});
