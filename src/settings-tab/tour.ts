/**
 * The Learn section's tour notes: download the pinned pack once (cached in the
 * plugin folder), then write its notes into the vault, or trash the ones the
 * user has not edited.
 */
import {
  type AssetPin, type BinaryAdapter, ensureAsset, type HttpGet, installTourNotes, parseTourPack, removeTourNotes,
  TOUR_FOLDER, type TourPack, type TourVault,
} from "../features/assets";

export const TOUR_ASSET = "tour-0.1.0.json";

export interface TourDeps {
  vault: TourVault;
  adapter: BinaryAdapter;
  /** The plugin folder (`manifest.dir`). */
  dir: string;
  /** The release the asset is downloaded from (`manifest.version`). */
  version: string;
  get: HttpGet;
  /** Pin override, for tests; defaults to the release pins. */
  pins?: Readonly<Record<string, AssetPin>>;
}

async function pack(d: TourDeps): Promise<TourPack> {
  const { data } = await ensureAsset(TOUR_ASSET, { get: d.get, version: d.version, adapter: d.adapter, dir: d.dir, pins: d.pins });
  return parseTourPack(data);
}

export async function installTour(d: TourDeps): Promise<{ created: string[] }> {
  return installTourNotes(d.vault, await pack(d), TOUR_FOLDER);
}

export async function removeTour(d: TourDeps): Promise<{ removed: string[]; kept: string[] }> {
  return removeTourNotes(d.vault, await pack(d), TOUR_FOLDER);
}

/** The Notice after Remove. */
export function removedMessage(r: { removed: string[]; kept: string[] }): string {
  const kept = r.kept.length ? ` Kept ${r.kept.length} you edited.` : "";
  return `Mehrpele: removed ${r.removed.length} tour notes.${kept}`;
}
