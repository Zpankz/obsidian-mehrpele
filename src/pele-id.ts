/** Node-id claiming shared by the generated-source paths (Bases views, graph integrations). */

/** Keywords a generated node id must not be (a bare `end` closes a subgraph, and so on). */
const RESERVED_IDS = new Set(["end", "graph", "subgraph", "flowchart", "click", "class", "classdef", "style", "linkstyle"]);

/** Claim `id` in `taken`: a reserved keyword gets a trailing "_", a taken id the first free `_2`, `_3`, …. */
export function claimId(id: string, taken: Set<string>): string {
  if (RESERVED_IDS.has(id.toLowerCase())) id = `${id}_`;
  if (!taken.has(id)) {
    taken.add(id);
    return id;
  }
  let n = 2;
  while (taken.has(`${id}_${n}`)) n++;
  const unique = `${id}_${n}`;
  taken.add(unique);
  return unique;
}
