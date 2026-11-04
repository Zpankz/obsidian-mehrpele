/** Editor commands for the diagram under the cursor or the whole note. */
import {
  MarkdownView, Notice, TFile
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import { parse, render, type RenderResult } from "pele-render/pele";
import { mathPlaceholdersToText } from "./math-resolver";
import { sanitizedSvgMarkup } from "./sanitize-svg";
import {
  validateMehrpele
} from "./mehrpele/index";
import { blockAtLine, extractBlocks } from "./extract-blocks";
import { formatError } from "./format-error";
import {
  toMountOptions
} from "./settings";
import type PeleMermaidPlugin from "../main";
import { repairAndApply } from "./repair-host";
import { renderSourceOf } from "./cli/handlers";
import { dispatchBlockReplace } from "./frame-host";

export interface EditorLike {
  getValue(): string;
  getCursor(): { line: number; ch: number };
}

export async function convertDiagramAtCursor(plugin: PeleMermaidPlugin, editor: EditorLike, view: MarkdownView): Promise<void> {
  const blocks = extractBlocks(editor.getValue(), ["mermaid", "pele", "mehrpele"]);
  if (blocks.length === 0) {
    new Notice("Pele: no Mermaid/pele block in this note.");
    return;
  }
  const hit = blockAtLine(blocks, editor.getCursor().line) ?? blocks[0];
  await plugin.convertToCanvas(hit.code, view.file?.path ?? "", hit.lang);
}

// -- commands -----------------------------------------------------------

export function diagramUnderCursor(plugin: PeleMermaidPlugin, editor: EditorLike): { code: string; lang: string; index: number } | null {
  const blocks = extractBlocks(editor.getValue());
  if (blocks.length === 0) return null;
  const cursor = editor.getCursor().line;
  const hit = blockAtLine(blocks, cursor) ?? blocks[0];
  return { code: hit.code, lang: hit.lang, index: blocks.indexOf(hit) };
}

/** SVG markup for copy/export, through the sanitizer when Sanitize SVG is on. */
export function svgFor(plugin: PeleMermaidPlugin, code: string, sourcePath: string, lang = "mermaid"): string {
  return sanitizedSvgMarkup(rawSvgFor(plugin, code, sourcePath, lang), plugin.settings.core.security.sanitize);
}

function rawSvgFor(plugin: PeleMermaidPlugin, code: string, sourcePath: string, lang: string): string {
  for (const frame of plugin.frames) {
    if (frame.sourcePath === sourcePath && frame.source === code && frame.currentSvg) {
      return mathPlaceholdersToText(frame.currentSvg);
    }
  }
  for (const shell of plugin.mehrShells) {
    if (shell.sourcePath === sourcePath && shell.source === code) {
      const svg = shell.result()?.svg;
      if (svg) return mathPlaceholdersToText(svg);
    }
  }
  const result: RenderResult = render(renderSourceOf(plugin, { lang, code }), toMountOptions(plugin.settings));
  return result.svg;
}

export async function copyDiagramSvg(plugin: PeleMermaidPlugin, editor: EditorLike, sourcePath: string): Promise<void> {
  const hit = diagramUnderCursor(plugin, editor);
  if (!hit) {
    new Notice("Pele: no Mermaid/pele block in this note.");
    return;
  }
  try {
    await navigator.clipboard.writeText(svgFor(plugin, hit.code, sourcePath, hit.lang));
    new Notice("Pele: diagram SVG copied to clipboard.");
  } catch (e) {
    new Notice(formatError(e, { showSnippet: true }));
  }
}

export async function exportDiagramSvg(plugin: PeleMermaidPlugin, editor: EditorLike, file: TFile | null): Promise<void> {
  const hit = diagramUnderCursor(plugin, editor);
  if (!hit) {
    new Notice("Pele: no Mermaid/pele block in this note.");
    return;
  }
  if (!file) {
    new Notice("Pele: save the note before exporting.");
    return;
  }
  try {
    const svg = svgFor(plugin, hit.code, file.path, hit.lang);
    const dir = file.parent?.path ? `${file.parent.path}/` : "";
    const base = `${dir}${file.basename}-diagram${hit.index > 0 ? `-${hit.index + 1}` : ""}.svg`;
    const existing = plugin.app.vault.getAbstractFileByPath(base);
    if (existing instanceof TFile) await plugin.app.vault.modify(existing, svg);
    else await plugin.app.vault.create(base, svg);
    new Notice(`Pele: exported ${base}`);
  } catch (e) {
    new Notice(formatError(e, { showSnippet: true }));
  }
}

export async function repairUnderCursor(plugin: PeleMermaidPlugin, editor: EditorLike, view: MarkdownView): Promise<void> {
  const blocks = extractBlocks(editor.getValue());
  if (blocks.length === 0) {
    new Notice("Pele: no Mermaid/pele block in this note.");
    return;
  }
  const hit = blockAtLine(blocks, editor.getCursor().line) ?? blocks[0];
  const frame = [...plugin.frames].find(
    (f) => f.sourcePath === (view.file?.path ?? "") && f.source === hit.code,
  );
  if (frame) {
    await plugin.repairFrame(frame);
    return;
  }
  const cm = (view.editor as unknown as { cm?: EditorView }).cm;
  if (!cm) {
    new Notice("Pele: repair needs the editor (live preview) or a rendered diagram.");
    return;
  }
  const outcome = await repairAndApply(plugin, hit.lang, hit.code, async (newSource) =>
    dispatchBlockReplace(cm, hit.startLine, hit.code, newSource),
  );
  new Notice(
    outcome === "repaired"
      ? "Pele: diagram repaired. Cmd/Ctrl+Z to undo."
      : outcome === "valid"
        ? "Pele: diagram is already valid."
        : outcome === "cancelled"
          ? "Pele: repair cancelled; nothing changed."
          : "Pele: could not repair this diagram.",
  );
}

export async function repairAllInNote(plugin: PeleMermaidPlugin, view: MarkdownView): Promise<void> {
  const cm = (view.editor as unknown as { cm?: EditorView }).cm;
  if (!cm) {
    new Notice("Pele: repair-all needs the editor (live preview).");
    return;
  }
  let repaired = 0;
  let failed = 0;
  // Re-read the doc each round: each apply is one undoable edit and shifts lines.
  for (let guard = 0; guard < 50; guard++) {
    const text = cm.state.doc.toString();
    const blocks = extractBlocks(text);
    const broken = blocks.find((b) => !plugin.validateDiagram(b.lang, b.code).ok);
    if (!broken) break;
    const outcome = await repairAndApply(plugin, broken.lang, broken.code, async (newSource) =>
      dispatchBlockReplace(cm, broken.startLine, broken.code, newSource),
    );
    if (outcome === "repaired") repaired++;
    else if (outcome !== "valid") {
      if (outcome === "failed") failed++;
      break; // don't spin on an unfixable (or declined) block
    }
  }
  const total = extractBlocks(cm.state.doc.toString()).length;
  new Notice(
    `Pele repair: ${repaired} repaired, ${failed} failed, ${total} diagram(s) in note. Cmd/Ctrl+Z undoes each edit.`,
    8000,
  );
}

export function validateNote(plugin: PeleMermaidPlugin, editor: EditorLike): void {
  const blocks = extractBlocks(editor.getValue());
  if (blocks.length === 0) {
    new Notice("Pele: no Mermaid/pele blocks in this note.");
    return;
  }
  let firstError: unknown = null;
  let valid = 0;
  const attempt = (src: string): { ok: true } | { ok: false; error: unknown } => {
    try {
      parse(src);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  };
  for (const b of blocks) {
    const r = plugin.isMehrpeleBlock(b.lang, b.code) ? validateMehrpele(b.code, attempt) : attempt(b.code);
    if (r.ok) valid++;
    else if (firstError === null) firstError = r.error;
  }
  const invalid = blocks.length - valid;
  if (invalid === 0) {
    new Notice(`Pele: ${valid}/${blocks.length} diagram(s) valid.`);
  } else {
    new Notice(
      `Pele: ${valid}/${blocks.length} valid, ${invalid} invalid. First error: ${formatError(firstError, { showSnippet: true })}`,
      8000,
    );
  }
}
