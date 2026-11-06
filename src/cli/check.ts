/** Pure core of `pele:check`: find, render-check and summarise diagrams (DOM/vault-free). */
import { render } from "pele-render/pele";
import { lintNodeSizes, topLevelLines } from "pele-render/node-size";
import { extractBlocks } from "../extract-blocks";
import { asPeleErrorLike } from "../format-error";
import { isMehrpeleSource } from "../mehrpele/extract";
import { mehrpeleRenderSource, validateMehrpele } from "../mehrpele/validate";

export const DIAGRAM_TYPES = [
  "flowchart", "sequence", "class", "state", "er", "pie", "gantt", "gitGraph",
  "mindmap", "timeline", "journey", "xychart", "quadrantChart", "requirement",
  "c4", "sankey", "block", "packet", "kanban", "architecture", "radar",
  "treemap", "info", "agentflow", "usecase", "railroad", "treeView", "venn",
  "cynefin", "wardley", "swimlane", "ishikawa", "eventmodeling",
] as const;

export interface CheckErrorEntry {
  file: string;
  index: number;
  line: number | null;
  column: number | null;
  code: string;
  type: string | null;
  message: string;
  snippet: string;
}

export interface CheckResultEntry {
  file: string;
  index: number;
  line: number;
  type: string | null;
  ok: boolean;
}

export interface CheckSummary {
  diagrams: number;
  invalid: number;
  errors: CheckErrorEntry[];
  results: CheckResultEntry[];
  /** Non-fatal `pele-size` problems (pele-render's schema); omitted when none. */
  warnings?: CheckWarningEntry[];
}

/** One `pele-size` warning, located at the directive line (1-based file line). */
export interface CheckWarningEntry {
  file: string;
  index: number;
  line: number;
  code: string;
  message: string;
}

export interface NoteInput {
  file: string;
  content: string;
  /** Whole-file diagram (.mmd/.mermaid) rather than fenced blocks. */
  wholeFile?: boolean;
}

export interface DiagramRef {
  index: number;
  /** 1-based line of the first source line in the host file. */
  line: number;
  code: string;
  lang: string;
}

export function diagramsOf(note: NoteInput): DiagramRef[] {
  if (note.wholeFile) {
    return [{ index: 0, line: 1, code: note.content, lang: "mermaid" }];
  }
  return extractBlocks(note.content, ["mermaid", "pele", "mehrpele"]).map((b, i) => ({
    index: i,
    line: b.startLine + 2,
    code: b.code,
    lang: b.lang,
  }));
}

/**
 * Which blocks render as Mehrpele (Markdown labels). Default: `mehrpele`
 * blocks and mermaid/pele blocks with the `%% mehrpele %%` directive; the
 * plugin passes its settings-aware check.
 */
export type MehrpelePredicate = (lang: string, code: string) => boolean;

export interface CheckOptions {
  isMehrpele?: MehrpelePredicate;
}

/**
 * The source Pele renders for a diagram: Mehrpele blocks with their labels
 * neutralised to plain fallback text (Pele never parses label Markdown).
 */
export function diagramRenderSource(d: Pick<DiagramRef, "lang" | "code">, isMehrpele: MehrpelePredicate = isMehrpeleSource): string {
  return isMehrpele(d.lang, d.code) ? mehrpeleRenderSource(d.code) : d.code;
}

/** Check summary in pele-render's JSON schema (render() semantics). */
export function buildCheckSummary(notes: NoteInput[], opts: CheckOptions = {}): CheckSummary {
  const acc: CheckSummary = { diagrams: 0, invalid: 0, errors: [], results: [] };
  for (const note of notes) checkNoteInto(note, acc, opts);
  return finishSummary(acc);
}

/**
 * Same as buildCheckSummary, but yields to the event loop every `yieldEvery`
 * notes (folder scans render every diagram synchronously; without yielding a
 * large vault freezes Obsidian's UI for the whole run).
 */
export async function buildCheckSummaryAsync(
  notes: AsyncIterable<NoteInput> | Iterable<NoteInput>,
  opts: CheckOptions & { yieldEvery?: number; yieldFn?: () => Promise<void> } = {},
): Promise<CheckSummary> {
  const every = Math.max(1, opts.yieldEvery ?? 10);
  const yieldFn = opts.yieldFn ?? (() => new Promise<void>((resolve) => window.setTimeout(resolve, 0)));
  const acc: CheckSummary = { diagrams: 0, invalid: 0, errors: [], results: [] };
  let n = 0;
  for await (const note of notes as AsyncIterable<NoteInput>) {
    checkNoteInto(note, acc, opts);
    if (++n % every === 0) await yieldFn();
  }
  return finishSummary(acc);
}

function finishSummary(acc: CheckSummary): CheckSummary {
  acc.errors.sort((a, b) => a.file.localeCompare(b.file) || a.index - b.index);
  const warnings = acc.warnings ?? [];
  return {
    diagrams: acc.diagrams,
    invalid: acc.errors.length,
    errors: acc.errors,
    results: acc.results,
    ...(warnings.length ? { warnings } : {}),
  };
}

type RenderAttempt = { ok: true; type: string } | { ok: false; error: unknown };

function tryRender(source: string): RenderAttempt {
  try {
    return { ok: true, type: render(source).type };
  } catch (error) {
    return { ok: false, error };
  }
}

function checkNoteInto(note: NoteInput, acc: CheckSummary, opts: CheckOptions = {}): void {
  const { errors, results } = acc;
  const isMehrpele = opts.isMehrpele ?? isMehrpeleSource;
  for (const d of diagramsOf(note)) {
    acc.diagrams++;
    const outer = topLevelLines(d.code);
    const at = d.code.split("\n").findIndex((l, i) => outer[i] && /^[ \t]*%%[ \t]*pele-size\b/.test(l));
    if (at >= 0) {
      const src = isMehrpele(d.lang, d.code) ? mehrpeleRenderSource(d.code) : d.code;
      for (const w of lintNodeSizes(src)) {
        (acc.warnings ??= []).push({ file: note.file, index: d.index, line: d.line + at, code: w.code, message: w.message });
      }
    }
    // Mehrpele: validate what renders (labels neutralised, line numbers kept).
    const r = isMehrpele(d.lang, d.code) ? validateMehrpele(d.code, tryRender) : tryRender(d.code);
    if (r.ok) {
      results.push({ file: note.file, index: d.index, line: d.line, type: r.type, ok: true });
    } else {
      const e = r.error;
      const like = asPeleErrorLike(e);
      results.push({ file: note.file, index: d.index, line: d.line, type: like?.type ?? null, ok: false });
      errors.push({
        file: note.file,
        index: d.index,
        line: like?.line && like.line > 0 ? d.line + like.line - 1 : null,
        column: like?.column && like.column > 0 ? like.column : null,
        code: like?.code ?? "semantic",
        type: like?.type ?? null,
        message: like?.message ?? String(e),
        snippet: like?.snippet ?? "",
      });
    }
  }
}

export function formatCheckText(summary: CheckSummary): string {
  const lines = summary.errors.map(
    (e) => `${e.file}:${e.line ?? "?"}:${e.column ?? "?"}: [${e.code}] (${e.type ?? "unknown"}) ${e.message}`,
  );
  lines.push(`${summary.diagrams - summary.invalid}/${summary.diagrams} valid`);
  return lines.join("\n");
}
