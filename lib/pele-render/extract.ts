import { detectTypeOrNull } from "./detect.js";
import type { DiagramType } from "pele";

export interface MermaidBlock {
  /** 0-based block index within the file. */
  index: number;
  /** 1-based line of the opening fence. */
  startLine: number;
  /** 1-based line of the first source line (startLine + 1). */
  line: number;
  /** 1-based line of the closing fence (last line of the file when unclosed). */
  endLine: number;
  /** False when the fence runs to the end of the file without a closing fence. */
  closed: boolean;
  /** Fence language as written (first word of the info string). */
  lang: string;
  /** Detected diagram type, or null. */
  type: DiagramType | null;
  /** Diagram source (without fences; CRLF line endings normalised to LF). */
  source: string;
  /** Leading indentation of the opening fence. */
  indent: string;
  /** `width=N` from the fence info string (the block's layout width), if any. */
  width?: number;
  /** `height=N` from the fence info string (a resized frame's box height), if any. */
  height?: number;
}

export interface ExtractOptions {
  /** Fence languages to include, matched case-insensitively. Default: exactly `mermaid`. */
  langs?: readonly string[];
}

/** Fence languages the Obsidian plugins treat as diagrams; `--index N` counts these in document order. */
export const DIAGRAM_FENCE_LANGS = ["mermaid", "pele", "mehrpele"] as const;

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

/** `width=N` / `height=N` tokens of a fence info string (same rule as the Obsidian plugin). */
function fenceSize(info: string): { width?: number; height?: number } {
  const out: { width?: number; height?: number } = {};
  for (const tok of info.split(/\s+/).slice(1)) {
    const m = /^(width|height)=(\d{1,5})$/.exec(tok);
    if (m && Number(m[2]) > 0) out[m[1] as "width" | "height"] = Number(m[2]);
  }
  return out;
}

/**
 * Extract ```mermaid blocks from Markdown, skipping blocks nested
 * inside other fenced code blocks. LF, CRLF and mixed line endings are
 * accepted; line numbers count "\n"-terminated lines either way.
 */
export function extractMermaidBlocks(markdown: string, opts: ExtractOptions = {}): MermaidBlock[] {
  const wanted = opts.langs ? new Set(opts.langs.map((l) => l.toLowerCase())) : null;
  const lines = markdown.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const blocks: MermaidBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = FENCE_RE.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const indent = m[1];
    const fence = m[2];
    const info = m[3].trim();
    const fenceChar = fence[0];
    const fenceLen = fence.length;
    const lang = info.split(/\s+/)[0];
    const isMermaid = wanted ? wanted.has(lang.toLowerCase()) : lang === "mermaid";
    // Find closing fence: same char, length >= opening.
    let j = i + 1;
    let closed = false;
    while (j < lines.length) {
      const cm = FENCE_RE.exec(lines[j]);
      if (cm) {
        const cf = cm[2];
        const cinfo = cm[3].trim();
        if (cf[0] === fenceChar && cf.length >= fenceLen && cinfo === "") {
          closed = true;
          break;
        }
      }
      j++;
    }
    const endIdx = closed ? j : lines.length;
    if (isMermaid) {
      const source = lines.slice(i + 1, endIdx).join("\n");
      blocks.push({
        index: blocks.length,
        startLine: i + 1,
        line: i + 2,
        endLine: closed ? j + 1 : lines.length,
        closed,
        lang,
        type: detectTypeOrNull(source),
        source,
        indent,
        ...fenceSize(info),
      });
    }
    i = closed ? j + 1 : lines.length;
  }
  return blocks;
}
