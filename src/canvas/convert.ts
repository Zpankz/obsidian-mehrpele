/**
 * Canvas → Mermaid in the plugin: one conversion used by the commands, the
 * file menu and the `pele:from-canvas` CLI handler, plus the pure helpers
 * for the two destinations (a new note beside the canvas, or a block
 * inserted into a note). No Obsidian imports (UI: convert-ui.ts).
 */
import { canvasToMermaid, type CanvasData, type FromCanvasOptions } from "pele-render/canvas";

export type CanvasLayoutMode = "auto" | "canvas";

export interface CanvasConvertSettings {
  portals: "link" | "inline";
  portalDepth: number;
  /** `canvas`: the block pins card positions (`%% pele-layout canvas %%`). */
  layout: CanvasLayoutMode;
}

export interface CanvasBlock {
  lang: "mermaid" | "mehrpele" | "pele";
  /** Diagram source (no fence, trailing newline). */
  source: string;
  /** The fenced block. */
  block: string;
  dropped: string[];
}

/** `.canvas` paths a canvas references through portal (or plain) file cards. */
export function canvasReferences(data: CanvasData): string[] {
  const out = new Set<string>();
  for (const n of data.nodes ?? []) {
    const f = (n as { file?: unknown }).file;
    if (n.type === "file" && typeof f === "string" && f.toLowerCase().endsWith(".canvas")) out.add(f);
  }
  return [...out];
}

/**
 * Convert canvas data to a fenced diagram block. `lang` forces the fence
 * (and Markdown labels for mehrpele); otherwise the block is mehrpele when
 * the canvas needs Markdown labels (file cards, Markdown text) or Mehrpele
 * is on for every block, else mermaid.
 */
export function canvasToBlock(
  data: CanvasData,
  settings: CanvasConvertSettings,
  opts: {
    lang?: "mermaid" | "mehrpele" | "pele";
    mehrpeleByDefault: boolean;
    resolveCanvas?: (path: string) => CanvasData | null;
    layout?: CanvasLayoutMode;
    scale?: number;
    /** view-nodes: link cards become live web-view nodes (Mehrpele view nodes on). */
    webNodes?: boolean;
  },
): CanvasBlock {
  const forced = opts.lang;
  const mehrpele = forced ? forced === "mehrpele" : opts.mehrpeleByDefault ? true : undefined;
  const fromOpts: FromCanvasOptions = {
    mehrpele,
    portals: settings.portals,
    portalDepth: settings.portalDepth,
    resolveCanvas: opts.resolveCanvas ?? (() => null),
    layout: opts.layout ?? settings.layout,
    ...(opts.scale !== undefined ? { scale: opts.scale } : {}),
    ...(opts.webNodes && forced !== "mermaid" && forced !== "pele" ? { webNodes: true } : {}), // view-nodes
  };
  const r = canvasToMermaid(data, fromOpts);
  const lang = forced ?? (r.mehrpele ? "mehrpele" : "mermaid");
  const source = r.source.endsWith("\n") ? r.source : `${r.source}\n`;
  const fence = fenceFor(source);
  return { lang, source, block: `${fence}${lang}\n${source}${fence}`, dropped: r.dropped };
}

/** A backtick fence longer than any backtick run in `source` (text cards may hold code blocks). */
export function fenceFor(source: string): string {
  const longest = Math.max(0, ...[...source.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** `<folder>/<canvas name>.md`, then ` 2`, ` 3`… when taken. */
export function mermaidNoteName(canvasPath: string, attempt = 1): string {
  const slash = canvasPath.lastIndexOf("/");
  const dir = slash >= 0 ? canvasPath.slice(0, slash + 1) : "";
  const stem = canvasPath.slice(slash + 1).replace(/\.canvas$/i, "") || "Canvas";
  return `${dir}${stem}${attempt > 1 ? ` ${attempt}` : ""}.md`;
}

/** Body of a new note holding the converted diagram (links back to the canvas). */
export function mermaidNoteBody(canvasPath: string, block: string): string {
  const link = canvasPath.replace(/\.canvas$/i, "");
  return `Converted from [[${canvasPath}|${link.split("/").pop()}]].\n\n${block}\n`;
}

/**
 * Insert `block` into note text: after line `line` (0-based; the block goes
 * on its own lines, blank-separated; a line inside a code fence means after
 * that fence), or at the end when `line` is omitted.
 * Returns the new text and the line the fence starts on.
 */
export function insertBlock(text: string, block: string, line?: number): { text: string; line: number } {
  const lines = text.split("\n");
  // Never inside a code fence: a cursor in a fenced block inserts after it.
  if (line !== undefined) {
    let open: string | null = null;
    let close = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
      if (!m) continue;
      if (!open) { open = m[1]!; if (i > line) break; }
      else if (m[1][0] === open[0] && m[1].length >= open.length) { if (i >= line) { close = i; break; } open = null; }
    }
    if (close >= 0) line = close;
  }
  if (line === undefined || line >= lines.length - 1) {
    const body = text.replace(/\s*$/, "");
    const prefix = body ? `${body}\n\n` : "";
    return { text: `${prefix}${block}\n`, line: prefix ? prefix.split("\n").length - 1 : 0 };
  }
  const at = Math.max(0, line + 1);
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  const pad = (arr: string[], end: boolean) => (arr.length && (end ? arr[arr.length - 1] : arr[0]).trim() !== "" ? [""] : []);
  const out = [...before, ...pad(before, true), ...block.split("\n"), ...pad(after, false), ...after];
  return { text: out.join("\n"), line: before.length + pad(before, true).length };
}
