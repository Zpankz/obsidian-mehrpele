import { describe, expect, test } from "bun:test";
import { intersects, placeCluster, placeSubmenu, placeToolbar, visibleBounds, CLUSTER_GAP, EDGE, HANDLE_GAP, type Box } from "../../src/edit/placement";

const VIEW: Box = { left: 0, top: 0, width: 1200, height: 800 };
const TOOLBAR = { width: 200, height: 36 };
const PALETTE = { width: 290, height: 40 };
const MENU = { width: 180, height: 220 };
const TALL = { width: 165, height: 362 };
const SHORT_VIEW: Box = { left: 270, top: 80, width: 1327, height: 708 };
const BAND = 32;
const grow = (b: Box, d: number): Box => ({ left: b.left - d, top: b.top - d, width: b.width + 2 * d, height: b.height + 2 * d });
const within = (b: Box, bounds: Box) =>
  b.left >= bounds.left + EDGE - 0.5 && b.top >= bounds.top + EDGE - 0.5 && b.left + b.width <= bounds.left + bounds.width - EDGE + 0.5 && b.top + b.height <= bounds.top + bounds.height - EDGE + 0.5;

describe("toolbar placement", () => {
  test("above the selection, beyond the + band, centred", () => {
    const node = { left: 500, top: 400, width: 80, height: 40 };
    const t = placeToolbar(node, TOOLBAR, VIEW, BAND);
    expect(t.side).toBe("above");
    expect(t.top + t.height).toBeLessThanOrEqual(node.top - BAND);
    expect(t.left + t.width / 2).toBeCloseTo(540, 6);
    // The top "+" (22 px, centred 14 px above) never touches it.
    const topPlus = { left: 529, top: node.top - 25, width: 22, height: 22 };
    expect(intersects(t, topPlus)).toBe(false);
  });
  test("below when the selection is at the top edge; clamped at the sides", () => {
    const node = { left: 2, top: 20, width: 60, height: 40 };
    const t = placeToolbar(node, TOOLBAR, VIEW, BAND);
    expect(t.side).toBe("below");
    expect(t.top).toBeGreaterThanOrEqual(node.top + node.height + BAND);
    expect(t.left).toBe(EDGE);
  });
});

describe("submenus never cover the selection", () => {
  const cases: Array<[string, Box]> = [
    ["middle", { left: 500, top: 400, width: 80, height: 40 }],
    ["top edge", { left: 500, top: 10, width: 80, height: 40 }],
    ["bottom edge", { left: 500, top: 740, width: 80, height: 40 }],
    ["left edge", { left: 2, top: 400, width: 80, height: 40 }],
    ["right edge", { left: 1110, top: 400, width: 80, height: 40 }],
    ["top-left corner", { left: 2, top: 4, width: 80, height: 40 }],
    ["bottom-right corner", { left: 1110, top: 750, width: 80, height: 40 }],
    ["tall node", { left: 500, top: 60, width: 120, height: 680 }],
  ];
  for (const [name, node] of cases) {
    for (const [what, size] of [["palette", PALETTE], ["menu", MENU]] as const) {
      test(`${what} at ${name}`, () => {
        const t = placeToolbar(node, TOOLBAR, VIEW, BAND);
        const avoid = [grow(node, 28)];
        const s = placeSubmenu(t, size, VIEW, avoid);
        expect(within(s, VIEW)).toBe(true);
        // Fits somewhere clean in every case here except the full-height node, where it is only clamped.
        if (name !== "tall node") {
          expect(intersects(s, avoid[0]!)).toBe(false);
          expect(intersects(s, t)).toBe(false);
        }
      });
    }
  }
  test("opens on the toolbar's far side when there is room", () => {
    const node = { left: 500, top: 400, width: 80, height: 40 };
    const t = placeToolbar(node, TOOLBAR, VIEW, BAND);
    const s = placeSubmenu(t, PALETTE, VIEW, [grow(node, 28)]);
    expect(s.side).toBe("above");
    expect(s.top + s.height).toBeLessThanOrEqual(t.top);
  });
});

