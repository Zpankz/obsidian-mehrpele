/**
 * The diagram context menu: an icon grid at the pointer (`menu pele-ctx-menu`),
 * one row per section, sections separated by space; names are tooltips and
 * aria-labels. A DOM popover rather than Obsidian's Menu: macOS native menus
 * show no icons. Keys: arrows / Home / End move, Enter or Space picks, Esc
 * closes, Tab closes and moves on. Outside pointerdown, scroll, resize or window blur closes it.
 */
import { setIcon, setTooltip } from "obsidian";
import { gridMove } from "./grid-nav";
import { placeContextMenu, type ContextItemId, type ContextSection } from "./context-menu-spec";

export { contextItems, type ContextCaps, type ContextItemId, type ContextSection } from "./context-menu-spec";

let current: (() => void) | null = null;

/** Close the open menu, if any (plugin unload). */
export function closeContextMenu(): void {
  current?.();
}

/** Open the menu for `evt` (a contextmenu event); `run` gets the picked item. */
export function openContextMenu(evt: MouseEvent, sections: ContextSection[], run: (id: ContextItemId) => void): void {
  current?.();
  if (!sections.length) return;
  const doc = (evt.target as Node | null)?.ownerDocument ?? document;
  const win = doc.defaultView ?? window;
  const restore = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  const el = doc.body.createDiv({ cls: "menu pele-ctx-menu" });
  el.setAttribute("role", "menu");
  el.setAttribute("aria-label", "Diagram");
  const rows: HTMLElement[][] = [];
  for (const s of sections) {
    const row = el.createDiv({ cls: "pele-ctx-row" });
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", s.label);
    rows.push(
      s.items.map((item) => {
        const b = row.createEl("button", { cls: "clickable-icon pele-ctx-item" });
        b.setAttribute("role", "menuitem");
        b.setAttribute("aria-label", item.label);
        b.dataset.item = item.id;
        b.tabIndex = -1;
        setIcon(b, item.icon);
        setTooltip(b, item.label, { placement: "top" });
        b.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!e.isTrusted) return;
          close(false);
          if (item.onPick) item.onPick(e);
          else run(item.id);
        });
        return b;
      }),
    );
  }

  const place = (): void => {
    const vp = { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
    const p = placeContextMenu({ x: evt.clientX, y: evt.clientY }, { width: el.offsetWidth, height: el.offsetHeight }, vp);
    el.style.left = `${Math.round(p.left)}px`;
    el.style.top = `${Math.round(p.top)}px`;
  };
  place();

  const focusAt = (row: number, col: number): void => {
    for (const r of rows) for (const b of r) b.tabIndex = -1;
    const b = rows[row]?.[col];
    if (!b) return;
    b.tabIndex = 0;
    b.focus({ preventScroll: true });
  };
  const cellOf = (t: EventTarget | null): { row: number; col: number } | null => {
    for (const [row, r] of rows.entries()) {
      const col = r.indexOf(t as HTMLElement);
      if (col >= 0) return { row, col };
    }
    return null;
  };
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      close(false); // focus moves on; the menu goes with it
      return;
    }
    const at = cellOf(doc.activeElement) ?? { row: 0, col: 0 };
    const next = gridMove(rows.map((r) => r.length), at, e.key);
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    focusAt(next.row, next.col);
  });
  for (const t of ["mousedown", "click", "contextmenu"]) el.addEventListener(t, (e) => e.stopPropagation());

  const onDown = (e: PointerEvent): void => {
    if (!el.contains(e.target as Node)) close(false);
  };
  const onScroll = (e: Event): void => {
    if (!el.contains(e.target as Node)) close(false);
  };
  const onBlur = (): void => close(false);
  // After this event: the contextmenu's own pointer events must not close it.
  win.setTimeout(() => {
    if (!el.isConnected) return;
    doc.addEventListener("pointerdown", onDown, true);
    win.addEventListener("scroll", onScroll, true);
    win.addEventListener("resize", onBlur);
    win.addEventListener("blur", onBlur);
  }, 0);
  focusAt(0, 0);

  function close(refocus: boolean): void {
    if (current !== dispose) return;
    current = null;
    doc.removeEventListener("pointerdown", onDown, true);
    win.removeEventListener("scroll", onScroll, true);
    win.removeEventListener("resize", onBlur);
    win.removeEventListener("blur", onBlur);
    el.remove();
    if (refocus && restore?.isConnected) restore.focus({ preventScroll: true });
  }
  const dispose = (): void => close(false);
  current = dispose;
}
