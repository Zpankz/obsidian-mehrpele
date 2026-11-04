/** Render children that own one diagram frame each. */
import {
  MarkdownRenderChild
} from "obsidian";
import { DiagramFrame } from "./diagram-frame";
import { type FenceSize } from "./info-width";
import type PeleMermaidPlugin from "../main";
import { frameHostOf } from "./frame-host";
import { isReadOnlyFrameRoot, inMehrpeleLabel } from "./mehrpele-dom";
import type { FrameCompanion } from "./api/frame-handles";

/**
 * Lifecycle wrapper for one integration mount target: owns the target's
 * current frame (replaced on refresh) and destroys it with the block.
 */
export class IntegrationFrameChild extends MarkdownRenderChild {
  frame: DiagramFrame | null = null;
  constructor(
    containerEl: HTMLElement,
    private onGone: () => void,
  ) {
    super(containerEl);
  }
  release(): void {
    this.frame?.destroy();
    this.frame = null;
  }
  onunload(): void {
    this.release();
    this.onGone();
  }
}

export class PeleDiagramChild extends MarkdownRenderChild {
  private frame: DiagramFrame;

  constructor(
    containerEl: HTMLElement,
    plugin: PeleMermaidPlugin,
    source: string,
    sourcePath: string,
    lang: string,
    fenceLine: number | undefined,
    size: FenceSize,
    nested = false,
    companion?: FrameCompanion,
  ) {
    super(containerEl);
    this.frame = new DiagramFrame(frameHostOf(plugin), {
      source,
      lang,
      sourcePath,
      ...size,
      nested,
      ...(companion ? { companion } : {}),
      onRevealCode: (frame) => {
        // Inside Live Preview (pele processor branch) reveal the source in
        // the editor; in Reading view toggle the inline source panel.
        const inLp = !!frame.root.closest(".cm-preview-code-block");
        if (inLp && fenceLine !== undefined && plugin.revealInEditor(sourcePath, fenceLine)) return;
        frame.toggleSourcePanel();
      },
      onPersistSize:
        fenceLine === undefined
          ? undefined
          : (edit) => {
              if (isReadOnlyFrameRoot(this.frame.root)) return; // live-only in embeds/labels
              plugin.persistSizeInFile(sourcePath, fenceLine, edit, source, this.frame.root);
            },
      onApplyRepaired:
        fenceLine === undefined
          ? undefined
          : (newSource, expected) =>
              inMehrpeleLabel(this.frame.root)
                ? Promise.resolve(false)
                : plugin.applyChildRepair(sourcePath, fenceLine, expected, newSource, this.frame.root),
      onEnsureBlockId:
        fenceLine === undefined
          ? undefined
          : (src) =>
              inMehrpeleLabel(this.frame.root)
                ? Promise.resolve(null)
                : plugin.ensureChildBlockId(sourcePath, fenceLine, src, this.frame.root),
    });
    containerEl.appendChild(this.frame.root);
  }

  onload(): void {
    this.frame.load();
  }

  onunload(): void {
    this.frame.destroy();
  }
}
