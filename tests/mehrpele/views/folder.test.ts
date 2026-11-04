import { describe, expect, test } from "bun:test";
import { parseSoleEmbed } from "../../../src/mehrpele/model";
import { isNoteTarget } from "../../../src/mehrpele/nested";
import { isNodeViewTarget, isViewNodeLabel, parseNodeViewTarget, viewSpecKey } from "../../../src/mehrpele/views/syntax";

const t = (md: string) => parseSoleEmbed(md)!;

describe("folder embeds (syntax)", () => {
  test("![[folder/]], alias tokens, view:folder", () => {
    expect(parseNodeViewTarget(t("![[Projects/]]"))).toEqual({ kind: "folder", folder: { path: "Projects", recursive: false, view: "table" } });
    expect(parseNodeViewTarget(t("![[Work/Projects/|recursive|cards|640x400]]"))).toEqual({ kind: "folder", folder: { path: "Work/Projects", recursive: true, view: "cards" } });
    expect(parseNodeViewTarget(t("![[view:folder?path=Projects&recursive=1&view=list]]"))).toEqual({ kind: "folder", folder: { path: "Projects", recursive: true, view: "list" } });
    expect(parseNodeViewTarget(t("![[view:folder]]"))).toEqual({ error: "view:folder needs path=…" });
  });

  test("folders are fixed viewports and view nodes (no auto height, no text editing)", () => {
    expect(isNodeViewTarget(t("![[Projects/]]"))).toBe(true);
    expect(isNoteTarget(t("![[Projects/]]"))).toBe(false);
    expect(isViewNodeLabel('"![[Projects/|recursive]]"')).toBe(true);
    // A bare name is a folder only with the vault at hand (the toolbar passes the lookup).
    expect(isViewNodeLabel('"![[v1.2]]"')).toBe(false);
    expect(isViewNodeLabel('"![[v1.2]]"', (tg) => tg.linkpath === "v1.2")).toBe(true);
  });

  test("identity ignores size, follows path, depth and view", () => {
    const a = parseNodeViewTarget(t("![[Projects/|300x200]]"))!;
    const b = parseNodeViewTarget(t("![[Projects/|600x400]]"))!;
    const c = parseNodeViewTarget(t("![[Projects/|recursive]]"))!;
    expect(viewSpecKey(a as never)).toBe(viewSpecKey(b as never));
    expect(viewSpecKey(a as never)).not.toBe(viewSpecKey(c as never));
  });
});
