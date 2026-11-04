import { describe, expect, test } from "bun:test";
import {
  findWidgetClass,
  isFencedCodeWidgetClass,
  widgetClassFromWidget,
} from "../src/widget-discovery";

class FakeWidget {
  static canRenderLang(lang: string): boolean {
    return lang === "mermaid";
  }
  initDOM(): object {
    return {};
  }
}

describe("widget discovery predicate", () => {
  test("accepts a class with static canRenderLang and prototype initDOM", () => {
    expect(isFencedCodeWidgetClass(FakeWidget)).toBe(true);
  });

  test("rejects non-functions, missing statics and missing initDOM", () => {
    expect(isFencedCodeWidgetClass(null)).toBe(false);
    expect(isFencedCodeWidgetClass({})).toBe(false);
    expect(isFencedCodeWidgetClass(class {})).toBe(false);
    class OnlyStatic {
      static canRenderLang(): boolean {
        return true;
      }
    }
    expect(isFencedCodeWidgetClass(OnlyStatic)).toBe(false);
    class OnlyProto {
      initDOM(): object {
        return {};
      }
    }
    expect(isFencedCodeWidgetClass(OnlyProto)).toBe(false);
  });

  test("resolves class from a widget instance and scans candidate lists", () => {
    const inst = new FakeWidget();
    expect(widgetClassFromWidget(inst)).toBe(FakeWidget as never);
    expect(widgetClassFromWidget(null)).toBeNull();
    expect(widgetClassFromWidget({})).toBeNull();
    expect(findWidgetClass([{}, inst, class {}])).toBe(FakeWidget as never);
    expect(findWidgetClass([FakeWidget])).toBe(FakeWidget as never);
    expect(findWidgetClass([])).toBeNull();
  });
});

describe("Obsidian 1.15 widget shapes (app.js lP / Uz / Gz)", () => {
  // Shapes from 1.15's app.js: one base class (Xp); the fenced-code widget lP
  // adds static canRenderLang + initDOM/updateCode; sibling widgets (Uz, the
  // callout Gz extends Uz, embeds) have initDOM but no canRenderLang.
  class Xp {
    eq(): boolean {
      return false;
    }
    toDOM(): object {
      return {};
    }
  }
  class LP extends Xp {
    installed = false;
    rendered = false;
    constructor(public lang: string, public code: string) {
      super();
    }
    initDOM(): object {
      return {};
    }
    updateCode(): void {}
    static canRenderLang(lang: string): boolean {
      return lang === "mermaid" || lang === "query";
    }
    get estimatedHeight(): number {
      return 50;
    }
  }
  class Uz extends Xp {
    initDOM(): object {
      return {};
    }
    resolveLinks(): void {}
    get estimatedHeight(): number {
      return 20;
    }
  }
  class Gz extends Uz {
    getType(): string {
      return "note";
    }
    override initDOM(): object {
      return {};
    }
  }
  class Embed extends Xp {
    initDOM(): object {
      return {};
    }
    getImageEl(): null {
      return null;
    }
  }

  test("only the fenced-code widget matches", () => {
    expect(isFencedCodeWidgetClass(LP)).toBe(true);
    for (const k of [Xp, Uz, Gz, Embed]) expect(isFencedCodeWidgetClass(k)).toBe(false);
  });

  test("a decoration scan with callouts and embeds first still finds lP", () => {
    const candidates = [new Gz(), new Embed(), new Uz(), new LP("mermaid", "graph TD; A-->B"), new LP("query", "x")];
    expect(findWidgetClass(candidates)).toBe(LP as never);
  });

  test("a note with no fenced-code widgets finds nothing (discovery stays pending)", () => {
    expect(findWidgetClass([new Gz(), new Embed(), new Uz()])).toBeNull();
  });
});
