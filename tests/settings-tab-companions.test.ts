/** Companion detection for the settings tab's Requires rows. */
import { describe, expect, test } from "bun:test";
import { companionReady, companionStatus, COMPANIONS, detectCompanion, MIN_EXCALIDRAW_VERSION, missingCompanion, versionAtLeast } from "../src/features/companions";
import { MIN_EXCALIDRAW_VERSION as EA_MIN } from "../src/excalidraw/ea";
import { detectFlows, FLOWS } from "../src/features/companions";

test("Flows requires a live compatible registration, with disabled state taking precedence", () => {
  const pm = { manifests: {} as Record<string, { version: string }>, enabledPlugins: new Set<string>() };
  const registered = { version: "0.1.0", requiredHostMinor: 1 };
  expect(detectFlows(pm, 1, registered).kind).toBe("missing");
  pm.manifests[FLOWS.id] = { version: "0.1.0" };
  expect(detectFlows(pm, 1, registered).kind).toBe("disabled");
  pm.enabledPlugins.add(FLOWS.id);
  expect(detectFlows(pm, 1, registered).kind).toBe("ready");
  expect(detectFlows(pm, 1, { ...registered, requiredHostMinor: 2 }).detail).toContain("API 1.2");
  expect(detectFlows(pm, 0, registered).kind).toBe("update-needed");
  expect(detectFlows(pm, 1).detail).toContain("has not connected");
  pm.enabledPlugins.delete(FLOWS.id);
  expect(detectFlows(pm, 0, registered).kind).toBe("disabled");
});

describe("companions", () => {
  test("the Excalidraw minimum matches the converter's own", () => {
    expect(MIN_EXCALIDRAW_VERSION).toBe(EA_MIN);
  });

  test("detect: installed from the manifest, enabled only when also installed", () => {
    const pm = { manifests: { datacore: { version: "0.1.2" } }, enabledPlugins: new Set(["datacore", "breadcrumbs"]) };
    expect(detectCompanion(pm, "datacore")).toEqual({ installed: true, enabled: true, version: "0.1.2" });
    expect(detectCompanion(pm, "breadcrumbs")).toEqual({ installed: false, enabled: false, version: null });
    expect(detectCompanion(undefined, "datacore")).toEqual({ installed: false, enabled: false, version: null });
  });

  test("version gate and status text", () => {
    const ex = COMPANIONS.excalidraw![0]!;
    expect(versionAtLeast("2.29.0", "2.29.0")).toBe(true);
    expect(versionAtLeast("2.3.0", "2.29.0")).toBe(false);
    expect(versionAtLeast("3.0.0-beta", "2.29.0")).toBe(true);
    const old = { installed: true, enabled: true, version: "2.1.0" };
    expect(companionReady(ex, old)).toBe(false);
    expect(companionStatus(ex, old)).toBe(`Version 2.1.0 is too old (needs ${MIN_EXCALIDRAW_VERSION} or later).`);
    expect(companionStatus(ex, { installed: false, enabled: false, version: null })).toBe(`Not installed (needs ${MIN_EXCALIDRAW_VERSION} or later).`);
  });

  test("optional companions never count as missing", () => {
    expect(missingCompanion({}, "canvas")).toBeNull();
    expect(missingCompanion({}, "integrations.tasknotes")?.name).toBe("TaskNotes");
    expect(missingCompanion({}, "reflow")).toBeNull();
  });
});
