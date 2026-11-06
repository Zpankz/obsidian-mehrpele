/**
 * Responsive reflow planner: picks the layout Pele should draw for a layout
 * width L so text is never magnified and is shrunk only down to a floor.
 *
 * - flowchart: a ladder of discrete layouts, each rendered once and cached:
 *   authored direction (normal, then Pele's compact spacing), LR/RL → TB,
 *   subgraph `direction LR/RL` → TB, then label wrap 160 → 88 px on the
 *   last direction level. The first step that fits L at 1× wins.
 * - class, state, ER, requirement without a written direction: top-down,
 *   then turned sideways (`direction LR`) when top-down is too wide.
 * - everything else: Pele's own reflow at maxWidth L with the direction
 *   breakpoint at infinity, so orientation switches exactly when the
 *   authored layout stops fitting.
 *
 * In a box (planFill: a frame with a height as well as a width) the layout
 * that fills the box best wins instead — the largest min(W/w, H/h), ties to
 * the less reflowed — then spare height spreads the flowchart along its
 * vertical axis, and only then is the chart scaled up (up to maxScale).
 * Compact and re-wrapped steps count only up to 1× (they exist to fit).
 * The fill scale is a maximum over a fixed set of layouts, so growing
 * either side of the box never makes the chart smaller.
 *
 * Upgrading to a less-reflowed layout needs `margin` px of spare room
 * (hysteresis); downgrades are immediate. A guard freezes the layout after
 * three direction changes within two seconds until the width moves by more
 * than 64 px. DOM-free: the caller passes a render function.
 */
import type { RenderOptions } from "pele";
import { render as peleRender } from "../pele.js";
import { detectTypeOrNull } from "../detect.js";
import { parseReflowDirective, type ReflowDirective } from "./directive.js";
import { hasCanvasLayout } from "../layout/directive.js";
import { flipSource, flowchartDirection, hasHorizontalSubgraph, hasWrittenDirection, turnSource, TURNABLE_TYPES } from "./transpose.js";

export interface LayoutSize {
  width: number;
  height: number;
}

/** Renders a source (only its size is used). */
export type ReflowRender = (source: string, options: RenderOptions) => LayoutSize;

export interface ReflowPolicy {
  /** LR/RL → TB when the authored layout does not fit (flowchart, mindmap, timeline, …). */
  switchDirection: boolean;
  /** Class/state/ER/requirement without a written direction turn sideways when too wide. */
  autoTurn: boolean;
  /** Smallest display scale before the frame scrolls. */
  minTextScale: number;
  /** Spare px needed before upgrading to a less-reflowed layout. */
  margin: number;
  /** Flowchart label wrap widths tried after every direction step (Pele's default is 200). */
  wraps: readonly number[];
}

export const DEFAULT_REFLOW_POLICY: ReflowPolicy = {
  switchDirection: true,
  autoTurn: true,
  minTextScale: 0.8,
  margin: 32,
  wraps: [160, 128, 104, 88],
};

/** maxWidth that never constrains a layout. */
export const NATURAL_WIDTH = 1_000_000;
/** Pele `directionBreakpoint` that switches orientation exactly at fit. */
export const DIRECTION_BREAKPOINT = Number.MAX_SAFE_INTEGER;

const GUARD_WINDOW_MS = 2000;
const GUARD_MAX_CHANGES = 3;
const GUARD_RELEASE_PX = 64;
/** Above this many source lines the ladder is capped (renders cost more). */
const LARGE_DIAGRAM_LINES = 150;

export type ReflowMode = "ladder" | "turn" | "native" | "off";

export interface ReflowPlan {
  /** Source Pele should render (header / `direction` lines rewritten). */
  source: string;
  /** Options to merge over the base options; always carries an explicit maxWidth. */
  options: Partial<RenderOptions>;
  /** Identity of the chosen layout: a re-render is needed only when it changes. */
  key: string;
  /** "authored", "TB", "TB*", "LR" (turned) or "native". */
  direction: string;
  /** Flowchart flip level (0–2) and whether a sideways turn was injected. */
  flip: number;
  turn: boolean;
  /** Size of the chosen layout (SVG units). */
  width: number;
  height: number;
  /** Width the plan was made for. */
  layoutWidth: number;
  /** Display scale (≤ 1; ≥ the floor unless scroll). */
  scale: number;
  /** Even the floor overflows L: the frame scrolls. */
  scroll: boolean;
  mode: ReflowMode;
  /** Box height the plan was made for (planFill); undefined for a width-only plan. */
  boxHeight?: number;
}

