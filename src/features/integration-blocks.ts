/**
 * Code blocks of the integrations (`pele-datacore`, `pele-breadcrumbs`,
 * `pele-tasks`). Obsidian cannot unregister a code block processor, so each
 * language is registered once per plugin life and checks its toggle on every
 * render: off shows a hint, on reaches the handler lazily. Toggling
 * re-renders open notes, which unloads the rendered blocks and their listeners.
 */
import type { MarkdownPostProcessorContext } from "obsidian";
import type PeleMermaidPlugin from "../../main";
import type { IntegrationHost } from "../integrations/host";
import { isEnabledV3, type ToggleId } from "../settings/schema";
import * as lazy from "./lazy";

type Handler = (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => void;

export interface IntegrationBlock {
  lang: string;
  id: ToggleId;
  name: string;
  make(host: IntegrationHost): Handler;
}

export const INTEGRATION_BLOCKS: readonly IntegrationBlock[] = [
  { lang: "pele-datacore", id: "integrations.datacore", name: "Datacore", make: (h) => lazy.datacore().makeDatacoreHandler(h) },
  { lang: "pele-breadcrumbs", id: "integrations.breadcrumbs", name: "Breadcrumbs", make: (h) => lazy.breadcrumbs().makeBreadcrumbsHandler(h) },
  { lang: "pele-tasks", id: "integrations.tasknotes", name: "TaskNotes", make: (h) => lazy.tasknotes().makeTasksHandler(h) },
];

export const integrationOffText = (name: string): string => `Turn on ${name} in Mehrpele settings`;

/** Call once from onload. */
export function registerIntegrationBlocks(plugin: PeleMermaidPlugin): void {
  for (const block of INTEGRATION_BLOCKS) {
    let handler: Handler | undefined;
    plugin.registerMarkdownCodeBlockProcessor(block.lang, (source, el, ctx) => {
      if (!isEnabledV3(plugin.settings, block.id)) {
        // The block's own document, so popout windows work.
        el.createDiv({ cls: "pele-integration-notice", text: integrationOffText(block.name) });
        return;
      }
      (handler ??= block.make(plugin.integrationHost()))(source, el, ctx);
    });
  }
}
