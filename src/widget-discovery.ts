/**
 * DOM-free predicate for discovering Obsidian's LP fenced-code widget class.
 * The class is minified/private, so we recognise it structurally: a constructor
 * with a static `canRenderLang(lang)` and an `initDOM(view)` on its prototype.
 */

export interface FencedCodeWidgetClass {
  canRenderLang: (lang: string) => boolean;
  prototype: { initDOM: (view: unknown) => unknown };
}

export function isFencedCodeWidgetClass(candidate: unknown): candidate is FencedCodeWidgetClass {
  if (typeof candidate !== "function") return false;
  const klass = candidate as { canRenderLang?: unknown; prototype?: unknown };
  if (typeof klass.canRenderLang !== "function") return false;
  const proto = klass.prototype as { initDOM?: unknown } | null | undefined;
  if (!proto || typeof proto !== "object") return false;
  return typeof proto.initDOM === "function";
}

/** Constructor of a widget instance, if it is an instance of the widget class. */
export function widgetClassFromWidget(widget: unknown): FencedCodeWidgetClass | null {
  if (!widget || (typeof widget !== "object" && typeof widget !== "function")) return null;
  const ctor = (widget as { constructor?: unknown }).constructor;
  return isFencedCodeWidgetClass(ctor) ? ctor : null;
}

/** First candidate (class or widget instance) matching the widget-class shape. */
export function findWidgetClass(candidates: Iterable<unknown>): FencedCodeWidgetClass | null {
  for (const c of candidates) {
    if (isFencedCodeWidgetClass(c)) return c;
    const fromWidget = widgetClassFromWidget(c);
    if (fromWidget) return fromWidget;
  }
  return null;
}
