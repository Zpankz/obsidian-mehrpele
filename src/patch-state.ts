import { around } from "monkey-around";

/**
 * DOM/CM-free patch/restore state machine for Obsidian's LP widget prototype.
 * Kept separate from lp-patch.ts (which imports CodeMirror) so it is unit
 * testable with a fake widget class.
 *
 * The live host is held in a mutable holder on the prototype
 * (Symbol.for("pele-mermaid.lpHost")): an adopted patch swaps `holder.current`
 * so widgets dispatch to the newest plugin instance, not the first.
 */

export const PATCH_MARK: unique symbol = Symbol.for("pele-mermaid.lpPatched") as never;
export const ORIG_MARK: unique symbol = Symbol.for("pele-mermaid.lpOriginal") as never;
export const HOST_MARK: unique symbol = Symbol.for("pele-mermaid.lpHost") as never;
/** The wrapper functions we installed (and seeded no-ops), to recognise "still ours on top". */
export const WRAP_MARK: unique symbol = Symbol.for("pele-mermaid.lpWrappers") as never;

const PATCHED_KEYS = ["initDOM", "destroy", "eq", "updateDOM"] as const;

/**
 * Widget/view/DOM arguments are whatever CodeMirror passes to the private
 * widget methods; hosts narrow them (method parameters are bivariant).
 */
export interface PatchHost {
  isOverrideOn(): boolean;
  buildWidgetDOM(widget: unknown, view: unknown): unknown;
  onWidgetDestroy(widget: unknown, dom?: unknown): void;
  onWidgetReuse?(widget: unknown, dom: unknown, view: unknown): boolean;
}

/** Shape of a patched prototype method as monkey-around sees it. */
type WidgetMethod = (this: unknown, ...args: unknown[]) => unknown;
/** The prototype viewed through the four methods we wrap. */
type PatchableProto = Record<(typeof PATCHED_KEYS)[number], WidgetMethod>;

export interface HostHolder {
  /** null = inactive: every wrapper passes straight through to the original. */
  current: PatchHost | null;
}

export type WidgetProto = Record<string, unknown> & {
  [PATCH_MARK]?: boolean;
  [ORIG_MARK]?: { initDOM: unknown; destroy: unknown; eq: unknown; updateDOM: unknown };
  [HOST_MARK]?: HostHolder;
  [WRAP_MARK]?: { wrappers: Record<string, unknown>; seeded: Record<string, unknown> };
};

export interface PatchHandle {
  adopted: boolean;
  uninstall: (() => void) | null;
}

const OUR_LANGS = new Set(["mermaid", "pele", "mehrpele"]);

function langOf(widget: unknown): string | undefined {
  return (widget as { lang?: string } | null)?.lang;
}

