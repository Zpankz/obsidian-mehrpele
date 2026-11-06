/**
 * Registrations that several holders need at once (every frame with editing
 * attached needs the floating action bar sweep): made once, on a child
 * Component of `owner`, when the first holder acquires them, and removed with
 * that child when the last holder releases. Nothing stays on the owner.
 */
import { Component } from "obsidian";

/** Returns `acquire`; each call returns its own release (idempotent). */
export function sharedChild(owner: Component, setup: (child: Component) => void): () => () => void {
  let child: Component | null = null;
  let holders = 0;
  return () => {
    if (!child) {
      child = owner.addChild(new Component());
      setup(child);
    }
    holders++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--holders > 0 || !child) return;
      owner.removeChild(child);
      child = null;
    };
  };
}
