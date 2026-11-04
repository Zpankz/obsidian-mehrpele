/** TaskNotes TaskInfo[] -> GanttSpec / GraphSpec / KanbanSpec (pure, read-only). */
import type { GanttSpec, GanttTask, GraphSpec, KanbanSpec } from "../graph-to-pele";
import type { StatusConfigLike, TaskInfoLike } from "../detect";

export interface TaskStatusMapping {
  done: string[];
  active: string[];
  crit: string[];
}

export const DEFAULT_STATUS_MAPPING: TaskStatusMapping = {
  done: ["done", "complete", "completed", "closed"],
  active: ["in-progress", "in progress", "active", "doing", "started"],
  crit: ["blocked", "critical", "urgent"],
};

export interface TaskFilter {
  status?: string[];
  tags: string[];
  project?: string;
}

export function filterTasks(tasks: TaskInfoLike[], filter: TaskFilter): TaskInfoLike[] {
  const statuses = new Set((filter.status ?? []).map((s) => s.toLowerCase()));
  const tags = new Set(filter.tags.map((t) => t.replace(/^#/, "").toLowerCase()));
  return tasks.filter((task) => {
    if (task.archived) return false;
    if (statuses.size > 0 && !statuses.has(task.status.toLowerCase())) return false;
    if (tags.size > 0 && !(task.tags ?? []).some((t) => tags.has(t.replace(/^#/, "").toLowerCase()))) return false;
    if (filter.project && !(task.projects ?? []).some((p) => linkTarget(p).toLowerCase() === filter.project!.toLowerCase())) {
      // Also allow a substring/project-title match for plain-text projects.
      if (!(task.projects ?? []).some((p) => p.toLowerCase().includes(filter.project!.toLowerCase()))) return false;
    }
    return true;
  });
}

/** Done statuses from runtime catalog configs plus the configured mapping. */
export function mappingWithCatalog(
  mapping: TaskStatusMapping,
  statuses: StatusConfigLike[] | undefined,
): TaskStatusMapping {
  if (!statuses || statuses.length === 0) return mapping;
  const done = new Set([...mapping.done.map((s) => s.toLowerCase())]);
  for (const s of statuses) if (s.isCompleted) done.add(s.value.toLowerCase());
  return { ...mapping, done: [...done] };
}

function ganttStatus(task: TaskInfoLike, mapping: TaskStatusMapping): GanttTask["status"] {
  const status = task.status.toLowerCase();
  if (mapping.done.some((s) => s.toLowerCase() === status)) return "done";
  if (task.isBlocked || mapping.crit.some((s) => s.toLowerCase() === status)) return "crit";
  if (mapping.active.some((s) => s.toLowerCase() === status)) return "active";
  return undefined;
}

/** Resolve a blockedBy uid (Obsidian link or path) to a task in the set. */
export function resolveBlocker(uid: string, tasks: TaskInfoLike[]): TaskInfoLike | undefined {
  const target = linkTarget(uid);
  return (
    tasks.find((t) => t.path === target) ??
    tasks.find((t) => t.path === `${target}.md`) ??
    tasks.find((t) => t.path.endsWith(`/${target}`) || t.path.endsWith(`/${target}.md`)) ??
    tasks.find((t) => (t.title ?? "").toLowerCase() === target.toLowerCase())
  );
}

export function linkTarget(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("[[") && s.endsWith("]]")) s = s.slice(2, -2);
  s = s.split("|")[0].split("#")[0].trim();
  return s;
}

export interface TasksToGanttOptions {
  mapping: TaskStatusMapping;
  groupBy?: string;
  title?: string;
}

export interface TasksToGanttResult {
  spec: GanttSpec;
  skippedNoDate: number;
}

export function tasksToGantt(tasks: TaskInfoLike[], options: TasksToGanttOptions): TasksToGanttResult {
  const ganttTasks: GanttTask[] = [];
  let skippedNoDate = 0;
  for (const task of tasks) {
    const start = task.scheduled ?? task.due;
    const end = task.due;
    if (!start && !end) {
      skippedNoDate++;
      continue;
    }
    const after: string[] = [];
    for (const dep of task.blockedBy ?? []) {
      const blocker = resolveBlocker(dep.uid, tasks);
      if (blocker && blocker.path !== task.path) after.push(blocker.path);
    }
    ganttTasks.push({
      id: task.path,
      label: task.title || task.path,
      section: sectionFor(task, options.groupBy),
      start,
      end: end && end !== start ? end : undefined,
      duration: end && end !== start ? undefined : "1d",
      after: after.length > 0 ? after : undefined,
      status: ganttStatus(task, options.mapping),
      href: task.path,
    });
  }
  return { spec: { title: options.title ?? "Tasks", tasks: ganttTasks }, skippedNoDate };
}

function sectionFor(task: TaskInfoLike, groupBy?: string): string {
  switch (groupBy) {
    case "status":
      return task.status;
    case "project": {
      const project = task.projects?.[0];
      return project ? linkTarget(project) : "Tasks";
    }
    case "tag": {
      const tag = task.tags?.[0];
      return tag ?? "Tasks";
    }
    default: {
      const project = task.projects?.[0];
      return project ? linkTarget(project) : "Tasks";
    }
  }
}

/** Dependency flowchart: blocker -> blocked task (kind "blocks"). */
export function tasksToGraph(tasks: TaskInfoLike[], mapping: TaskStatusMapping): GraphSpec {
  const nodes: GraphSpec["nodes"] = tasks.map((task) => ({
    id: task.path,
    label: task.title || task.path,
    href: task.path,
    classes: nodeClasses(task, mapping),
  }));
  const edges: GraphSpec["edges"] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    for (const dep of task.blockedBy ?? []) {
      const blocker = resolveBlocker(dep.uid, tasks);
      if (!blocker || blocker.path === task.path) continue;
      const key = `${blocker.path}\u0000${task.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: blocker.path, to: task.path, kind: "blocks", label: "blocks" });
    }
    for (const blockedPath of task.blocking ?? []) {
      const target = tasks.find((t) => t.path === blockedPath);
      if (!target) continue;
      const key = `${task.path}\u0000${target.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: task.path, to: target.path, kind: "blocks", label: "blocks" });
    }
  }
  return { nodes, edges, direction: "LR" };
}

function nodeClasses(task: TaskInfoLike, mapping: TaskStatusMapping): string[] {
  const status = ganttStatus(task, mapping);
  if (status === "done") return ["done"];
  if (status === "crit") return ["blocked"];
  if (status === "active") return ["active"];
  return [];
}

/** Kanban columns by status (config order first, then first-seen order). */
export function tasksToKanban(tasks: TaskInfoLike[], statusOrder?: string[]): KanbanSpec {
  const order = statusOrder && statusOrder.length > 0 ? statusOrder : [...new Set(tasks.map((t) => t.status))];
  const columns = order.map((status) => ({
    label: status,
    tasks: tasks
      .filter((t) => t.status === status)
      .map((t) => ({ id: t.path, label: t.title || t.path, href: t.path })),
  }));
  // Include statuses not in the configured order at the end.
  const known = new Set(order);
  for (const task of tasks) {
    if (known.has(task.status)) continue;
    known.add(task.status);
    columns.push({ label: task.status, tasks: [{ id: task.path, label: task.title || task.path, href: task.path }] });
  }
  return { columns: columns.filter((c) => c.tasks.length > 0 || (statusOrder ?? []).includes(c.label)) };
}