/** Patch `proto` (or adopt an existing patch, swapping the host). Never throws. */
export function patchWidgetPrototype(proto: WidgetProto, host: PatchHost): PatchHandle {
  if (proto[PATCH_MARK]) {
    const holder = (proto[HOST_MARK] ??= { current: host });
    holder.current = host; // adoption: newest instance owns dispatch
    return { adopted: true, uninstall: null };
  }
  const holder: HostHolder = { current: host };
  proto[HOST_MARK] = holder;
  proto[ORIG_MARK] = {
    initDOM: proto["initDOM"],
    destroy: proto["destroy"],
    eq: proto["eq"],
    updateDOM: proto["updateDOM"],
  };
  // monkey-around's fallback for a method missing from the whole chain
  // throws when called. Seed absent methods with no-ops so the wrappers
  // always have a callable original; restore deletes them again
  // (their recorded originals are undefined).
  const NOOPS: Record<string, () => unknown> = {
    destroy: () => undefined,
    eq: () => false,
    updateDOM: () => false,
  };
  const seeded: Record<string, unknown> = {};
  for (const [key, noop] of Object.entries(NOOPS)) {
    if (typeof proto[key] !== "function") {
      proto[key] = noop;
      seeded[key] = noop;
    }
  }

  const uninstall = around(proto as PatchableProto, {
    initDOM(orig: WidgetMethod | undefined) {
      return function (this: unknown, ...args: unknown[]) {
        const h = holder.current;
        const lang = langOf(this);
        if (h && lang !== undefined && OUR_LANGS.has(lang) && (lang !== "mermaid" || h.isOverrideOn())) {
          try {
            const el = h.buildWidgetDOM(this, args[0]);
            if (el) return el;
          } catch (e) {
            console.error("[pele-mermaid] LP widget build failed, falling back to native", e);
          }
        }
        return orig ? orig.apply(this, args) : undefined;
      };
    },
    destroy(orig: WidgetMethod | undefined) {
      return function (this: unknown, ...args: unknown[]) {
        try {
          holder.current?.onWidgetDestroy(this, args[0]);
        } catch {
          /* ignore */
        }
        return orig ? orig.apply(this, args) : undefined;
      };
    },
    eq(orig: WidgetMethod | undefined) {
      return function (this: unknown, other: unknown, ...rest: unknown[]) {
        // Never eq-equal distinct mermaid/pele widgets: forcing a rebuild
        // re-reads the fence (width) and re-keys the frame by its new DOM.
        const lang = langOf(this);
        if (holder.current && this !== other && lang !== undefined && OUR_LANGS.has(lang)) return false;
        return orig ? orig.apply(this, [other, ...rest]) : false;
      };
    },
    updateDOM(orig: WidgetMethod | undefined) {
      return function (this: unknown, dom: unknown, view: unknown, ...rest: unknown[]) {
        const lang = langOf(this);
        const h = holder.current;
        if (h && lang !== undefined && OUR_LANGS.has(lang) && h.onWidgetReuse) {
          try {
            if (h.onWidgetReuse(this, dom, view)) return true;
          } catch {
            /* fall through to original */
          }
        }
        return orig ? orig.apply(this, [dom, view, ...rest]) : false;
      };
    },
  });

  const wrappers: Record<string, unknown> = {};
  for (const key of PATCHED_KEYS) wrappers[key] = proto[key];
  proto[WRAP_MARK] = { wrappers, seeded };
  proto[PATCH_MARK] = true;
  return { adopted: false, uninstall };
}

/**
 * Restore originals and delete every mark, adopted or not. Never throws.
 *
 * A method is only force-restored while the installed method is still *our*
 * wrapper (or our seeded no-op). If another plugin wrapped on top of us, its
 * wrapper stays: monkey-around's uninstall has already made ours a
 * pass-through, and the holder is deactivated so an un-uninstallable
 * (adopted) wrapper also passes through. Returns false when such a foreign
 * wrapper was left in place.
 */
export function restoreWidgetPrototype(proto: WidgetProto | null, uninstall: (() => void) | null): boolean {
  if (!proto) return true;
  const orig = proto[ORIG_MARK];
  const wrapped = proto[WRAP_MARK];
  const holder = proto[HOST_MARK];
  try {
    uninstall?.();
  } catch {
    /* ignore */
  }
  let clean = true;
  if (orig) {
    for (const key of PATCHED_KEYS) {
      const original = orig[key];
      const current = proto[key];
      if (current === original) continue;
      const ours =
        current === wrapped?.wrappers[key] ||
        (wrapped?.seeded[key] !== undefined && current === wrapped.seeded[key]) ||
        !wrapped; // legacy patch without WRAP_MARK: previous behaviour
      if (!ours) {
        clean = false; // someone else's wrapper is on top: leave the chain intact
        continue;
      }
      if (original === undefined) delete proto[key];
      else proto[key] = original;
    }
  }
  // Whatever wrapper of ours remains in a chain now passes through.
  if (holder) holder.current = null;
  delete proto[PATCH_MARK];
  delete proto[ORIG_MARK];
  delete proto[HOST_MARK];
  delete proto[WRAP_MARK];
  return clean;
}
