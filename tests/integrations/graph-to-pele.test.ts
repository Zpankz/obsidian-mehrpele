import { describe, expect, test } from "bun:test";
import { parse } from "pele";
import {
  flowchartFromGraph,
  ganttFromSpec,
  kanbanFromSpec,
  mindmapFromTree,
  sanitiseId,
  type GraphSpec,
} from "../../src/integrations/graph-to-pele";

const spec: GraphSpec = {
  direction: "LR",
  nodes: [
    { id: "Projects/Alpha.md", label: "Alpha", href: "Projects/Alpha.md", classes: ["active"] },
    { id: "Projects/Beta.md", label: "Beta", href: "Projects/Beta.md", classes: ["done"] },
    { id: "Projects/Gamma.md", label: "Gamma" },
  ],
  edges: [
    { from: "Projects/Alpha.md", to: "Projects/Beta.md", label: "up", kind: "up" },
    { from: "Projects/Alpha.md", to: "Projects/Gamma.md", label: "same", kind: "same" },
  ],
};

describe("flowchartFromGraph", () => {
  test("is deterministic", () => {
    expect(flowchartFromGraph(spec).source).toBe(flowchartFromGraph(spec).source);
  });

  test("generated source parses with Pele", () => {
    expect(parse(flowchartFromGraph(spec).source).type).toBe("flowchart");
  });

  test("emits click lines for hrefs and typed arrows", () => {
    const { source } = flowchartFromGraph(spec);
    expect(source).toContain('click Projects_Alpha "Projects/Alpha.md"');
    expect(source).toContain("-.->");
    expect(source).toContain("classDef pele-active");
    expect(source).toContain("classDef pele-done");
  });

  test("never hard-codes colours by default", () => {
    const { source } = flowchartFromGraph(spec);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toContain("var(--");
  });

  test("user-configured colours are the only colour source", () => {
    const { source } = flowchartFromGraph(spec, { classColors: { done: "#123456" } });
    expect(source).toContain("fill:#123456");
  });

  test("quotes labels with quotes, brackets and newlines", () => {
    const tricky: GraphSpec = {
      nodes: [
        { id: "a", label: 'Say "hi" [now] (please)' },
        { id: "b", label: "line1\nline2" },
      ],
      edges: [{ from: "a", to: "b", label: 'has "quote"' }],
    };
    const { source } = flowchartFromGraph(tricky);
    expect(source).toContain("#quot;");
    expect(parse(source).type).toBe("flowchart");
  });

  test("truncates with a …N more node and drops dangling edges", () => {
    const many: GraphSpec = {
      nodes: Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, label: `N${i}` })),
      edges: [{ from: "n4", to: "n0", label: "x" }],
    };
    const out = flowchartFromGraph(many, { maxNodes: 2 });
    expect(out.truncated).toBe(true);
    expect(out.omittedCount).toBe(3);
    expect(out.source).toContain("…3 more");
    expect(out.edgeCount).toBe(0);
    expect(parse(out.source).type).toBe("flowchart");
  });

  test("groups become subgraphs", () => {
    const grouped: GraphSpec = {
      nodes: [
        { id: "a", label: "A", group: "Work" },
        { id: "b", label: "B", group: "Work" },
        { id: "c", label: "C" },
      ],
      edges: [{ from: "a", to: "c" }],
    };
    const { source } = flowchartFromGraph(grouped);
    expect(source).toContain('subgraph "Work"');
    expect(parse(source).type).toBe("flowchart");
  });
});

describe("sanitiseId", () => {
  test("handles leading digits, reserved words and collisions", () => {
    const taken = new Set<string>();
    expect(sanitiseId("123 Note.md", taken)).toMatch(/^n_/);
    expect(sanitiseId("end", taken)).toBe("end_");
    expect(sanitiseId("a b", taken)).toBe("a_b");
    expect(sanitiseId("a/b", taken)).toBe("a_b_2");
  });
});

describe("ganttFromSpec", () => {
  test("emits deps, statuses, milestones and href clicks; parses", () => {
    const { source } = ganttFromSpec({
      title: "Plan",
      tasks: [
        { id: "Tasks/Design.md", label: "Design", section: "Work", start: "2026-01-01", end: "2026-01-03", status: "done", href: "Tasks/Design.md" },
        { id: "Tasks/Build.md", label: "Build", section: "Work", after: ["Tasks/Design.md"], duration: "5d", status: "active" },
        { id: "Tasks/Ship.md", label: "Ship", section: "Work", start: "2026-01-10", status: "milestone" },
        { id: "Tasks/Risky.md", label: "Risky", section: "Work", start: "2026-01-05", duration: "2d", status: "crit" },
      ],
    });
    expect(source).toContain("after Tasks_Design");
    expect(source).toContain("done,");
    expect(source).toContain("milestone,");
    expect(source).toContain('click Tasks_Design href "Tasks/Design.md"');
    expect(parse(source).type).toBe("gantt");
  });
});

describe("mindmapFromTree + kanbanFromSpec", () => {
  test("mindmap parses and truncates", () => {
    const { source, truncated } = mindmapFromTree(
      { root: { label: "Project", children: [{ label: "Design" }, { label: "Build", children: [{ label: "Ship it" }] }] } },
      { maxNodes: 2 },
    );
    expect(truncated).toBe(true);
    expect(parse(source).type).toBe("mindmap");
  });

  test("kanban parses with status columns", () => {
    const { source } = kanbanFromSpec({
      columns: [
        { label: "Todo", tasks: [{ id: "t1", label: "First", href: "Tasks/First.md" }] },
        { label: "Done", tasks: [{ id: "t2", label: "Second" }] },
      ],
    });
    expect(source).toContain("Todo");
    expect(parse(source).type).toBe("kanban");
  });
});

describe("kanban links", () => {
  test("never emits click statements (unsupported in kanban)", () => {
    const out = kanbanFromSpec({ columns: [{ label: "open", tasks: [{ id: "t1", label: "Task", href: "Notes/Task.md" }] }] });
    expect(out.source).not.toContain("click");
  });
});

import { escapeQuotedLabel } from "../../src/integrations/graph-to-pele";

describe("escapeQuotedLabel newlines", () => {
  test("lone CR, CRLF and LF all collapse to spaces", () => {
    expect(escapeQuotedLabel('a\rclick X "u"\r\nb\nc')).toBe("a click X #quot;u#quot; b c");
  });
});
