/**
 * Node sizing as a Pele diagram wrapper. Pele has no per-node size API: a
 * node box follows its label's measured width and line count. So a sized
 * node's label is rewritten in a fresh model at render time — its words
 * re-wrapped to the target width (explicit breaks, spaces turned into a
 * non-breaking private-use joiner), a fenced width filler appended to the
 * widest line and empty lines added for height — and the result measured
 * and corrected (a few renders, cached per source and measurer). Fillers
 * and joiners are removed from the returned SVG.
 *
 * The filler is measured by whatever measurer Pele uses (canvas in
 * Obsidian, metrics in the CLI, Mehrpele's reservation measurer), so sizes
 * mean the same thing everywhere. Width lands within ~2 px; height moves in
 * whole lines (Pele 1.9+: 1.3 em once a label has two or more lines; a
 * single line is 1.5 em). A box is never smaller than its content: shrinking
 * re-wraps words, and the floor is the longest word.
 */
import type { Diagram, RenderOptions } from "pele";
import { lintSizeDirective, type NodeSize } from "./directive.js";
import { sizableNodes, type SizeCaps } from "./adapters.js";
import { nodeBoxMap, type Box } from "./svgbox.js";
import { decodeEntities } from "../svg/read.js";
import { wrapDiagram, type ParseRest, type RenderArgs, type Rendered } from "../directive/wrap.js";

/**
 * Width filler fence (stripped from the SVG). Zero-width characters, so the
 * fence itself adds nothing to the measured width: every width above the
 * content is reachable. ZWJ + ZWNJ, not ZWSP: Pele 1.9+ breaks lines at
 * U+200B, which would split the filler onto its own line.
 */
