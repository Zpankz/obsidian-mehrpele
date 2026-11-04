/**
 * Companion context-menu items (api `addMenuItems`). The diagram menu is a DOM popover
 * (src/context-menu.ts), not an Obsidian `Menu`, so each callback gets a small
 * Menu-compatible collector. Its items become extra icon rows after the built-in sections:
 * one row per `setSection` name (or per run between `addSeparator` calls), in the order
 * they were added. Picking an item runs its `onClick`. Disabled items are left out;
 * `setChecked`/`setWarning` are accepted and ignored.
 */
import type { Menu } from "obsidian";
import type { FrameHandle } from "mehrpele-api";
import type { ContextItem, ContextSection } from "../context-menu-spec";

type MenuCallback = (menu: Menu, frame: FrameHandle) => void;
type ClickHandler = (evt: MouseEvent | KeyboardEvent) => unknown;

/** The icon shown for a companion item that sets none (the menu is icon-only). */
const FALLBACK_ICON = "puzzle";

interface Collected {
  title: string;
  icon: string | null;
  section: string | null;
  disabled: boolean;
  handler: ClickHandler | null;
  /** Bumped by `addSeparator`: items on either side go in different rows. */
  group: number;
}

class CollectorItem {
  constructor(readonly data: Collected) {}
  setTitle(title: string | DocumentFragment): this {
    this.data.title = typeof title === "string" ? title : (title.textContent ?? "");
    return this;
  }
  setIcon(icon: string | null): this {
    this.data.icon = icon;
    return this;
  }
  setSection(section: string): this {
    this.data.section = section;
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.data.disabled = disabled;
    return this;
  }
  setChecked(_checked: boolean | null): this {
    return this;
  }
  setWarning(_warning: boolean): this {
    return this;
  }
  setIsLabel(_label: boolean): this {
    return this;
  }
  onClick(cb: ClickHandler): this {
    this.data.handler = cb;
    return this;
  }
}

class CollectorMenu {
  readonly items: Collected[] = [];
  private group = 0;
  addItem(cb: (item: CollectorItem) => unknown): this {
    const data: Collected = { title: "", icon: null, section: null, disabled: false, handler: null, group: this.group };
    cb(new CollectorItem(data));
    this.items.push(data);
    return this;
  }
  addSeparator(): this {
    this.group++;
    return this;
  }
  setNoIcon(): this {
    return this;
  }
  setUseNativeMenu(_native: boolean): this {
    return this;
  }
}

export class CompanionMenus {
  private callbacks: MenuCallback[] = [];

  add(cb: MenuCallback): () => void {
    this.callbacks.push(cb);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.callbacks = this.callbacks.filter((c) => c !== cb);
    };
  }

  get size(): number {
    return this.callbacks.length;
  }

  clear(): void {
    this.callbacks = [];
  }

  /**
   * Runs every callback for `frame` and returns their items as menu sections, to append
   * after the built-in ones. A callback that throws is skipped.
   */
  sections(frame: FrameHandle): ContextSection[] {
    const out: ContextSection[] = [];
    let n = 0;
    for (const [ci, cb] of [...this.callbacks].entries()) {
      const menu = new CollectorMenu();
      try {
        cb(menu as unknown as Menu, frame);
      } catch (e) {
        console.error("Mehrpele: a companion menu callback failed", e);
        continue;
      }
      const rows = new Map<string, ContextSection>();
      for (const it of menu.items) {
        if (it.disabled || !it.title) continue;
        const key = `${it.group}\u0000${it.section ?? ""}`;
        let row = rows.get(key);
        if (!row) {
          row = { id: `ext:${ci}:${rows.size}`, label: it.section ?? "More", items: [] };
          rows.set(key, row);
        }
        const handler = it.handler;
        const item: ContextItem = {
          id: `ext:${n++}`,
          icon: it.icon ?? FALLBACK_ICON,
          label: it.title,
          onPick: (evt) => {
            const failed = (e: unknown): void => console.error("Mehrpele: a companion menu item failed", e);
            try {
              void Promise.resolve(handler?.(evt)).catch(failed);
            } catch (e) {
              failed(e);
            }
          },
        };
        row.items.push(item);
      }
      out.push(...rows.values());
    }
    return out;
  }
}