interface Step {
  key: string;
  flip: 0 | 1 | 2;
  turn: boolean;
  compact: boolean;
  /** Label wrap width; null = Pele's default (author config untouched). */
  wrap: number | null;
  direction: string;
  /** Vertical spacing × Pele's default (planFill only): spare box height. */
  spread?: number;
}

/** Spacing factors tried along the vertical axis when a box has height to spare. */
const SPREADS = [1.5, 2, 3, 4] as const;
/** Pele's flowchart defaults (nodeSpacing within a rank, rankSpacing between ranks). */
const PELE_NODE_SPACING = 40;
const PELE_RANK_SPACING = 48;
/** Largest display scale planFill returns (the frame zoom bound). */
export const FILL_MAX_SCALE = 4;
/** Native (width-adaptive) layouts tried in a box, besides the box width itself. */
const NATIVE_FILL_WIDTHS = [2400, 1600, 1200, 960, 800, 640, 520, 420, 340, 280, 220, 180, 140] as const;

/** Fill scale of a layout in a box: how much it can grow (or must shrink) to fit both sides. */
export function fillScale(W: number, H: number, s: LayoutSize): number {
  return s.width > 0 && s.height > 0 ? Math.min(W / s.width, H / s.height) : 0;
}

/** Class/state/ER/requirement: top-down as written, then turned sideways. */
function turnSteps(): Step[] {
  return [
    { key: "authored", flip: 0, turn: false, compact: false, wrap: null, direction: "authored" },
    { key: "LR", flip: 0, turn: true, compact: false, wrap: null, direction: "LR" },
  ];
}

/** Display scale for a layout `w` wide in L: never magnified, floored, else scroll. */
export function displayScale(L: number, w: number, floor: number): { scale: number; scroll: boolean } {
  if (!(w > 0) || !(L > 0)) return { scale: 1, scroll: false };
  const s = Math.min(1, L / w);
  const f = Math.min(1, Math.max(0, floor));
  return s + 1e-6 < f ? { scale: f, scroll: true } : { scale: s, scroll: false };
}

/**
 * Two layouts of the same structure: height unchanged, or both dimensions
 * moved the same way by similar amounts (proportional types). A structural
 * switch (direction, legend below, rows) trades width for height.
 */
export function similarLayout(a: LayoutSize, b: LayoutSize): boolean {
  const dw = Math.abs(a.width - b.width) / Math.max(a.width, b.width, 1);
  const dh = Math.abs(a.height - b.height) / Math.max(a.height, b.height, 1);
  if (dh <= 0.02) return true;
  if (dw <= 0.002) return false;
  const sameWay = Math.sign(a.width - b.width) === Math.sign(a.height - b.height);
  return sameWay && dh <= dw + 0.04;
}

const globalSizes = new Map<string, LayoutSize>();
const GLOBAL_CACHE_MAX = 2000;

function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

function withWrap(config: RenderOptions["config"], wrap: number): RenderOptions["config"] {
  const cfg = (config ?? {}) as Record<string, unknown>;
  const flow = (cfg.flowchart ?? {}) as Record<string, unknown>;
  return { ...cfg, flowchart: { ...flow, wrappingWidth: wrap } };
}

/**
 * Spread a flowchart along its vertical axis: nodeSpacing for LR/RL (ranks
 * run across, nodes of a rank stack down), rankSpacing for top-down. The
 * width is unchanged; only the height grows.
 */
function withSpread(config: RenderOptions["config"], horizontal: boolean, k: number): RenderOptions["config"] {
  const cfg = (config ?? {}) as Record<string, unknown>;
  const flow = (cfg.flowchart ?? {}) as Record<string, unknown>;
  const name = horizontal ? "nodeSpacing" : "rankSpacing";
  const own = flow[name];
  const base = typeof own === "number" && own > 0 ? own : horizontal ? PELE_NODE_SPACING : PELE_RANK_SPACING;
  return { ...cfg, flowchart: { ...flow, [name]: Math.round(base * k) } } as RenderOptions["config"];
}

