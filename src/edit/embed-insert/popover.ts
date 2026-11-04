/**
 * The insert-embed popover: an icon grid in three groups (views, content,
 * media & links), labels as tooltips and aria-labels, sub-choices in a row
 * under the grid (graph views, base view types, folder depth). Native look
 * (`menu`, `clickable-icon`), placed beside its anchor so it never covers
 * the node it edits. Keys: arrows move (by position), Home/End, Enter or
 * Space choose, Esc closes (back to the anchor).
 */
import { setIcon, setTooltip } from "obsidian";
import { GROUPS, groupsFor, type CatalogItem, type GroupId, type ItemId, type SubItem } from "./catalog";
import { placePopover, type Box } from "./place";

export type { Box };

export interface PopoverOptions {
  doc: Document;
  /** Where the popover hangs (the toolbar button). */
  anchor: HTMLElement;
  /** What it must never cover (the selected node / the inline editor). */
  avoid(): Box | null;
  /** Parent element (the toolbar menu, so its outside-click rule keeps the selection). */
  parent: HTMLElement;
  subsFor(id: ItemId): SubItem[];
  /** The host's own placement for menus (the edit toolbar's placeSub); else beside the anchor. */
  place?(el: HTMLElement): void;
  onPick(id: ItemId, sub: string | null, ev: MouseEvent | KeyboardEvent): void;
  onClose(): void;
  /** Just this group's items, as a small flyout with no heading (a toolbar group button). */
  group?: GroupId;
}

export interface PopoverHandle {
  el: HTMLElement;
  close(): void;
}

export function openPopover(o: PopoverOptions): PopoverHandle {
  const only = o.group ? GROUPS.find((g) => g.id === o.group) : undefined;
  const el = o.parent.createDiv({ cls: only ? "menu pele-embed-insert pele-edit-flyout" : "menu pele-embed-insert" });
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", only?.button ?? "Insert embed");
  let open: ItemId | null = null;
  let subRow: HTMLElement | null = null;
  let closed = false;

  const button = (parent: HTMLElement, icon: string, label: string, cls: string): HTMLElement => {
    const b = parent.createEl("button", { cls: `clickable-icon pele-embed-insert-item ${cls}` });
    setIcon(b, icon);
    b.setAttribute("aria-label", label);
    setTooltip(b, label, { placement: "top" });
    return b;
  };

  const showSubs = (item: CatalogItem, anchorBtn: HTMLElement, focusFirst: boolean): void => {
    subRow?.remove();
    el.querySelectorAll(".pele-embed-insert-item.is-active").forEach((b) => b.removeClass("is-active"));
    el.querySelectorAll(".pele-embed-insert-item.has-sub").forEach((b) => b.setAttribute("aria-expanded", "false"));
    if (open === item.id) {
      open = null;
      subRow = null;
      return;
    }
    open = item.id;
    anchorBtn.addClass("is-active");
    subRow = el.createDiv({ cls: "pele-embed-insert-sub" });
    subRow.setAttribute("role", "group");
    subRow.setAttribute("aria-label", item.label);
    subRow.createDiv({ cls: "pele-embed-insert-heading", text: item.label });
    const grid = subRow.createDiv({ cls: "pele-embed-insert-grid" });
    for (const s of o.subsFor(item.id)) {
      const b = button(grid, s.icon, s.label, "is-sub");
      b.dataset.sub = s.id;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.isTrusted) o.onPick(item.id, s.id, e);
      });
    }
    reposition();
    if (focusFirst) (grid.firstElementChild as HTMLElement | null)?.focus();
  };

  for (const g of groupsFor(o.group)) {
    const sec = el.createDiv({ cls: "pele-embed-insert-group" });
    if (!only) sec.createDiv({ cls: "pele-embed-insert-heading", text: g.label });
    const grid = sec.createDiv({ cls: "pele-embed-insert-grid" });
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", g.label);
    for (const item of g.items) {
      const b = button(grid, item.icon, item.label, item.sub ? "has-sub" : "");
      b.dataset.item = item.id;
      if (item.sub) b.setAttribute("aria-expanded", "false");
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.isTrusted) return;
        if (item.sub) {
          showSubs(item, b, e.detail === 0);
          b.setAttribute("aria-expanded", String(open === item.id));
        } else o.onPick(item.id, null, e);
      });
    }
  }

  const items = (): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(".pele-embed-insert-item")];
  const move = (from: HTMLElement, dir: "left" | "right" | "up" | "down"): HTMLElement | null => {
    const r = from.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const b of items()) {
      if (b === from) continue;
      const q = b.getBoundingClientRect();
      const dx = q.left + q.width / 2 - cx;
      const dy = q.top + q.height / 2 - cy;
      const ok = dir === "left" ? dx < -2 : dir === "right" ? dx > 2 : dir === "up" ? dy < -2 : dy > 2;
      if (!ok) continue;
      // Along the axis first, then across it.
      const score = dir === "left" || dir === "right" ? Math.abs(dy) * 4 + Math.abs(dx) : Math.abs(dx) + Math.abs(dy) * 4;
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best;
  };
  el.addEventListener("keydown", (e) => {
    const cur = (o.doc.activeElement as HTMLElement | null)?.closest?.(".pele-embed-insert-item") as HTMLElement | null;
    const keys: Record<string, "left" | "right" | "up" | "down"> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    if (keys[e.key] && cur) {
      e.preventDefault();
      e.stopPropagation();
      move(cur, keys[e.key])?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const all = items();
      (e.key === "Home" ? all[0] : all[all.length - 1])?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      handle.close();
    }
  });
  for (const t of ["pointerdown", "mousedown", "click", "wheel"]) el.addEventListener(t, (e) => e.stopPropagation());

  const reposition = (): void => {
    if (o.place) return o.place(el);
    const a = o.anchor.getBoundingClientRect();
    const vw = o.doc.documentElement.clientWidth;
    const vh = o.doc.documentElement.clientHeight;
    const p = placePopover(a, { width: el.offsetWidth || 260, height: el.offsetHeight || 200 }, o.avoid(), vw, vh);
    el.style.left = `${Math.round(p.left)}px`;
    el.style.top = `${Math.round(p.top)}px`;
  };
  reposition();
  window.requestAnimationFrame(() => {
    reposition();
    el.querySelector<HTMLElement>(".pele-embed-insert-item")?.focus({ preventScroll: true });
  });

  const handle: PopoverHandle = {
    el,
    close: () => {
      if (closed) return;
      closed = true;
      // Focus inside goes back to the anchor however it closes (Esc here or the host's own Esc).
      const hadFocus = el.contains(o.doc.activeElement);
      el.remove();
      if (hadFocus && o.anchor.isConnected) o.anchor.focus({ preventScroll: true });
      o.onClose();
    },
  };
  return handle;
}
