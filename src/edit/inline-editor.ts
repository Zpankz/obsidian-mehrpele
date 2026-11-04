/**
 * Rendered inline label editor.
 *
 * Primary route: Obsidian's own embeddable Markdown editor — the editor
 * Canvas text cards and the Kanban plugin use. There is no public API for
 * it; the class is recovered from a throwaway Markdown embed
 * (`app.embedRegistry.embedByExtension.md(…).editMode`, two prototypes up),
 * then subclassed once per load to add our keys. It is a real Live Preview
 * editor, so tables (cell navigation, add row/column), callouts, maths,
 * code, lists and headings render and edit the way they do in a note, and
 * Obsidian's own suggests — `[[` links, `![[` embeds, `/` slash commands —
 * work on it unchanged (they follow `workspace.activeEditor`, which the
 * editor sets on focus).
 *
 * Fallback (internals missing): a plain textarea with the same keys; no
 * suggests or live rendering.
 *
 * Keys: Mod+Enter commits; Enter commits a single plain line (otherwise it
 * is a newline / list or table continuation); Esc cancels (an open suggest
 * closes first); a click outside commits.
 */
import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { Platform, Scope, TFile, type App } from "obsidian";
import { createPopupGuard, suggestShowing } from "./popup-guard";

/** Where and how the label is drawn, so the editor sits on it seamlessly. */
export interface LabelPlacement {
  /** Label area (client px): the box inscribed in the node's shape. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Corner radius of that area (px). */
  radius: number;
  font: string;
  /** On-screen font size (px). */
  fontSize: number;
  color: string;
  /** Node fill behind the text ("" = editor background). */
  background: string;
  align: "center" | "left";
}

export interface InlineEditorOptions {
  app: App;
  /** The diagram's document (popout windows have their own). */
  doc?: Document;
  /** Label geometry and style; called again on scroll and resize. */
  placement: () => LabelPlacement | null;
  /** Hide the rendered label while editing; returns the restorer. */
  hideLabel?: () => () => void;
  text: string;
  /** Note the label belongs to (link suggestions resolve against it). */
  sourcePath: string;
  /** Model suggestions to pick from (Cmd-click "+"): shown as chips under the editor. */
  suggestions?: Promise<string[]>;
  onCommit(text: string): void;
  onCancel(): void;
}

export interface InlineEditorHandle {
  /** "native" (Obsidian's editor) or "textarea" (fallback). */
  kind: "native" | "textarea";
  el: HTMLElement;
  value(): string;
  /** Replace the text being edited (insert-embed), keeping the editor open and focused. */
  setValue?(text: string): void;
  /** Give the editor the keyboard back (after a popover or picker). */
  focus?(): void;
  commit(): void;
  cancel(): void;
}

/** Internal editor surface we use (subset of Obsidian's MarkdownScrollableEditView). */
interface NativeEditor {
  editor: { getValue(): string; setCursor(p: { line: number; ch: number }): void; lastLine(): number; getLine(n: number): string; focus(): void };
  cm: EditorView;
  editorSuggest?: { currentSuggest?: unknown; close?(): void };
  containerEl: HTMLElement;
  set(text: string, clear?: boolean): void;
  load?(): void;
  unload?(): void;
  destroy?(): void;
  buildLocalExtensions(): Extension[];
}

type EditorCtor = new (app: App, container: HTMLElement, owner: unknown) => NativeEditor;

const ctorCache = new WeakMap<App, EditorCtor | null>();

/** Obsidian's embeddable Markdown editor class, or null when internals changed. */
export function nativeEditorClass(app: App): EditorCtor | null {
  if (ctorCache.has(app)) return ctorCache.get(app)!;
  let ctor: EditorCtor | null = null;
  try {
    const reg = (app as unknown as { embedRegistry?: { embedByExtension?: Record<string, unknown> } }).embedRegistry;
    const md = reg?.embedByExtension?.md as ((ctx: unknown, file: unknown, sub: string) => Record<string, unknown>) | undefined;
    if (typeof md === "function") {
      const embed = md({ app, containerEl: createDiv(), state: {} }, null, "") as {
        load?(): void;
        unload?(): void;
        showEditor?(): void;
        editable?: boolean;
        editMode?: object;
      };
      embed.load?.();
      embed.editable = true;
      embed.showEditor?.();
      const em = embed.editMode;
      const proto: unknown = em ? Object.getPrototypeOf(Object.getPrototypeOf(em)) : null;
      const c: unknown = proto && typeof proto === "object" ? proto.constructor : undefined;
      embed.unload?.();
      if (typeof c === "function" && typeof (c.prototype as NativeEditor).buildLocalExtensions === "function") ctor = c as EditorCtor;
    }
  } catch (e) {
    console.warn("[pele-mermaid] native inline editor unavailable; using the plain fallback", e);
  }
  ctorCache.set(app, ctor);
  return ctor;
}

