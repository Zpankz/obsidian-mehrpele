import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { lpLocate } from "../src/lp/locate";

const NOTE = ["# Note", "", "Intro.", "", "```mermaid theme=x", "flowchart LR", "  a --> b", "```"].join("\n");

/** A view whose widget container maps to the fence line (1-based `line`). */
function view(text: string, line: number) {
  const doc = Text.of(text.split("\n"));
  const container = { isConnected: true, offsetParent: {} as unknown } as unknown as HTMLElement;
  const v = {
    state: { doc },
    dom: { contains: (el: unknown) => el === container },
    posAtDOM: () => doc.line(line).from,
  } as unknown as EditorView;
  return { v, container };
}

describe("lpLocate", () => {
  test("a shown widget reports its fence line and rest, exact", () => {
    const { v, container } = view(NOTE, 5);
    expect(lpLocate(v, container)).toEqual({ line: 4, rest: "theme=x", exact: true });
  });

  test("the widget position may map to the line after the fence", () => {
    const { v, container } = view(NOTE, 6);
    expect(lpLocate(v, container)).toEqual({ line: 4, rest: "theme=x", exact: true });
  });

  test("a hidden editor can't tell: its doc can lag the note (a split in Reading mode)", () => {
    const { v, container } = view(NOTE, 5);
    (container as unknown as { offsetParent: unknown }).offsetParent = null;
    expect(lpLocate(v, container)).toBeNull();
  });

  test("a widget no longer in the view can't tell", () => {
    const { v, container } = view(NOTE, 5);
    (container as unknown as { isConnected: boolean }).isConnected = false;
    expect(lpLocate(v, container)).toBeNull();
    const other = { isConnected: true, offsetParent: {} } as unknown as HTMLElement;
    expect(lpLocate(v, other)).toBeNull();
  });
});
