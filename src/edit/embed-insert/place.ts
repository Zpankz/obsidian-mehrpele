/** Insert-embed popover placement (pure). */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function intersects(a: Box, b: Box): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/** Position (pure): below/above the anchor, never over `avoid`, inside the viewport. */
export function placePopover(anchor: Box, size: { width: number; height: number }, avoid: Box | null, vw: number, vh: number, gap = 6): { left: number; top: number } {
  const clampX = (x: number) => Math.min(Math.max(4, x), vw - size.width - 4);
  const clampY = (y: number) => Math.min(Math.max(4, y), vh - size.height - 4);
  const cx = clampX(anchor.left + anchor.width / 2 - size.width / 2);
  const aboveNode = avoid ? anchor.top + anchor.height / 2 < avoid.top + avoid.height / 2 : true;
  const candidates = [
    // Away from the node first: above a menu that sits above the node, below one below it.
    aboveNode ? { left: cx, top: anchor.top - size.height - gap } : { left: cx, top: anchor.top + anchor.height + gap },
    aboveNode ? { left: cx, top: anchor.top + anchor.height + gap } : { left: cx, top: anchor.top - size.height - gap },
  ];
  if (avoid) {
    candidates.push({ left: avoid.left + avoid.width + gap, top: clampY(avoid.top) });
    candidates.push({ left: avoid.left - size.width - gap, top: clampY(avoid.top) });
  }
  for (const c of candidates) {
    const box = { left: c.left, top: c.top, width: size.width, height: size.height };
    const inside = c.left >= 4 && c.top >= 4 && c.left + size.width <= vw - 4 && c.top + size.height <= vh - 4;
    if (inside && !(avoid && intersects(box, avoid))) return c;
  }
  return { left: cx, top: clampY(candidates[0].top) };
}

