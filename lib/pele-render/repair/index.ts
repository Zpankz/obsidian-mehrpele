import { render, detectType } from "../pele.js";
import { formatViewLine, parseViewEntries } from "../canvas/views.js"; // view-nodes
import { nodeSizeCaps } from "../node-size/index.js";
import { hasSizeDirective, parseSizeDirective, withSizeDirective } from "../node-size/directive.js";

export type RepairTier = "linter" | "jev" | "llm";
export interface PeleErrorLike { message: string; code?: string; type?: string | null; line?: number; column?: number; snippet?: string }
export interface RepairCandidate { source: string; tier: RepairTier; fixes: string[]; cost: number; type?: string; lossy: boolean; dropped?: string[] }
export interface RepairAttempt { tier: RepairTier; ok: boolean; detail: string; candidates?: number; error?: PeleErrorLike }
export interface JevChoice { choice: string; confidence: number; probabilities: Record<string, number> }
export interface JevProvider { choose(state: string, question: string, options: Record<string, string>): Promise<JevChoice> }
export interface LlmProvider { complete(system: string, user: string, signal?: AbortSignal): Promise<string> }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;
export interface RepairOptions {
  tiers?: RepairTier[];
  jev?: JevProvider; llm?: LlmProvider;
  jevMinConfidence?: number;
  llmMaxAttempts?: number;
  maxCandidates?: number;
  config?: object;
  signal?: AbortSignal;
}
export interface RepairResult { ok: boolean; source?: string; tier?: RepairTier; fixes: string[]; attempts: RepairAttempt[]; error?: PeleErrorLike; unchanged?: boolean; lossy?: boolean; dropped?: string[] }

function toErrorLike(err: unknown): PeleErrorLike {
  const e = err as { message?: unknown; code?: unknown; type?: unknown; line?: unknown; column?: unknown; snippet?: unknown };
  return {
    message: err instanceof Error ? err.message : String(err),
    code: typeof e?.code === "string" ? e.code : undefined,
    type: typeof e?.type === "string" || e?.type === null ? e.type : undefined,
    line: typeof e?.line === "number" && e.line > 0 ? e.line : undefined,
    column: typeof e?.column === "number" && e.column > 0 ? e.column : undefined,
    snippet: typeof e?.snippet === "string" ? e.snippet : undefined,
  };
}

export function validateSource(source: string, config?: object): { ok: true; type: string } | { ok: false; error: PeleErrorLike } {
  if (typeof source !== "string") throw new TypeError("validateSource: source must be a string");
  try {
    const r = render(source, config ? { config: config as never } : undefined);
    return { ok: true, type: r.type };
  } catch (err) {
    return { ok: false, error: toErrorLike(err) };
  }
}

function detect(source: string): string | null {
  try { return detectType(source); } catch { return null; }
}

/** Simple unified-style line diff (pure, small inputs). */
export function diffLines(a: string, b: string): string {
  const al = a.split("\n");
  const bl = b.split("\n");
  const out: string[] = [];
  const n = al.length, m = bl.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`-${al[i]}`); i++; }
    else { out.push(`+${bl[j]}`); j++; }
  }
  while (i < n) { out.push(`-${al[i]}`); i++; }
  while (j < m) { out.push(`+${bl[j]}`); j++; }
  return out.join("\n");
}

function levenshtein(a: string, b: string, cap = 400): number {
  if (Math.abs(a.length - b.length) > cap) return cap;
  const m = b.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap;
    prev = cur;
  }
  return prev[m];
}

function editCost(a: string, b: string): number {
  const al = a.split("\n"), bl = b.split("\n");
  let changedLines = Math.abs(al.length - bl.length);
  const n = Math.min(al.length, bl.length);
  for (let i = 0; i < n; i++) if (al[i] !== bl[i]) changedLines++;
  const charCost = a.length + b.length > 6000 ? Math.abs(a.length - b.length) : levenshtein(a, b);
  return changedLines * 4 + Math.min(charCost, 200);
}

/* ------------------------------- rules ------------------------------- */

interface Ctx { type: string | null; errorLine?: number }
interface RuleLoss { lossy: boolean; dropped?: string[]; weight?: number }
interface Rule { id: string; label: string; weight: number; apply(src: string, ctx: Ctx): string[]; lossFor?: (src: string, out: string, ctx: Ctx) => RuleLoss | undefined }

/** Lines present in `src` but removed in `out`, described with 1-based line numbers. */
function droppedLines(src: string, out: string, verb: string): string[] {
  const remaining = new Map<string, number>();
  for (const l of out.split("\n")) remaining.set(l, (remaining.get(l) ?? 0) + 1);
  const dropped: string[] = [];
  src.split("\n").forEach((l, i) => {
    const n = remaining.get(l) ?? 0;
    if (n > 0) { remaining.set(l, n - 1); return; }
    if (l.trim().length > 0) dropped.push(`line ${i + 1}: \`${l.trim()}\` (${verb})`);
  });
  return dropped;
}

function mapLines(src: string, fn: (line: string, idx: number) => string): string {
  return src.split("\n").map(fn).join("\n");
}
function variant(src: string, next: string): string[] { return next !== src ? [next] : []; }

const DIRECTIONS: Record<string, string> = { TOP: "TD", UP: "TD", T: "TD", DOWN: "BT", BOTTOM: "BT", LEFT: "RL", RIGHT: "LR", LR: "LR", TD: "TD", TB: "TB", BT: "BT", RL: "RL" };

