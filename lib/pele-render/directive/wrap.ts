/**
 * Pele diagram wrappers driven by a `%% pele-* %%` directive (node sizing,
 * canvas layout). Pele drops `%%` lines before `parse` unless a diagram
 * keeps them, so a wrapper sets `keepComments`, reads its directive from
 * the full source, strips the comments itself for the inner diagram, and
 * hands what it read to `render` on the model (a non-enumerable symbol
 * property, so models still compare and serialise as before).
 */
import type { Diagram } from "pele";

/** Pele/Mermaid comment removal (bundle's cleanupComments). */
const COMMENT_RE = /^\s*%%(?!{)[^\n]+\n?/gm;

/** Source without Pele/Mermaid `%%` comment lines (what Pele parses). */
export function stripComments(source: string): string {
  return (source.includes("%%") ? source.replace(COMMENT_RE, "") : source).trimStart();
}

export type ParseRest<M> = Parameters<Diagram<M>["parse"]> extends [string, ...infer R] ? R : never;
export type RenderArgs<M> = Parameters<Diagram<M>["render"]>;
export type Rendered<M> = ReturnType<Diagram<M>["render"]>;

export interface DirectiveWrapper<M, T> {
  /** Text the source must contain for `read` to run (a cheap pre-check). */
  marker: string;
  /**
   * What the directive says, or undefined when it asks for nothing. Gets the
   * full source, the comment-free text the inner diagram parsed, and the
   * remaining parse arguments.
   */
  read(source: string, text: string, ...rest: ParseRest<M>): T | undefined;
  /** Render a model whose source had the directive (`meta` is what `read` returned). */
  render(model: M, meta: T, config: RenderArgs<M>[1], options: RenderArgs<M>[2]): Rendered<M>;
}

/** What `read` attached to a parsed model under `key`, if anything. */
export function directiveMeta<T>(model: unknown, key: symbol): T | undefined {
  return model && typeof model === "object" ? ((model as Record<symbol, unknown>)[key] as T | undefined) : undefined;
}

/**
 * Wrap `d` so its directive is read at parse time and applied at render
 * time; models without it render through `d` unchanged. Wrapping twice with
 * the same `key` returns the wrapper as is.
 */
export function wrapDiagram<M, T>(d: Diagram<M>, key: symbol, spec: DirectiveWrapper<M, T>): Diagram<M> {
  if ((d as unknown as Record<symbol, unknown>)[key]) return d;
  const wrapped: Diagram<M> = {
    ...d,
    keepComments: true,
    parse(source, config, title, lineOffset, limits) {
      const text = d.keepComments ? source : stripComments(source);
      const model = d.parse(text, config, title, lineOffset, limits);
      if (source.includes(spec.marker) && model && typeof model === "object") {
        const meta = spec.read(source, text, config, title, lineOffset, limits);
        if (meta !== undefined) Object.defineProperty(model, key, { value: meta, enumerable: false, configurable: true });
      }
      return model;
    },
    render(model, config, options) {
      const meta = directiveMeta<T>(model, key);
      return meta ? spec.render(model, meta, config, options) : d.render(model, config, options);
    },
  };
  Object.defineProperty(wrapped, key, { value: true, enumerable: false });
  return wrapped;
}
