import type { FrameHandle } from "mehrpele-api";
import type { HandleRegistry } from "./frame-handles";

export const FLOW_HINT_LAYER = "mehrpele:addon-hint:flows";
export const FLOW_HINT_TEXT = "Flow · needs Mehrpele Flows";

/** One host-owned hint on the handle's active surface; never imports the companion. */
export class AddonHints {
  private readonly buttons = new Map<FrameHandle, HTMLButtonElement>();
  private readonly off: (() => void)[];
  private disposed = false;

  constructor(private readonly deps: {
    handles: Pick<HandleRegistry, "list" | "onDidRender" | "onDidDestroy" | "startWatching">;
    enabled(): boolean;
    ready(): boolean;
    openFlows(): void;
  }) {
    this.off = [deps.handles.onDidRender((f) => this.sync(f)), deps.handles.onDidDestroy((f) => this.remove(f))];
    this.refresh();
  }

  refresh(): void {
    if (this.disposed) return;
    for (const f of this.buttons.keys()) if (!f.isConnected()) this.remove(f);
    for (const f of this.deps.handles.list()) this.sync(f);
  }

  private sync(frame: FrameHandle): void {
    if (this.disposed) return;
    if (!this.deps.enabled() || this.deps.ready() || !frame.isConnected() || !frame.fenceRest.split(/\s+/).includes("cannoli")) {
      this.remove(frame);
      return;
    }
    // Reuse the registry's visibility watches; ordinary diagrams still allocate no hint layer.
    this.deps.handles.startWatching();
    if (this.buttons.has(frame)) return;
    const layer = frame.overlay(FLOW_HINT_LAYER);
    const button = layer.createEl("button", { cls: "mehrpele-addon-hint", text: FLOW_HINT_TEXT });
    button.type = "button";
    button.onpointerdown = (evt) => evt.stopPropagation();
    button.onclick = (evt) => { evt.stopPropagation(); this.deps.openFlows(); };
    this.buttons.set(frame, button);
  }

  private remove(frame: FrameHandle): void {
    const button = this.buttons.get(frame);
    if (!button) return;
    button.onclick = button.onpointerdown = null;
    button.remove();
    this.buttons.delete(frame);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.off) off();
    for (const f of this.buttons.keys()) this.remove(f);
  }
}