export interface PlannerOptions {
  /** Defaults to the source's own `%% pele-reflow %%` lines. */
  directive?: ReflowDirective;
  /** Clock for the thrash guard (tests). */
  now?: () => number;
  /**
   * Process-wide cache key for this planner's base options (fonts, sizes,
   * reservations). Omit to derive it; null disables the shared cache (e.g.
   * a measurer that cannot be described by a key).
   */
  cacheKey?: string | null;
}

export class ReflowPlanner {
  readonly type: string | null;
  readonly mode: ReflowMode;
  readonly policy: ReflowPolicy;
  readonly switchDirection: boolean;
  /** Renders spent so far (tests, perf). */
  renders = 0;
  private steps: Step[] = [];
  private sizes = new Map<string, LayoutSize>();
  private current: { plan: ReflowPlan; index: number } | null = null;
  private changes: number[] = [];
  private frozenAt: number | null = null;
  private frozenSince = 0;
  private sameHeightWidth: number | null | undefined;
  private now: () => number;
  private cacheKey: string | null;
  private floor: number;

  constructor(
    readonly source: string,
    private base: RenderOptions = {},
    private renderFn: ReflowRender = peleRender,
    policy: Partial<ReflowPolicy> = {},
    opts: PlannerOptions = {},
  ) {
    this.policy = { ...DEFAULT_REFLOW_POLICY, ...policy };
    this.now = opts.now ?? (() => Date.now());
    const directive = opts.directive ?? parseReflowDirective(source);
    this.floor = directive.floor ?? this.policy.minTextScale;
    const type = detectTypeOrNull(source);
    this.type = type;
    const fixed = directive.direction === "fixed";
    const forced = directive.direction === "auto";
    this.switchDirection = !fixed && (forced || this.policy.switchDirection);
    const autoTurn = !fixed && (forced || this.policy.autoTurn);
    if (directive.off || type === null) this.mode = "off";
    else if (type === "flowchart") this.mode = "ladder";
    else if ((TURNABLE_TYPES as readonly string[]).includes(type) && autoTurn && !hasWrittenDirection(source)) this.mode = "turn";
    else this.mode = "native";
    this.steps = this.mode === "ladder" ? this.ladderSteps() : this.mode === "turn" ? turnSteps() : [];
    if (opts.cacheKey === null || (opts.cacheKey === undefined && base.measurer)) this.cacheKey = null;
    else {
      const { fontFamily, fontFamilyMono, fontSize, padding, config } = base;
      this.cacheKey = `${hashString(source)}|${opts.cacheKey ?? ""}|${JSON.stringify({ fontFamily, fontFamilyMono, fontSize, padding, config })}`;
    }
  }

  /** The shrink floor in effect (setting or the block's `floor=`). */
  get minTextScale(): number {
    return this.floor;
  }

  private ladderSteps(): Step[] {
    // Canvas layout pins every node: flips, compact spacing and re-wrapped
    // labels would only break the drawing, so it just scales.
    if (hasCanvasLayout(this.source)) return [{ key: "canvas", flip: 0, turn: false, compact: false, wrap: null, direction: "authored" }];
    const levels: (0 | 1 | 2)[] = [0];
    if (this.switchDirection) {
      const dir = flowchartDirection(this.source);
      if (dir === "LR" || dir === "RL") levels.push(1);
      if (hasHorizontalSubgraph(this.source)) levels.push(2);
    }
    const names = ["authored", "TB", "TB*"];
    const out: Step[] = [];
    // Large diagrams: authored and the first flip only, no wrap steps.
    const large = this.source.split("\n").length > LARGE_DIAGRAM_LINES;
    const add = (flip: 0 | 1 | 2, wrap: number | null) => {
      for (const compact of [false, true]) {
        out.push({ key: `${names[flip]}/${compact ? "c" : "n"}/${wrap ?? 200}`, flip, turn: false, compact, wrap, direction: names[flip] });
      }
    };
    // Direction first: no label re-wrapping before every flip has been tried.
    for (const flip of large ? levels.slice(0, 2) : levels) add(flip, null);
    if (large) return out;
    const last = levels[levels.length - 1];
    for (const wrap of this.policy.wraps) add(last, wrap);
    return out;
  }