const HEADER_KEYWORDS: [string, string[]][] = [
  ["flowchart", ["flowchart", "graph"]],
  ["sequenceDiagram", ["sequenceDiagram"]],
  ["classDiagram", ["classDiagram"]],
  ["stateDiagram-v2", ["stateDiagram-v2", "stateDiagram"]],
  ["erDiagram", ["erDiagram"]],
  ["pie", ["pie"]],
  ["gantt", ["gantt"]],
  ["gitGraph", ["gitGraph"]],
  ["mindmap", ["mindmap"]],
  ["timeline", ["timeline"]],
  ["journey", ["journey", "userJourney"]],
  ["xychart-beta", ["xychart-beta", "xychart"]],
  ["quadrantChart", ["quadrantChart"]],
  ["requirementDiagram", ["requirementDiagram"]],
  ["sankey-beta", ["sankey-beta", "sankey"]],
  ["block-beta", ["block-beta", "block"]],
  ["packet-beta", ["packet-beta", "packet"]],
  ["kanban", ["kanban"]],
  ["architecture-beta", ["architecture-beta"]],
  ["radar-beta", ["radar-beta"]],
  ["treemap-beta", ["treemap-beta"]],
  ["info", ["info"]],
  ["agentflow-beta", ["agentflow-beta"]],
  ["usecase-beta", ["usecase-beta"]],
  ["treeView-beta", ["treeView-beta"]],
  ["venn-beta", ["venn-beta"]],
  ["cynefin-beta", ["cynefin-beta"]],
  ["wardley-beta", ["wardley-beta"]],
  ["swimlane-beta", ["swimlane-beta"]],
  ["ishikawa-beta", ["ishikawa-beta"]],
  ["eventmodeling", ["eventmodeling"]],
  ["C4Context", ["C4Context", "C4Container", "C4Component", "C4Dynamic", "C4Deployment"]],
  ["railroad-ebnf-beta", ["railroad-ebnf-beta", "railroad-beta"]],
];

function lev(a: string, b: string): number { return levenshtein(a.toLowerCase(), b.toLowerCase(), 100); }

