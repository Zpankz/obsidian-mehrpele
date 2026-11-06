// Pure glue: the result contract shared by the diagram menu, the commands and the
// `pele:excalidraw` CLI handler (no Obsidian imports).
import type { PeleToExcalidrawResult } from "pele-render/excalidraw";

export type Fidelity = PeleToExcalidrawResult["fidelity"];

export interface ConvertOptions {
  palette?: Record<string, string>;
  scale?: number;
  fontFamily?: number;
}

/**
 * Outcome of `createDrawing` / `insertIntoView`. A failure before conversion ran
 * reports `fidelity: "image"`, `elements: 0`, `dropped: []` so every result has
 * the same keys (the CLI JSON relies on that).
 */
export interface DrawingResult {
  ok: boolean;
  out?: string;
  fidelity: Fidelity;
  elements: number;
  dropped: string[];
  error?: string;
}

/** `insertIntoView` writes into the open drawing, so it never reports `out`. */
export type InsertResult = Omit<DrawingResult, "out">;

export function succeeded(result: PeleToExcalidrawResult, out?: string): DrawingResult {
  return { ok: true, ...(out !== undefined ? { out } : {}), fidelity: result.fidelity, elements: result.elements.length, dropped: result.dropped };
}

/** `result` is the conversion, when the failure happened after it ran. */
export function failed(error: string, result?: PeleToExcalidrawResult): DrawingResult {
  return result
    ? { ok: false, fidelity: result.fidelity, elements: result.elements.length, dropped: result.dropped, error }
    : { ok: false, fidelity: "image", elements: 0, dropped: [], error };
}

/** JSON printed by the `pele:excalidraw` CLI handler (`format=json`, the default). */
export function cliResultJson(payload: Partial<DrawingResult> & { ok: boolean }): string {
  return JSON.stringify(payload, null, 2);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
