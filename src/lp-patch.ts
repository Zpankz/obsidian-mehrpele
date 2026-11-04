import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { fenceLayoutChanged, fenceWidthChangesIn, type TextChange } from "./fence-change";
import {
  patchWidgetPrototype,
  restoreWidgetPrototype,
  type PatchHandle,
  type WidgetProto,
} from "./patch-state";
import { findWidgetClass, isFencedCodeWidgetClass, type FencedCodeWidgetClass } from "./widget-discovery";
import { lpSelfCheckVerdict, type LpSelfCheckVerdict } from "./lp-self-check";

/** Minimal surface of Obsidian's private LP fenced-code widget instances. */
export interface LpWidgetLike {
  lang: string;
  code: string;
  containerEl?: HTMLElement;
  lineStart: number;
  lineEnd: number;
  start: number;
  end: number;
  resizeWidget?: (view: EditorView, el: HTMLElement) => void;
}

export interface LpHost {
  isOverrideOn(): boolean;
  /** Build the Pele DOM for a widget; return null to fall back to native rendering. */
  buildWidgetDOM(widget: LpWidgetLike, view: EditorView): HTMLElement | null;
  /** Called when CM destroys a widget; `dom` is the widget's DOM (may be undefined). */
  onWidgetDestroy(widget: LpWidgetLike, dom?: HTMLElement): void;
  /** Called when CM reuses a widget's DOM (eq match); return true if handled. */
  onWidgetReuse(widget: LpWidgetLike, dom: HTMLElement, view: EditorView): boolean;
  /** Fence width(s) changed by a doc edit (widget instance was reused, so no initDOM ran). */
  onFenceWidthChanges(view: EditorView, changes: { line: number; width: number | undefined; height: number | undefined; zoom: number | undefined }[]): void;
  /**
   * A doc edit may have moved fences (line count changed) or edited a fence's info line
   * without any widget DOM call: companion frame keys may be stale (see fenceLayoutChanged).
   */
  onFenceLayoutChange?(view: EditorView): void;
  /** Called once after the prototype is first patched. */
  onFirstPatch(): void;
  /** Called at most once when code blocks are on screen but the widget class was not found. */
  onUnavailable?(reason: string): void;
}

/** The decoration's widget when it is an instance of the patched widget class (`proto` is in its chain). */
function widgetOf(spec: unknown, proto: WidgetProto): LpWidgetLike | undefined {
  if (typeof spec !== "object" || spec === null || !("widget" in spec)) return undefined;
  const widget: unknown = spec.widget;
  if (!widget || !Object.prototype.isPrototypeOf.call(proto, widget)) return undefined;
  return widget as LpWidgetLike;
}

const MAX_DISCOVERY_ATTEMPTS = 30;
const RESCAN_MIN_INTERVAL_MS = 500;

interface ViewScanState {
  attempts: number;
  lastScanAt: number;
  lastBlockCount: number;
  gaveUp: boolean;
}

/**
 * Discovers Obsidian's private Live Preview fenced-code widget class at
 * runtime and patches its prototype so `mermaid` (override on) and `pele`
 * widgets render with Pele. Discovery is structural (see widget-discovery.ts);
 * any failure leaves native rendering untouched and never throws.
 */
export class LpTakeover {
  private host: LpHost;
  private handle: PatchHandle | null = null;
  private patchedProto: WidgetProto | null = null;
  private loggedFailure = false;
  private notifiedPatch = false;
  private reportedUnavailable = false;
  private scanStates = new WeakMap<EditorView, ViewScanState>();
  private healedViews = new WeakSet<EditorView>();

  constructor(host: LpHost) {
    this.host = host;
  }

