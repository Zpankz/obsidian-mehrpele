/**
 * `%% pele-reflow … %%` — per-block reflow options, stored as a Mermaid
 * comment line so mermaid.js ignores it (same convention as `pele-size`).
 *
 *   %% pele-reflow direction=fixed %%   keep the written direction
 *   %% pele-reflow direction=auto %%    switch even when the setting is off
 *   %% pele-reflow floor=0.6 %%         smallest text scale before scrolling
 *   %% pele-reflow off %%               no reflow: raw Pele at the layout width
 *
 * Several lines merge; the last value of a key wins. Pure: no Pele, no DOM.
 */

export interface ReflowDirective {
  direction?: "fixed" | "auto";
  /** `off` / `reflow=off`: plain Pele, no ladder, no direction switching. */
  off?: boolean;
  /** Per-block shrink floor (0.3 … 1). */
  floor?: number;
}

export interface ReflowDirectiveLint {
  directive: ReflowDirective;
  /** Tokens that could not be read (raw text). */
  malformed: string[];
  /** Number of directive lines. */
  lines: number;
}

/** One directive line (global/multiline): group 1 = the options; the closing `%%` is optional. */
export const REFLOW_DIRECTIVE_RE = /^[ \t]*%%[ \t]*pele-reflow\b(.*?)(?:%%)?[ \t]*$/gm;

export const MIN_FLOOR = 0.3;

/** Every token of every directive line, with what could not be read. */
export function lintReflowDirective(source: string): ReflowDirectiveLint {
  const directive: ReflowDirective = {};
  const malformed: string[] = [];
  let lines = 0;
  for (const m of source.matchAll(REFLOW_DIRECTIVE_RE)) {
    lines++;
    for (const tok of (m[1] ?? "").split(/\s+/).filter(Boolean)) {
      const [key, value, extra] = tok.split("=");
      if (extra !== undefined) {
        malformed.push(tok);
      } else if (value === undefined) {
        if (key === "off") directive.off = true;
        else if (key === "on") directive.off = false;
        else malformed.push(tok);
      } else if (key === "direction" && (value === "fixed" || value === "auto")) {
        directive.direction = value;
      } else if (key === "reflow" && (value === "off" || value === "on")) {
        directive.off = value === "off";
      } else if (key === "floor" && /^\d*\.?\d+$/.test(value)) {
        const n = Number(value);
        if (n >= MIN_FLOOR && n <= 1) directive.floor = n;
        else malformed.push(tok);
      } else {
        malformed.push(tok);
      }
    }
  }
  return { directive, malformed, lines };
}

/** Options from every `%% pele-reflow … %%` line (unreadable tokens ignored). */
export function parseReflowDirective(source: string): ReflowDirective {
  return lintReflowDirective(source).directive;
}

/** Whether the source carries a `pele-reflow` line at all. */
export function hasReflowDirective(source: string): boolean {
  REFLOW_DIRECTIVE_RE.lastIndex = 0;
  const hit = REFLOW_DIRECTIVE_RE.test(source);
  REFLOW_DIRECTIVE_RE.lastIndex = 0;
  return hit;
}

/** Warnings for `check` (malformed tokens; Mermaid still renders the block). */
export function lintReflowWarnings(source: string): string[] {
  return lintReflowDirective(source).malformed.map(
    (t) => `pele-reflow: cannot read "${t}" (use direction=fixed|auto, floor=0.3–1 or off)`,
  );
}
