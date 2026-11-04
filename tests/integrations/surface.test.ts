import { describe, expect, test } from "bun:test";
import { IntegrationSurface } from "../../src/integrations/host";

function setup() {
  const log: string[] = [];
  const el = {} as HTMLElement;
  const host = {
    renderSource: (src: string) => void log.push(`render:${src}`),
    releaseSource: () => void log.push("release"),
  };
  const surface = new IntegrationSurface(host, el, {} as never, (_el, m) => void log.push(`notice:${m}`));
  return { surface, log };
}

describe("IntegrationSurface (one frame per target, skip unchanged)", () => {
  test("unchanged generated source is not re-rendered (Datacore update storm)", () => {
    const { surface, log } = setup();
    expect(surface.show("graph TD\n A")).toBe(true);
    expect(surface.show("graph TD\n A")).toBe(false);
    expect(surface.show("graph TD\n A")).toBe(false);
    expect(surface.show("graph TD\n B")).toBe(true);
    expect(log).toEqual(["render:graph TD\n A", "render:graph TD\n B"]);
  });

  test("a notice releases the live frame first; release on unload", () => {
    const { surface, log } = setup();
    surface.show("x");
    surface.notice("no results");
    surface.notice("no results");
    surface.show("x");
    surface.release();
    expect(log).toEqual(["render:x", "release", "notice:no results", "render:x", "release"]);
  });
});
