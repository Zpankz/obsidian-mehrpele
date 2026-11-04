/**
 * Companion action-bar buttons (api `addFrameAction`). Each frame's bar keeps the
 * built-in actions first (src/action-bar.ts); companion buttons follow them in
 * registration order as `div.embed-action.mehrpele-companion-action[data-action=<id>]`.
 * `when`, `icon` and `title` are evaluated per frame on every render and on
 * `refreshActions`; the disposer removes the button from every bar.
 */
import { setIcon, setTooltip } from "obsidian";
import type { FrameActionDef, FrameHandle, PerFrame } from "mehrpele-api";
import { asButton } from "../a11y";

export const COMPANION_ACTION_CLASS = "mehrpele-companion-action";

interface Drawn {
  def: FrameActionDef;
  el: HTMLElement;
  icon: string | null;
  title: string | null;
  handle: FrameHandle;
}

function resolve(v: PerFrame<string>, frame: FrameHandle): string {
  return typeof v === "function" ? v(frame) : v;
}

export class CompanionActions {
  private defs: FrameActionDef[] = [];
  /** Buttons drawn per bar, by action id. */
  private bars = new Map<HTMLElement, Map<string, Drawn>>();

  /** `changed` re-syncs every live frame (the host passes its handle registry's resync). */
  constructor(private changed: () => void = () => undefined) {}

  add(def: FrameActionDef): () => void {
    // Re-registering an id replaces the earlier action.
    const prev = this.defs.find((d) => d.id === def.id);
    if (prev) this.remove(prev);
    this.defs.push(def);
    this.changed();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.remove(def);
    };
  }

  get size(): number {
    return this.defs.length;
  }

  private remove(def: FrameActionDef): void {
    if (!this.defs.includes(def)) return;
    this.defs = this.defs.filter((d) => d !== def);
    for (const drawn of this.bars.values()) {
      const d = drawn.get(def.id);
      if (d?.def !== def) continue;
      d.el.remove();
      drawn.delete(def.id);
    }
  }

  /** Brings the companion buttons on `bar` up to date for `frame`. */
  sync(bar: HTMLElement, frame: FrameHandle): void {
    let drawn = this.bars.get(bar);
    if (!drawn) {
      if (!this.defs.length) return;
      drawn = new Map();
      this.bars.set(bar, drawn);
    }
    const want: HTMLElement[] = [];
    for (const def of this.defs) {
      let cur = drawn.get(def.id);
      if (cur && cur.def !== def) {
        cur.el.remove();
        drawn.delete(def.id);
        cur = undefined;
      }
      let show = false;
      let icon = "";
      let title = "";
      try {
        show = !!def.when(frame);
        if (show) {
          icon = resolve(def.icon, frame);
          title = resolve(def.title, frame);
        }
      } catch (e) {
        console.error(`Mehrpele: frame action ${def.id} failed`, e);
        show = false;
      }
      if (!show) {
        cur?.el.remove();
        drawn.delete(def.id);
        continue;
      }
      const d = cur ?? this.create(bar, def, frame);
      d.handle = frame;
      if (d.icon !== icon) {
        setIcon(d.el, icon);
        d.icon = icon;
      }
      if (d.title !== title) {
        d.el.setAttribute("aria-label", title);
        setTooltip(d.el, title);
        d.title = title;
      }
      drawn.set(def.id, d);
      want.push(d.el);
    }
    // Keep the companion buttons last, in registration order (built-ins stay first).
    let n = bar.lastChild;
    let ordered = true;
    for (let i = want.length - 1; i >= 0; i--) {
      if (n !== want[i]) {
        ordered = false;
        break;
      }
      n = n.previousSibling;
    }
    if (!ordered) for (const el of want) bar.appendChild(el);
  }

  private create(bar: HTMLElement, def: FrameActionDef, frame: FrameHandle): Drawn {
    // Keyboard: role=button, a tab stop, Enter/Space (a11y.ts), like the built-ins.
    const el = asButton(createDiv());
    el.className = `embed-action ${COMPANION_ACTION_CLASS}`;
    el.setAttribute("data-action", def.id);
    const d: Drawn = { def, el, icon: null, title: null, handle: frame };
    el.addEventListener("click", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        void Promise.resolve(d.def.run(d.handle, e)).catch((err: unknown) =>
          console.error(`Mehrpele: frame action ${d.def.id} failed`, err),
        );
      } catch (err) {
        console.error(`Mehrpele: frame action ${d.def.id} failed`, err);
      }
    });
    return d;
  }

  /** Forgets a bar whose frame is gone (its buttons go with it). */
  forget(bar: HTMLElement): void {
    this.bars.delete(bar);
  }

  /** Removes every companion button and action (host unload). */
  clear(): void {
    for (const drawn of this.bars.values()) for (const d of drawn.values()) d.el.remove();
    this.bars.clear();
    this.defs = [];
  }
}