/** Enter commits when the label is one plain line (no block construct to continue). */
export function enterCommits(text: string): boolean {
  if (text.includes("\n")) return false;
  return !/^\s*(?:[-*+]\s|\d+[.)]\s|>|\||#{1,6}\s|```|~~~|\$\$)/.test(text);
}

/**
 * Centre the editor on the label area: it starts at the area's size and grows
 * from the centre with its content (CSS translate(-50%, -50%)).
 */
function place(el: HTMLElement, p: LabelPlacement, doc: Document): void {
  const vw = doc.documentElement.clientWidth;
  const cx = Math.min(Math.max(p.left + p.width / 2, 40), vw - 40);
  const cy = p.top + p.height / 2;
  Object.assign(el.style, {
    left: `${cx}px`,
    top: `${cy}px`,
    minWidth: `${Math.max(48, Math.round(p.width))}px`,
    minHeight: `${Math.max(20, Math.round(p.height))}px`,
    maxWidth: `${Math.min(640, vw - 16)}px`,
  });
  el.style.setProperty("--pele-inline-radius", `${Math.round(p.radius)}px`);
  el.style.setProperty("--pele-inline-font-size", `${Math.max(9, Math.round(p.fontSize * 10) / 10)}px`);
  el.style.setProperty("--pele-inline-font", p.font);
  el.style.setProperty("--pele-inline-color", p.color);
  el.style.setProperty("--pele-inline-bg", p.background || "var(--background-primary)");
  el.toggleClass("is-left", p.align === "left");
}