const RULES: Rule[] = [
  {
    id: "unicode", label: "normalize unicode punctuation", weight: 1,
    apply(src) {
      let s = src.replace(/^\uFEFF/, "");
      s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
      s = s.replace(/\u00A0/g, " ");
      s = s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
      s = s.replace(/\u2192|\u2794|\u27F6/g, "-->").replace(/\u21D2/g, "==>");
      s = s.replace(/[\u2013\u2014](?=>)/g, "-").replace(/([\w\]])\s*[\u2013\u2014]{1,2}\s*(?=[\w[])/g, "$1 --> ");
      s = s.replace(/\t/g, "    ");
      return variant(src, s);
    },
  },
  {
    id: "fences", label: "remove stray fences / leading mermaid word", weight: 1,
    apply(src) {
      const lines = src.split("\n").filter((l) => !/^\s*```/.test(l));
      let s = lines.join("\n");
      s = s.replace(/^\s*mermaid\s*\n/, "");
      return variant(src, s);
    },
  },
  {
    id: "trailing-noise", label: "remove trailing ;/, noise", weight: 1,
    apply(src) { return variant(src, mapLines(src, (l) => l.replace(/[;,]\s*$/, ""))); },
  },
  {
    id: "header", label: "fix diagram header keyword/direction", weight: 5,
    apply(src) {
      const lines = src.split("\n");
      const idx = lines.findIndex((l) => l.trim().length > 0 && !l.trim().startsWith("%%") && !l.trim().startsWith("---"));
      if (idx === -1) return [];
      const line = lines[idx];
      const m = /^(\s*)(\S+)(.*)$/.exec(line);
      if (!m) return [];
      const [, indent, tok, rest] = m as unknown as [string, string, string, string];
      const out: string[] = [];
      // exact canonical?
      const allKw = HEADER_KEYWORDS.flatMap(([canon, kws]) => kws.map((k) => ({ canon, k })));
      const exact = allKw.find((e) => e.k === tok);
      if (!exact) {
        let best: { canon: string; d: number } | null = null;
        for (const e of allKw) {
          const d = e.k.toLowerCase() === tok.toLowerCase() ? 0 : lev(tok, e.k);
          if (best === null || d < best.d) best = { canon: e.canon === "flowchart" && e.k === "graph" ? "graph" : e.canon, d };
        }
        if (best && best.d <= 3) {
          const copy = [...lines];
          // 'graph' stays graph (direction rule below may add TD)
          const canonTok = HEADER_KEYWORDS.find(([c]) => c === best.canon);
          const repl = best.canon === "flowchart" && tok.toLowerCase().startsWith("graph") ? "graph" : (canonTok ? best.canon : best.canon);
          copy[idx] = `${indent}${repl}${rest}`;
          out.push(copy.join("\n"));
        }
      }
      // flowchart/graph direction fixes (on original + header-fixed variants)
      const bases = [src, ...out];
      const dirOut: string[] = [];
      for (const base of bases) {
        const bl = base.split("\n");
        const bi = bl.findIndex((l) => /^\s*(flowchart|graph)\b/.test(l));
        if (bi === -1) continue;
        const hm = /^(\s*(?:flowchart|graph))(\s+)(\S+)(.*)$/.exec(bl[bi]);
        if (!hm) {
          // 'graph' alone -> 'graph TD'; 'flowchart' alone is left (valid default in some renderers; Pele needs direction? keep)
          if (/^\s*graph\s*$/.test(bl[bi])) { const c = [...bl]; c[bi] = `${bl[bi]} TD`; dirOut.push(c.join("\n")); }
          continue;
        }
        const dir = hm[3];
        if (!["TD", "TB", "BT", "RL", "LR"].includes(dir)) {
          const mapped = DIRECTIONS[dir.toUpperCase()];
          if (mapped) { const c = [...bl]; c[bi] = `${hm[1]} ${mapped}${hm[4]}`; dirOut.push(c.join("\n")); }
        }
      }
      return [...out, ...dirOut].filter((s) => s !== src);
    },
  },
  {
    id: "flow-arrows", label: "fix flowchart arrow typos", weight: 5,
    apply(src, ctx) {
      if (ctx.type && !["flowchart", "state", "class", "er"].includes(ctx.type)) return [];
      let s = src;
      s = s.replace(/--\s+>/g, "-->");
      s = s.replace(/(?<![-\d])---->(?![-])/g, "-->");
      s = s.replace(/(?<![<=-])=>(?![=>])/g, "==>");
      s = s.replace(/(?<!-)\.->/g, "-.->");
      s = s.replace(/(^|[\s\w\])}])(->)(?=[\s\w[{(])/gm, "$1-->");
      return variant(src, s);
    },
  },
  {
    id: "seq-arrows", label: "fix sequence arrow typos / missing colon", weight: 5,
    apply(src, ctx) {
      if (ctx.type && ctx.type !== "sequence") return [];
      let s = src;
      s = s.replace(/->>>/g, "->>").replace(/-->>>/g, "-->>").replace(/=>>/g, "->>").replace(/(?<![<=-])=>(?![=>])/g, "->>");
      s = mapLines(s, (l) => {
        const m = /^(\s*[\w]+(?:->>|-->>|->|-->)[\w]+)(\s+)(?!:)((?:(?!:).)+)$/.exec(l);
        if (m && !l.includes(":")) return `${m[1]}: ${m[3].trim()}`;
        return l;
      });
      return variant(src, s);
    },
  },
  {
    id: "quote-labels", label: "quote labels containing special characters", weight: 6,
    apply(src, ctx) {
      const esc = (t: string) => t.replace(/"/g, "#quot;");
      const quoteLine = (l: string): string => {
        let s = l;
        s = s.replace(/(\b[\w-]+)\[([^\]"]*[(){}|][^\]"]*)\]/g, (_a, id: string, t: string) => `${id}["${esc(t)}"]`);
        s = s.replace(/(\b[\w-]+)\[\[([^\]"]*[(){}|][^\]"]*)\]\]/g, (_a, id: string, t: string) => `${id}[["${esc(t)}"]]`);
        s = s.replace(/(\b[\w-]+)\{([^}"]*[()[\]][^}"]*)\}/g, (_a, id: string, t: string) => `${id}{"${esc(t)}"}`);
        s = s.replace(/(-->|---|-\.->|==>)\|([^|"]*[(){}[\]][^|"]*)\|/g, (_a, ar: string, t: string) => `${ar}|"${esc(t)}"|`);
        s = s.replace(/(\b[\w-]+)\[([^\]"]*"[^\]"]*)\]/g, (_a, id: string, t: string) => `${id}["${esc(t)}"]`);
        return s;
      };
      const all = mapLines(src, quoteLine);
      const out = variant(src, all);
      if (ctx.errorLine) {
        const lines = src.split("\n");
        const li = ctx.errorLine - 1;
        if (lines[li] !== undefined) {
          const copy = [...lines];
          copy[li] = quoteLine(copy[li]);
          const one = copy.join("\n");
          if (one !== src && one !== all) out.push(one);
        }
      }
      return out;
    },
  },
  {
    id: "reserved-ids", label: "rename reserved node ids (end/graph/subgraph)", weight: 6,
    apply(src, ctx) {
      if (ctx.type && ctx.type !== "flowchart") return [];
      const s = mapLines(src, (l) => {
        if (l.trim() === "end") return l;
        return l
          .replace(/\bend(?=\s*(?:\[|\{|\(|-->|---|-\.->|==>))/g, "end_")
          .replace(/(-->|---|-\.->|==>)(\s*)end\b(?=\s*$|\s*(?:\[|\{|\(|\||-->|---|-\.->|==>))/g, "$1$2end_")
          .replace(/\bgraph(?=\[)/g, "graph_")
          .replace(/\bsubgraph(?=\[)/g, "subgraph_");
      });
      return variant(src, s);
    },
  },
  {
    id: "close-brackets", label: "close unbalanced brackets/quotes", weight: 8,
    apply(src, ctx) {
      const closeLine = (l: string): string => {
        let s = l;
        const counts: Record<string, number> = { "[": 0, "{": 0, "(": 0 };
        const pairs: Record<string, string> = { "[": "]", "{": "}", "(": ")" };
        let inQ = false;
        for (const ch of s) {
          if (ch === '"') inQ = !inQ;
          if (inQ) continue;
          if (ch in counts) counts[ch] = counts[ch] + 1;
          if (ch === "]") counts["["] = Math.max(0, counts["["] - 1);
          if (ch === "}") counts["{"] = Math.max(0, counts["{"] - 1);
          if (ch === ")") counts["("] = Math.max(0, counts["("] - 1);
        }
        if (inQ) s += '"';
        for (const [o, c] of Object.entries(pairs)) for (let k = 0; k < counts[o]; k++) s += c;
        return s;
      };
      const out = variant(src, mapLines(src, closeLine));
      if (ctx.errorLine) {
        const lines = src.split("\n");
        const li = ctx.errorLine - 1;
        if (lines[li] !== undefined) {
          const copy = [...lines];
          copy[li] = closeLine(copy[li]);
          const one = copy.join("\n");
          if (one !== src && !out.includes(one)) out.push(one);
        }
      }
      return out;
    },
  },
  {
    id: "subgraph-end", label: "balance subgraph/end", weight: 8,
    apply(src, ctx) {
      if (ctx.type && !["flowchart", "state", "er"].includes(ctx.type)) return [];
      const lines = src.split("\n");
      const subs = lines.filter((l) => /^\s*subgraph\b/.test(l)).length;
      const ends = lines.filter((l) => /^\s*end\s*$/.test(l)).length;
      if (subs > ends) return [src.endsWith("\n") ? src + "end\n" : src + "\nend\n"];
      if (ends > subs) {
        const out: string[] = [];
        let toRemove = ends - subs;
        const copy: string[] = [];
        for (let i = lines.length - 1; i >= 0; i--) {
          if (toRemove > 0 && /^\s*end\s*$/.test(lines[i])) { toRemove--; continue; }
          copy.unshift(lines[i]);
        }
        out.push(copy.join("\n"));
        return out.filter((s) => s !== src);
      }
      return [];
    },
  },
  {
    id: "dangling-edge", label: "fix dangling edge", weight: 12,
    apply(src) {
      const out: string[] = [];
      const lines = src.split("\n");
      lines.forEach((l, i) => {
        if (/-->\s*$|---\s*$|==>\s*$|-\.->\s*$/.test(l) && l.trim().length > 0) {
          const removed = [...lines];
          removed.splice(i, 1);
          out.push(removed.join("\n"));
          const target = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(l)?.[1] ?? "A";
          const filled = [...lines];
          filled[i] = `${l.replace(/\s*$/, "")} ${target}_missing`;
          out.push(filled.join("\n"));
        }
      });
      return out.filter((s) => s !== src);
    },
    lossFor(src, out) {
      // removal variant drops a line; fill variant keeps every line (adds a node): non-lossy but pricey
      if (out.split("\n").length < src.split("\n").length) return { lossy: true, dropped: droppedLines(src, out, "removed") };
      return { lossy: false, weight: 20 };
    },
  },
  {
    id: "pie", label: "fix pie entries (quotes/colon)", weight: 5,
    apply(src, ctx) {
      if (ctx.type && ctx.type !== "pie") return [];
      const s = mapLines(src, (l) => {
        const m = /^(\s*)"?([^":]+?)"?\s*:?\s*(\d+(?:\.\d+)?)\s*$/.exec(l);
        if (m && !/^\s*pie\b/.test(l)) return `${m[1]}"${m[2].trim()}" : ${m[3]}`;
        return l;
      });
      return variant(src, s);
    },
  },
  {
    id: "gantt", label: "fix gantt dateFormat / task colon", weight: 5,
    apply(src, ctx) {
      if (ctx.type && ctx.type !== "gantt") return [];
      let s = src;
      if (!/dateFormat/.test(s)) {
        const lines = s.split("\n");
        const hi = lines.findIndex((l) => /^\s*gantt\b/.test(l));
        if (hi !== -1) { lines.splice(hi + 1, 0, "    dateFormat YYYY-MM-DD"); s = lines.join("\n"); }
      }
      s = mapLines(s, (l) => {
        const named = /^(\s*\S[^:]*?)\s+([a-zA-Z]\w*,\s*\d{4}-\d{2}-\d{2}.*)$/.exec(l);
        if (named && !/dateFormat|title|section/.test(l)) return `${named[1]} :${named[2]}`;
        const m = /^(\s*\S[^:]*?)\s+(\d{4}-\d{2}-\d{2}.*)$/.exec(l);
        if (m && !/dateFormat|title|section/.test(l)) return `${m[1]} :${m[2]}`;
        return l;
      });
      return variant(src, s);
    },
  },
  {
    id: "mindmap-indent", label: "normalize mindmap indentation", weight: 4,
    apply(src, ctx) {
      if (ctx.type && ctx.type !== "mindmap") return [];
      const s = mapLines(src, (l) => l.replace(/^\t+/, (t) => "  ".repeat(t.length)).replace(/^ +\t/, "  "));
      return variant(src, s);
    },
  },
  {
    id: "init-json", label: "fix %%{init}%% JSON quoting", weight: 6,
    apply(src) {
      const s = src.replace(/%%\{init:\s*([\s\S]*?)\}%%/g, (_a, body: string) => {
        let b = body.replace(/'/g, '"').replace(/,\s*([}\]])/g, "$1");
        return `%%{init: ${b}}%%`;
      });
      return variant(src, s);
    },
  },
  {
    id: "style-sep", label: "fix classDef/style separators (; to ,)", weight: 4,
    apply(src) {
      const s = mapLines(src, (l) => /^\s*(classDef|style|linkStyle)\b/.test(l) ? l.replace(/;/g, ",") : l);
      return variant(src, s);
    },
  },
  {
    id: "rel-colon", label: "add missing colon in relationship/message line", weight: 5,
    apply(src, ctx) {
      if (ctx.type && !["er", "class"].includes(ctx.type)) return [];
      const s = mapLines(src, (l) => {
        if (l.includes(":")) return l;
        const m = /^(\s*\S+\s+\S+\s+\S+)\s+([A-Za-z][\w ]*)$/.exec(l);
        return m ? `${m[1]} : ${m[2].trim()}` : l;
      });
      return variant(src, s);
    },
  },
  {
    id: "statement-typo", label: "fix statement keyword typo", weight: 5,
    apply(src, ctx) {
      const KW: Record<string, string[]> = {
        gitGraph: ["commit", "branch", "checkout", "merge", "cherry-pick", "reset"],
        sequence: ["participant", "actor", "activate", "deactivate", "Note", "loop", "alt", "opt", "par", "autonumber"],
        flowchart: ["subgraph", "direction", "classDef", "style", "click", "linkStyle"],
        class: ["class", "namespace", "direction"],
        gantt: ["title", "section", "dateFormat", "axisFormat", "todayMarker", "excludes", "includes"],
        state: ["state", "direction", "note"],
      };
      const kws = ctx.type ? KW[ctx.type] : undefined;
      if (!kws) return [];
      const s = mapLines(src, (l) => {
        const m = /^(\s*)(\S+)(.*)$/.exec(l);
        if (!m) return l;
        const tok = m[2];
        if (kws.includes(tok)) return l;
        let best: string | null = null;
        let bd = 99;
        for (const k of kws) { const d = lev(tok, k); if (d < bd) { bd = d; best = k; } }
        return best && bd > 0 && bd <= 2 ? `${m[1]}${best}${m[3]}` : l;
      });
      return variant(src, s);
    },
  },
  {
    id: "comment-out", label: "comment out the broken line (last resort)", weight: 100,
    apply(src, ctx) {
      if (!ctx.errorLine) return [];
      const lines = src.split("\n");
      const li = ctx.errorLine - 1;
      if (lines[li] === undefined || lines[li].trim().startsWith("%%")) return [];
      const copy = [...lines];
      copy[li] = `%% ${copy[li]}`;
      return [copy.join("\n")];
    },
    lossFor(src, _out, ctx) {
      if (!ctx.errorLine) return { lossy: true };
      const text = src.split("\n")[ctx.errorLine - 1]?.trim() ?? "";
      return { lossy: true, dropped: [`line ${ctx.errorLine}: \`${text}\` (commented out)`] };
    },
  },
];

