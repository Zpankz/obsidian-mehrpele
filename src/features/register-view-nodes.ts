/** Feature "view-nodes": web/PDF/workspace views in Mehrpele nodes and `%% pele-view %%` panels. */
import { installViewNodes } from "../mehrpele/views/plugin";
import { viewNodeOptions } from "../mehrpele/views/settings";
import type { FeatureContext } from "./types";

export function register({ plugin }: FeatureContext): void {
  installViewNodes(plugin, {
    settings: () => viewNodeOptions(plugin.settings),
    resolveDiagram: (wrapper) => {
      for (const f of [...plugin.frames, ...plugin.mehrShells]) {
        if (wrapper.parentElement === f.root) return { source: f.source, sourcePath: f.sourcePath, wrapper: wrapper as HTMLElement };
      }
      return null;
    },
  });
}