  /** Editor extension that runs discovery on editor updates (with backoff). */
  extension() {
    // The plugin class below has its own `this`; reach the takeover through these.
    const tryDiscover = (view: EditorView): void => this.tryDiscover(view);
    const healView = (view: EditorView): void => this.healView(view);
    const notifyFenceWidthChanges: LpTakeover["notifyFenceWidthChanges"] = (view, entries) =>
      this.notifyFenceWidthChanges(view, entries);
    const onFenceLayoutChange = (view: EditorView): void => this.host.onFenceLayoutChange?.(view);
    return ViewPlugin.fromClass(
      class {
        constructor(view: EditorView) {
          tryDiscover(view);
          // Widgets Obsidian built natively before our patch (e.g. a note restored
          // in Live Preview at startup) are reused with their cached DOM; heal once.
          window.requestAnimationFrame(() => healView(view));
        }
        update(u: ViewUpdate): void {
          tryDiscover(u.view);
          if (!u.docChanged) return;
          // The decoration builder reuses the identical widget instance when
          // lang+code are unchanged, so a hand-edited fence width never runs
          // initDOM/eq/updateDOM. Detect it from the change ranges instead.
          try {
            const changes: TextChange[] = [];
            u.changes.iterChanges((fromA, toA, fromB, toB) => {
              changes.push({ fromA, toA, fromB, toB });
            });
            // Line-level access to the changed ranges only (no doc copies).
            const entries = fenceWidthChangesIn(u.startState.doc, u.state.doc, changes);
            if (entries.length > 0) notifyFenceWidthChanges(u.view, entries);
            if (fenceLayoutChanged(u.startState.doc, u.state.doc, changes)) onFenceLayoutChange(u.view);
          } catch {
            /* never break editor updates */
          }
        }
      },
    );
  }

  get isPatched(): boolean {
    return this.patchedProto !== null;
  }

  /**
   * Obsidian's widget `toDOM` returns a cached `containerEl` once `initDOM` has
   * run, so instances rendered natively before the patch keep native DOM. Drop
   * those caches for our langs so the next `toDOM` runs the patched `initDOM`.
   * `force` langs (a toggled integration block) are reset whatever they show,
   * so their processor runs again. Returns how many widgets were reset.
   */
  clearStaleWidgetCaches(view: EditorView, force: ReadonlySet<string> = new Set()): number {
    const proto = this.patchedProto;
    if (!proto) return 0;
    let reset = 0;
    try {
      for (const deco of view.state.facet(EditorView.decorations)) {
        if (typeof deco === "function") continue;
        const iter = deco.iter();
        for (let guard = 0; iter.value && guard < 10_000; guard++, iter.next()) {
          const widget = widgetOf(iter.value.spec, proto);
          if (!widget) continue;
          const lang = widget.lang;
          if (force.has(lang)) {
            if (widget.containerEl) {
              widget.containerEl = undefined;
              reset++;
            }
            continue;
          }
          if (lang !== "mermaid" && lang !== "pele" && lang !== "mehrpele") continue;
          if (lang === "mermaid" && !this.host.isOverrideOn()) continue;
          const el = widget.containerEl;
          if (el && !el.querySelector(".pele-embed")) {
            widget.containerEl = undefined;
            reset++;
          }
        }
      }
    } catch {
      /* facet shape changed: leave native rendering */
    }
    return reset;
  }

  /** Once per view: reset stale widget caches and redraw in place (keeps undo/selection). */
  healView(view: EditorView): void {
    if (this.healedViews.has(view) || !this.patchedProto) return;
    this.healedViews.add(view);
    try {
      if (this.clearStaleWidgetCaches(view) > 0) view.setState(view.state);
    } catch {
      /* view destroyed meanwhile */
    }
  }

  notifyFenceWidthChanges(
    view: EditorView,
    changes: { line: number; width: number | undefined; height: number | undefined; zoom: number | undefined }[],
  ): void {
    try {
      this.host.onFenceWidthChanges(view, changes);
    } catch {
      /* ignore */
    }
  }

  tryDiscover(view: EditorView): void {
    if (this.patchedProto) return;
    try {
      // Backoff: rescan only when the code-block count changed or ≥500 ms
      // elapsed, and give up after N failed attempts per view (log once).
      let count = -1;
      try {
        count = view.dom.querySelectorAll(".cm-preview-code-block").length;
      } catch {
        /* DOM not ready */
      }
      const now = Date.now();
      let st = this.scanStates.get(view);
      if (!st) {
        st = { attempts: 0, lastScanAt: 0, lastBlockCount: -1, gaveUp: false };
        this.scanStates.set(view, st);
      }
      if (st.gaveUp) return;
      if (count === st.lastBlockCount && now - st.lastScanAt < RESCAN_MIN_INTERVAL_MS) return;
      st.lastScanAt = now;
      st.lastBlockCount = count;
      st.attempts++;

      const klass = this.discover(view);
      if (!klass) {
        if (st.attempts >= MAX_DISCOVERY_ATTEMPTS) {
          st.gaveUp = true;
          if (lpSelfCheckVerdict({ patched: false, sawCodeBlocks: count > 0 }) === "failed") {
            this.reportUnavailable("widget class not found after repeated scans");
          } else {
            this.logFailure(new Error("widget class not found after repeated scans"));
          }
        }
        return;
      }
      this.patch(klass);
    } catch (e) {
      this.logFailure(e);
    }
  }

