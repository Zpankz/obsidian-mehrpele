/**
 * Obsidian 1.15+ renders ```mermaid in Reading view itself: a core
 * post-processor (sortOrder 0, registered before any plugin) swaps
 * `code.language-mermaid` for its own `div.mermaid` when the section is shown.
 * Post-processors run by sortOrder, ties in registration order, so a plugin
 * processor at the default 0 runs too late and core's diagram wins. A negative
 * sortOrder lets ours replace the `<pre>` first, so core never sees the block.
 */
export const BEFORE_CORE = -100;

type CodeBlockRegistrar<H> = {
  registerMarkdownCodeBlockProcessor(language: string, handler: H, sortOrder?: number): unknown;
};

export function registerBeforeCore<H>(plugin: CodeBlockRegistrar<H>, language: string, handler: H): void {
  plugin.registerMarkdownCodeBlockProcessor(language, handler, BEFORE_CORE);
}
