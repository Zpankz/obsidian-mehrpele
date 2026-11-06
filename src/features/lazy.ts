/**
 * On-demand access to feature code from the core. Each accessor runs its
 * module on first call (esbuild turns the in-bundle `require` into a lazy
 * module init), so nothing here runs at plugin load. Core code must reach
 * feature modules through these or the registry (tests/lazy-guard.test.ts).
 */

/**
 * The in-bundle CommonJS `require` esbuild resolves at build time. Declared
 * here (erased at compile time) so each `require("…")` below is typed as the
 * module it loads instead of `any`.
 */
declare const require: <T>(id: string) => T;

const once = <T>(load: () => T): (() => T) => {
  let m: T | undefined;
  return () => (m ??= load());
};

/** Mehrpele (Markdown labels): first Mehrpele block, lightbox or nested diagram. */
export const mehrpele = once<typeof import("../mehrpele/index")>(() => require("../mehrpele/index"));
export const mehrpeleShell = once<typeof import("../mehrpele/shell")>(() => require("../mehrpele/shell"));
export const mehrpeleViewport = once<typeof import("../mehrpele/viewport")>(() => require("../mehrpele/viewport"));

/** Edit toolbar and inline editing: first frame with editing on. */
export const edit = once<typeof import("../edit/index")>(() => require("../edit/index"));
export const floatActions = once<typeof import("../edit/float-actions")>(() => require("../edit/float-actions"));

/** Repair, validation commands, SVG export: first command or repair. */
export const repairHost = once<typeof import("../repair/host")>(() => require("../repair/host"));
export const editorCommands = once<typeof import("../editor-commands")>(() => require("../editor-commands"));

/** Diagram → canvas: first conversion. */
export const canvas = once<typeof import("pele-render/canvas")>(() => require("pele-render/canvas"));
export const canvasFiles = once<typeof import("../canvas/files")>(() => require("../canvas/files"));

/** Settings tab definitions (built when the tab is added, for search); integration helpers: first use. */
export const settingsTab = once<typeof import("../settings-tab/index")>(() => require("../settings-tab/index"));
export const generatorContext = once<typeof import("../integrations/generator-context")>(() =>
  require("../integrations/generator-context"),
);
export const datacore = once<typeof import("../integrations/datacore/index")>(() => require("../integrations/datacore/index"));
export const breadcrumbs = once<typeof import("../integrations/breadcrumbs/index")>(() =>
  require("../integrations/breadcrumbs/index"),
);
export const tasknotes = once<typeof import("../integrations/tasknotes/index")>(() => require("../integrations/tasknotes/index"));
export const extendedGraph = once<typeof import("../integrations/extended-graph/index")>(() =>
  require("../integrations/extended-graph/index"),
);
