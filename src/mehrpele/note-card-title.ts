/** The note card's file-name label, as Canvas writes it (`Note`, `Note › Heading`, `Note › ^block`). */
export function noteCardTitle(basename: string, subpath: string): string {
  const s = subpath.replace(/^#/, "").trim();
  return s ? `${basename} › ${s.replace(/#/g, " › ")}` : basename;
}