export const REPAIR_RULES: { id: string; label: string; weight: number }[] = RULES.map((r) => ({ id: r.id, label: r.label, weight: r.weight }));

const MAX_VALIDATIONS = 200;

export function lintCandidates(source: string, error?: PeleErrorLike): RepairCandidate[] {
  if (typeof source !== "string") throw new TypeError("lintCandidates: source must be a string");
  let err = error;
  if (!err) {
    const v = validateSource(source);
    if (v.ok) return [];
    err = v.error;
  }
  const ctx: Ctx = { type: err.type ?? detect(source), errorLine: err.line };
  let budget = MAX_VALIDATIONS;
  const validBySource = new Map<string, RepairCandidate>();
  const seen = new Set<string>();

  interface Scored { lossy: boolean; dropped?: string[]; weight: number }
  const score = (rule: Rule, from: string, out: string, c: Ctx): Scored => {
    const loss = rule.lossFor?.(from, out, c);
    return { lossy: loss?.lossy ?? false, dropped: loss?.dropped, weight: loss?.weight ?? rule.weight };
  };

  const consider = (src: string, fixes: string[], weight: number, order: number, lossy: boolean, dropped?: string[]): void => {
    if (src === source || seen.has(src) || budget <= 0) return;
    seen.add(src);
    budget--;
    const v = validateSource(src);
    if (!v.ok) return;
    const cand: RepairCandidate = { source: src, tier: "linter", fixes, cost: weight + editCost(source, src), type: v.type, lossy, ...(dropped && dropped.length ? { dropped } : {}) };
    (cand as RepairCandidate & { _order?: number })._order = order;
    validBySource.set(src, cand);
  };

  // depth 1 (error-line/whole-source variants are inside each rule)
  const depth1: { src: string; fixes: string[]; weight: number; order: number; lossy: boolean; dropped?: string[] }[] = [];
  RULES.forEach((rule, ri) => {
    let outs: string[] = [];
    try { outs = rule.apply(source, ctx); } catch { outs = []; }
    for (const o of outs) {
      const sc = score(rule, source, o, ctx);
      depth1.push({ src: o, fixes: [rule.label], weight: sc.weight, order: ri, lossy: sc.lossy, dropped: sc.dropped });
      consider(o, [rule.label], sc.weight, ri, sc.lossy, sc.dropped);
    }
  });
  // depth 2: apply a second rule to each depth-1 result
  outer: for (const d1 of depth1) {
    const ctx2: Ctx = { type: ctx.type, errorLine: ctx.errorLine };
    for (let rj = 0; rj < RULES.length; rj++) {
      if (budget <= 0) break outer;
      const rule = RULES[rj];
      let outs: string[] = [];
      try { outs = rule.apply(d1.src, ctx2); } catch { continue; }
      for (const o of outs) {
        const sc = score(rule, d1.src, o, ctx2);
        const dupRule = d1.fixes.includes(rule.label);
        const dropped = [...(d1.dropped ?? []), ...(sc.dropped ?? [])];
        consider(o, dupRule ? d1.fixes : [...d1.fixes, rule.label], d1.weight + sc.weight, d1.order, d1.lossy || sc.lossy, dropped.length ? dropped : undefined);
      }
    }
  }

  const list = [...validBySource.values()];
  list.sort((a, b) => {
    if (a.cost !== b.cost) return a.cost - b.cost;
    const oa = (a as RepairCandidate & { _order?: number })._order ?? 0;
    const ob = (b as RepairCandidate & { _order?: number })._order ?? 0;
    if (oa !== ob) return oa - ob;
    return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
  });
  for (const c of list) delete (c as RepairCandidate & { _order?: number })._order;
  return list;
}

