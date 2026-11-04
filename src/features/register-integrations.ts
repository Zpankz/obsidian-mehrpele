/**
 * Features "integrations.*". The code blocks are core
 * (./integration-blocks.ts); Datacore also publishes the API here.
 */
import type { EventRef } from "obsidian";
import { publishPeleMermaid } from "../integrations/datacore/index";
import { extendedGraphDataPath, primeExtendedGraphSettings } from "../integrations/extended-graph/index";
import type { FeatureContext, FeatureModule } from "./types";

export const datacore: FeatureModule = {
  register({ plugin, component }: FeatureContext): void {
    component.register(publishPeleMermaid(plugin.integrationHost()));
  },
};

/** Extended Graph colours: EG persists its settings to data.json; keep a cached copy. */
export const extendedGraph: FeatureModule = {
  register({ plugin }: FeatureContext): void {
    const app = plugin.app;
    void primeExtendedGraphSettings(app);
    // `raw` (config-dir file changes) exists at runtime but isn't in the typings.
    const vaultEvents = app.vault as unknown as { on(name: "raw", callback: (path: string) => void): EventRef };
    plugin.registerEvent(
      vaultEvents.on("raw", (path) => {
        if (path === extendedGraphDataPath(app)) void primeExtendedGraphSettings(app);
      }),
    );
  },
};