export const FILL_OPEN = "\u200D\u200C";
export const FILL_CLOSE = "\u200C\u200D";
/** Word joiner: keeps a re-wrapped line on one line; restored to a space. */
export const JOINER = "\uE012";
const FILL_RE = /\u200D\u200C[0']*\u200C\u200D/g;
const JOINER_RE = /\uE012/g;
const META = Symbol.for("pele-render.node-size");
/** Width of "'" relative to "0" (approximate; the solver measures). */
const FINE_RATIO = 0.36;
const MAX_PASSES = 22;
/**
 * Narrower wraps (characters per line) tried when a node has a width and a
 * height with room to spare: the one whose box best fills the target wins,
 * so text that can grow into the extra height does. Absolute values, so a
 * wider target only adds candidates (growing a side never shrinks the fill).
 */
const SHAPE_WRAPS = [48, 36, 28, 22, 18, 14, 11, 8] as const;
/** Score gain a narrower wrap needs to split a label that fits unbroken. */
const SPLIT_GAIN = 0.05;

export interface NodeSizeInfo {
  /** Size asked for (directive entry, restricted to what the node supports). */
  target: NodeSize;
  /** Box as rendered (SVG units). */
  applied: { w: number; h: number };
  caps: SizeCaps;
}

/** RenderResult fields added when a diagram has sized nodes. */
export interface NodeSizeResult {
  nodeSizes?: Record<string, NodeSizeInfo>;
}

type ParseArgs = ParseRest<unknown>;

interface Meta {
  sizes: Map<string, NodeSize>;
  text: string;
  config: ParseArgs[0];
  title: ParseArgs[1];
  lineOffset: number;
  limits: ParseArgs[3];
}

interface PlanState {
  /** Characters per line when re-wrapping (Infinity: hard lines only). */
  c: number;
  /** Width filler, in "0" units. */
  fill: number;
  /** Extra empty lines (split above/below). */
  extra: number;
}

interface Sample extends PlanState {
  w: number;
  h: number;
}

interface Plan {
  id: string;
  t: NodeSize;
  caps: SizeCaps;
  hard: string[];
  /** Mehrpele placeholder labels: never re-wrap (the reservation decides). */
  token: boolean;
  longest: number;
  widest: number;
  state: PlanState;
  phase: "wrap" | "shape" | "fit" | "done";
  /** Shape phase: wraps still to try, and the best seen (fill score, wrap). */
  shapeCands?: number[];
  shapeBest?: { c: number; score: number };
  /** Phase a solve without a cached plan starts in. */
  freshPhase: "wrap" | "fit" | "done";
  /** Started from a cached plan (verified on the first render). */
  cached: boolean;
  wrapLo?: Sample;
  wrapHi?: Sample;
  samples: Sample[];
  last?: Sample;
}

// -- cache -------------------------------------------------------------------

const NO_MEASURER = {};
const planCache = new WeakMap<object, Map<string, Map<string, PlanState>>>();
const CACHE_MAX = 200;

function cacheFor(options: RenderOptions | undefined): Map<string, Map<string, PlanState>> {
  const key = (options?.measurer as object | undefined) ?? NO_MEASURER;
  let m = planCache.get(key);
  if (!m) {
    m = new Map();
    planCache.set(key, m);
  }
  return m;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

function cacheKey(meta: Meta, config: unknown, options: RenderOptions | undefined): string {
  const o = (options ?? {}) as RenderOptions & { fontFamily?: string; fontFamilyMono?: string };
  return [meta.text, safeJson([...meta.sizes]), o.fontSize ?? "", o.fontFamily ?? "", o.fontFamilyMono ?? "", o.padding ?? "", safeJson(config)].join("\u0000");
}

// -- label building ---------------------------------------------------------------

/**
 * Words a label may break between: whitespace-separated, except that
 * Markdown spans (`**…**`, `*…*`, `__…__`, `_…_`, `~~…~~`, `` `…` ``) are
 * kept whole (their inner spaces become joiners), so a re-wrap never splits
 * a span's markers across lines.
 */
export function labelWords(line: string): string[] {
  const units = /\*\*[^*\n]+?\*\*|__[^_\n]+?__|~~[^~\n]+?~~|\*[^*\s][^*\n]*?\*|_[^_\s][^_\n]*?_|`[^`\n]+`|\s+|[^\s*_~`]+|[*_~`]/g;
  const words: string[] = [];
  let cur = "";
  for (const m of line.matchAll(units)) {
    const u = m[0];
    if (/^\s+$/.test(u)) {
      if (cur) words.push(cur);
      cur = "";
    } else cur += u.replace(/\s+/g, JOINER);
  }
  if (cur) words.push(cur);
  return words;
}

function wrapWords(line: string, c: number): string[] {
  const words = labelWords(line);
  if (!Number.isFinite(c) || words.length <= 1) return [words.join(" ")];
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && [...next].length > c) {
      out.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

function fillerFor(amount: number): string {
  if (amount <= 0) return "";
  const units = Math.floor(amount + 1e-9);
  const fine = Math.round((amount - units) / FINE_RATIO);
  if (units + fine === 0) return "";
  return `${FILL_OPEN}${"0".repeat(units)}${"'".repeat(fine)}${FILL_CLOSE}`;
}

function buildLabel(p: Plan, s: PlanState): string {
  // Width given: we own the wrapping (joined words never break again).
  // Height only: keep the label's own lines so Pele wraps it as before.
  const own = p.t.w !== undefined;
  let lines = own ? p.hard.flatMap((l) => wrapWords(l, p.token ? Infinity : s.c)) : [...p.hard];
  if (own) lines = lines.map((l) => l.replace(/ +/g, JOINER));
  if (lines.length === 0) lines = [""];
  // The same filler on every line: the widest line stays the widest, so the
  // box grows by exactly the filler's width.
  const fill = own ? fillerFor(s.fill) : "";
  if (fill) lines = lines.map((l) => l + fill);
  const above = Math.floor(s.extra / 2);
  const below = s.extra - above;
  return [...Array<string>(above).fill(""), ...lines, ...Array<string>(below).fill("")].join("<br>");
}

// -- the wrapper --------------------------------------------------------------


/** Wrap one Pele diagram so `%% pele-size … %%` entries size its nodes. */
export function withNodeSizing<M>(d: Diagram<M>): Diagram<M> {
  return wrapDiagram<M, Meta>(d, META, {
    marker: "pele-size",
    read(source, text, config, title, lineOffset, limits) {
      const { sizes } = lintSizeDirective(source);
      return sizes.size ? { sizes, text, config, title, lineOffset, limits } : undefined;
    },
    render(model, meta, config, options) {
      try {
        return solve(d, model, meta, config, options);
      } catch {
        return d.render(model, config, options);
      }
    },
  });
}

function solve<M>(d: Diagram<M>, model: M, meta: Meta, config: RenderArgs<M>[1], options: RenderOptions): Rendered<M> & NodeSizeResult {
  const fs = typeof options?.fontSize === "number" && options.fontSize > 0 ? options.fontSize : 16;
  // Height lines: pele 1.9+ lays multi-line labels (any label with filler
  // lines) on a 1.3 em grid. Half of it is the height tolerance; a looser one
  // settles a line short of the closest box.
  const step = 1.3 * fs;
  const nodes = sizableNodes(model);
  const plans: Plan[] = [];
  const cache = cacheFor(options);
  const key = cacheKey(meta, config, options);
  const cached = cache.get(key);
  for (const [id, raw] of meta.sizes) {
    const node = nodes.get(id);
    if (!node) continue;
    const { caps } = node;
    const t: NodeSize = {};
    if (caps.w && raw.w !== undefined) t.w = raw.w;
    if (caps.h && caps.lock !== "square" && raw.h !== undefined) t.h = raw.h;
    if (t.w === undefined && t.h === undefined) continue;
    const label = node.ref.get();
    const hard = label.split(/<br\s*\/?>|\n/i).map((l) => l.trim());
    const words = hard.flatMap((l) => labelWords(l));
    const longest = Math.max(1, ...words.map((w) => [...w].length));
    const widest = Math.max(1, ...hard.map((l) => [...l].length));
    const token = /\uE000/.test(label);
    const start = cached?.get(id);
    const freshPhase: Plan["phase"] = t.w !== undefined && !token && words.length > hard.filter(Boolean).length ? "wrap" : "fit";
    plans.push({
      id,
      t,
      caps,
      hard,
      token,
      longest,
      widest,
      state: start ? { ...start } : { c: Infinity, fill: 0, extra: 0 },
      phase: start ? "fit" : freshPhase,
      freshPhase,
      cached: !!start,
      samples: [],
    });
  }
  if (plans.length === 0) return d.render(model, config, options);

  let out: Rendered<M> | undefined;
  let boxes = new Map<string, Box>();
  let rendered = "";
  const stateKey = (): string => safeJson(plans.map((p) => [p.state.c === Infinity ? "inf" : p.state.c, p.state.fill, p.state.extra]));
  const renderPass = (): void => {
    rendered = stateKey();
    const fresh = d.parse(meta.text, meta.config, meta.title, meta.lineOffset, meta.limits);
    const refs = sizableNodes(fresh);
    for (const p of plans) refs.get(p.id)?.ref.set(buildLabel(p, p.state));
    out = d.render(fresh, config, options);
    boxes = nodeBoxMap(out.svg);
  };

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    renderPass();
    let settled = true;
    for (const p of plans) {
      const b = boxes.get(p.id);
      if (!b) {
        p.phase = "done";
        continue;
      }
      const sample: Sample = { ...p.state, w: b.w, h: b.h };
      p.last = sample;
      if (p.cached) {
        // A cached plan that no longer lands (fonts loaded, measurer changed):
        // solve this node from scratch.
        p.cached = false;
        const offW = p.t.w !== undefined && Math.abs(p.t.w - b.w) > 2;
        const offH = p.t.h !== undefined && Math.abs(p.t.h - b.h) > step / 2;
        if (offW || offH) {
          p.state = { c: Infinity, fill: 0, extra: 0 };
          p.phase = p.freshPhase;
          settled = false;
          continue;
        }
      }
      if (p.phase === "done") continue;
      if (p.phase === "wrap") {
        if (!advanceWrap(p, sample)) settled = false;
        continue;
      }
      if (p.phase === "shape") {
        advanceShape(p, sample);
        settled = false;
        continue;
      }
      // fit: width filler + height lines
      p.samples.push(sample);
      let changed = false;
      if (p.t.w !== undefined && Math.abs(p.t.w - b.w) > 1) {
        const next = nextFill(p, sample, fs);
        if (Math.abs(next - p.state.fill) > 1e-6 && !triedFill(p, next)) {
          p.state.fill = next;
          changed = true;
        }
      }
      if (p.t.h !== undefined && Math.abs(p.t.h - b.h) > step / 2) {
        const perLine = lineStep(p, step);
        const e = Math.max(0, p.state.extra + Math.round((p.t.h - b.h) / perLine));
        if (e !== p.state.extra && !p.samples.some((s) => s.extra === e && s.fill === p.state.fill && s.c === p.state.c)) {
          p.state.extra = e;
          changed = true;
        }
      }
      if (changed) settled = false;
      else {
        p.phase = "done";
        // Settle on the closest box seen (filler steps can overshoot).
        const best = bestSample(p);
        if (best && (best.fill !== p.state.fill || best.extra !== p.state.extra || best.c !== p.state.c)) {
          p.state = { c: best.c, fill: best.fill, extra: best.extra };
          settled = false;
        }
      }
    }
    if (settled) break;
  }

  // Not converged: settle every node on its best sample.
  if (plans.some((p) => p.phase !== "done")) {
    for (const p of plans) {
      // Out of passes mid shape search: the best wrap found, not a mid-search one.
      if (p.phase === "shape" && p.shapeBest) {
        p.state = { c: p.shapeBest.c, fill: 0, extra: 0 };
        continue;
      }
      const best = bestSample(p);
      if (best) p.state = { c: best.c, fill: best.fill, extra: best.extra };
    }
  }
  // The returned SVG must show the states being cached and reported.
  if (stateKey() !== rendered) renderPass();

  const nodeSizes: Record<string, NodeSizeInfo> = {};
  const toCache = new Map<string, PlanState>();
  for (const p of plans) {
    const b = boxes.get(p.id);
    if (!b) continue;
    nodeSizes[p.id] = { target: p.t, applied: { w: Math.round(b.w), h: Math.round(b.h) }, caps: p.caps };
    toCache.set(p.id, { ...p.state });
  }
  cache.delete(key);
  cache.set(key, toCache);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  // MAX_PASSES > 0, so renderPass has run.
  if (!out) return d.render(model, config, options);
  return { ...out, svg: centreSizedLabels(cleanSizedText(out.svg), new Set(plans.map((p) => p.id))), nodeSizes };
}

/**
 * Height filler lines come in whole lines, split above and below the text;
 * an odd count leaves the text half a line off centre. Move the visible lines
 * of each sized node's label back to the middle of its line block.
 */
export function centreSizedLabels(svg: string, ids: Set<string>): string {
  if (ids.size === 0) return svg;
  return svg.replace(/<g\b[^>]*\bclass="[^"]*\bpele-node\b[^"]*"[^>]*\sdata-id="([^"]*)"[^>]*>/g, (open, rawId: string) =>
    ids.has(decodeEntities(rawId)) ? `${open}\u0000` : open,
  ).replace(/\0((?:(?!<\/text>)[\s\S])*?)(<text class="pele-label"[^>]*>)((?:<tspan[^>]*>[^<]*<\/tspan>)+)(<\/text>)/g, (_m, pre: string, open: string, spans: string, close: string) => {
    const list = [...spans.matchAll(/<tspan([^>]*)\sy="([-\d.e+]+)"([^>]*)>([^<]*)<\/tspan>/g)];
    if (list.length < 2) return pre + open + spans + close;
    const blank = (t: string) => t.trim() === "";
    let lead = 0;
    while (lead < list.length && blank(list[lead][4])) lead++;
    let trail = 0;
    while (trail < list.length - lead && blank(list[list.length - 1 - trail][4])) trail++;
    if (lead === trail || lead === list.length) return pre + open + spans + close;
    const step = (Number(list[list.length - 1][2]) - Number(list[0][2])) / (list.length - 1);
    const shift = ((trail - lead) * step) / 2;
    const moved = list
      .map((m) => `<tspan${m[1]} y="${Math.round((Number(m[2]) + shift) * 100) / 100}"${m[3]}>${m[4]}</tspan>`)
      .join("");
    return pre + open + moved + close;
  }).replace(/\0/g, "");
}

/** Remove fillers and restore joiners in rendered markup. */
export function cleanSizedText(s: string): string {
  return s.includes(FILL_OPEN) || s.includes(JOINER) ? s.replace(FILL_RE, "").replace(JOINER_RE, " ") : s;
}

/**
 * Re-wrap search: the widest wrap (most characters per line) whose box still
 * fits the target width; the floor is the longest word.
 */
function advanceWrap(p: Plan, s: Sample): boolean {
  const tw = p.t.w!;
  const fits = s.w <= tw + 1;
  const c = Number.isFinite(s.c) ? s.c : p.widest;
  const at: Sample = { ...s, c };
  if (fits) {
    if (!p.wrapLo || c > p.wrapLo.c) p.wrapLo = at;
  } else if (!p.wrapHi || c < p.wrapHi.c) p.wrapHi = at;
  if (!Number.isFinite(s.c) && fits) return finishWrap(p, Infinity);
  if (c <= p.longest && !fits) return finishWrap(p, p.longest);
  if (!p.wrapLo) {
    p.state = { ...p.state, c: p.longest };
    return false;
  }
  if (!p.wrapHi) return finishWrap(p, p.wrapLo.c);
  const lo = p.wrapLo;
  const hi = p.wrapHi;
  if (hi.c - lo.c <= 1) return finishWrap(p, lo.c);
  const est = hi.w !== lo.w ? lo.c + ((tw - lo.w) * (hi.c - lo.c)) / (hi.w - lo.w) : (lo.c + hi.c) / 2;
  const next = Math.min(hi.c - 1, Math.max(lo.c + 1, Math.floor(est)));
  p.state = { ...p.state, c: next };
  return false;
}

/**
 * Wrap chosen: the next render is the first width/height fit sample — or,
 * for a node with both a width and a height, first the shape search over
 * narrower wraps (advanceShape).
 */
function finishWrap(p: Plan, c: number): boolean {
  const cands = p.t.w !== undefined && p.t.h !== undefined && !p.token ? shapeWraps(c, p.longest, p.widest) : [];
  p.phase = cands.length ? "shape" : "fit";
  if (cands.length) p.shapeCands = cands;
  p.state = { ...p.state, c };
  return false;
}

/** Narrower wraps worth trying below `c` (never under the longest word). */
export function shapeWraps(c: number, longest: number, widest: number): number[] {
  const top = Number.isFinite(c) ? c : widest;
  return SHAPE_WRAPS.filter((k) => k < top && k >= longest);
}

/** How much a box w×h could grow into the target W×H (≥ 1 when it fits). */
export function shapeScore(W: number, H: number, w: number, h: number): number {
  return w > 0 && h > 0 ? Math.min(W / w, H / h) : 0;
}

/**
 * One shape sample: keep the wrap whose box fills the target best (a wrap
 * too wide for it never wins); stop once narrower wraps stop helping. A label
 * that fits on its own lines only splits for a clear gain (SPLIT_GAIN): on
 * pele 1.9+'s tighter line grid a split "Root topic" scored under 1% higher.
 */
function advanceShape(p: Plan, s: Sample): void {
  const W = p.t.w!;
  const H = p.t.h!;
  const score = s.w <= W + 1 ? shapeScore(W, H, s.w, s.h) : 0;
  const best = p.shapeBest;
  const gain = best && !Number.isFinite(best.c) ? SPLIT_GAIN : 1e-6;
  const top = !best || score > best.score * (1 + gain) ? { c: s.c, score } : best;
  p.shapeBest = top;
  const worse = !!best && score < best.score;
  const next = worse ? undefined : p.shapeCands?.shift();
  if (next !== undefined) {
    p.state = { ...p.state, c: next };
    return;
  }
  p.phase = "fit";
  p.state = { ...p.state, c: top.c };
}

function nextFill(p: Plan, s: Sample, fs: number): number {
  const same = p.samples.filter((x) => x.c === s.c && x.extra === s.extra);
  let slope = 0.55 * fs;
  for (let i = same.length - 2; i >= 0; i--) {
    const a = same[i];
    if (Math.abs(a.fill - s.fill) > 1e-6 && Math.abs(a.w - s.w) > 0.5) {
      const k = (s.w - a.w) / (s.fill - a.fill);
      if (k > 0.5) slope = k;
      break;
    }
  }
  const want = Math.max(0, s.fill + (p.t.w! - s.w) / slope);
  const units = Math.floor(want + 1e-9);
  return units + Math.round((want - units) / FINE_RATIO) * FINE_RATIO;
}

function triedFill(p: Plan, fill: number): boolean {
  return p.samples.some((x) => Math.abs(x.fill - fill) < 1e-6 && x.c === p.state.c && x.extra === p.state.extra);
}

function lineStep(p: Plan, fallback: number): number {
  const xs = p.samples;
  for (let i = xs.length - 1; i > 0; i--) {
    const a = xs[i - 1];
    const b = xs[i];
    if (a.extra !== b.extra && a.fill === b.fill && a.c === b.c) {
      const k = (b.h - a.h) / (b.extra - a.extra);
      if (k > 2) return k;
    }
  }
  return fallback;
}

function bestSample(p: Plan): Sample | undefined {
  const err = (s: Sample) =>
    (p.t.w !== undefined ? Math.abs(p.t.w - s.w) : 0) + (p.t.h !== undefined ? Math.abs(p.t.h - s.h) : 0);
  let best: Sample | undefined;
  for (const s of p.samples) if (!best || err(s) < err(best)) best = s;
  return best ?? p.last;
}
