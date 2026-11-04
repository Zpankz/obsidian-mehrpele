/** Datacore results -> GraphSpec / GanttSpec (pure). */
import type { GanttSpec, GanttTask, GraphSpec } from "../graph-to-pele";
import type { DatacorePageLike } from "../detect";
import { basenameLabel } from "../breadcrumbs/map";

export function pagePath(page: DatacorePageLike): string {
  return page.$path ?? page.$file ?? page.$id ?? "";
}

export function pageLabel(page: DatacorePageLike): string {
  if (typeof page.$name === "string" && page.$name.trim()) return page.$name.trim();
  const path = pagePath(page);
  return path ? basenameLabel(path) : "(untitled)";
}

/** Read a field from a Datacore page: direct prop, frontmatter, or .value(). */
export function pageField(page: DatacorePageLike, ...keys: string[]): unknown {
  for (const key of keys) {
    const lower = key.toLowerCase();
    const direct = page[key] ?? page[lower];
    if (direct !== undefined && direct !== null && direct !== "") return direct;
    const fm = page.$frontmatter as Record<string, { value?: unknown }> | undefined;
    const entry = fm?.[lower] ?? fm?.[key];
    if (entry && typeof entry === "object" && "value" in entry && entry.value !== undefined && entry.value !== "") {
      return entry.value;
    }
    const valueFn = page.value as ((k: string) => unknown) | undefined;
    if (typeof valueFn === "function") {
      try {
        const v = valueFn.call(page, key);
        if (v !== undefined && v !== null && v !== "") return v;
      } catch { /* field absent */ }
    }
  }
  return undefined;
}

function asDateString(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  if (value && typeof value === "object") {
    const iso = (value as { toISODate?: () => string }).toISODate?.();
    if (typeof iso === "string" && iso) return iso.slice(0, 10);
    // Datacore dates are luxon DateTimes: their toString() is the ISO form.
    const s = (value as { toString(): string }).toString();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  }
  return undefined;
}

/**
 * Sub-page Datacore results (`@section` / `@block`) deep-link to their
 * heading/block. Shapes per datacore index/types/markdown.ts: sections carry
 * `$title`, blocks `$blockId`; both carry `$file` (and a unique `$id`).
 */
export function subTarget(page: DatacorePageLike): { key: string; heading?: string; block?: string; label?: string } | null {
  const type = typeof page.$type === "string" ? page.$type : "";
  const file = typeof page.$file === "string" ? page.$file : pagePath(page);
  if (!file) return null;
  if (type === "section" && typeof page.$title === "string" && page.$title.trim()) {
    const heading = page.$title.trim();
    return { key: typeof page.$id === "string" ? page.$id : `${file}#${heading}`, heading, label: heading };
  }
  if (type === "block" && typeof page.$blockId === "string" && page.$blockId.trim()) {
    const block = page.$blockId.trim().replace(/^\^/, "");
    return { key: typeof page.$id === "string" ? page.$id : `${file}#^${block}`, block };
  }
  return null;
}

/** Link graph between matched pages (links landing outside the set are dropped). */
export function datacoreToGraph(pages: DatacorePageLike[], title?: string): GraphSpec {
  const byPath = new Map<string, DatacorePageLike>();
  const keyOf = new Map<DatacorePageLike, string>();
  for (const page of pages) {
    const path = pagePath(page);
    if (!path) continue;
    const sub = subTarget(page);
    keyOf.set(page, sub?.key ?? path);
    if (!sub) byPath.set(path, page);
  }
  const nodes = pages
    .filter((p) => pagePath(p))
    .map((p) => {
      const sub = subTarget(p);
      const path = typeof p.$file === "string" && sub ? p.$file : pagePath(p);
      const folder = path.includes("/") ? path.split("/").slice(0, -1).join("/") : undefined;
      return {
        id: keyOf.get(p) ?? path,
        label: sub?.label ? `${pageLabel(p)} › ${sub.label}` : pageLabel(p),
        href: path,
        heading: sub?.heading,
        block: sub?.block,
        group: folder,
        classes: undefined,
      };
    });
  const seen = new Set<string>();
  const edges: GraphSpec["edges"] = [];
  for (const page of pages) {
    const from = keyOf.get(page);
    if (!from) continue;
    for (const link of page.$links ?? []) {
      const to = resolveLink(link.path, byPath);
      if (!to || to === from) continue;
      const key = `${from}\u0000${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to, kind: "link" });
    }
  }
  return { nodes, edges, direction: "LR", title, groups: undefined };
}

function resolveLink(linkPath: string, byPath: Map<string, DatacorePageLike>): string | undefined {
  if (!linkPath) return undefined;
  if (byPath.has(linkPath)) return linkPath;
  const withExt = linkPath.toLowerCase().endsWith(".md") ? linkPath : `${linkPath}.md`;
  if (byPath.has(withExt)) return withExt;
  for (const path of byPath.keys()) {
    if (path === withExt || path.endsWith(`/${withExt}`)) return path;
  }
  return undefined;
}

/** Pages carrying scheduled/due dates -> gantt tasks (Datacore @task/@page rows). */
export function datacoreToGantt(pages: DatacorePageLike[], title?: string): GanttSpec {
  const tasks: GanttTask[] = [];
  for (const page of pages) {
    const path = pagePath(page);
    if (!path) continue;
    const start = asDateString(pageField(page, "scheduled", "start", "starts"));
    const end = asDateString(pageField(page, "due", "deadline", "end", "ends"));
    if (!start && !end) continue;
    const statusField = pageField(page, "status");
    // Status may be a string, number or list; stringify it as String() does.
    const statusRaw = statusField == null ? "" : (statusField as { toString(): string }).toString().toLowerCase();
    const status: GanttTask["status"] =
      statusRaw === "done" || statusRaw === "complete" || statusRaw === "completed"
        ? "done"
        : statusRaw === "active" || statusRaw === "in-progress" || statusRaw === "doing"
          ? "active"
          : undefined;
    tasks.push({
      id: path,
      label: pageLabel(page),
      section: sectionFor(page),
      start: start ?? end,
      end: end ?? undefined,
      duration: start && !end ? "1d" : undefined,
      status,
      href: path,
    });
  }
  return { title: title ?? "Datacore tasks", tasks };
}

function sectionFor(page: DatacorePageLike): string {
  const project = pageField(page, "project", "projects");
  if (typeof project === "string" && project.trim()) return project.trim();
  if (Array.isArray(project) && typeof project[0] === "string") return project[0];
  const path = pagePath(page);
  return path.includes("/") ? path.split("/")[0] : "Tasks";
}
