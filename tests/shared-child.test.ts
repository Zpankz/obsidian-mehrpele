/**
 * sharedChild (src/shared-child.ts): registrations several holders need are
 * made once, on a child Component of the owner, and leave with the last holder.
 */
import { describe, expect, mock, test } from "bun:test";
import { Component, obsidianStub } from "./helpers/obsidian-stub";

mock.module("obsidian", () => obsidianStub);
const { sharedChild } = await import("../src/shared-child");

describe("sharedChild", () => {
  test("set up on the first acquire, torn down when the last holder releases", () => {
    const owner = new Component();
    owner.load();
    let setups = 0;
    const cleanups: string[] = [];
    const acquire = sharedChild(owner as never, (c) => {
      setups++;
      c.register(() => void cleanups.push("sweep"));
    });
    const base = owner._cleanups.length;
    const a = acquire();
    const b = acquire();
    expect(setups).toBe(1);
    expect(owner._children.length).toBe(1);
    a();
    a(); // twice: still one release
    expect(cleanups).toEqual([]);
    b();
    expect(cleanups).toEqual(["sweep"]);
    expect(owner._children.length).toBe(0);
    expect(owner._cleanups.length).toBe(base);
    // Needed again later: set up again.
    const c = acquire();
    expect(setups).toBe(2);
    c();
    expect(cleanups).toEqual(["sweep", "sweep"]);
  });

  test("the owner unloading first takes the child with it; a late release is harmless", () => {
    const owner = new Component();
    owner.load();
    const cleanups: string[] = [];
    const acquire = sharedChild(owner as never, (c) => c.register(() => void cleanups.push("sweep")));
    const a = acquire();
    owner.unload();
    expect(cleanups).toEqual(["sweep"]);
    a();
    expect(cleanups).toEqual(["sweep"]);
  });
});
