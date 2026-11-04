/** Pure cores for the pele:* Obsidian CLI handlers (DOM/vault-free). */
import { render } from "pele-render/pele";
import { lintNodeSizes, topLevelLines } from "pele-render/node-size";
import { extractBlocks } from "./extract-blocks";
import { asPeleErrorLike } from "./format-error";
import { replaceBlockBody } from "./replace-block";
import { isMehrpeleSource } from "./mehrpele/extract";
import { mehrpeleRenderSource, validateMehrpele } from "./mehrpele/validate";

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

export const MAX_CLI_OUTPUT = 512 * 1024;

export function guardOutput(text: string): string {
  if (text.length <= MAX_CLI_OUTPUT) return text;
  return `error: output-too-large: result is ${text.length} bytes (limit ${MAX_CLI_OUTPUT}); write to a file with out= instead`;
}

/** Parse an index= param; throws an Error whose message the CLI host prints as `Error: <message>`. */
export function parseIndexParam(raw: string | undefined, count: number, path: string): number {
  if (raw === undefined) {
    if (count === 1) return 0;
    throw new Error(`pele: ${path} has ${count} diagrams; pass index=<n> or out=<folder>`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || String(n) !== raw.trim() || n < 0 || n >= count) {
    throw new Error(`pele: index ${raw} out of range: ${path} has ${count} diagram(s) (0–${count - 1})`);
  }
  return n;
}

/**
 * Canvas output filename for a converted diagram, keyed by the diagram's
 * stable identity (its source hash) rather than its position in the note:
 * `<note> - diagram <hash6>.canvas`, then ` 2`, ` 3`, … on collision.
 */
export function canvasFileName(notePath: string, sourceHash: string, folder: string, attempt = 1): string {
  const base = notePath.split("/").pop() ?? "note";
  const stem = base.replace(/\.[^.]+$/, "");
  const hash6 = sourceHash.replace(/[^0-9a-z]/gi, "").slice(0, 6) || "000000";
  const name = `${stem} - diagram ${hash6}${attempt > 1 ? ` ${attempt}` : ""}.canvas`;
  // The vault root folder is "/": no leading slash (vault paths have none).
  const dir = folder.replace(/^\/+|\/+$/g, "");
  return dir ? `${dir}/${name}` : name;
}

/** Minimal canvas JSON shape (structurally compatible with pele-render's CanvasData). */
export interface CanvasLike {
  nodes?: { id: string; [key: string]: unknown }[];
  edges?: { id: string; fromNode?: string; toNode?: string; [key: string]: unknown }[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/** `metadata.pele.sourceHash` of a canvas, if any. */
export function canvasSourceHash(canvas: CanvasLike | null | undefined): string | undefined {
  const pele = (canvas?.metadata as { pele?: { sourceHash?: unknown } } | undefined)?.pele;
  return typeof pele?.sourceHash === "string" ? pele.sourceHash : undefined;
}

export type CanvasTarget<C extends CanvasLike> =
  | { path: string; kind: "create" }
  | { path: string; kind: "merge"; previous: C };

/**
 * Pick the canvas file for a diagram. An existing file is reused (merged)
 * only when its `metadata.pele.sourceHash` equals this diagram's hash; any
 * other existing file — another diagram's canvas, a user canvas, unparsable
 * JSON — is never touched, and the next free numbered name is used instead.
 * `read(path)` returns the file text, or null when no file exists there.
 */
export async function chooseCanvasTarget<C extends CanvasLike>(
  nameFor: (attempt: number) => string,
  sourceHash: string,
  read: (path: string) => string | null | Promise<string | null>,
  maxAttempts = 100,
): Promise<CanvasTarget<C>> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const path = nameFor(attempt);
    const text = await read(path);
    if (text === null) return { path, kind: "create" };
    let parsed: C | null = null;
    try {
      parsed = JSON.parse(text) as C;
    } catch {
      parsed = null;
    }
    if (parsed && canvasSourceHash(parsed) === sourceHash) return { path, kind: "merge", previous: parsed };
  }
  throw new Error(`no free canvas file name after ${maxAttempts} attempts`);
}

/**
 * Carry user-added content from the previous canvas into a regenerated one:
 * nodes without a `peleId` (cards the user added) and edges the generator
 * did not produce, when both of their endpoints still exist.
 */
export function mergeUserCanvasContent<C extends CanvasLike>(generated: C, previous: CanvasLike): C {
  const nodes = [...(generated.nodes ?? [])];
  const nodeIds = new Set(nodes.map((n) => n.id));
  const generatedPrevIds = new Set(
    (previous.nodes ?? []).filter((n) => typeof n["peleId"] === "string").map((n) => n.id),
  );
  for (const n of previous.nodes ?? []) {
    if (typeof n["peleId"] === "string" || nodeIds.has(n.id)) continue;
    nodes.push(n);
    nodeIds.add(n.id);
  }
  const edges = [...(generated.edges ?? [])];
  const edgeIds = new Set(edges.map((e) => e.id));
  for (const e of previous.edges ?? []) {
    if (edgeIds.has(e.id)) continue;
    // Generator edges are `e_<from>_<to>_<k>` between generated nodes; a stale
    // one (diagram edge removed) must not survive the regeneration.
    const generatorShaped =
      /^e_/.test(e.id) && generatedPrevIds.has(String(e.fromNode)) && generatedPrevIds.has(String(e.toNode));
    if (generatorShaped) continue;
    if (!nodeIds.has(String(e.fromNode)) || !nodeIds.has(String(e.toNode))) continue;
    edges.push(e);
    edgeIds.add(e.id);
  }
  return { ...generated, nodes, edges };
}

/** Whether a vault-relative file path lies in `folder` ("", ".", "/" = whole vault). */
export function inVaultFolder(path: string, folder: string): boolean {
  const f = folder.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (f === "" || f === ".") return true;
  return path === f || path.startsWith(`${f}/`);
}

/** `.mmd`/`.mermaid` files are one whole-file diagram (no fences). */
export function isWholeFileDiagram(extension: string): boolean {
  const ext = extension.toLowerCase();
  return ext === "mmd" || ext === "mermaid";
}

/**
 * Validate a vault-relative output path from a CLI `out=`/`folder=` param.
 * Rejects absolute paths, `~`, drive letters and any `..` segment; when
 * `extensions` is given the path must end with one of them. Returns the
 * normalised path (leading `./` and duplicate slashes removed). Throws an
 * Error (the CLI host prints `Error: <message>`, as for built-in handlers).
 */
export function validateOutPath(raw: string | undefined, extensions?: readonly string[]): string {
  const value = (raw ?? "").trim();
  if (!value) throw new Error("pele: out= must be a vault-relative path");
  if (/^[\\/~]/.test(value) || /^[A-Za-z]:/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new Error(`pele: out=${value} must be vault-relative (no absolute paths or ~)`);
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((s) => s === "..")) throw new Error(`pele: out=${value} must not contain ".." segments`);
  const normalised = segments.filter((s, i) => s !== "." && (s !== "" || i === segments.length - 1)).join("/");
  if (!normalised || normalised === "/") throw new Error("pele: out= must name a file or folder inside the vault");
  if (extensions && extensions.length > 0) {
    const lower = normalised.toLowerCase();
    if (!extensions.some((ext) => lower.endsWith(ext.toLowerCase()) && lower.length > ext.length)) {
      throw new Error(`pele: out=${value} must end with ${extensions.join(" or ")}`);
    }
  }
  return normalised.replace(/\/$/, "");
}

/** CLI boolean flag (`force`, `write`, …): present without value or `=true`. */
export function cliFlag(value: string | undefined): boolean {
  return value === "true" || value === "";
}

export interface RepairReplacement {
  /** 1-based line of the first source line (DiagramRef.line). */
  line: number;
  old: string;
  next: string;
}

/**
 * Apply CLI repairs to the current file text. Each replacement is located
 * independently by fence + exact body (so one block that moved or can't be
 * found — or a different lang — never aborts the others); whole-file diagrams
 * replace the entire body when it still equals the repaired source.
 */
export function applyRepairsToText(
  text: string,
  wholeFile: boolean,
  replacements: readonly RepairReplacement[],
): { text: string; applied: number; skipped: number } {
  // Diagram sources are LF-normalised; a consistently CRLF file is matched in
  // LF and written back in CRLF (mixed endings are left alone → skipped).
  const crlf = text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
  if (crlf) {
    const r = applyRepairsToText(text.replace(/\r\n/g, "\n"), wholeFile, replacements);
    return { ...r, text: r.applied > 0 ? r.text.replace(/\n/g, "\r\n") : text };
  }
  if (wholeFile) {
    const r = replacements[0];
    if (!r) return { text, applied: 0, skipped: 0 };
    const body = text.replace(/\r?\n$/, "");
    if (body !== r.old.replace(/\r?\n$/, "")) return { text, applied: 0, skipped: replacements.length };
    const trailing = text.slice(body.length);
    return { text: r.next.replace(/\n$/, "") + trailing, applied: 1, skipped: replacements.length - 1 };
  }
  let out = text;
  let applied = 0;
  let skipped = 0;
  // Bottom-up so earlier fence lines stay valid hints.
  for (const r of [...replacements].sort((a, b) => b.line - a.line)) {
    const replaced = replaceBlockBody(out, Math.max(0, r.line - 2), r.old, r.next);
    if (replaced.ok) {
      out = replaced.text;
      applied++;
    } else skipped++;
  }
  return { text: out, applied, skipped };
}

/** One entry of `pele:repair format=json` (same shape as `pele-render repair --format json`). */
export interface RepairResultEntry {
  file: string;
  index: number;
  line: number;
  ok: boolean;
  tier?: string;
  fixes: string[];
  attempts: unknown;
  unchanged?: boolean;
  lossy: boolean;
  dropped?: string[];
}

export interface RepairSummary {
  diagrams: number;
  repaired: number;
  failed: number;
  results: RepairResultEntry[];
}

/** Engine RepairResult → summary entry (pele-render's mapping, field for field). */
export function repairResultEntry(
  d: { file: string; index: number; line: number },
  r: { ok: boolean; tier?: string; fixes: string[]; attempts: unknown; unchanged?: boolean; lossy?: boolean; dropped?: string[] },
): RepairResultEntry {
  return {
    file: d.file,
    index: d.index,
    line: d.line,
    ok: r.ok,
    tier: r.tier,
    fixes: r.fixes,
    attempts: r.attempts,
    unchanged: r.unchanged,
    lossy: r.lossy ?? false,
    ...(r.dropped && r.dropped.length ? { dropped: r.dropped } : {}),
  };
}

/** Counts exactly as pele-render: repaired = ok && !unchanged, failed = !ok. */
export function buildRepairSummary(results: RepairResultEntry[]): RepairSummary {
  return {
    diagrams: results.length,
    repaired: results.filter((r) => r.ok && !r.unchanged).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

/**
 * Output fence lang for `pele:from-canvas`: pele-render sends `lang=mermaid|
 * mehrpele`; the older `mehrpele` flag is still accepted. An explicit choice
 * wins over the Mehrpele setting. Throws on an unknown lang.
 */
export function fromCanvasLang(
  params: { lang?: string; mehrpele?: string },
  mehrpeleByDefault: boolean,
): "mermaid" | "mehrpele" | "pele" {
  if (params.lang !== undefined) {
    const lang = params.lang.trim().toLowerCase();
    if (lang === "mermaid" || lang === "mehrpele" || lang === "pele") return lang;
    throw new Error(`pele: unknown lang "${params.lang}" (expected mermaid|mehrpele)`);
  }
  if (params.mehrpele !== undefined) return cliFlag(params.mehrpele) ? "mehrpele" : "mermaid";
  return mehrpeleByDefault ? "mehrpele" : "mermaid";
}