function aborted(signal?: AbortSignal): boolean { return Boolean(signal?.aborted); }

export async function repairDiagram(source: string, opts: RepairOptions = {}): Promise<RepairResult> {
  if (typeof source !== "string") throw new TypeError("repairDiagram: source must be a string");
  const tiersIn = opts.tiers ?? ["linter"];
  for (const t of tiersIn) if (!["linter", "jev", "llm"].includes(t)) throw new TypeError(`repairDiagram: unknown tier "${t}"`);
  const tiers: RepairTier[] = ["linter", "jev", "llm"].filter((t) => tiersIn.includes(t as RepairTier)) as RepairTier[];
  const jevMin = opts.jevMinConfidence ?? 0.2;
  const maxAttempts = opts.llmMaxAttempts ?? 2;
  const maxCand = opts.maxCandidates ?? 12;
  const attempts: RepairAttempt[] = [];

  if (aborted(opts.signal)) return { ok: false, fixes: [], attempts, error: { message: "aborted" } };
  const first = validateSource(source, opts.config);
  if (first.ok) return { ok: true, source, tier: undefined, fixes: [], attempts: [], unchanged: true, lossy: false };
  let lastError: PeleErrorLike = first.error;

  const candidates = lintCandidates(source, lastError);
  const nonLossy = candidates.filter((c) => !c.lossy);
  let jevPool: RepairCandidate[] = [];
  let jevLossyPick: RepairCandidate | undefined;

  const accept = (cand: RepairCandidate, tier: RepairTier): RepairResult => ({
    ok: true, source: preserveDirectives(source, cand.source), tier, fixes: cand.fixes, attempts,
    lossy: cand.lossy, ...(cand.dropped && cand.dropped.length ? { dropped: cand.dropped } : {}),
  });

  if (tiers.includes("linter")) {
    if (candidates.length === 0) {
      attempts.push({ tier: "linter", ok: false, detail: "no valid linter candidates", candidates: 0, error: lastError });
    } else {
      const first = nonLossy[0];
      const uniqueNonLossy = first !== undefined && (nonLossy.length === 1 || nonLossy[1].cost > first.cost);
      if (uniqueNonLossy) {
        attempts.push({ tier: "linter", ok: true, detail: `accepted unique cheapest non-lossy candidate at cost ${first.cost} (of ${candidates.length})`, candidates: candidates.length });
        return accept(first, "linter");
      }
      if (!tiers.includes("jev") && !tiers.includes("llm")) {
        // linter-only: prefer a tied non-lossy candidate, else the cheapest lossy (flagged)
        const pick = first ?? candidates[0];
        attempts.push({ tier: "linter", ok: true, detail: pick.lossy ? `linter-only fallback: accepted cheapest lossy candidate at cost ${pick.cost}` : `linter-only: accepted tied non-lossy candidate at cost ${pick.cost}`, candidates: candidates.length });
        return accept(pick, "linter");
      }
      jevPool = candidates.slice(0, maxCand);
      attempts.push({ tier: "linter", ok: false, detail: nonLossy.length === 0 ? `only lossy candidate(s) available (${candidates.length}); escalating` : `non-lossy candidates tie at cost ${first?.cost}; escalating`, candidates: candidates.length });
    }
  } else if (tiers.includes("jev")) {
    jevPool = candidates.slice(0, maxCand);
  }

  if (tiers.includes("jev")) {
    if (aborted(opts.signal)) return { ok: false, fixes: [], attempts, error: { message: "aborted" } };
    if (!opts.jev) {
      attempts.push({ tier: "jev", ok: false, detail: "jev tier enabled but no provider configured", candidates: jevPool.length });
    } else if (jevPool.length === 0) {
      attempts.push({ tier: "jev", ok: false, detail: "no candidates to rank", candidates: 0 });
    } else {
      const describe = (c: RepairCandidate) => `${c.fixes.join("; ")} (cost ${c.cost})${c.lossy ? ` [lossy: ${c.dropped?.join("; ") ?? "removes content"}]` : ""}`;
      const options: Record<string, string> = {};
      jevPool.forEach((c, i) => { options[`c${i + 1}`] = `${describe(c)}\n${diffLines(source, c.source)}`; });
      options["none"] = "none preserves the author's intent";
      const state = `Broken Mermaid diagram:\n${source}\n\nPele error (${lastError.code ?? "error"} at line ${lastError.line ?? "?"}:${lastError.column ?? "?"}): ${lastError.message}\n\nCandidates:\n${jevPool.map((c, i) => `--- c${i + 1}: ${describe(c)}\n${diffLines(source, c.source)}`).join("\n")}`;
      const question = "Which single repair best preserves the author's intent while making the diagram valid? Prefer non-lossy repairs; choose a lossy one only if no non-lossy repair preserves intent. Choose none if no candidate preserves intent.";
      try {
        const choice = await opts.jev.choose(state, question, options);
        const detail = `choice=${choice.choice} confidence=${choice.confidence} probabilities=${JSON.stringify(choice.probabilities)}`;
        const winner = choice.choice !== "none" ? jevPool[Number(choice.choice.slice(1)) - 1] : undefined;
        if (winner && choice.confidence >= jevMin && !winner.lossy) {
          attempts.push({ tier: "jev", ok: true, detail, candidates: jevPool.length });
          return accept(winner, "jev");
        }
        if (winner && choice.confidence >= jevMin && winner.lossy) {
          if (!tiers.includes("llm")) {
            attempts.push({ tier: "jev", ok: true, detail: `${detail}; accepted jev's lossy pick (no llm tier)`, candidates: jevPool.length });
            return accept(winner, "jev");
          }
          jevLossyPick = winner;
          attempts.push({ tier: "jev", ok: false, detail: `${detail}; jev picked a lossy candidate — trying llm first`, candidates: jevPool.length });
        } else {
          attempts.push({ tier: "jev", ok: false, detail: `${detail}; abstained/escalating (min confidence ${jevMin})`, candidates: jevPool.length });
        }
      } catch (err) {
        if (aborted(opts.signal)) return { ok: false, fixes: [], attempts, error: { message: "aborted" } };
        attempts.push({ tier: "jev", ok: false, detail: `jev provider failed: ${(err as Error).message}`, candidates: jevPool.length, error: toErrorLike(err) });
      }
    }
  }

  if (tiers.includes("llm")) {
    if (!opts.llm) {
      attempts.push({ tier: "llm", ok: false, detail: "llm tier enabled but no provider configured" });
    } else {
      const system = "You repair Mermaid 12.1.0 diagram source for the Pele renderer. Make minimal edits, preserve ids, labels, structure and intent. Output ONLY the diagram source, no explanation, no fences.";
      let currentError = lastError;
      let tried = attempts.filter((a) => a.tier === "linter").map((a) => a.detail).join("; ") || "none";
      for (let n = 1; n <= maxAttempts; n++) {
        if (aborted(opts.signal)) return { ok: false, fixes: [], attempts, error: { message: "aborted" } };
        const numbered = source.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
        const user = `Repair this diagram.\n\nSource (with line numbers):\n${numbered}\n\nPele error: code=${currentError.code ?? "unknown"} line=${currentError.line ?? "?"} col=${currentError.column ?? "?"} snippet=${currentError.snippet ?? ""}\n${currentError.message}\n\nLinter tried: ${tried}\nLinter candidates: ${candidates.length}. Output ONLY the repaired diagram source.`;
        try {
          const reply = await opts.llm.complete(system, user, opts.signal);
          const extracted = extractDiagramFromLlm(reply);
          const v = validateSource(extracted, opts.config);
          if (v.ok) {
            attempts.push({ tier: "llm", ok: true, detail: `attempt ${n}: valid ${v.type} diagram` });
            return { ok: true, source: preserveDirectives(source, extracted), tier: "llm", fixes: [`llm repair (attempt ${n})`], attempts, lossy: false };
          }
          lastError = v.error;
          currentError = v.error;
          tried = `llm attempt ${n} still invalid: ${v.error.message.split("\n")[0]}`;
          attempts.push({ tier: "llm", ok: false, detail: `attempt ${n}: still invalid: ${v.error.message.split("\n")[0]}`, error: v.error });
        } catch (err) {
          if (aborted(opts.signal)) return { ok: false, fixes: [], attempts, error: { message: "aborted" } };
          attempts.push({ tier: "llm", ok: false, detail: `attempt ${n}: provider failed: ${(err as Error).message}`, error: toErrorLike(err) });
          break;
        }
      }
    }
  }

  // Final fallback: Jev's lossy pick, else a tied non-lossy candidate, else cheapest lossy.
  const fallback = jevLossyPick ?? (tiers.includes("linter") ? (nonLossy[0] ?? candidates[0]) : undefined);
  if (fallback) {
    attempts.push({ tier: jevLossyPick ? "jev" : "linter", ok: true, detail: `final fallback: accepted ${fallback.lossy ? "lossy" : "non-lossy"} candidate at cost ${fallback.cost}`, candidates: candidates.length });
    return accept(fallback, jevLossyPick ? "jev" : "linter");
  }

  return { ok: false, fixes: [], attempts, error: lastError };
}

