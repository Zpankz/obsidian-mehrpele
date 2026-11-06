/** Context menu, PNG copy and file export for diagram frames and Mehrpele shells. */
import {
  Notice, TFile
} from "obsidian";
import { contextItems, openContextMenu } from "./context-menu";
import { DiagramFrame } from "./diagram-frame";
import { clearNodeSizes, nodeSizeEntry, writeNodeSize } from "./node-size";
import { buildPlaygroundUrl } from "./render-policy";
import type PeleMermaidPlugin from "../main";
import type { MehrpeleShell } from "./mehrpele/shell";
import type { FrameSurface } from "./api/frame-handles";

export function showMehrpeleMenu(plugin: PeleMermaidPlugin, shell: MehrpeleShell, evt: MouseEvent): void {
  showDiagramMenu(plugin, evt, shell, "mehrpele", {
    svg: () => shell.flattenedSvg(),
    png: () => void copyShellPng(shell),
    export: (kind) => void exportShell(plugin, shell, kind),
    link: (kind) => void plugin.copyDiagramLink(shell, kind),
  });
}

export async function copyShellPng(shell: MehrpeleShell): Promise<void> {
  const r = shell.result();
  const blob = r ? await pngBlobFromSvg(shell.flattenedSvg(), r.width, r.height) : null;
  if (!blob) {
    new Notice("Pele: could not render PNG.");
    return;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    new Notice("Pele: PNG copied.");
  } catch {
    new Notice("Pele: clipboard write failed.");
  }
}

export async function exportShell(plugin: PeleMermaidPlugin, shell: MehrpeleShell, kind: "svg" | "png"): Promise<void> {
  const file = shell.sourcePath ? plugin.app.vault.getAbstractFileByPath(shell.sourcePath) : null;
  if (!(file instanceof TFile)) {
    new Notice("Pele: diagram is not in a saved note.");
    return;
  }
  const dir = file.parent?.path ? `${file.parent.path}/` : "";
  const stem = `${dir}${file.basename}-diagram`;
  let path = `${stem}.${kind}`;
  for (let n = 1; plugin.app.vault.getAbstractFileByPath(path); n++) path = `${stem}-${n}.${kind}`;
  try {
    if (kind === "svg") await plugin.app.vault.create(path, shell.flattenedSvg());
    else {
      const r = shell.result();
      const blob = r ? await pngBlobFromSvg(shell.flattenedSvg(), r.width, r.height) : null;
      if (!blob) throw new Error("png render failed");
      await plugin.app.vault.createBinary(path, await blob.arrayBuffer());
    }
    new Notice(`Pele: exported ${path}`);
  } catch {
    new Notice("Pele: export failed.");
  }
}

// -- context menu ---------------------------------------------------------

export function showFrameMenu(plugin: PeleMermaidPlugin, frame: DiagramFrame, evt: MouseEvent): void {
  showDiagramMenu(plugin, evt, frame, frame.lang, {
    svg: () => frame.flattenedSvg(),
    png: () => void copyFramePng(frame),
    export: (kind) => void exportFrame(plugin, frame, kind),
    link: (kind) => void plugin.copyDiagramLink(frame, kind),
  });
}

