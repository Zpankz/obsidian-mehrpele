/**
 * View nodes wired into the plugin with one call (main.ts):
 * the embed renderer (web / PDF / view: labels), the attached-view layer
 * (`%% pele-view %%`), the "Remove stale node views" command and teardown.
 */
import { Component, Notice, type Editor, type Plugin } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { AttachedViewsLayer, type DiagramResolver } from "./attach";
import { watchViewDocuments } from "./documents";
import { pruneNoteViews } from "./plugin-pure";
import { registerViewNodeRenderer } from "./renderer";
import type { ViewNodeSettings } from "./settings";
import type { ViewHub } from "./stage";

export interface ViewNodesInstall {
  hub: ViewHub;
  attached: AttachedViewsLayer;
}

export function installViewNodes(
  plugin: Plugin,
  opts: { settings: () => ViewNodeSettings; resolveDiagram: DiagramResolver },
): ViewNodesInstall {
  const host = {
    app: plugin.app,
    settings: opts.settings,
    notify: (m: string) => new Notice(m, 8000),
  };
  const { hub, unregister } = registerViewNodeRenderer(host);
  // Off then on again: the old renderer (destroyed hub) must not match first.
  plugin.register(unregister);
  const attached = new AttachedViewsLayer(host, hub, opts.resolveDiagram);
  watchViewDocuments(plugin, (doc) => {
    const child = plugin.addChild(new Component());
    child.registerDomEvent(doc, "pointermove", attached.onPointerMove, { passive: true });
    child.registerDomEvent(doc, "keydown", attached.onKeyDown);
    if (doc !== document) child.registerDomEvent(doc, "keydown", hub.onKeyNavigation, { capture: true });
    child.registerDomEvent(doc, "focusin", attached.onFocusIn);
    return () => { plugin.removeChild(child); };
  });
  plugin.registerEvent(plugin.app.workspace.on("layout-change", attached.onWorkspaceChange));
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", attached.onWorkspaceChange));
  plugin.register(() => {
    attached.destroy();
    hub.destroy();
  });
  plugin.addCommand({
    id: "show-attached-views",
    name: "Show attached views",
    checkCallback: (checking) => {
      const target = attached.keyboardTarget();
      if (!target) return false;
      if (!checking) attached.openFromKeyboard(target);
      return true;
    },
  });
  plugin.addCommand({
    id: "prune-node-views",
    name: "Remove stale attached views (%% pele-view %%) in this note",
    editorCallback: (editor: Editor) => {
      const cm = (editor as unknown as { cm?: EditorView }).cm;
      const plan = pruneNoteViews(editor.getValue());
      if (!cm || plan.length === 0) {
        new Notice("Pele: no stale attached views in this note.");
        return;
      }
      const doc = cm.state.doc;
      cm.dispatch({
        changes: plan.map((p) => ({ from: doc.line(p.firstLine + 1).from, to: doc.line(p.lastLine + 1).to, insert: p.body })),
        scrollIntoView: false,
      });
      new Notice(`Pele: removed stale attached views in ${plan.length} diagram${plan.length === 1 ? "" : "s"}.`);
    },
  });
  // Diagnostics for live checks (window.__peleViewNodes.hub.stats()).
  (window as unknown as { __peleViewNodes?: ViewNodesInstall }).__peleViewNodes = { hub, attached };
  plugin.register(() => {
    delete (window as unknown as { __peleViewNodes?: ViewNodesInstall }).__peleViewNodes;
  });
  return { hub, attached };
}
