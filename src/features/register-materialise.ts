/** Feature "materialise": materialise a diagram as notes. */
import { materialiseFor } from "../materialise";
import type { FeatureContext } from "./types";

export function register({ plugin }: FeatureContext): void {
  materialiseFor(plugin).registerCommands(plugin);
}
