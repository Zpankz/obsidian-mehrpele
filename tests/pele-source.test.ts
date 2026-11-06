/**
 * Canvas embeds: a `cannoli` fence whose whole body is one
 * `%% pele-source: [[X.canvas]] %%` line mounts the canvas through mountCanvas, keyed by the fence.
 */
import { describe, expect, test } from "bun:test";
import { isCannoliFence, mountPeleSource, parsePeleSource } from "../src/api/pele-source";

describe("parsePeleSource", () => {
  test("accepts a .canvas link, with or without the extension, an alias and surrounding whitespace", () => {
    expect(parsePeleSource("%% pele-source: [[Maps/flow.canvas]] %%")).toBe("Maps/flow.canvas");
    expect(parsePeleSource("%% pele-source: [[Maps/flow]] %%")).toBe("Maps/flow.canvas");
    expect(parsePeleSource("%% pele-source: [[flow.canvas|My flow]] %%")).toBe("flow.canvas");
    expect(parsePeleSource("%% pele-source: [[flow|My flow]] %%")).toBe("flow.canvas");
    expect(parsePeleSource("\n  %%pele-source:[[ flow.CANVAS ]]%%  \n\n")).toBe("flow.CANVAS");
  });

  test("rejects extra lines, other comments and an empty body", () => {
    expect(parsePeleSource("%% pele-source: [[flow.canvas]] %%\nflowchart LR")).toBeNull();
    expect(parsePeleSource("flowchart LR\n%% pele-source: [[flow.canvas]] %%")).toBeNull();
    expect(parsePeleSource("%% pele-canvas: {} %%")).toBeNull();
    expect(parsePeleSource("%% a comment %%")).toBeNull();
    expect(parsePeleSource("%% pele-source: [[]] %%")).toBeNull();
    expect(parsePeleSource("%% pele-source: flow.canvas %%")).toBeNull();
    expect(parsePeleSource("%% pele-source: [[flow.canvas]] %% extra")).toBeNull();
    expect(parsePeleSource("")).toBeNull();
    expect(parsePeleSource("   \n ")).toBeNull();
  });
});

test("isCannoliFence: a cannoli token in the fence rest", () => {
  expect(isCannoliFence("cannoli")).toBe(true);
  expect(isCannoliFence("width=300 cannoli")).toBe(true);
  expect(isCannoliFence("")).toBe(false);
  expect(isCannoliFence("cannolis")).toBe(false);
  expect(isCannoliFence("theme=cannoli")).toBe(false);
});

// region mountPeleSource
class El {
  children: El[] = [];
  parent: El | null = null;
  constructor(
    readonly cls = "",
    readonly text = "",
  ) {}
  createDiv(o: { cls?: string; text?: string }): El {
    const c = new El(o.cls ?? "", o.text ?? "");
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove(): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

function deps(files: Record<string, { path: string; extension: string }>) {
  const mounts: unknown[][] = [];
  const resolved: [string, string][] = [];
  let destroyed = 0;
  return {
    mounts,
    resolved,
    destroyed: () => destroyed,
    deps: {
      resolve: (link: string, from: string) => {
        resolved.push([link, from]);
        return (files[link] ?? null) as never;
      },
      mountCanvas: (file: unknown, el: unknown, opts: unknown) => {
        mounts.push([file, el, opts]);
        return { destroy: () => void destroyed++ };
      },
    },
  };
}

describe("mountPeleSource", () => {
  const body = "%% pele-source: [[flow]] %%";
  const locate = () => null;

  test("a cannoli fence with a pele-source body mounts the resolved canvas keyed by the fence", () => {
    const file = { path: "Maps/flow.canvas", extension: "canvas" };
    const d = deps({ "flow.canvas": file });
    const el = new El();
    const m = mountPeleSource(d.deps, body, el as never, "Notes/a.md", "cannoli", "Notes/a.md#4", locate);
    expect(d.resolved).toEqual([["flow.canvas", "Notes/a.md"]]);
    expect(d.mounts).toEqual([[file, el, { fenceRest: "cannoli", key: "Notes/a.md#4", locate, sourcePath: "Notes/a.md" }]]);
    m!.destroy();
    expect(d.destroyed()).toBe(1);
  });

  test("not an embed: no cannoli token, or any other body → null, nothing resolved or mounted", () => {
    const d = deps({});
    expect(mountPeleSource(d.deps, body, new El() as never, "a.md", "", "a.md#0", locate)).toBeNull();
    expect(mountPeleSource(d.deps, "flowchart LR\nA-->B", new El() as never, "a.md", "cannoli", "a.md#0", locate)).toBeNull();
    expect(d.resolved).toEqual([]);
    expect(d.mounts).toEqual([]);
  });

  test("a missing canvas (or a non-canvas file) renders a .pele-error naming it; destroy removes it", () => {
    const cases: Record<string, { path: string; extension: string }>[] = [{}, { "flow.canvas": { path: "flow.canvas.md", extension: "md" } }];
    for (const files of cases) {
      const d = deps(files);
      const el = new El();
      const m = mountPeleSource(d.deps, body, el as never, "a.md", "cannoli", "a.md#0", locate);
      expect(d.mounts).toEqual([]);
      expect(el.children.map((c) => c.cls)).toEqual(["pele-error"]);
      expect(el.children[0]!.text).toContain("flow.canvas");
      m!.destroy();
      expect(el.children).toEqual([]);
    }
  });
});
// endregion mountPeleSource
