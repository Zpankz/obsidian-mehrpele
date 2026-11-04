// Build post-pass: wrap each esbuild lazy-module init arrow in parentheses.
//
// The plugin defers most modules behind esbuild's lazy init helper
// (`var init = __esm(() => { ... })`), so V8 only pre-parses those bodies at
// load and parses them again when they run. A parenthesised function is V8's
// hint to compile it eagerly in one pass (a PIFE), which roughly halves module
// evaluation at plugin load. Only parentheses are added; nothing else changes.
import { parse } from "acorn";

/**
 * Find esbuild's init helper by shape, not by (minified) name:
 * `(fn, res, err) => () => { if (err) throw err[0]; ... }`.
 */
function isInitHelper(init) {
  if (init?.type !== "ArrowFunctionExpression" || init.params.length !== 3) return false;
  const inner = init.body;
  if (inner?.type !== "ArrowFunctionExpression" || inner.params.length !== 0) return false;
  const first = inner.body?.type === "BlockStatement" ? inner.body.body[0] : undefined;
  const err = init.params[2];
  return (
    first?.type === "IfStatement" &&
    first.test.type === "Identifier" &&
    err.type === "Identifier" &&
    first.test.name === err.name &&
    (first.consequent.type === "ThrowStatement" ||
      (first.consequent.type === "BlockStatement" && first.consequent.body[0]?.type === "ThrowStatement"))
  );
}

/** Returns the rewritten code and how many init arrows were wrapped. */
export function pife(code) {
  const ast = parse(code, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true });
  const helpers = new Set();
  const calls = [];
  const visit = (n) => {
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && isInitHelper(n.init)) helpers.add(n.id.name);
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.arguments[0]?.type === "ArrowFunctionExpression") {
      calls.push(n);
    }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === "string") visit(c);
      } else if (v && typeof v === "object" && typeof v.type === "string") visit(v);
    }
  };
  visit(ast);
  const spots = calls
    .filter((c) => helpers.has(c.callee.name))
    .map((c) => [c.arguments[0].start, c.arguments[0].end])
    .sort((a, b) => b[0] - a[0]);
  let out = code;
  for (const [a, b] of spots) out = `${out.slice(0, a)}(${out.slice(a, b)})${out.slice(b)}`;
  return { code: out, wrapped: spots.length };
}
