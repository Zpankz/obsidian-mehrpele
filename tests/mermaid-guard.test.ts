import { describe, expect, test } from "bun:test";
import { unwrapMermaidGuard, type GuardNode } from "../src/mermaid-guard";

/** A tiny element tree: class lists, parent links, and the four calls the helper uses. */
class Node implements GuardNode<Node> {
  parentNode: Node | null = null;
  children: Node[] = [];
  constructor(readonly classes: string[] = []) {}
  add(child: Node): Node {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  private matches(selector: string): boolean {
    return selector
      .replace(/^:scope > /, "")
      .split(".")
      .filter(Boolean)
      .every((c) => this.classes.includes(c));
  }
  closest(selector: string): Node | null {
    for (let n: Node | null = this; n; n = n.parentNode) if (n.matches(selector)) return n;
    return null;
  }
  querySelector(selector: string): Node | null {
    // Only the `:scope > .x` form the helper uses.
    return this.children.find((c) => c.matches(selector)) ?? null;
  }
  contains(other: Node | null): boolean {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  replaceWith(n: Node): void {
    const parent = this.parentNode!;
    n.parentNode?.children.splice(n.parentNode.children.indexOf(n), 1);
    parent.children[parent.children.indexOf(this)] = n;
    n.parentNode = parent;
    this.parentNode = null;
  }
}

/** Obsidian 1.14's guard around a block a code-block processor received. */
function guarded(): { section: Node; guard: Node; header: Node; block: Node } {
  const section = new Node(["el-pre"]);
  const holder = section.add(new Node());
  const guard = holder.add(new Node(["mermaid-wrapper", "is-guarded"]));
  const header = guard.add(new Node(["mermaid-guard-header"]));
  const source = guard.add(new Node(["mermaid-guard-source"]));
  const block = source.add(new Node(["block-language-mermaid"]));
  return { section, guard, header, block };
}

describe("unwrapMermaidGuard", () => {
  test("the block takes the guard's place: no header, no source area", () => {
    const { section, guard, header, block } = guarded();
    expect(unwrapMermaidGuard(block)).toBe(true);
    const holder = section.children[0]!;
    expect(holder.children).toEqual([block]);
    expect(block.parentNode).toBe(holder);
    expect(section.contains(guard)).toBe(false);
    expect(section.contains(header)).toBe(false);
  });
  test("a block outside any guard (trusted vault) is untouched", () => {
    const section = new Node(["el-pre"]);
    const block = section.add(new Node(["block-language-mermaid"]));
    expect(unwrapMermaidGuard(block)).toBe(false);
    expect(section.children).toEqual([block]);
  });
  test("fail safe: a guard of another shape is left as it is", () => {
    // No source area (Obsidian changed its DOM): Pele renders, the banner may stay.
    const section = new Node(["el-pre"]);
    const guard = section.add(new Node(["mermaid-wrapper", "is-guarded"]));
    const block = guard.add(new Node(["block-language-mermaid"]));
    expect(unwrapMermaidGuard(block)).toBe(false);
    expect(block.parentNode).toBe(guard);
    // Inside the guard but in its header, not its source: untouched too.
    const g = guarded();
    const stray = g.header.add(new Node(["block-language-mermaid"]));
    expect(unwrapMermaidGuard(stray)).toBe(false);
    expect(g.section.contains(g.guard)).toBe(true);
  });
  test("a detached guard is left alone", () => {
    const guard = new Node(["mermaid-wrapper", "is-guarded"]);
    const source = guard.add(new Node(["mermaid-guard-source"]));
    const block = source.add(new Node());
    expect(unwrapMermaidGuard(block)).toBe(false);
  });
});
