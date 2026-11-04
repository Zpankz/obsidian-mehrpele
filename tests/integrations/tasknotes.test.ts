import { describe, expect, test } from "bun:test";
import { parse } from "pele";
import type { TaskInfoLike } from "../../src/integrations/detect";
import { ganttFromSpec, flowchartFromGraph, kanbanFromSpec } from "../../src/integrations/graph-to-pele";
import {
  DEFAULT_STATUS_MAPPING,
  filterTasks,
  tasksToGantt,
  tasksToGraph,
  tasksToKanban,
} from "../../src/integrations/tasknotes/map";

// Fake tasks shaped like TaskInfo (tasknotes/src/types.ts:456).
const tasks: TaskInfoLike[] = [
  {
    title: "Design",
    status: "done",
    priority: "normal",
    path: "Tasks/Design.md",
    archived: false,
    scheduled: "2026-01-01",
    due: "2026-01-03",
    projects: ["[[Projects/Alpha]]"],
    tags: ["work"],
  },
  {
    title: "Build",
    status: "in-progress",
    priority: "high",
    path: "Tasks/Build.md",
    archived: false,
    scheduled: "2026-01-04",
    due: "2026-01-08",
    projects: ["[[Projects/Alpha]]"],
    blockedBy: [{ uid: "[[Tasks/Design]]", reltype: "FINISHTOSTART" }],
  },
  {
    title: "Ship",
    status: "open",
    priority: "normal",
    path: "Tasks/Ship.md",
    archived: false,
    due: "2026-01-10",
    isBlocked: true,
    blockedBy: [{ uid: "Tasks/Build.md", reltype: "FINISHTOSTART" }],
  },
  { title: "Someday", status: "open", priority: "low", path: "Tasks/Someday.md", archived: false },
  { title: "Old", status: "done", priority: "low", path: "Tasks/Old.md", archived: true, due: "2025-01-01" },
];

describe("tasksToGantt", () => {
  test("maps dates, deps (after) and statuses; skips undated", () => {
    const { spec, skippedNoDate } = tasksToGantt(tasks, { mapping: DEFAULT_STATUS_MAPPING });
    expect(skippedNoDate).toBe(1);
    expect(spec.tasks).toHaveLength(4); // archived included here; filterTasks removes it
    const build = spec.tasks!.find((t) => t.id === "Tasks/Build.md")!;
    expect(build.after).toEqual(["Tasks/Design.md"]);
    expect(build.status).toBe("active");
    expect(spec.tasks!.find((t) => t.id === "Tasks/Design.md")!.status).toBe("done");
    expect(spec.tasks!.find((t) => t.id === "Tasks/Ship.md")!.status).toBe("crit");
    expect(parse(ganttFromSpec(spec).source).type).toBe("gantt");
  });

  test("custom status mapping wins", () => {
    const { spec } = tasksToGantt(tasks, {
      mapping: { done: ["open"], active: [], crit: [] },
    });
    expect(spec.tasks!.find((t) => t.id === "Tasks/Ship.md")!.status).toBe("done");
  });
});

describe("filterTasks + dependency graph + kanban", () => {
  test("filters archived, status, tags and project", () => {
    expect(filterTasks(tasks, { tags: [] })).toHaveLength(4);
    expect(filterTasks(tasks, { tags: [], status: ["done"] }).map((t) => t.path)).toEqual(["Tasks/Design.md"]);
    expect(filterTasks(tasks, { tags: ["work"] }).map((t) => t.path)).toEqual(["Tasks/Design.md"]);
    expect(filterTasks(tasks, { tags: [], project: "Projects/Alpha" })).toHaveLength(2);
  });

  test("dependency flowchart parses with blocks edges", () => {
    const spec = tasksToGraph(filterTasks(tasks, { tags: [] }), DEFAULT_STATUS_MAPPING);
    expect(spec.edges).toContainEqual({ from: "Tasks/Design.md", to: "Tasks/Build.md", kind: "blocks", label: "blocks" });
    expect(parse(flowchartFromGraph(spec).source).type).toBe("flowchart");
  });

  test("kanban groups by status and parses", () => {
    const spec = tasksToKanban(filterTasks(tasks, { tags: [] }));
    expect(spec.columns.map((c) => c.label)).toEqual(["done", "in-progress", "open"]);
    expect(parse(kanbanFromSpec(spec).source).type).toBe("kanban");
  });
});
