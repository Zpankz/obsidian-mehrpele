/** Canvas file naming, reuse and merge for converted diagrams (DOM/vault-free). */

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
