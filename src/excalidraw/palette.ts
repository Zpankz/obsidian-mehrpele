// Pure glue: palette variable list + resolution from a getPropertyValue fn.
export const PELE_VARS = [
  "--pele-bg", "--pele-fg", "--pele-muted", "--pele-line", "--pele-surface",
  "--pele-surface-alt", "--pele-border", "--pele-accent",
  "--pele-series-1", "--pele-series-2", "--pele-series-3", "--pele-series-4",
  "--pele-series-5", "--pele-series-6", "--pele-series-7", "--pele-series-8",
] as const;

export function resolvePalette(getVar: (name: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PELE_VARS) {
    const v = getVar(name).trim();
    if (v) out[name] = v;
  }
  return out;
}