describe("tall menus in a short window", () => {
  // The live case: Obsidian's 14-item shape menu (362 px) on a node mid-window, 708 px of note.
  const nodes: Array<[string, Box]> = [
    ["middle", { left: 517, top: 366, width: 80, height: 48 }],
    ["left edge", { left: 290, top: 366, width: 80, height: 48 }],
    ["right edge", { left: 1500, top: 300, width: 80, height: 48 }],
    ["near top", { left: 700, top: 90, width: 80, height: 48 }],
    ["near bottom", { left: 700, top: 720, width: 80, height: 48 }],
  ];
  for (const [name, node] of nodes) {
    test(`never covers the node or the toolbar: ${name}`, () => {
      const t = placeToolbar(node, TOOLBAR, SHORT_VIEW, BAND);
      const avoid = [grow(node, 28)];
      const s = placeSubmenu(t, TALL, SHORT_VIEW, avoid);
      expect(intersects(s, avoid[0]!)).toBe(false);
      expect(intersects(s, t)).toBe(false);
      expect(within(s, SHORT_VIEW)).toBe(true);
      if (s.maxHeight !== undefined) expect(s.height).toBe(s.maxHeight);
    });
  }
});

test("visible bounds: the scroll container clipped to the viewport", () => {
  expect(visibleBounds({ left: 300, top: -200, width: 900, height: 2000 }, { width: 1000, height: 800 })).toEqual({ left: 300, top: 0, width: 700, height: 800 });
  expect(visibleBounds(null, { width: 10, height: 20 })).toEqual({ left: 0, top: 0, width: 10, height: 20 });
});

describe("node-actions cluster (U2)", () => {
  const view = { left: 0, top: 0, width: 1000, height: 800 };
  const size = { width: 70, height: 22 };
  const node = { left: 300, top: 200, width: 120, height: 40 };
  test("just outside the bottom-right corner (the resize handle's)", () => {
    const b = placeCluster(node, size, view);
    expect(b.left).toBe(420 + CLUSTER_GAP);
    expect(b.top).toBe(240 + CLUSTER_GAP / 2);
  });
  test("clear of the right and bottom '+' buttons (side midpoints, 22 px, 14 px out)", () => {
    const b = placeCluster(node, size, view);
    const rightPlus = { left: 420 + 14 - 11, top: 220 - 11, width: 22, height: 22 };
    const bottomPlus = { left: 360 - 11, top: 240 + 14 - 11, width: 22, height: 22 };
    expect(intersects(b, rightPlus)).toBe(false);
    expect(intersects(b, bottomPlus)).toBe(false);
    expect(intersects(b, node)).toBe(false);
  });
  test("mirrors left at the right edge, above at the bottom edge", () => {
    const b = placeCluster({ left: 900, top: 760, width: 90, height: 30 }, size, view);
    expect(b.left + b.width).toBe(900 - CLUSTER_GAP);
    expect(b.top + b.height).toBe(760 - CLUSTER_GAP / 2);
  });
  test("always inside the visible area", () => {
    const b = placeCluster({ left: -50, top: -50, width: 1100, height: 900 }, size, view);
    expect(b.left).toBeGreaterThanOrEqual(EDGE);
    expect(b.top).toBeGreaterThanOrEqual(EDGE);
    expect(b.left + b.width).toBeLessThanOrEqual(1000 - EDGE);
  });
});

describe("node-actions cluster clears the node resize handle", () => {
  const view = { left: 0, top: 0, width: 1000, height: 800 };
  const size = { width: 70, height: 22 };
  const node = { left: 300, top: 200, width: 120, height: 40 };
  test("a handle centred on the corner", () => {
    const handle = { left: 414, top: 234, width: 12, height: 12 };
    const b = placeCluster(node, size, view, handle);
    expect(intersects(b, handle)).toBe(false);
  });
  test("a media node's handle shifted 8 px out", () => {
    const handle = { left: 422, top: 242, width: 12, height: 12 };
    const b = placeCluster(node, size, view, handle);
    expect(intersects(b, handle)).toBe(false);
    expect(b.left).toBe(434 + HANDLE_GAP);
  });
});