const MEHRPELE_LINE_RE = /^[ \t]*%%\s*mehrpele\s*%%[ \t]*$/m;

/**
 * Keep the plugin's comment directives through a repair that rewrote the
 * source (an LLM reply drops comments freely): `%% mehrpele %%` is restored
 * at the top, `%% pele-size … %%` and `%% pele-view … %%` at the end,
 * filtered to nodes that still exist. A repair that kept them is returned
 * unchanged.
 */
export function preserveDirectives(before: string, after: string): string {
  let out = after;
  if (MEHRPELE_LINE_RE.test(before) && !MEHRPELE_LINE_RE.test(out)) {
    const line = MEHRPELE_LINE_RE.exec(before)![0].trim();
    out = `${line}\n${out}`;
  }
  if (hasSizeDirective(before) && !hasSizeDirective(out)) {
    const caps = nodeSizeCaps(out);
    const kept = new Map([...parseSizeDirective(before)].filter(([id]) => !caps || caps.has(id)));
    if (kept.size) out = withSizeDirective(out, kept);
  }
  // view-nodes: `%% pele-view … %%` (views attached to nodes), likewise.
  const views = parseViewEntries(before);
  if (views.size && parseViewEntries(out).size === 0) {
    const caps = nodeSizeCaps(out);
    const line = formatViewLine([...views].filter(([id]) => !caps || caps.has(id)).flatMap(([id, specs]) => specs.map((v): [string, string] => [id, v])));
    if (line) out = `${out.replace(/\n+$/, "")}\n${line}${/\n$/.test(out) ? "\n" : ""}`;
  }
  return out;
}