const reducedMotion = (doc: Document) => !!doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Open the inline editor on the label (`placement()`). */
export function openInlineEditor(o: InlineEditorOptions): InlineEditorHandle | null {
  const p0 = o.placement();
  if (!p0) return null;
  const doc = o.doc ?? document;
  const host = doc.body.createDiv({ cls: "pele-inline-editor" });
  host.setAttribute("role", "dialog");
  // aria-labelledby, not aria-label: Obsidian shows aria-labels as hover tooltips.
  const titleEl = host.createSpan({ cls: "pele-a11y-label", text: "Edit label: Mod+Enter or click outside to save, Esc to cancel" });
  titleEl.id = `pele-inline-editor-${Date.now()}`;
  host.setAttribute("aria-labelledby", titleEl.id);
  place(host, p0, doc);
  const hint = doc.body.createDiv({ cls: "pele-inline-hint" });
  hint.setText(`${Platform.isMacOS ? "⌘↵" : "Ctrl+↵"} save · Esc cancel`);
  // Suggestions (if any) sit in a strip under the box, the key hint under that.
  let chips: HTMLElement | null = null;
  const placeHint = () => {
    const r = host.getBoundingClientRect();
    let y = r.bottom + 4;
    if (chips) {
      Object.assign(chips.style, { left: `${r.left + r.width / 2}px`, top: `${y}px` });
      y += chips.offsetHeight + 2;
    }
    Object.assign(hint.style, { left: `${r.left + r.width / 2}px`, top: `${y}px` });
  };
  const restoreLabel = o.hideLabel?.() ?? (() => undefined);
  /**
   * Grow from the centre with the content: widest line (or table) at full
   * width, clamped between the label area and the max width. Lines only wrap
   * past the max.
   */
  const fit = (): void => {
    if (closed || !native) return;
    const min = Number.parseFloat(host.style.minWidth) || 48;
    const max = Number.parseFloat(host.style.maxWidth) || 640;
    host.style.width = `${max}px`;
    let w = 0;
    for (const line of Array.from(host.querySelectorAll(".cm-line"))) {
      const r = doc.createRange();
      r.selectNodeContents(line);
      w = Math.max(w, r.getBoundingClientRect().width);
    }
    for (const t of Array.from(host.querySelectorAll<HTMLElement>(".cm-content table, .cm-content .callout"))) w = Math.max(w, t.scrollWidth);
    const pad = 14;
    host.style.width = `${Math.min(max, Math.max(min, Math.ceil(w) + pad))}px`;
  };
  const sizeObs = typeof ResizeObserver !== "undefined" ? new ResizeObserver(placeHint) : null;
  sizeObs?.observe(host);
  window.requestAnimationFrame(() => {
    host.addClass("is-open");
    hint.addClass("is-open");
    placeHint();
  });
  const prevFocus = doc.activeElement as HTMLElement | null;
  const ws = o.app.workspace as unknown as { activeEditor: unknown };
  const prevActive = ws.activeEditor;
  let closed = false;
  // Obsidian's keymap sees keys before the editor does (Mod+Enter is a global
  // hotkey): our scope sits above the app's, below any open suggest's.
  const scope = new Scope(o.app.scope);
  o.app.keymap.pushScope(scope);
  // Core menus (highlight swatch, context menu) close on Esc before the editor sees it.
  const popups = createPopupGuard(doc);
  let native: NativeEditor | null = null;
  let area: HTMLTextAreaElement | null = null;

  const value = (): string => (native ? native.editor.getValue() : (area?.value ?? o.text));
  /** Keyboard to the editor, caret at the end. */
  const focusEnd = (): void => {
    if (closed) return;
    if (native) {
      native.editor.focus();
      const last = native.editor.lastLine();
      native.editor.setCursor({ line: last, ch: native.editor.getLine(last).length });
    } else if (area) {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    }
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    o.app.keymap.popScope(scope);
    popups.dispose();
    doc.removeEventListener("pointerdown", onOutside, true);
    doc.defaultView?.removeEventListener("scroll", onScroll, true);
    try {
      native?.editorSuggest?.close?.();
    } catch {
      /* already closed */
    }
    try {
      native?.destroy?.();
      native?.unload?.();
    } catch {
      /* torn down */
    }
    sizeObs?.disconnect();
    restoreLabel();
    hint.remove();
    chips?.remove();
    // Fade out in place (no motion when reduced), then remove.
    host.removeClass("is-open");
    host.addClass("is-closing");
    if (reducedMotion(doc)) host.remove();
    else window.setTimeout(() => host.remove(), 140);
    if (ws.activeEditor !== prevActive && (ws.activeEditor as { editMode?: unknown } | null)?.editMode === native) {
      try {
        ws.activeEditor = prevActive;
      } catch {
        /* read-only in this version */
      }
    }
    if (prevFocus?.isConnected) prevFocus.focus({ preventScroll: true });
  };
  const handle: InlineEditorHandle = {
    kind: "native",
    el: host,
    value,
    setValue: (text) => {
      if (native) native.set(text, false);
      else if (area) area.value = text;
      focusEnd();
    },
    focus: () => focusEnd(),
    commit: () => {
      if (closed) return;
      const text = value();
      close();
      o.onCommit(text);
    },
    cancel: () => {
      if (closed) return;
      close();
      o.onCancel();
    },
  };
  /** A suggest or menu owns the key (open, or closed by this same keypress). */
  const suggestOpen = (): boolean => suggestShowing(native?.editorSuggest?.currentSuggest) || popups.owns();
  const onOutside = (e: PointerEvent): void => {
    if (!e.isTrusted) return; // only a real click outside saves
    const t = e.target as Element | null;
    if (!t || host.contains(t) || chips?.contains(t)) return;
    // Obsidian's own popups belong to the editor.
    if (t.closest(".suggestion-container, .menu, .modal-container, .prompt, .popover, .tooltip, .pele-embed-insert")) return; // pele-embed-insert: insert-embed button/popover
    handle.commit();
  };
  const onScroll = (): void => {
    const p = o.placement();
    if (p) place(host, p, doc);
    placeHint();
  };

  scope.register(["Mod"], "Enter", () => {
    handle.commit();
    return false;
  });
  scope.register([], "Escape", () => {
    if (suggestOpen()) return true;
    // embed-insert: Esc in the insert popover beside the editor closes the popover only.
    if ((doc.activeElement)?.closest?.(".pele-embed-insert")) return true;
    handle.cancel();
    return false;
  });

  const Ctor = nativeEditorClass(o.app);
  if (Ctor) {
    try {
      const file = o.app.vault.getAbstractFileByPath(o.sourcePath);
      const owner: Record<string, unknown> = {
        app: o.app,
        file: file instanceof TFile ? file : null,
        getMode: () => "source",
        onMarkdownScroll: () => undefined,
      };
      const keys = Prec.highest(
        keymap.of([
          { key: "Mod-Enter", run: () => (handle.commit(), true) },
          {
            key: "Enter",
            run: () => {
              if (suggestOpen() || !enterCommits(value())) return false;
              handle.commit();
              return true;
            },
          },
          {
            key: "Escape",
            run: () => {
              if (suggestOpen()) return false;
              handle.cancel();
              return true;
            },
          },
        ]),
      );
      const sizing = EditorView.updateListener.of((u) => {
        if (u.docChanged || u.geometryChanged) window.requestAnimationFrame(() => {
          fit();
          placeHint();
        });
      });
      class PeleLabelEditor extends (Ctor as unknown as new (...a: unknown[]) => NativeEditor) {
        buildLocalExtensions(): Extension[] {
          return [...super.buildLocalExtensions(), keys, sizing];
        }
      }
      const ed = new PeleLabelEditor(o.app, host, owner);
      owner.editMode = ed;
      owner.editor = ed.editor;
      ed.load?.();
      ed.set(o.text, true);
      native = ed;
      host.addClass("is-native");
      window.requestAnimationFrame(() => {
        if (closed) return;
        fit();
        placeHint();
        focusEnd();
      });
    } catch (e) {
      console.warn("[pele-mermaid] native inline editor failed; using the plain fallback", e);
      native = null;
      for (const c of Array.from(host.children)) if (c !== titleEl) c.remove();
    }
  }
  if (!native) {
    handle.kind = "textarea";
    area = host.createEl("textarea", { cls: "pele-inline-textarea" });
    area.value = o.text;
    area.setAttribute("aria-label", "Label text");
    const grow = () => {
      area!.style.removeProperty("height");
      area!.style.height = `${area!.scrollHeight}px`;
    };
    area.addEventListener("input", grow);
    area.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (popups.owns()) return; // a context menu took this Esc
        e.preventDefault();
        handle.cancel();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (!e.shiftKey && enterCommits(area!.value)))) {
        e.preventDefault();
        handle.commit();
      }
    });
    window.requestAnimationFrame(() => {
      grow();
      focusEnd();
    });
  }
  if (o.suggestions) {
    chips = doc.body.createDiv({ cls: "pele-inline-suggestions" });
    chips.setAttribute("role", "listbox");
    chips.setAttribute("aria-label", "Suggested labels");
    chips.createSpan({ cls: "pele-inline-thinking", text: "Thinking…" });
    window.requestAnimationFrame(placeHint);
    void o.suggestions.then(
      (list) => {
        if (closed) return;
        if (!chips) return;
        chips.empty();
        if (!list.length) chips.createSpan({ cls: "pele-inline-thinking", text: "No suggestions" });
        window.requestAnimationFrame(placeHint);
        for (const label of list) {
          const b = chips.createEl("button", { cls: "pele-inline-chip", text: label });
          b.setAttribute("role", "option");
          b.addEventListener("click", (e) => {
            e.preventDefault();
            if (!e.isTrusted) return;
            if (native) native.set(label, false);
            else if (area) area.value = label;
            handle.commit();
          });
        }
      },
      (err: unknown) => {
        if (closed || !chips) return;
        chips.empty();
        chips.createSpan({ cls: "pele-inline-thinking", text: `No suggestions (${err instanceof Error ? err.message : String(err)})` });
      },
    );
  }
  // Let the opening click finish before listening for outside clicks.
  window.setTimeout(() => {
    if (!closed) doc.addEventListener("pointerdown", onOutside, true);
  }, 0);
  doc.defaultView?.addEventListener("scroll", onScroll, true);
  return handle;
}
