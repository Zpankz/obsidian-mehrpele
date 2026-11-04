/**
 * Rapid concept mapping (pure): add a parent, child or sibling to a node,
 * a child shared by several nodes, or wrap nodes in a new subgraph. Each is
 * one source rewrite; new nodes get fresh ids (`N1`, `N2`, …) and new
 * subgraphs `G1`, `G2`, ….
 */
import { scanFlowchart, type FlowScan, type VertexStatement } from "./flow-scan";
import { shiftLinkStylesForInsert } from "./style-lines";

export type FlowDir = "TB" | "BT" | "LR" | "RL";
export type Side = "top" | "bottom" | "left" | "right";
export type Relation = "child" | "parent" | "sibling-before" | "sibling-after";

/** What a "+" on `side` means for a diagram laid out in `dir`. */
export function relationFor(dir: FlowDir, side: Side): Relation {
  const table: Record<FlowDir, Record<Side, Relation>> = {
    TB: { bottom: "child", top: "parent", left: "sibling-before", right: "sibling-after" },
    BT: { top: "child", bottom: "parent", left: "sibling-before", right: "sibling-after" },
    LR: { right: "child", left: "parent", top: "sibling-before", bottom: "sibling-after" },
    RL: { left: "child", right: "parent", top: "sibling-before", bottom: "sibling-after" },
  };
  return table[dir][side];
}

/** The written direction of a flowchart header (`TD` = `TB`). */
export function headerDirection(src: string): FlowDir {
  const m = /^\s*(?:flowchart|graph)(?:-elk)?\s+(TB|TD|BT|LR|RL)\b/m.exec(src);
  const d = (m?.[1] ?? "TB");
  return d === "TD" ? "TB" : (d as FlowDir);
}

/** A direction a reflow plan reports ("TB", "LR", "authored", …) on top of the written one. */
export function effectiveDirection(src: string, planDirection: string | null | undefined): FlowDir {
  const p = (planDirection ?? "").replace("*", "");
  if (p === "TB" || p === "BT" || p === "LR" || p === "RL") return p;
  if (p === "TD") return "TB";
  return headerDirection(src);
}

/** The first `${prefix}N` not used as a word anywhere in the block. */
export function freshId(src: string, prefix = "N"): string {
  // Dashed ids (`my-node`) and ids glued to an arrow (`N1-->B`) both count.
  const taken = new Set([...(src.match(/[\p{L}\p{N}_-]+/gu) ?? []), ...(src.match(/[\p{L}\p{N}_]+/gu) ?? [])]);
  for (let i = 1; ; i++) if (!taken.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

function lineAt(src: string, pos: number): { start: number; end: number; indent: string } {
  const start = src.lastIndexOf("\n", pos - 1) + 1;
  const nl = src.indexOf("\n", pos);
  const end = nl < 0 ? src.length : nl;
  return { start, end, indent: /^[ \t]*/.exec(src.slice(start))![0] };
}

function mentions(st: VertexStatement, id: string): boolean {
  return st.vertices.some((g) => g.some((v) => v.id === id));
}

function insertAfter(src: string, pos: number, lines: string[]): string {
  const l = lineAt(src, pos);
  return src.slice(0, l.end) + lines.map((x) => `\n${l.indent}${x}`).join("") + src.slice(l.end);
}

function insertBefore(src: string, pos: number, lines: string[]): string {
  const l = lineAt(src, pos);
  return src.slice(0, l.start) + lines.map((x) => `${l.indent}${x}\n`).join("") + src.slice(l.start);
}

export interface Added {
  source: string;
  /** The new node's id. */
  id: string;
}

/**
 * New edges touching `nid` were inserted into `before` giving `after`: shift
 * linkStyle indices past each one (ascending), so every existing edge keeps
 * its style wherever the new lines landed.
 */
export function keepLinkStyles(after: string, nid: string): string {
  if (!/(^|\n)\s*linkStyle\s/.test(after)) return after;
  const added = scanFlowchart(after)
    .edges.filter((e) => e.start === nid || e.end === nid)
    .map((e) => e.index)
    .sort((a, b) => a - b);
  let out = after;
  for (const i of added) out = shiftLinkStylesForInsert(out, i);
  return out;
}

/**
 * Add a node related to `id`. Child: `id --> N`; parent: `N --> id`;
 * sibling: `N` gets the same parents as `id` (a node without parents gets a
 * standalone sibling). Lines go beside `id`'s own statements (before them
 * for a sibling on the leading side), so a node inside a subgraph gets its
 * relative in the same subgraph.
 */
export function addRelated(src: string, scan: FlowScan, id: string, relation: Relation, label = "New"): Added | null {
  const own = scan.statements.filter((st) => mentions(st, id));
  if (!own.length) return null;
  const nid = freshId(src);
  const decl = `${nid}[${label}]`;
  const done = (source: string): Added => ({ source: keepLinkStyles(source, nid), id: nid });
  if (relation === "child") return done(insertAfter(src, own[own.length - 1].span.end, [`${id} --> ${decl}`]));
  if (relation === "parent") return done(insertAfter(src, own[own.length - 1].span.end, [`${decl} --> ${id}`]));
  const parents = [...new Set(scan.edges.filter((e) => e.end === id && e.start !== id).map((e) => e.start))];
  const lines = parents.length ? parents.map((p, i) => `${p} --> ${i === 0 ? decl : nid}`) : [decl];
  const anchor = scan.statements.filter((st) => st.links.length && scan.edges.some((e) => e.end === id && e.stmt.start === st.span.start));
  if (relation === "sibling-before") return done(insertBefore(src, (anchor[0] ?? own[0]).span.start, lines));
  const last = anchor.length ? anchor[anchor.length - 1] : own[own.length - 1];
  return done(insertAfter(src, last.span.end, lines));
}

/**
 * One new node with an edge from each of `ids` (`A & B --> N1[New]`), written
 * at `at` (a line start) with `indent` — the nodes' common scope, so no node
 * is pulled into a subgraph it is not in.
 */
export function sharedChildAt(
  src: string,
  ids: string[],
  at: { pos: number; indent: string },
  label: string,
  insert: (src: string, pos: number, lines: string) => string,
): Added | null {
  if (!ids.length) return null;
  const nid = freshId(src);
  const line = `${at.indent}${ids.join(" & ")} --> ${nid}[${label}]\n`;
  return { source: keepLinkStyles(insert(src, at.pos, line), nid), id: nid };
}

/**
 * The subgraph text wrapping `ids`, placed at `at` (a line start). `indent`
 * is the enclosing block's statement indentation.
 */
export function subgraphLines(gid: string, title: string, ids: string[], indent: string): string {
  const inner = `${indent}  `;
  return [`${indent}subgraph ${gid} [${title}]`, ...ids.map((id) => `${inner}${id}`), `${indent}end`].join("\n");
}
