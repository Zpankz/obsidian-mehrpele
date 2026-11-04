/**
 * Which top-level sections of the settings tab are folded. This is UI state,
 * not a setting: it lives in the app's per-vault local storage, never in data.json.
 */
export const FOLDS_KEY = "mehrpele-settings-folds";
/** Class on a folded group element; styles.css hides its items. */
export const FOLDED_CLASS = "mehrpele-folded";

/**
 * Unfold the section that hides `el`, through its chevron so the fold state
 * saves too. Search navigation calls this before it scrolls to a row.
 */
export function revealFolded(el: Element | null | undefined): void {
  const group = el?.closest(`.${FOLDED_CLASS}`);
  group?.querySelector<HTMLElement>(".setting-item-heading .extra-setting-button[aria-expanded='false']")?.click();
}

export interface LocalStorageLike {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, data: unknown): void;
}

export class FoldState {
  private folded: Set<string>;

  constructor(private readonly store: LocalStorageLike) {
    const raw = store.loadLocalStorage(FOLDS_KEY);
    this.folded = new Set(Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : []);
  }

  isFolded(id: string): boolean {
    return this.folded.has(id);
  }

  set(id: string, folded: boolean): void {
    if (folded) this.folded.add(id);
    else this.folded.delete(id);
    this.store.saveLocalStorage(FOLDS_KEY, [...this.folded].sort());
  }
}
