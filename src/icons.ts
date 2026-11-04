/**
 * Icon name resolution for Pele's `icons` resolver. Pure: maps the names
 * diagram authors write (`fa:fa-car`, `lucide:car`, bare names) to Lucide
 * names in Obsidian's built-in set. The host supplies the actual SVG lookup;
 * only names that resolve there are ever returned (trusted markup only).
 */

export const FA_ALIASES: Readonly<Record<string, string>> = {
  car: "car",
  user: "user",
  users: "users",
  database: "database",
  cloud: "cloud",
  server: "server",
  lock: "lock",
  unlock: "lock-open",
  envelope: "mail",
  mail: "mail",
  file: "file",
  folder: "folder",
  cog: "settings",
  gear: "settings",
  check: "check",
  times: "x",
  close: "x",
  home: "home",
  search: "search",
  github: "github",
  globe: "globe",
  link: "link",
  calendar: "calendar",
  clock: "clock",
  star: "star",
  heart: "heart",
  bell: "bell",
  camera: "camera",
  phone: "phone",
  download: "download",
  upload: "upload",
  trash: "trash-2",
  edit: "pencil",
  plus: "plus",
  minus: "minus",
  warning: "triangle-alert",
  exclamation: "circle-alert",
  info: "info",
  key: "key",
  shield: "shield",
  bolt: "zap",
  lightning: "zap",
  book: "book",
  image: "image",
  chart: "chart-bar",
  graph: "chart-line",
};

/** Map an author-written icon name to a Lucide icon name, or null. */
export function resolveLucideName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null;
  if (name.startsWith("lucide:")) {
    const n = name.slice("lucide:".length).trim();
    return n || null;
  }
  if (name.startsWith("fa:")) {
    let n = name.slice(3).trim();
    if (n.startsWith("fa-")) n = n.slice(3);
    return FA_ALIASES[n] ?? (n || null);
  }
  // Bare Font Awesome style ("fa-car") and bare Lucide names.
  if (name.startsWith("fa-")) {
    const n = name.slice(3);
    return FA_ALIASES[n] ?? (n || null);
  }
  return FA_ALIASES[name] ?? name;
}

/**
 * Build a Pele `icons` resolver from a host lookup. Returns undefined for
 * anything that does not resolve — Pele inserts resolver output unfiltered,
 * so the lookup must only return trusted, app-generated SVG.
 */
export function makeIconResolver(
  lookup: (lucideName: string) => string | null | undefined,
): (name: string) => string | undefined {
  return (name: string) => {
    const lucide = resolveLucideName(name);
    if (!lucide) return undefined;
    return lookup(lucide) ?? undefined;
  };
}