  /**
   * Startup self-check (layout-ready): scan each open editor now, ignoring the
   * backoff. Code blocks on screen with no matching widget class means this
   * Obsidian build changed the widget; report once and leave native rendering.
   */
  selfCheck(views: readonly EditorView[]): LpSelfCheckVerdict {
    let sawCodeBlocks = false;
    for (const view of views) {
      if (this.patchedProto) break;
      try {
        if (view.dom.querySelectorAll(".cm-preview-code-block").length > 0) sawCodeBlocks = true;
        const klass = this.discover(view);
        if (klass) this.patch(klass);
      } catch (e) {
        this.logFailure(e);
      }
    }
    const verdict = lpSelfCheckVerdict({ patched: this.isPatched, sawCodeBlocks });
    if (verdict === "failed") this.reportUnavailable("no fenced-code widget class among open Live Preview code blocks");
    return verdict;
  }

  private reportUnavailable(reason: string): void {
    if (this.reportedUnavailable) return;
    this.reportedUnavailable = true;
    this.logFailure(new Error(reason));
    try {
      this.host.onUnavailable?.(reason);
    } catch {
      /* never break editor updates */
    }
  }

  private discover(view: EditorView): FencedCodeWidgetClass | null {
    // Primary: scan decoration facets for widget instances/classes.
    try {
      const facets = view.state.facet(EditorView.decorations) as unknown[];
      const candidates: unknown[] = [];
      for (const entry of facets) {
        if (typeof entry === "function") continue; // function-valued facet entries are providers
        const set = entry as { iter?: () => { value: { spec?: { widget?: unknown } } | null; next: () => void } };
        if (!set || typeof set.iter !== "function") continue;
        const cursor = set.iter();
        let guard = 0;
        while (cursor.value && guard++ < 10000) {
          const w = cursor.value.spec?.widget;
          if (w) candidates.push(w);
          cursor.next();
        }
      }
      const found = findWidgetClass(candidates);
      if (found) return found;
    } catch {
      /* fall through to DOM scan */
    }
    // Fallback: widgets already in the DOM carry cmView.widget.
    try {
      const els = view.dom.querySelectorAll(".cm-preview-code-block");
      const candidates: unknown[] = [];
      els.forEach((el) => {
        const w = (el as unknown as { cmView?: { widget?: unknown } }).cmView?.widget;
        if (w) candidates.push(w);
      });
      return findWidgetClass(candidates);
    } catch {
      return null;
    }
  }

  private patch(klass: FencedCodeWidgetClass): void {
    const proto = klass.prototype as unknown as WidgetProto;
    this.handle = patchWidgetPrototype(proto, this.host);
    this.patchedProto = proto;
    this.notifyPatched();
  }

  private notifyPatched(): void {
    if (this.notifiedPatch) return;
    this.notifiedPatch = true;
    try {
      this.host.onFirstPatch();
    } catch (e) {
      this.logFailure(e);
    }
  }

  /** Restore the original prototype methods. Safe to call when not patched. */
  restore(): void {
    try {
      restoreWidgetPrototype(this.patchedProto, this.handle?.uninstall ?? null);
    } catch (e) {
      this.logFailure(e);
    }
    this.handle = null;
    this.patchedProto = null;
    this.notifiedPatch = false;
  }

  private logFailure(e: unknown): void {
    if (this.loggedFailure) return;
    this.loggedFailure = true;
    console.error("[pele-mermaid] Live Preview takeover unavailable; native rendering left intact.", e);
  }
}

export { isFencedCodeWidgetClass };
