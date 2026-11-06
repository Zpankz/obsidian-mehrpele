/**
 * Live Preview widget reuse: a Mehrpele shell whose fence body is edited
 * into a `%% pele-source: [[X.canvas]] %%` line on a `cannoli` fence is rebuilt as a canvas embed,
 * never updated in place (that would show the comment as a write-back diagram).
 */
import { describe, expect, mock, test } from "bun:test";
import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { obsidianStub } from "./helpers/obsidian-stub";

// Named ESM imports need own keys up front; reading through the stub's proxy fills them.
for (const k of ["finishRenderMath", "loadMathJax", "renderMath", "getAllTags", "getIcon", "normalizePath", "requestUrl", "resolveSubpath"]) {
  void obsidianStub[k];
}
mock.module("obsidian", () => obsidianStub);
// Obsidian supplies @codemirror/commands at runtime; it is not a package dependency.
mock.module("@codemirror/commands", () => ({ isolateHistory: { of: () => null } }));
const { handleLpWidgetReuse, refreshLpFenceModes } = await import("../src/lp/widget");

const SOURCE = "%% pele-source: [[Maps/f.canvas]] %%";

function setup(fence: string) {
  const doc = Text.of(["# Note", fence, "flowchart LR", "```"]);
  const view = { state: { doc } } as unknown as EditorView;
  const log: string[] = [];
  const shell = {
    source: "flowchart LR",
    update: (code: string) => void log.push(`update:${code}`),
    destroy: () => void log.push("shell:destroy"),
    applyFenceSize: () => undefined,
  };
  const dom = { replaceChildren: () => void log.push("replaceChildren") } as unknown as HTMLElement;
  const plugin = {
    frameHandles: { resyncSoon: () => undefined },
    canvasEmbedsByDom: new WeakMap<HTMLElement, unknown>(),
    mehrByDom: new WeakMap<HTMLElement, unknown>([[dom, shell]]),
    framesByDom: new WeakMap<HTMLElement, unknown>(),
    app: { workspace: { getLeavesOfType: () => [], getActiveFile: () => ({ path: "Notes/a.md" }) } },
    canvasEmbed: (code: string, _el: HTMLElement, sourcePath: string, companion: { key: string; fenceRest: string }) => {
      log.push(`embed:${code}:${sourcePath}:${companion.key}:${companion.fenceRest}`);
      return { destroy: () => void log.push("embed:destroy") };
    },
    appliesMehrpele: () => true,
  };
  const widget = { code: SOURCE, lang: "mermaid", lineStart: 1, start: -1 };
  const reuse = () => handleLpWidgetReuse(plugin as never, widget as never, dom, view);
  return { plugin, shell, dom, widget, log, reuse };
}

describe("handleLpWidgetReuse: a shell edited into a pele-source body", () => {
  test("a cannoli fence rebuilds as a canvas embed: the shell goes, the embed is tracked", () => {
    const t = setup("```mermaid cannoli");
    expect(t.reuse()).toBe(true);
    expect(t.log).toEqual(["shell:destroy", "replaceChildren", `embed:${SOURCE}:Notes/a.md:Notes/a.md#1:cannoli`]);
    expect(t.plugin.mehrByDom.has(t.dom)).toBe(false);
    expect(t.plugin.canvasEmbedsByDom.get(t.dom)).toMatchObject({ code: SOURCE, rest: "cannoli" });
  });

  test("without the cannoli token the shell updates in place, as before", () => {
    const t = setup("```mermaid");
    expect(t.reuse()).toBe(true);
    expect(t.log).toEqual([`update:${SOURCE}`]);
    expect(t.plugin.mehrByDom.get(t.dom)).toBe(t.shell);
  });
});


test("adding only cannoli to a source-body shell rebuilds it as a canvas embed", () => {
  const t = setup("```mehrpele cannoli");
  t.widget.lang = "mehrpele";
  t.shell.source = SOURCE;
  expect(t.reuse()).toBe(true);
  expect(t.log).toEqual(["shell:destroy", "replaceChildren", `embed:${SOURCE}:Notes/a.md:Notes/a.md#1:cannoli`]);
});


test("info-only layout callback revisits visible source-body shells", () => {
  const t = setup("```mehrpele cannoli");
  t.shell.source = SOURCE;
  t.widget.lang = "mehrpele";
  const dom = Object.assign(t.dom, { isConnected: true, offsetParent: {}, cmTile: { widget: t.widget } });
  const view = {
    state: { doc: Text.of(["# Note", "```mehrpele cannoli", SOURCE, "``` "]) },
    dom: { contains: () => true, querySelectorAll: () => [dom] },
    posAtDOM: () => 7,
  } as unknown as EditorView;
  refreshLpFenceModes(t.plugin as never, view);
  expect(t.log).toEqual(["shell:destroy", "replaceChildren", `embed:${SOURCE}:Notes/a.md:Notes/a.md#1:cannoli`]);
});
