/** Wrap each esbuild lazy init arrow in parentheses (V8 eager-compile hint). */
export function pife(code: string): { code: string; wrapped: number };