  /** Source and options for one ladder step. */
  private stepRender(step: Step): { source: string; options: Partial<RenderOptions> } {
    let source = step.turn ? turnSource(this.source) : flipSource(this.source, step.flip);
    if (source === this.source) source = this.source;
    const options: Partial<RenderOptions> = { autoDirection: false, maxWidth: NATURAL_WIDTH };
    if (step.wrap !== null) options.config = withWrap(this.base.config, step.wrap);
    if (step.spread !== undefined) {
      const dir = flowchartDirection(source);
      options.config = withSpread(options.config ?? this.base.config, dir === "LR" || dir === "RL", step.spread);
    }
    if (step.compact) {
      // Pele compacts spacing only when the normal layout overflows maxWidth.
      const normal = this.size(this.steps.find((s) => s.flip === step.flip && s.wrap === step.wrap && !s.compact)!);
      options.maxWidth = Math.max(1, Math.floor(normal.width) - 1);
    }
    return { source, options };
  }

  private size(step: Step): LayoutSize {
    const hit = this.sizes.get(step.key);
    if (hit) return hit;
    const gkey = this.cacheKey ? `${this.cacheKey}|${step.key}` : null;
    const shared = gkey ? globalSizes.get(gkey) : undefined;
    if (shared) {
      this.sizes.set(step.key, shared);
      return shared;
    }
    const { source, options } = this.stepRender(step);
    const size = this.measure(source, options);
    this.sizes.set(step.key, size);
    if (gkey) {
      const oldest = globalSizes.size >= GLOBAL_CACHE_MAX ? globalSizes.keys().next() : undefined;
      if (oldest && !oldest.done) globalSizes.delete(oldest.value);
      globalSizes.set(gkey, size);
    }
    return size;
  }

  private measure(source: string, options: Partial<RenderOptions>): LayoutSize {
    this.renders++;
    try {
      const r = this.renderFn(source, { ...this.base, ...options });
      return { width: r.width, height: r.height };
    } catch {
      // Invalid source: the mount reports the error; plan as unconstrained.
      return { width: 0, height: 0 };
    }
  }

  private nativeOptions(maxWidth: number): Partial<RenderOptions> {
    return this.switchDirection
      ? { maxWidth, directionBreakpoint: DIRECTION_BREAKPOINT }
      : { maxWidth, autoDirection: false };
  }

  private nativeSize(maxWidth: number): LayoutSize {
    const w = Math.max(1, Math.round(maxWidth));
    const key = `native@${w}`;
    const hit = this.sizes.get(key);
    if (hit) return hit;
    // Unconstrained and non-adaptive layouts never change with the width.
    const natural = this.sizes.get("native@natural") ?? this.cacheNative("native@natural", NATURAL_WIDTH);
    let size: LayoutSize;
    if (natural.width <= w) size = natural;
    else {
      const narrowest = this.sizes.get("native@1") ?? this.cacheNative("native@1", 1);
      size = narrowest.width === natural.width && narrowest.height === natural.height ? natural : this.measure(this.source, this.nativeOptions(w));
    }
    this.sizes.set(key, size);
    return size;
  }

  private cacheNative(key: string, maxWidth: number): LayoutSize {
    const size = this.measure(this.source, this.nativeOptions(maxWidth));
    this.sizes.set(key, size);
    return size;
  }

  /** Index of the first step (≤ maxIndex) whose layout fits `limit`. */
  private firstFit(limit: number, maxIndex = this.steps.length - 1): number | null {
    for (let i = 0; i <= maxIndex; i++) {
      const step = this.steps[i];
      if (step.compact) {
        // Compaction saves 3–10%: don't render it when it cannot fit.
        const normal = this.sizes.get(step.key.replace("/c/", "/n/"));
        if (normal && normal.width * 0.85 > limit) continue;
      }
      const s = this.size(step);
      if (s.width > 0 && s.width <= limit) return i;
    }
    return null;
  }

