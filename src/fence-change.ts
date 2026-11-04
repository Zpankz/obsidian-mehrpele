/** DOM-free detection of fence width changes between two doc versions. */
import { isDiagramFenceLine } from "./fence-locate";
import { parseFenceInfo } from "./info-width";

export interface TextChange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

export interface FenceWidthChange {
  /** 0-based line of the opening fence in the NEW text. */
  line: number;
  /** New width (undefined = width removed / natural size). */
  width: number | undefined;
  /** New box height (undefined = none). */
  height: number | undefined;
  /** New zoom (undefined = no zoom). */
  zoom: number | undefined;
}

/** Width, height and zoom of a fence line, as one comparable value. */
function sizeOf(line: string): { width: number | undefined; height: number | undefined; zoom: number | undefined; key: string } {
  const info = parseFenceInfo(line);
  return { width: info.width, height: info.height, zoom: info.zoom, key: `${info.width ?? ""}|${info.height ?? ""}|${info.zoom ?? ""}` };
}

/**
 * Line access over a document without materialising it (CodeMirror `Text`
 * satisfies this: `lineAt(pos).number` is 1-based, `line(n)` too).
 */
export interface LineDoc {
  readonly lines: number;
  lineAt(pos: number): { number: number };
  line(n: number): { text: string };
}

/** LineDoc over a plain string (tests, non-CM callers). */
export function stringLineDoc(text: string): LineDoc {
  const lines = text.split("\n");
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  return {
    lines: lines.length,
    lineAt(pos: number) {
      let lo = 0;
      let hi = starts.length - 1;
      const p = Math.max(0, Math.min(pos, text.length));
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= p) lo = mid;
        else hi = mid - 1;
      }
      return { number: lo + 1 };
    },
    line(n: number) {
      return { text: lines[n - 1] ?? "" };
    },
  };
}

/** 0-based line numbers touched by [from, to] in `doc`. */
function touchedLines(doc: LineDoc, from: number, to: number): number[] {
  const start = doc.lineAt(from).number - 1;
  const end = doc.lineAt(Math.max(from, to)).number - 1;
  const out: number[] = [];
  for (let l = start; l <= end; l++) out.push(l);
  return out;
}

function fenceSizeAt(doc: LineDoc, touched: readonly number[]): string {
  for (const l of touched) {
    if (l < 0 || l >= doc.lines) continue;
    const line = doc.line(l + 1).text;
    if (isDiagramFenceLine(line)) return sizeOf(line).key;
  }
  return "none";
}

/**
 * Given old/new docs and CM change ranges, list the opening-fence lines (in
 * new-doc coordinates) whose width actually changed. Only the lines inside
 * changed ranges are read — no full-document copy per keystroke.
 */
export function fenceWidthChangesIn(
  oldDoc: LineDoc,
  newDoc: LineDoc,
  changes: readonly TextChange[],
): FenceWidthChange[] {
  const out: FenceWidthChange[] = [];
  const seen = new Set<number>();
  for (const change of changes) {
    // A paste spanning thousands of lines is not a width edit; cap the scan.
    const newTouched = touchedLines(newDoc, change.fromB, change.toB).slice(0, 2000);
    let oldRaw: string | undefined;
    for (const l of newTouched) {
      if (seen.has(l) || l >= newDoc.lines) continue;
      const lineText = newDoc.line(l + 1).text;
      if (!isDiagramFenceLine(lineText)) continue;
      seen.add(l);
      const next = sizeOf(lineText);
      oldRaw ??= fenceSizeAt(oldDoc, touchedLines(oldDoc, change.fromA, change.toA).slice(0, 2000));
      // A fence that only appeared in the new text counts as changed when it
      // carries a size token; a width/height/zoom edit or removal always counts.
      if (oldRaw === "none" ? next.key !== "||" : next.key !== oldRaw) {
        out.push({ line: l, width: next.width, height: next.height, zoom: next.zoom });
      }
    }
  }
  return out;
}

/** String convenience wrapper around fenceWidthChangesIn. */
export function fenceWidthChanges(
  oldText: string,
  newText: string,
  changes: readonly TextChange[],
): FenceWidthChange[] {
  return fenceWidthChangesIn(stringLineDoc(oldText), stringLineDoc(newText), changes);
}

/**
 * Whether an edit can have left companion frame keys (`sourcePath#fenceLine`) or a fence's
 * info-string rest stale: the line count changed (fences below moved), a change added or
 * removed lines (others in the same transaction may offset the count), or a change touched
 * an opening diagram fence line. Reads only the changed lines; typing on one line costs a
 * few integer compares and one regex per touched line.
 */
export function fenceLayoutChanged(oldDoc: LineDoc, newDoc: LineDoc, changes: readonly TextChange[]): boolean {
  if (oldDoc.lines !== newDoc.lines) return true;
  for (const change of changes) {
    const start = newDoc.lineAt(change.fromB).number;
    const oldSpan = oldDoc.lineAt(change.toA).number - oldDoc.lineAt(change.fromA).number;
    if (newDoc.lineAt(change.toB).number - start !== oldSpan) return true;
    const end = Math.min(newDoc.lineAt(Math.max(change.fromB, change.toB)).number, start + 2000);
    for (let n = start; n <= end; n++) if (isDiagramFenceLine(newDoc.line(n).text)) return true;
  }
  return false;
}
