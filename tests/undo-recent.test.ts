import { expect, test } from "bun:test";
import { RECENT_MS, recentDiagram } from "../src/undo-recent";

// Mod+Z with nothing focused falls back to the diagram last pressed in. A
// diagram in a background tab is still connected but hidden: undoing there
// would change a note the user can't see.
const el = (o: { connected?: boolean; shown?: boolean } = {}) =>
  ({ isConnected: o.connected ?? true, isShown: () => o.shown ?? true }) as unknown as Element;

test("a recent, connected, visible diagram is the fallback target", () => {
  const e = el();
  expect(recentDiagram({ el: e, at: 1000 }, 2000)).toBe(e);
});

test("a diagram in a hidden (background) tab is not", () => {
  expect(recentDiagram({ el: el({ shown: false }), at: 1000 }, 2000)).toBeNull();
});

test("a detached or stale diagram is not", () => {
  expect(recentDiagram({ el: el({ connected: false }), at: 1000 }, 2000)).toBeNull();
  expect(recentDiagram({ el: el(), at: 0 }, RECENT_MS + 1)).toBeNull();
  expect(recentDiagram(null, 0)).toBeNull();
});
