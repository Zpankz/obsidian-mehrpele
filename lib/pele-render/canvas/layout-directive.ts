/**
 * Canvas layout directives — Mermaid comment lines, so mermaid.js ignores
 * them (same convention as `pele-size` and `pele-reflow`):
 *
 *   %% pele-layout canvas %%     render at the pinned positions below
 *   %% pele-layout auto %%       Pele's own layout (the default)
 *   %% pele-pos A=120,80 G=300,90,420,200 A>B=right,left A>B#2=bottom,top %%
 *
 * `pele-pos` entries, in SVG units (CSS px at scale 1):
 * - `id=x,y` — node centre; `id=x,y,w,h` — centre and box (subgraphs: the
 *   group rectangle, grown to fit its members).
 * - `from>to=side,side` — edge ports (`top|right|bottom|left`, or `auto`).
 *   `#n` picks the n-th edge between the same pair (n ≥ 2), in source order.
 * Ids are bare when they match BARE_ID, otherwise JSON-quoted. Several lines
 * merge; the last occurrence of a key wins. Pure: no Pele, no DOM.
 */

export type Side = "top" | "right" | "bottom" | "left";
export const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

export interface PinnedBox {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export interface EdgePorts {
  from?: Side;
  to?: Side;
}

export interface CanvasLayout {
  /** `canvas` when a `pele-layout canvas` line is present (last line wins). */
  mode: "canvas" | "auto";
  pos: Map<string, PinnedBox>;
  /** Keyed by `edgeKey(from, to, n)`. */
  ports: Map<string, EdgePorts>;
}

export interface LayoutDirectiveLint extends CanvasLayout {
  malformed: string[];
  lines: number;
}

export const LAYOUT_DIRECTIVE_RE = /^[ \t]*%%[ \t]*pele-layout\b(.*?)(?:%%)?[ \t]*$/gm;
export const POS_DIRECTIVE_RE = /^[ \t]*%%[ \t]*pele-pos\b(.*?)%%[ \t]*$/gm;
const LINE_RE = /^[ \t]*%%[ \t]*pele-(?:layout|pos)\b.*$/;
const ID = String.raw`"(?:[^"\\]|\\.)*"|[^\s=>#"]+`;
const ENTRY_RE = new RegExp(String.raw`(${ID})(?:>(${ID})(?:#(\d+))?)?=(\S*)`, "g");
const BARE_ID = /^[\p{L}\p{N}_.:-]+$/u;
const NUM = /^-?\d+(?:\.\d+)?$/;
/** Largest accepted coordinate magnitude (SVG units). */
export const MAX_COORD = 1_000_000;

export function quotePosId(id: string): string {
  return BARE_ID.test(id) ? id : JSON.stringify(id);
}

function parseId(raw: string): string | null {
  if (!raw.startsWith('"')) return raw;
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

/** Key of the n-th (1-based) edge between `from` and `to`. */
export function edgeKey(from: string, to: string, n = 1): string {
  return n > 1 ? `${from}>${to}#${n}` : `${from}>${to}`;
}

function parseBox(raw: string): PinnedBox | null {
  const parts = raw.split(",");
  if (parts.length !== 2 && parts.length !== 4) return null;
  if (!parts.every((p) => NUM.test(p))) return null;
  const v = parts.map(Number);
  if (v.some((n) => !Number.isFinite(n) || Math.abs(n) > MAX_COORD)) return null;
  if (v.length === 4 && (v[2] <= 0 || v[3] <= 0)) return null;
  return v.length === 4 ? { x: v[0], y: v[1], w: v[2], h: v[3] } : { x: v[0], y: v[1] };
}

function parsePorts(raw: string): EdgePorts | null {
  const parts = raw.split(",");
  if (parts.length !== 2) return null;
  const out: EdgePorts = {};
  for (const [i, p] of parts.entries()) {
    if (p === "auto") continue;
    if (!(SIDES as readonly string[]).includes(p)) return null;
    if (i === 0) out.from = p as Side;
    else out.to = p as Side;
  }
  return out;
}

export function lintLayoutDirective(source: string): LayoutDirectiveLint {
  let mode: CanvasLayout["mode"] = "auto";
  const pos = new Map<string, PinnedBox>();
  const ports = new Map<string, EdgePorts>();
  const malformed: string[] = [];
  let lines = 0;
  for (const m of source.matchAll(LAYOUT_DIRECTIVE_RE)) {
    lines++;
    const v = (m[1] ?? "").trim();
    if (v === "canvas" || v === "auto") mode = v;
    else malformed.push(`pele-layout ${v}`);
  }
  for (const m of source.matchAll(POS_DIRECTIVE_RE)) {
    lines++;
    const body = m[1] ?? "";
    let rest = body;
    for (const e of body.matchAll(ENTRY_RE)) {
      rest = rest.replace(e[0], "");
      const a = parseId(e[1]);
      if (a === null) {
        malformed.push(e[0]);
        continue;
      }
      if (e[2] !== undefined) {
        const b = parseId(e[2]);
        const n = e[3] !== undefined ? Number(e[3]) : 1;
        const p = parsePorts(e[4]);
        if (b === null || p === null || n < 1) malformed.push(e[0]);
        else ports.set(edgeKey(a, b, n), p);
      } else {
        const box = parseBox(e[4]);
        if (box === null) malformed.push(e[0]);
        else pos.set(a, box);
      }
    }
    for (const junk of rest.split(/\s+/).filter(Boolean)) malformed.push(junk);
  }
  return { mode, pos, ports, malformed, lines };
}

export function parseLayoutDirective(source: string): CanvasLayout {
  const { mode, pos, ports } = lintLayoutDirective(source);
  return { mode, pos, ports };
}

/** Whether the source asks for the canvas layout (`%% pele-layout canvas %%`). */
export function hasCanvasLayout(source: string): boolean {
  if (!source.includes("pele-layout")) return false;
  return parseLayoutDirective(source).mode === "canvas";
}

/** Warnings for `check` (Mermaid still renders the block). */
export function lintLayoutWarnings(source: string): string[] {
  return lintLayoutDirective(source).malformed.map(
    (t) => `pele-pos/pele-layout: cannot read "${t}" (use id=x,y[,w,h], from>to=side,side, pele-layout canvas|auto)`,
  );
}

/** Up to two decimals, no trailing zeros. */
export function fmtNum(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

/** The `pele-pos` line; "" when there is nothing to write. */
export function formatPosDirective(pos: Iterable<[string, PinnedBox]>, ports: Iterable<[string, EdgePorts]> = []): string {
  const parts: string[] = [];
  for (const [id, b] of pos) {
    const v = [b.x, b.y, ...(b.w !== undefined && b.h !== undefined ? [b.w, b.h] : [])].map(fmtNum).join(",");
    parts.push(`${quotePosId(id)}=${v}`);
  }
  for (const [key, p] of ports) {
    if (!p.from && !p.to) continue;
    const m = /^(.*)>(.*?)(?:#(\d+))?$/.exec(key);
    if (!m) continue;
    const k = `${quotePosId(m[1])}>${quotePosId(m[2])}${m[3] ? `#${m[3]}` : ""}`;
    parts.push(`${k}=${p.from ?? "auto"},${p.to ?? "auto"}`);
  }
  return parts.length ? `%% pele-pos ${parts.join(" ")} %%` : "";
}

/** The source without `pele-layout` / `pele-pos` lines. */
export function stripLayoutDirective(source: string): string {
  const lines = source.split("\n");
  const kept = lines.filter((l) => !LINE_RE.test(l.replace(/\r$/, "")));
  return kept.length === lines.length ? source : kept.join("\n");
}
