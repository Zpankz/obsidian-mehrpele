/** Feature "cli": Obsidian CLI handlers (desktop). Registered once (no CLI unregister): off makes
 * the handlers answer "feature off" at once; they go on reload. */
import { registerCliCommands } from "../cli/handlers";
import type { FeatureContext } from "./types";

export function register({ plugin }: FeatureContext): void {
  registerCliCommands(plugin);
}
