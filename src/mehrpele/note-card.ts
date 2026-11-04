/**
 * Note cards: a node whose label is a sole `![[Note]]` (`#Heading`, `#^block`)
 * IS the note, as a Canvas file card is. The note is rendered with Obsidian's
 * own Markdown embed (the object Canvas file cards use) without the embed
 * chrome: no embed title row, no left border, no link icon. The inline title
 * and properties follow the user's settings exactly as in Canvas, and the
 * file name can show as a small label above the node (overlay.ts,
 * `noteCardLabels`).
 *
 * Like a Canvas card: links and hover previews work inside; Mod-click opens
 * the note; double-click edits the note in place (the embed's own editor:
 * edits are saved to the note file, never to the diagram, and undo is the
 * editor's); Esc or clicking elsewhere returns to reading. A note longer than
 * its node scrolls inside it.
 */
import { Keymap, type App, type Component, type TFile } from "obsidian";
import { noteCardTitle } from "./note-card-title";

/** Class of the card container (mehrpele.css; the toolbar leaves its double-clicks alone). */
export const NOTE_CARD_CLASS = "mehrpele-note-card";
/** Set on the card while its editor is open (re-measures wait; see mount.ts). */
export const NOTE_EDITING_CLASS = "is-editing-note";

interface MarkdownEmbedLike extends Component {
  editable?: boolean;
  loadFile?(): Promise<void> | void;
  showEditor?(): void;
  showPreview?(): void;
  getMode?(): string;
  editor?: { focus(): void };
}

type EmbedCreator = (
  ctx: { app: App; containerEl: HTMLElement; linktext: string; sourcePath: string; depth: number },
  file: TFile,
  subpath: string,
) => MarkdownEmbedLike | null;

export interface NoteCard {
  el: HTMLElement;
  /** The label above the node (`Note`, `Note › Heading`). */
  title: string;
  editing(): boolean;
}


/**
 * Mount `file` (with `subpath`, e.g. `#Heading`) as a card in `parent`.
 * Null when Obsidian has no Markdown embed to use (the caller falls back to
 * the plain embed).
 */
export async function mountNoteCard(
  app: App,
  file: TFile,
  subpath: string,
  parent: HTMLElement,
  sourcePath: string,
  owner: Component,
  depth: number,
): Promise<NoteCard | null> {
  const creator = (app as unknown as { embedRegistry?: { embedByExtension?: Record<string, EmbedCreator> } }).embedRegistry?.embedByExtension?.md;
  if (typeof creator !== "function") return null;
  const el = parent.createDiv({ cls: `${NOTE_CARD_CLASS} markdown-embed` });
  let embed: MarkdownEmbedLike | null = null;
  try {
    embed = creator({ app, containerEl: el, linktext: file.path + subpath, sourcePath, depth }, file, subpath);
  } catch (e) {
    console.warn("[mehrpele] note card failed", e);
  }
  if (!embed) {
    el.remove();
    return null;
  }
  owner.addChild(embed);
  embed.editable = true;
  await embed.loadFile?.();
  el.addClass("is-loaded");

  const editing = (): boolean => el.hasClass(NOTE_EDITING_CLASS);
  const stopEditing = (): void => {
    if (!editing()) return;
    el.removeClass(NOTE_EDITING_CLASS);
    doc.removeEventListener("pointerdown", onOutside, true);
    try {
      embed.showPreview?.(); // the embed has saved its edits to the note
    } catch {
      /* unloaded */
    }
  };
  const doc = el.ownerDocument;
  // Popups the editor opens (link suggest, menus, modals) live outside the card.
  const isPopup = (t: EventTarget | null): boolean =>
    !!(t as Element | null)?.closest?.(".suggestion-container, .menu, .modal-container");
  const onOutside = (ev: PointerEvent): void => {
    const t = ev.target as Node | null;
    if (t && !el.contains(t) && !isPopup(t)) stopEditing();
  };
  // Blur ends editing too (keyboard focus moved away: palette, other pane, window).
  el.addEventListener("focusout", (ev) => {
    if (!editing()) return;
    const next = ev.relatedTarget as Node | null;
    if (next && (el.contains(next) || isPopup(next))) return;
    // A popup may take focus a tick later; only stop if focus really left.
    (doc.defaultView ?? window).setTimeout(() => {
      const a = doc.activeElement;
      if (a && (el.contains(a) || isPopup(a))) return;
      if (doc.querySelector(".suggestion-container, .menu, .modal-container")) return;
      stopEditing();
    }, 0);
  });
  const startEditing = (): void => {
    if (editing() || !embed?.showEditor) return;
    el.addClass(NOTE_EDITING_CLASS);
    embed.showEditor();
    embed.editor?.focus();
    doc.addEventListener("pointerdown", onOutside, true);
  };
  owner.register(() => {
    doc.removeEventListener("pointerdown", onOutside, true);
  });

  el.addEventListener("dblclick", (ev) => {
    if (editing() || !ev.isTrusted) return;
    // Links keep their own double-click (they navigate on click anyway).
    if ((ev.target as Element | null)?.closest?.("a, .internal-link, .external-link")) return;
    ev.preventDefault();
    ev.stopPropagation();
    startEditing();
  });
  el.addEventListener("keydown", (ev) => {
    // Esc that closes the editor's own suggest popup, or leaves vim insert mode,
    // stays the editor's; blur still ends editing then.
    const vim = !!(app.vault as unknown as { getConfig?(k: string): unknown }).getConfig?.("vimMode");
    if (ev.key === "Escape" && editing() && !vim && !doc.querySelector(".suggestion-container")) {
      ev.preventDefault();
      ev.stopPropagation();
      stopEditing();
    }
  }, true);
  // Mod-click anywhere on the card (not on a link: links open their own target) opens the note.
  el.addEventListener("click", (ev) => {
    if (editing() || !Keymap.isModEvent(ev) || !ev.isTrusted) return;
    if ((ev.target as Element | null)?.closest?.("a, .internal-link, .external-link")) return;
    ev.preventDefault();
    ev.stopPropagation();
    void app.workspace.openLinkText(file.path + subpath, sourcePath, Keymap.isModEvent(ev));
  });
  return { el, title: noteCardTitle(file.basename, subpath), editing };
}
