/**
 * Whether a block is written as Mehrpele, from its fence language and source
 * alone. Core: validation and the edit toolbar ask for every block, so this
 * must not load the Mehrpele feature.
 */

/** `mehrpele` language, or the `%% mehrpele %%` directive in mermaid/pele. */
export function isMehrpeleSource(lang: string, source: string): boolean {
  if (lang === "mehrpele") return true;
  if (lang !== "mermaid" && lang !== "pele") return false;
  return hasMehrpeleDirective(source);
}

/** True when the `%% mehrpele %%` opt-in directive appears in the source. */
export function hasMehrpeleDirective(source: string): boolean {
  return /(^|\n)\s*%%\s*mehrpele\s*%%/.test(source);
}
