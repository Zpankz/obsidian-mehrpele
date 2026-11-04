import { describe, expect, test } from "bun:test";
import {
  parseBreadcrumbsOptions,
  parseDatacoreOptions,
  parseKeyValueOptions,
  parseTaskOptions,
} from "../../src/integrations/options";
import { normalizeIntegrationSettings } from "../../src/integrations/settings";

describe("parseKeyValueOptions", () => {
  test("supports colon, equals, lists and quotes", () => {
    const raw = parseKeyValueOptions('start: "Folder/My Note"\nfields: [up, down]\ndepth=3\ntags:\n  - work\n  - home\n');
    expect(raw.start).toBe("Folder/My Note");
    expect(raw.fields).toEqual(["up", "down"]);
    expect(raw.depth).toBe("3");
    expect(raw.tags).toEqual(["work", "home"]);
  });
});

describe("block option parsers", () => {
  test("breadcrumbs defaults and overrides", () => {
    expect(parseBreadcrumbsOptions("")).toMatchObject({ depth: 2, direction: "LR", implied: false });
    expect(parseBreadcrumbsOptions("start: Home\nfields: up, same\ndepth: 3\ndirection: TD\nimplied: true")).toMatchObject({
      start: "Home",
      fields: ["up", "same"],
      depth: 3,
      direction: "TD",
      implied: true,
    });
    expect(parseBreadcrumbsOptions("depth: 99").depth).toBe(10);
    expect(parseBreadcrumbsOptions("direction: XX").direction).toBe("LR");
  });

  test("datacore defaults and gantt view", () => {
    expect(parseDatacoreOptions("")).toMatchObject({ query: "@page", diagram: "flowchart" });
    expect(parseDatacoreOptions('query: "@page and #x"\ndiagram: gantt')).toMatchObject({
      query: "@page and #x",
      diagram: "gantt",
    });
  });

  test("tasks views and filters", () => {
    expect(parseTaskOptions("")).toMatchObject({ view: "gantt", tags: [] });
    expect(parseTaskOptions("view: kanban\ntags: [work]\nproject: Alpha")).toMatchObject({
      view: "kanban",
      tags: ["work"],
      project: "Alpha",
    });
    expect(parseTaskOptions("view: bogus").view).toBe("gantt");
  });
});

describe("normalizeIntegrationSettings", () => {
  test("all integrations off by default; partial data merges", () => {
    const s = normalizeIntegrationSettings(null);
    expect(s.breadcrumbs.enabled).toBe(false);
    expect(s.datacore.enabled).toBe(false);
    expect(s.tasknotes.enabled).toBe(false);
    const on = normalizeIntegrationSettings({ breadcrumbs: { enabled: true } as never });
    expect(on.breadcrumbs.enabled).toBe(true);
    expect(on.breadcrumbs.maxNodes).toBe(200);
  });
});
