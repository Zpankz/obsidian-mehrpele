import { expect, test } from "bun:test";
import { detectFlows, FLOWS } from "../src/features/companions";

test("Flows gives public BRAT and manual installation guidance, not a private repository link", async () => {
  expect(detectFlows(undefined, 1).detail).toContain("BRAT");
  expect(FLOWS.repository).toBe("Zpankz/obsidian-mehrpele-cannoli");
  expect(FLOWS.releaseUrl).toBe(`https://github.com/${FLOWS.repository}/releases/latest`);
  const help = FLOWS.installationHelp.join("\n");
  expect(help).toContain("{vaultConfig}/plugins/mehrpele-cannoli");
  for (const file of ["main.js", "manifest.json", "styles.css"]) expect(help).toContain(file);
  expect(help).toContain("Do not replace");
  expect(help).toContain("stop active flows");
  expect(help).toContain(FLOWS.repository);
  expect(help).not.toContain("https://github.com/Zpankz/mehrpele");
  const source = await Bun.file(new URL("../src/features/settings-tab.ts", import.meta.url)).text();
  const flowsBranch = source.slice(source.indexOf("if (id === FLOWS.id) {"), source.indexOf("const url = `obsidian://show-plugin"));
  expect(flowsBranch).toContain("new Modal(this.app)");
  expect(flowsBranch).toContain("FLOWS.installationHelp");
  expect(flowsBranch).toContain("modal.open()");
  expect(flowsBranch).toContain("this.app.vault.configDir");
  expect(flowsBranch).toContain("href: FLOWS.releaseUrl");
  expect(flowsBranch).toContain("href: FLOWS.installUrl");
  expect(flowsBranch).not.toContain("win.open");
});
