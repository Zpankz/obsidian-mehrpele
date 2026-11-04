/** Feature "bases": the Mehrpele diagram view for Bases. Registered once (no Bases unregister): off makes
 * the view inert at once; the registration itself goes on reload. */
import { registerMehrpeleBasesView } from "../mehrpele/index";
import type { FeatureContext } from "./types";

export function register({ plugin }: FeatureContext): void {
  registerMehrpeleBasesView(plugin, plugin.mehrBasesDeps());
}
