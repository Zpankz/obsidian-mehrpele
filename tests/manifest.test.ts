import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Rules from the Obsidian community directory (Manifest + Submission requirements).
const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const versions = JSON.parse(readFileSync(join(root, "versions.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("manifest.json meets directory rules", () => {
  test("id: lowercase letters and hyphens, no 'obsidian', not ending in 'plugin'", () => {
    expect(manifest.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
    expect(manifest.id).not.toContain("obsidian");
    expect(manifest.id).not.toMatch(/plugin$/);
  });
  test("name: basic Latin, no 'Obsidian'", () => {
    expect(manifest.name).toMatch(/^[\x20-\x7e]+$/);
    expect(manifest.name).not.toMatch(/obsi|sidian/i);
  });
  test("description: ≤250 chars, ends with a period, no 'This plugin'", () => {
    expect(manifest.description.length).toBeLessThanOrEqual(250);
    expect(manifest.description).toMatch(/\.$/);
    expect(manifest.description).not.toMatch(/^this (is a )?plugin/i);
  });
  test("version is plain semver and matches package.json", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.version).toBe(manifest.version);
  });
  test("versions.json maps the current version to minAppVersion", () => {
    expect(versions[manifest.version]).toBe(manifest.minAppVersion);
  });
  test("required fields present; no fundingUrl unless donations are taken", () => {
    for (const k of ["id", "name", "version", "minAppVersion", "description", "author", "isDesktopOnly"]) expect(manifest).toHaveProperty(k);
    expect(manifest).not.toHaveProperty("fundingUrl");
  });
  test("a LICENSE ships beside the manifest", () => {
    expect(existsSync(join(root, "LICENSE"))).toBe(true);
  });
});