  /**
   * Narrowest layout when nothing fits: among the steps already measured,
   * plus the most reflowed step (normal and compact), so a first solve on a
   * very narrow column costs a few renders, not the whole ladder.
   */
  private narrowest(): number {
    const n = this.steps.length;
    for (const i of [n - 2, n - 1]) if (i >= 0) this.size(this.steps[i]);
    let best = 0;
    let bestWidth = -1; // -1: nothing measured with a positive width yet
    for (const [i, step] of this.steps.entries()) {
      const s = this.sizes.get(step.key);
      if (s && s.width > 0 && (bestWidth < 0 || s.width < bestWidth)) {
        best = i;
        bestWidth = s.width;
      }
    }
    return best;
  }

  private planFor(index: number, L: number, spread?: Step): ReflowPlan {
    const step = spread ?? this.steps[index];
    const { source, options } = this.stepRender(step);
    const size = this.size(step);
    const { scale, scroll } = displayScale(L, size.width, this.floor);
    return {
      source, options, key: `${this.mode}:${step.key}`, direction: step.direction, flip: step.flip, turn: step.turn,
      width: size.width, height: size.height, layoutWidth: L, scale, scroll, mode: this.mode,
    };
  }

  private nativePlan(maxWidth: number, L: number): ReflowPlan {
    const w = Math.max(1, Math.round(maxWidth));
    const size = this.nativeSize(w);
    const { scale, scroll } = displayScale(L, size.width, this.floor);
    return {
      source: this.source,
      options: this.mode === "off" ? { maxWidth: w } : this.nativeOptions(w),
      key: `${this.mode}:${Math.round(size.width)}x${Math.round(size.height)}`,
      direction: "native", flip: 0, turn: false,
      width: size.width, height: size.height, layoutWidth: L, scale, scroll, mode: this.mode,
    };
  }

  /** Re-score a kept plan for a new width (display scale only). */
  private rescale(plan: ReflowPlan, L: number): ReflowPlan {
    const { boxHeight: _box, ...rest } = plan;
    return { ...rest, layoutWidth: L, ...displayScale(L, plan.width, this.floor) };
  }

  /** The plan last returned, if any. */
  get last(): ReflowPlan | null {
    return this.current?.plan ?? null;
  }

  /**
   * Carry the layout of an earlier planner over (the source was edited in
   * place, or Mehrpele re-measured its labels): the next plan keeps that
   * step while it still fits, with the usual margin before upgrading.
   */
  seed(prev: ReflowPlan | null): void {
    if (!prev || prev.mode !== this.mode) return;
    if (this.mode === "native" || this.mode === "off") {
      this.current = { plan: prev, index: -1 };
      return;
    }
    const key = prev.key.slice(prev.key.indexOf(":") + 1);
    const index = this.steps.findIndex((s) => s.key === key);
    if (index >= 0) this.current = { plan: this.planFor(index, prev.layoutWidth), index };
  }

  /** Forget the chosen layout (hysteresis restarts), keeping the size cache. */
  reset(): void {
    this.current = null;
    this.changes = [];
    this.frozenAt = null;
  }

  /** Plan for layout width L (column width, capped by `width=`). */
  plan(L: number): ReflowPlan {
    const width = Math.max(1, Math.floor(L));
    const cur = this.current;
    if (cur && this.frozenAt !== null) {
      // Released by a real width change, or once the burst has calmed down.
      const calm = this.now() - this.frozenSince >= GUARD_WINDOW_MS;
      if (!calm && Math.abs(width - this.frozenAt) <= GUARD_RELEASE_PX) return this.keep(cur.plan, width);
      this.frozenAt = null;
      this.changes = [];
    }
    let next: { plan: ReflowPlan; index: number };
    if (this.mode === "off") next = { plan: this.nativePlan(width, width), index: -1 };
    else if (this.mode === "native") next = { plan: this.pickNative(width), index: -1 };
    else next = this.pickLadder(width);
    if (cur && next.plan.key !== cur.plan.key && this.isStructural(cur.plan, next.plan)) {
      const t = this.now();
      this.changes = this.changes.filter((c) => t - c < GUARD_WINDOW_MS);
      if (this.changes.length >= GUARD_MAX_CHANGES) {
        this.frozenAt = width;
        this.frozenSince = t;
        return this.keep(cur.plan, width);
      }
      this.changes.push(t);
    }
    this.current = next;
    return next.plan;
  }

  private keep(plan: ReflowPlan, width: number): ReflowPlan {
    const kept = this.rescale(plan, width);
    this.current = { plan: kept, index: this.current?.index ?? -1 };
    return kept;
  }