/** The icon-first context menu (src/context-menu) for a frame or a Mehrpele shell. */
export function showDiagramMenu(
  plugin: PeleMermaidPlugin,
  evt: MouseEvent,
  target: {
    source: string;
    sourcePath: string;
    canLinkBlock: boolean;
    hasWidth: boolean;
    revealCode(): void;
    resetSize(): void;
    nodeIdAt(t: EventTarget | null): string | null;
    editNodeSizes(edit: (s: string) => string): void;
    companionSurface(): FrameSurface | null;
  },
  lang: string,
  io: { svg(): string; png(): void; export(kind: "svg" | "png"): void; link(kind: "uri" | "wikilink"): void },
): void {
  evt.preventDefault();
  const nodeId = target.nodeIdAt(evt.target);
  const exApi = plugin.excalidrawApi();
  // Companion items (api addMenuItems) follow the built-ins, for frames with a handle.
  const surface = target.companionSurface();
  const handle = surface ? plugin.frameHandles.handleOf(surface) : null;
  const sections = contextItems(
    {
      link: target.canLinkBlock,
      excalidraw: typeof exApi?.createDrawing === "function",
      width: target.hasWidth,
      nodeSize: nodeId !== null && !!nodeSizeEntry(target.source, nodeId),
      allSizes: clearNodeSizes(target.source) !== target.source,
    },
    handle ? plugin.companionMenus.sections(handle) : [],
  );
  openContextMenu(evt, sections, (id) => {
    switch (id) {
      case "svg":
        void navigator.clipboard.writeText(io.svg()).then(() => new Notice("Pele: SVG copied (theme vars inlined)."));
        return;
      case "png":
        return io.png();
      case "link":
        return io.link("uri");
      case "wikilink":
        return io.link("wikilink");
      case "export-svg":
        return io.export("svg");
      case "export-png":
        return io.export("png");
      case "source":
        return target.revealCode();
      case "playground": {
        const url = buildPlaygroundUrl(target.source);
        if (url) window.open(url);
        else new Notice("Pele: diagram too large for a playground link.");
        return;
      }
      case "canvas":
        return void plugin.convertToCanvas(target.source, target.sourcePath, lang);
      case "excalidraw":
        return void exApi?.createDrawing(target.source, { sourcePath: target.sourcePath, open: true }).catch((e: unknown) => {
          new Notice(`Pele: Excalidraw conversion failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      case "reset-size":
        return target.resetSize();
      case "reset-node-size":
        if (nodeId !== null) target.editNodeSizes((s) => writeNodeSize(s, nodeId, null));
        return;
      case "reset-all-sizes":
        return target.editNodeSizes(clearNodeSizes);
    }
  });
}

export async function framePngBlob(frame: DiagramFrame): Promise<Blob | null> {
  const w = frame.diagramWidth || frame.root.offsetWidth || 800;
  const h = frame.diagramHeight || frame.root.offsetHeight || 600;
  return pngBlobFromSvg(frame.flattenedSvg(), w, h);
}

export async function pngBlobFromSvg(svg: string, w: number, h: number): Promise<Blob | null> {
  const scale = 2 * (window.devicePixelRatio || 1);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("svg load failed"));
      img.src = url;
    });
    const canvas = createEl("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function copyFramePng(frame: DiagramFrame): Promise<void> {
  const blob = await framePngBlob(frame);
  if (!blob) {
    new Notice("Pele: could not render PNG.");
    return;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    new Notice("Pele: PNG copied.");
  } catch {
    new Notice("Pele: clipboard write failed.");
  }
}

export async function exportFrame(plugin: PeleMermaidPlugin, frame: DiagramFrame, kind: "svg" | "png"): Promise<void> {
  const file = frame.sourcePath ? plugin.app.vault.getAbstractFileByPath(frame.sourcePath) : null;
  if (!(file instanceof TFile)) {
    new Notice("Pele: diagram is not in a saved note.");
    return;
  }
  const dir = file.parent?.path ? `${file.parent.path}/` : "";
  const stem = `${dir}${file.basename}-diagram`;
  let path = `${stem}.${kind}`;
  for (let n = 1; plugin.app.vault.getAbstractFileByPath(path); n++) {
    path = `${stem}-${n}.${kind}`;
  }
  try {
    if (kind === "svg") {
      await plugin.app.vault.create(path, frame.flattenedSvg());
    } else {
      const blob = await framePngBlob(frame);
      if (!blob) throw new Error("png render failed");
      await plugin.app.vault.createBinary(path, await blob.arrayBuffer());
    }
    new Notice(`Pele: exported ${path}`);
  } catch {
    new Notice("Pele: export failed.");
  }
}