export function extractDiagramFromLlm(text: string): string {
  if (typeof text !== "string") throw new TypeError("extractDiagramFromLlm: text must be a string");
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  const fence = /```(?:mermaid)?\s*\n([\s\S]*?)```/.exec(s);
  if (fence) return fence[1].trim() + "\n";
  s = s.trim();
  // slice from first plausible diagram header line
  const headerRe = /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|pie|gantt|gitGraph|mindmap|timeline|journey|xychart|quadrantChart|requirementDiagram|C4|sankey|block|packet|kanban|architecture|radar|treemap|info|agentflow|usecase|railroad|treeView|venn|cynefin|wardley|swimlane|ishikawa|eventmodeling|%%\{|---)/;
  const lines = s.split("\n");
  const hi = lines.findIndex((l) => headerRe.test(l));
  if (hi > 0) s = lines.slice(hi).join("\n");
  return s.replace(/```\s*$/, "").trim() + "\n";
}

export function playgroundUrl(source: string): string {
  if (typeof source !== "string") throw new TypeError("playgroundUrl: source must be a string");
  if (source.length > 100_000) throw new Error("playgroundUrl: source exceeds 100000 characters");
  return `https://pele.run/playground#${new URLSearchParams({ source }).toString()}`;
}

/* ----------------------------- providers ----------------------------- */

async function readJson(res: { status: number; json(): Promise<unknown>; text(): Promise<string> }): Promise<unknown> {
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export function createJevHttpProvider(o: { apiKey: string; baseUrl?: string; model?: string; fetch: FetchLike }): JevProvider {
  if (!o?.apiKey) throw new TypeError("createJevHttpProvider: apiKey is required");
  if (!o?.fetch) throw new TypeError("createJevHttpProvider: fetch is required");
  const base = (o.baseUrl ?? "https://api.typesafe.ai").replace(/\/$/, "");
  const model = o.model ?? "jev-latest";
  return {
    async choose(state, question, options) {
      const res = await o.fetch(`${base}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify({ state, model, questions: { repair: { type: "choice", instructions: question, criteria: options } } }),
      });
      const data = (await readJson(res)) as { answers?: { repair?: { choice?: string; confidence?: number; probabilities?: Record<string, number> } } };
      const ans = data.answers?.repair;
      if (!ans || typeof ans.choice !== "string") throw new Error("jev: unexpected response shape (missing answers.repair)");
      return { choice: ans.choice, confidence: ans.confidence ?? 0, probabilities: ans.probabilities ?? {} };
    },
  };
}

export function createAnthropicProvider(o: { apiKey: string; model?: string; baseUrl?: string; fetch: FetchLike; maxTokens?: number }): LlmProvider {
  if (!o?.apiKey) throw new TypeError("createAnthropicProvider: apiKey is required");
  if (!o?.fetch) throw new TypeError("createAnthropicProvider: fetch is required");
  const base = (o.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const model = o.model ?? "claude-sonnet-5-5";
  return {
    async complete(system, user, signal) {
      const res = await o.fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": o.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: o.maxTokens ?? 4096, system, messages: [{ role: "user", content: user }] }),
        signal,
      });
      const data = (await readJson(res)) as { content?: { type?: string; text?: string }[] };
      const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      if (!text) throw new Error("anthropic: empty response");
      return text;
    },
  };
}

export function createOpenAICompatibleProvider(o: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetch: FetchLike;
  /** `reasoning_effort` for reasoning models (e.g. "none" makes Ollama qwen3.5 answer in ~1s instead of ~2min); omit/"default" to leave unset. */
  reasoningEffort?: string;
  /** Abort a single request after this many ms (default: no limit). */
  timeoutMs?: number;
}): LlmProvider {
  if (!o?.baseUrl) throw new TypeError("createOpenAICompatibleProvider: baseUrl is required");
  if (!o?.model) throw new TypeError("createOpenAICompatibleProvider: model is required");
  if (!o?.fetch) throw new TypeError("createOpenAICompatibleProvider: fetch is required");
  const base = o.baseUrl.replace(/\/$/, "");
  return {
    async complete(system, user, signal) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (o.apiKey) headers["authorization"] = `Bearer ${o.apiKey}`;
      const body: Record<string, unknown> = { model: o.model, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
      if (o.reasoningEffort && o.reasoningEffort !== "default") body.reasoning_effort = o.reasoningEffort;
      const { signal: merged, dispose } = withTimeout(signal, o.timeoutMs);
      try {
        const res = await o.fetch(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: merged });
        const data = (await readJson(res)) as { choices?: { message?: { content?: string } }[] };
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error("openai-compatible: empty response");
        return text;
      } catch (e) {
        if (merged?.aborted && !signal?.aborted) throw new Error(`openai-compatible: no response within ${Math.round((o.timeoutMs ?? 0) / 1000)}s`);
        throw e;
      } finally {
        dispose();
      }
    },
  };
}

/** Combine an optional caller signal with an optional timeout. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal | undefined; dispose: () => void } {
  if (!timeoutMs || timeoutMs <= 0) return { signal, dispose: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}