  private isStructural(a: ReflowPlan, b: ReflowPlan): boolean {
    if (a.mode === "native" || a.mode === "off") return !similarLayout(a, b);
    return a.direction !== b.direction;
  }

  private pickLadder(L: number): { plan: ReflowPlan; index: number } {
    const cur = this.current;
    let index: number;
    if (cur && cur.index >= 0 && this.size(this.steps[cur.index]).width <= L) {
      // Keep the current layout unless a better one fits with room to spare.
      index = this.firstFit(L - this.policy.margin, cur.index - 1) ?? cur.index;
    } else {
      index = this.firstFit(L) ?? this.narrowest();
    }
    return { plan: this.planFor(index, L), index };
  }

  private pickNative(L: number): ReflowPlan {
    const cur = this.current?.plan;
    const a = this.nativeSize(L);
    if (!cur || cur.mode !== this.mode || cur.width > L + 0.5 || similarLayout(a, cur)) return this.nativePlan(L, L);
    // A structural switch: upgrade only when it still holds `margin` px narrower.
    const b = this.nativeSize(L - this.policy.margin);
    return similarLayout(a, b) ? this.nativePlan(L, L) : this.nativePlan(L - this.policy.margin, L);
  }

  /**
   * Layout for a frame box W×H (a resized frame): the layout with the largest
   * fill scale min(W/w, H/h) wins, ties to the less reflowed one; spare
   * height then spreads a flowchart vertically at the same scale; the scale
   * is capped at maxScale, and below the floor the frame scrolls. Pure in
   * (W, H): no hysteresis, so a drag can only grow the chart with the box.
   */
  planFill(W: number, H: number, maxScale = FILL_MAX_SCALE): ReflowPlan {
    const width = Math.max(1, Math.floor(W));
    const height = Math.max(1, Math.floor(H));
    let plan: ReflowPlan;
    let fill: number;
    if (this.mode === "ladder" || this.mode === "turn") {
      let best = 0;
      let bestScore = -1;
      for (let i = 0; i < this.steps.length; i++) {
        const step = this.steps[i];
        // Compact spacing and re-wrapped labels only help a chart fit: they
        // never earn a magnification (no tighter or more wrapped text just
        // because it scales up better).
        const raw = fillScale(width, height, this.size(step));
        const sc = step.compact || step.wrap !== null ? Math.min(raw, 1) : raw;
        if (sc > bestScore * (1 + 1e-9)) {
          best = i;
          bestScore = sc;
        }
      }
      fill = Math.max(0, bestScore);
      const spread = this.mode === "ladder" ? this.bestSpread(best, width, height, Math.min(fill, maxScale)) : undefined;
      plan = this.planFor(best, width, spread);
      this.current = { plan, index: best };
    } else {
      const narrow = this.mode === "off" ? null : this.narrowestSameHeight();
      const fixed = narrow !== null && narrow < width ? [...NATIVE_FILL_WIDTHS, narrow] : NATIVE_FILL_WIDTHS;
      const widths = this.mode === "off" ? [NATURAL_WIDTH] : [NATURAL_WIDTH, ...fixed.filter((w) => w < width), width];
      let bestW: number = NATURAL_WIDTH;
      let bestScore = -1;
      for (const w of widths) {
        const raw = fillScale(width, height, this.mode === "off" ? this.nativeSize(NATURAL_WIDTH) : this.nativeSize(w));
        // The layout at exactly this box width is not in the next width's set:
        // like compact steps it only helps a fit (≤ 1×), keeping the fill monotonic.
        const sc = w === width && this.mode !== "off" ? Math.min(raw, 1) : raw;
        if (sc > bestScore * (1 + 1e-9)) {
          bestW = w;
          bestScore = sc;
        }
      }
      fill = Math.max(0, bestScore);
      plan = this.nativePlan(bestW, width);
      this.current = { plan, index: -1 };
    }
    // A box plan is pure in (W, H): the width-only thrash guard starts over.
    this.frozenAt = null;
    this.changes = [];
    const capped = Math.min(fill, maxScale);
    const scroll = capped + 1e-6 < this.floor;
    return { ...plan, layoutWidth: width, boxHeight: height, scale: scroll ? this.floor : capped || 1, scroll };
  }

