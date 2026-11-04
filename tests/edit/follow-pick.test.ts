import { describe, expect, test } from "bun:test";
import { pickResume, type ResumeCandidate } from "../../src/edit/follow-pick";

const leafA = { id: "a" };
const leafB = { id: "b" };
const c = (ref: string, leaf: unknown, order: number, ready = true, visible = true): ResumeCandidate<string> => ({ ref, leaf, order, ready, visible });

describe("pickResume: the selection comes back only where the edit was made", () => {
  test("the frame in the origin leaf, at the same place", () => {
    expect(pickResume([c("split", leafB, 0), c("here", leafA, 0)], { leaf: leafA, order: 0 })).toBe("here");
  });

  test("another leaf that settled first is never used: wait for the origin's frame", () => {
    expect(pickResume([c("split", leafB, 0), c("here", leafA, 0, false)], { leaf: leafA, order: 0 })).toBeNull();
  });

  test("a hidden duplicate (display:none tab) is never used, even in the same leaf", () => {
    expect(pickResume([c("hidden", leafA, 0, true, false)], { leaf: leafA, order: 0 })).toBeNull();
    expect(pickResume([c("hidden", leafB, 0, true, false), c("here", leafA, 0)], { leaf: leafA, order: 0 })).toBe("here");
  });

  test("a twin diagram in the same note is not taken while the edited one is still re-rendering", () => {
    expect(pickResume([c("twin", leafA, 1), c("edited", leafA, 0, false)], { leaf: leafA, order: 0 })).toBeNull();
    expect(pickResume([c("twin", leafA, 1), c("edited", leafA, 0)], { leaf: leafA, order: 0 })).toBe("edited");
  });

  test("when the leaf's diagrams were renumbered, the nearest ready one there", () => {
    expect(pickResume([c("far", leafA, 0), c("near", leafA, 2)], { leaf: leafA, order: 3 })).toBe("near");
  });

  test("frames outside any leaf (popovers) only match a popover origin", () => {
    expect(pickResume([c("leaf", leafA, 0), c("pop", null, 0)], { leaf: null, order: 0 })).toBe("pop");
    expect(pickResume([c("pop", null, 0)], { leaf: leafA, order: 0 })).toBeNull();
  });

  test("while the edited frame is not shown (mid re-render), the next diagram taking its place is not used", () => {
    // Its last place is the origin's; the next one now counts as order 0.
    expect(pickResume([c("next", leafA, 0), c("edited", leafA, 0, false, false)], { leaf: leafA, order: 0 })).toBeNull();
    // A diagram hidden elsewhere in the leaf (folded) does not block.
    expect(pickResume([c("edited", leafA, 0), c("folded", leafA, 3, false, false)], { leaf: leafA, order: 0 })).toBe("edited");
  });

  test("nothing ready: null", () => {
    expect(pickResume([], { leaf: leafA, order: 0 })).toBeNull();
  });
});
