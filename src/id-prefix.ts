/** Unique-per-diagram id prefixes (a11y title/description ids in Pele SVG). */

export function createIdPrefixer(): () => string {
  let counter = 0;
  return () => `pele-${++counter}-`;
}

/** Shared process-wide prefixer so frames, embeds and lightboxes never collide. */
export const nextIdPrefix: () => string = createIdPrefixer();