  /**
   * Narrowest native layout width that keeps the natural height (null: the
   * layout never narrows, or only by getting taller). Pele 1.9+ re-wraps
   * sequence messages to any width, so this layout fills a box better than
   * any fixed candidate. A property of the diagram alone: adding it to
   * planFill's candidates (when narrower than the box) keeps the fill
   * monotonic in W and H.
   */
  private narrowestSameHeight(): number | null {
    if (this.sameHeightWidth !== undefined) return this.sameHeightWidth;
    const natural = this.nativeSize(NATURAL_WIDTH);
    const taller = (w: number) => this.nativeSize(w).height > natural.height + 0.5;
    let hi = Math.ceil(natural.width);
    let lo = Math.max(1, Math.min(...NATIVE_FILL_WIDTHS));
    let found: number | null = null;
    if (hi > lo && taller(lo)) {
      // Heights only grow as the width shrinks: bisect to within 2 px.
      while (hi - lo > 2) {
        const mid = Math.floor((lo + hi) / 2);
        if (taller(mid)) lo = mid;
        else hi = mid;
      }
      if (this.nativeSize(hi).width < natural.width - 0.5) found = hi;
    }
    this.sameHeightWidth = found;
    return found;
  }

  /** The widest vertical spread of a flowchart step that keeps its fill scale (null: none). */
  private bestSpread(index: number, W: number, H: number, fill: number): Step | undefined {
    const step = this.steps[index];
    if (step.compact || step.key === "canvas") return undefined;
    let chosen: Step | undefined;
    let height = this.size(step).height;
    for (const k of SPREADS) {
      const s: Step = { ...step, key: `${step.key}~${k}`, spread: k };
      const size = this.size(s);
      if (Math.min(fillScale(W, H, size), FILL_MAX_SCALE) + 1e-9 < fill) break;
      // Nothing to spread (one node per rank): keep the plain layout.
      if (!(size.height > height + 0.5)) break;
      chosen = s;
      height = size.height;
    }
    return chosen;
  }

  /**
   * Best layout for a box W×H (lightbox, Canvas cards): maximises
   * min(1, W/w, H/h); ties within 3% go to the less reflowed layout.
   * The returned scale may be below the floor (the caller zooms or pans).
   */
  planBox(W: number, H: number): ReflowPlan {
    const score = (s: LayoutSize) => (s.width > 0 && s.height > 0 ? Math.min(1, W / s.width, H / s.height) : 0);
    let plan: ReflowPlan;
    if (this.mode === "ladder" || this.mode === "turn") {
      let best = 0;
      let bestScore = -1;
      for (let i = 0; i < this.steps.length; i++) {
        const sc = score(this.size(this.steps[i]));
        if (sc > bestScore * 1.03) {
          best = i;
          bestScore = sc;
        }
      }
      plan = this.planFor(best, W);
      this.current = { plan, index: best };
    } else {
      const atW = this.nativePlan(W, W);
      const natural = this.nativePlan(NATURAL_WIDTH, W);
      plan = score(natural) > score(atW) * 1.03 ? natural : atW;
      this.current = { plan, index: -1 };
    }
    return { ...plan, scale: score(plan) || 1, scroll: false };
  }
}

/** Apply a plan's direction rewrite to another source (e.g. an edited copy). */
export function applyPlanSource(source: string, plan: Pick<ReflowPlan, "flip" | "turn">): string {
  return plan.turn ? turnSource(source) : flipSource(source, plan.flip);
}

/** One-shot box plan (CLI `--max-height`, a fence `height=`): see ReflowPlanner.planFill. */
export function planFillReflow(
  source: string,
  base: RenderOptions,
  layoutWidth: number,
  layoutHeight: number,
  policy: Partial<ReflowPolicy> = {},
  render: ReflowRender = peleRender,
): ReflowPlan {
  return new ReflowPlanner(source, base, render, policy).planFill(layoutWidth, layoutHeight);
}

/** One-shot plan (CLI, exports). */
export function planReflow(
  source: string,
  base: RenderOptions,
  layoutWidth: number,
  policy: Partial<ReflowPolicy> = {},
  render: ReflowRender = peleRender,
): ReflowPlan {
  return new ReflowPlanner(source, base, render, policy).plan(layoutWidth);
}
