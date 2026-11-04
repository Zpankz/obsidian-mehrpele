/** Obsidian CLI (pele:*) handler registration. */
import {
  Platform, requireApiVersion, TFile, type CliData
} from "obsidian";
import { render } from "pele-render/pele";
import { sanitizedSvgMarkup } from "../sanitize-svg";
import {
  repairDiagram
} from "pele-render/repair";
import {
  mermaidToCanvas,
  sourceHash as canvasSourceHashOf,
  stringifyCanvas,
  type CanvasData,
} from "pele-render/canvas";
import {
  applyRepairsToText,
  buildCheckSummaryAsync,
  buildRepairSummary,
  fromCanvasLang,
  repairResultEntry,
  type RepairResultEntry,
  canvasFileName,
  canvasSourceHash,
  chooseCanvasTarget,
  cliFlag,
  isWholeFileDiagram,
  mergeUserCanvasContent,
  validateOutPath,
  DIAGRAM_TYPES,
  diagramsOf,
  diagramRenderSource,
  formatCheckText,
  guardOutput,
  inVaultFolder,
  parseIndexParam,
  type NoteInput,
} from "../cli-handlers";
import { repairOptions, toRepairOptions } from "../repair-settings";
import { convertCanvasFile } from "../canvas-convert-ui";
import { MaterialiseController, materialiseFor } from "../materialise";
import {
  toMountOptions
} from "../settings";
import type PeleMermaidPlugin from "../../main";
import { pngBlobFromSvg } from "../frame-menus";
import { buildJevProvider, buildLlmProvider } from "../repair-host";

// -- Obsidian CLI handlers ----------------------------------------------------

export function cliResolveFile(plugin: PeleMermaidPlugin, params: CliData): TFile {
  if (params.path) {
    const f = plugin.app.vault.getAbstractFileByPath(params.path);
    if (!f) throw new Error(`File "${params.path}" not found.`);
    if (!(f instanceof TFile)) throw new Error(`"${params.path}" is a folder, not a file.`);
    return f;
  }
  if (params.file) {
    const f = plugin.app.metadataCache.getFirstLinkpathDest(params.file, "");
    if (!f) throw new Error(`File "${params.file}" not found.`);
    return f;
  }
  throw new Error("Missing required parameter: path=<path> (or file=<name>)");
}

/** Notes for pele:check, read lazily (a folder scan streams one file at a time). */
export async function* cliNotes(plugin: PeleMermaidPlugin, params: CliData): AsyncGenerator<NoteInput> {
  if (params.folder !== undefined) {
    const folder = params.folder;
    const files = plugin.app.vault
      .getFiles()
      .filter((f) => ["md", "markdown", "mmd", "mermaid"].includes(f.extension.toLowerCase()))
      .filter((f) => inVaultFolder(f.path, folder))
      .sort((a, b) => a.path.localeCompare(b.path));
    for (const f of files) {
      yield {
        file: f.path,
        content: await plugin.app.vault.cachedRead(f),
        wholeFile: isWholeFileDiagram(f.extension),
      };
    }
    return;
  }
  const file = cliResolveFile(plugin, params);
  yield {
    file: file.path,
    content: await plugin.app.vault.cachedRead(file),
    wholeFile: isWholeFileDiagram(file.extension),
  };
}

/**
 * Write CLI output into the vault. Refuses to replace an existing file
 * unless `overwrite`, never replaces a folder, and creates missing parent
 * folders. `path` must already be validated (validateOutPath).
 */
export async function cliWriteFile(plugin: PeleMermaidPlugin, path: string, data: string | ArrayBuffer, overwrite: boolean): Promise<void> {
  const existing = plugin.app.vault.getAbstractFileByPath(path);
  if (existing && !(existing instanceof TFile)) throw new Error(`pele: ${path} is a folder`);
  if (existing && !overwrite) throw new Error(`pele: ${path} exists; pass force to overwrite`);
  if (existing instanceof TFile) {
    if (typeof data === "string") await plugin.app.vault.modify(existing, data);
    else await plugin.app.vault.modifyBinary(existing, data);
    return;
  }
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir && !plugin.app.vault.getAbstractFileByPath(dir)) {
    try {
      await plugin.app.vault.createFolder(dir);
    } catch {
      /* created concurrently, or create() below reports the real error */
    }
  }
  if (typeof data === "string") await plugin.app.vault.create(path, data);
  else await plugin.app.vault.createBinary(path, data);
}

/** Headless render source: Mehrpele labels read as their fallback text. */
export function renderSourceOf(plugin: PeleMermaidPlugin, d: { lang: string; code: string }): string {
  return diagramRenderSource(d, (lang, code) => plugin.isMehrpeleBlock(lang, code));
}

export function cliRenderSvg(plugin: PeleMermaidPlugin, source: string, theme: string | undefined): string {
  const svg = sanitizedSvgMarkup(render(source, toMountOptions(plugin.settings)).svg, plugin.settings.core.security.sanitize);
  if (!theme || theme === "none") return svg;
  const palettes: Record<string, string> = {
    light:
      "--pele-bg:#ffffff;--pele-fg:#1a1a1a;--pele-muted:#6a6a6a;--pele-line:#1a1a1a;--pele-surface:#f2f2f2;--pele-surface-alt:#e8e8e8;--pele-border:#d8d8d8;--pele-accent:#7c3aed;",
    dark:
      "--pele-bg:#1e1e1e;--pele-fg:#e8e8e8;--pele-muted:#9a9a9a;--pele-line:#e8e8e8;--pele-surface:#2a2a2a;--pele-surface-alt:#333333;--pele-border:#444444;--pele-accent:#a78bfa;",
  };
  const vars = palettes[theme] ?? "";
  if (!vars) return svg;
  return svg.replace(/<svg([^>]*)>/, `<svg$1><style>svg.pele{${vars}}</style>`);
}

export const CLI_OFF = "pele: feature off (turn on Obsidian CLI handlers in Mehrpele settings)";

export function registerCliCommands(plugin: PeleMermaidPlugin): void {
  if (!Platform.isDesktopApp || Platform.isMobile) return;
  try {
    if (!requireApiVersion("1.12.2")) return;
  } catch {
    return;
  }
  if (typeof (plugin as unknown as { registerCliHandler?: unknown }).registerCliHandler !== "function") return;
  const reg = (
    id: string,
    desc: string,
    flags: Record<string, { value?: string; description: string }> | null,
    handler: (p: CliData) => Promise<string>,
  ): void => {
    try {
      // No CLI unregister: handlers stay until reload, answering "feature off" while the toggle is off.
      plugin.registerCliHandler(id, desc, flags, async (p) => (plugin.settings.features.cli.enabled ? handler(p) : CLI_OFF));
    } catch (e) {
      console.error(`[pele-mermaid] CLI handler ${id} failed to register`, e);
    }
  };

  reg("pele", "Pele diagram tools (see: help pele)", null, async () =>
    [
      "pele:types     List supported diagram types",
      "pele:check     Validate diagrams in a note or folder",
      "pele:render    Render a diagram to SVG/PNG",
      "pele:export    Export every diagram in a note to a folder",
      "pele:repair    Repair broken diagrams (dry-run unless write)",
      "pele:canvas    Convert a diagram to a .canvas file",
      "pele:from-canvas  Convert a .canvas file to a diagram block",
      "pele:materialise  Turn a diagram into notes (JSON; dry-run)",
      "pele:excalidraw   Convert a diagram to an Excalidraw drawing",
    ].join("\n"),
  );
  reg("pele:types", "List supported diagram types", { format: { value: "text|json", description: "Output format" } }, async (p) =>
    p.format === "json" ? JSON.stringify([...DIAGRAM_TYPES], null, 2) : DIAGRAM_TYPES.join("\n"),
  );
  reg(
    "pele:check",
    "Validate mermaid/pele diagrams in a note or folder",
    {
      path: { value: "<path>", description: "Vault-relative note path" },
      file: { value: "<name>", description: "Note name (linkpath)" },
      folder: { value: "<folder>", description: "Folder to scan recursively (. = vault root)" },
      format: { value: "text|json", description: "Output format" },
      strict: { description: "Throw the first error when any diagram is invalid" },
      out: { value: "<path>", description: "Write the report to a vault .json/.txt file (large folders)" },
      force: { description: "Overwrite an existing out= file" },
    },
    async (p) => {
      // Validate out= before the (possibly long) scan.
      const out = p.out !== undefined ? validateOutPath(p.out, [".json", ".txt", ".md"]) : null;
      const summary = await buildCheckSummaryAsync(cliNotes(plugin, p), {
        yieldEvery: 10,
        isMehrpele: (lang, code) => plugin.isMehrpeleBlock(lang, code),
      });
      if (cliFlag(p.strict) && summary.invalid > 0) {
        const e = summary.errors[0];
        throw new Error(`Pele: [${e.code}] (${e.type ?? "unknown"}) at ${e.line ?? "?"}:${e.column ?? "?"} — ${e.message}`);
      }
      const report = p.format === "json" ? JSON.stringify(summary, null, 2) : formatCheckText(summary);
      if (out) {
        await cliWriteFile(plugin, out, report, cliFlag(p.force));
        return `Wrote ${out} (${summary.diagrams - summary.invalid}/${summary.diagrams} valid)`;
      }
      return guardOutput(report);
    },
  );
  reg(
    "pele:render",
    "Render a diagram to SVG/PNG",
    {
      path: { value: "<path>", description: "Vault-relative note path" },
      file: { value: "<name>", description: "Note name (linkpath)" },
      index: { value: "<n>", description: "0-based diagram index" },
      out: { value: "<path>", description: "Output .svg/.png file, or folder for all diagrams" },
      format: { value: "svg|png", description: "Output format" },
      theme: { value: "light|dark|auto|none", description: "Theme palette" },
      force: { description: "Overwrite existing output files" },
    },
    async (p) => {
      const file = cliResolveFile(plugin, p);
      const note: NoteInput = {
        file: file.path,
        content: await plugin.app.vault.cachedRead(file),
        wholeFile: isWholeFileDiagram(file.extension),
      };
      const diagrams = diagramsOf(note);
      if (diagrams.length === 0) throw new Error(`pele: no mermaid/pele diagrams in ${file.path}`);
      const format = p.format ?? "svg";
      if (format !== "svg" && format !== "png") throw new Error(`pele: unknown format "${format}" (expected svg|png)`);
      if (format === "png" && !p.out) throw new Error("pele: format=png requires out=<path>");
      const force = cliFlag(p.force);
      const writeOne = async (d: (typeof diagrams)[number], name: string): Promise<string> => {
        const svg = cliRenderSvg(plugin, renderSourceOf(plugin, d), p.theme);
        if (format === "png") {
          const blob = await pngBlobFromSvg(plugin, svg, 800, 600);
          if (!blob) throw new Error("pele: could not render PNG");
          await cliWriteFile(plugin, name, await blob.arrayBuffer(), force);
        } else {
          await cliWriteFile(plugin, name, svg, force);
        }
        return `Wrote ${name} (${format})`;
      };
      if (p.index === undefined && p.out && diagrams.length > 1) {
        const folder = validateOutPath(p.out);
        const lines: string[] = [];
        for (const d of diagrams) {
          lines.push(await writeOne(d, `${folder}/${file.basename}-${d.index + 1}.${format}`));
        }
        return lines.join("\n");
      }
      const idx = parseIndexParam(p.index, diagrams.length, file.path);
      const d = diagrams[idx];
      if (!p.out) return guardOutput(format === "svg" ? cliRenderSvg(plugin, renderSourceOf(plugin, d), p.theme) : "");
      return writeOne(d, validateOutPath(p.out, [`.${format}`]));
    },
  );
  reg(
    "pele:export",
    "Export every diagram in a note to a folder",
    {
      path: { value: "<path>", description: "Vault-relative note path" },
      file: { value: "<name>", description: "Note name (linkpath)" },
      folder: { value: "<folder>", description: "Destination folder" },
      format: { value: "svg|png", description: "Output format" },
      theme: { value: "light|dark|auto|none", description: "Theme palette" },
      force: { description: "Overwrite existing files (default: skip them)" },
    },
    async (p) => {
      const file = cliResolveFile(plugin, p);
      const folder = validateOutPath(
        p.folder ?? `${file.parent?.path ? `${file.parent.path}/` : ""}${file.basename}-diagrams`,
      );
      const note: NoteInput = {
        file: file.path,
        content: await plugin.app.vault.cachedRead(file),
        wholeFile: isWholeFileDiagram(file.extension),
      };
      const diagrams = diagramsOf(note);
      if (diagrams.length === 0) throw new Error(`pele: no mermaid/pele diagrams in ${file.path}`);
      const format = p.format ?? "svg";
      if (format !== "svg" && format !== "png") throw new Error(`pele: unknown format "${format}" (expected svg|png)`);
      const force = cliFlag(p.force);
      let written = 0;
      let skipped = 0;
      let failed = 0;
      const lines: string[] = [];
      for (const d of diagrams) {
        const name = `${folder}/${file.basename}-${d.index + 1}.${format}`;
        if (!force && plugin.app.vault.getAbstractFileByPath(name)) {
          skipped++;
          lines.push(`Skipped ${name} (exists; pass force to overwrite)`);
          continue;
        }
        try {
          const svg = cliRenderSvg(plugin, renderSourceOf(plugin, d), p.theme);
          if (format === "png") {
            const blob = await pngBlobFromSvg(plugin, svg, 800, 600);
            if (!blob) throw new Error("png failed");
            await cliWriteFile(plugin, name, await blob.arrayBuffer(), true);
          } else {
            await cliWriteFile(plugin, name, svg, true);
          }
          written++;
          lines.push(`Wrote ${name}`);
        } catch (e) {
          failed++;
          lines.push(`Failed ${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      lines.push(`${written} written, ${skipped} skipped, ${failed} failed`);
      return lines.join("\n");
    },
  );
  reg(
    "pele:repair",
    "Repair broken diagrams (uses configured providers)",
    {
      path: { value: "<path>", description: "Vault-relative note path" },
      file: { value: "<name>", description: "Note name (linkpath)" },
      index: { value: "<n>", description: "0-based diagram index (default: all)" },
      tiers: { value: "<linter,jev,llm>", description: "Comma list of tiers" },
      write: { description: "Apply fixes (default is dry-run)" },
      format: { value: "text|json", description: "Output format (json = pele-render repair --format json shape)" },
    },
    async (p) => {
      const file = cliResolveFile(plugin, p);
      const tierList = (p.tiers ?? "linter").split(",").map((t) => t.trim()).filter(Boolean);
      for (const t of tierList) {
        if (!["linter", "jev", "llm"].includes(t)) throw new Error(`pele: unknown repair tier "${t}" (expected linter,jev,llm)`);
      }
      const wholeFile = isWholeFileDiagram(file.extension);
      const content = await plugin.app.vault.cachedRead(file);
      const diagrams = diagramsOf({ file: file.path, content, wholeFile });
      const targetIdx = p.index !== undefined ? [parseIndexParam(p.index, diagrams.length, file.path)] : diagrams.map((d) => d.index);
      // The tier choice is passed down; saved settings are never swapped
      // (other repairs may run concurrently while providers await).
      const repairSettings = {
        ...repairOptions(plugin.settings),
        tierLinter: tierList.includes("linter"),
        tierJev: tierList.includes("jev"),
        tierLlm: tierList.includes("llm"),
      };
      const json = p.format === "json";
      if (p.format !== undefined && !json && p.format !== "text") throw new Error(`pele: unknown format "${p.format}" (expected text|json)`);
      let repaired = 0;
      let failed = 0;
      const results: RepairResultEntry[] = [];
      const replacements: { line: number; old: string; next: string }[] = [];
      for (const idx of targetIdx) {
        const d = diagrams[idx];
        if (!d) continue;
        const ref = { file: file.path, index: d.index, line: d.line };
        if (plugin.validateDiagram(d.lang, d.code).ok) {
          results.push(repairResultEntry(ref, { ok: true, fixes: [], attempts: [], unchanged: true }));
          continue;
        }
        const result = await repairDiagram(d.code, toRepairOptions(repairSettings, {
          jev: buildJevProvider(plugin, repairSettings),
          llm: buildLlmProvider(plugin, repairSettings),
        }));
        results.push(repairResultEntry(ref, result));
        if (result.ok && result.source && result.source !== d.code) {
          repaired++;
          replacements.push({ line: d.line, old: d.code, next: result.source });
        } else if (!result.ok) failed++;
      }
      let writeNote = "";
      if (cliFlag(p.write) && replacements.length > 0) {
        let applied = 0;
        let skipped = 0;
        await plugin.app.vault.process(file, (data) => {
          const r = applyRepairsToText(data, wholeFile, replacements);
          applied = r.applied;
          skipped = r.skipped;
          return r.text;
        });
        if (applied === 0) {
          if (json) throw new Error(`pele: repair aborted: ${file.path} changed while repairing; re-run`);
          return `pele: repair aborted: ${file.path} changed while repairing; re-run`;
        }
        if (skipped > 0) writeNote = `, ${skipped} not written (block changed or not found)`;
      }
      if (json) return guardOutput(JSON.stringify(buildRepairSummary(results), null, 2));
      return `Repaired ${repaired}/${targetIdx.length} diagram(s) in ${file.path} (tiers: ${tierList.join(",")}, ${failed} failed${writeNote})${cliFlag(p.write) ? "" : " [dry-run]"}`;
    },
  );
  reg(
    "pele:canvas",
    "Convert a diagram to a .canvas file",
    {
      path: { value: "<path>", description: "Vault-relative note path" },
      file: { value: "<name>", description: "Note name (linkpath)" },
      index: { value: "<n>", description: "0-based diagram index" },
      out: { value: "<path>", description: "Output .canvas path" },
      advanced: { value: "true|false", description: "Emit Advanced Canvas attributes (default: when Advanced Canvas is installed)" },
      force: { description: "Overwrite an existing out= file made from another diagram" },
    },
    async (p) => {
      const file = cliResolveFile(plugin, p);
      const content = await plugin.app.vault.cachedRead(file);
      const diagrams = diagramsOf({ file: file.path, content, wholeFile: isWholeFileDiagram(file.extension) });
      if (diagrams.length === 0) throw new Error(`pele: no mermaid/pele diagrams in ${file.path}`);
      const idx = parseIndexParam(p.index, diagrams.length, file.path);
      const d = diagrams[idx];
      const opts = {
        advancedCanvas: p.advanced !== undefined ? cliFlag(p.advanced) : plugin.advancedCanvasInstalled(),
        mehrpele: d.lang === "mehrpele" || plugin.appliesMehrpele(d.lang, d.code),
        sourcePath: file.path,
      };
      const fresh = mermaidToCanvas(d.code, opts).canvas;
      const hash = canvasSourceHash(fresh) ?? canvasSourceHashOf(d.code);
      if (p.out) {
        const name = validateOutPath(p.out, [".canvas"]);
        const existingText = await plugin.readVaultText(name);
        let canvas = fresh;
        if (existingText !== null) {
          let previous: CanvasData | null = null;
          try {
            previous = JSON.parse(existingText) as CanvasData;
          } catch {
            previous = null;
          }
          // Re-exporting the same diagram updates its own canvas (keeping
          // layout and user cards); anything else needs force.
          if (previous && canvasSourceHash(previous) === hash) {
            canvas = mergeUserCanvasContent(mermaidToCanvas(d.code, { ...opts, previous }).canvas, previous);
          } else if (!cliFlag(p.force)) {
            throw new Error(`pele: ${name} exists and was not made from this diagram; pass force to overwrite`);
          }
        }
        await cliWriteFile(plugin, name, stringifyCanvas(canvas), true);
        return `Wrote ${name}${existingText !== null ? " (updated)" : ""}`;
      }
      const target = await chooseCanvasTarget<CanvasData>(
        (n) => canvasFileName(file.path, hash, file.parent?.path ?? "", n),
        hash,
        (path) => plugin.readVaultText(path),
      );
      const canvas =
        target.kind === "merge"
          ? mergeUserCanvasContent(mermaidToCanvas(d.code, { ...opts, previous: target.previous }).canvas, target.previous)
          : fresh;
      await cliWriteFile(plugin, target.path, stringifyCanvas(canvas), target.kind === "merge");
      // pele-render's bridge requires every line to start with "Wrote ".
      return `Wrote ${target.path}${target.kind === "merge" ? " (updated)" : ""}`;
    },
  );
  reg(
    "pele:from-canvas",
    "Convert a .canvas file to a diagram block",
    {
      path: { value: "<path>", description: "Vault-relative .canvas path" },
      lang: { value: "mermaid|mehrpele", description: "Output fence (default: mehrpele when the canvas needs Markdown labels or Mehrpele is enabled)" },
      mehrpele: { description: "Output a mehrpele block (same as lang=mehrpele)" },
      portals: { value: "link|inline", description: "Portal mode" },
      "portal-depth": { value: "<n>", description: "Inline portal depth (default: setting)" },
      layout: { value: "canvas|auto", description: "canvas pins card positions (default: setting)" },
      scale: { value: "<n>", description: "Canvas px per diagram unit (default: the canvas's own, else 1)" },
    },
    async (p) => {
      const file = cliResolveFile(plugin, p);
      if (file.extension !== "canvas") throw new Error(`pele: ${file.path} is not a .canvas file`);
      const explicit = p.lang !== undefined || p.mehrpele !== undefined ? fromCanvasLang(p, plugin.settings.features["live-view"].enabled) : undefined;
      const depth = p["portal-depth"] !== undefined ? Number.parseInt(p["portal-depth"], 10) : undefined;
      if (depth !== undefined && !(depth >= 0 && depth <= 5)) throw new Error(`pele: portal-depth must be 0-5`);
      if (p.layout !== undefined && p.layout !== "canvas" && p.layout !== "auto") throw new Error(`pele: layout must be canvas|auto`);
      if (p.portals !== undefined && p.portals !== "inline" && p.portals !== "link") throw new Error(`pele: portals must be link|inline`);
      const scale = p.scale !== undefined ? Number(p.scale) : undefined;
      if (scale !== undefined && !(scale > 0 && scale <= 100)) throw new Error(`pele: scale must be a number > 0`);
      const block = await convertCanvasFile(plugin, file, {
        lang: explicit,
        layout: p.layout as "canvas" | "auto" | undefined,
        portals: p.portals === "inline" ? "inline" : p.portals === "link" ? "link" : undefined,
        portalDepth: depth,
        scale,
      });
      if (!block) throw new Error(`pele: ${file.path} is not a valid .canvas (JSON) file`);
      return block.block;
    },
  );

  reg("pele:materialise", "Materialise a diagram as notes (JSON; dry-run supported)", MaterialiseController.cliFlags, async (p) => {
    const file = cliResolveFile(plugin, p);
    const count = diagramsOf({ file: file.path, content: await plugin.app.vault.cachedRead(file) }).length;
    if (count === 0) throw new Error(`pele: no mermaid/pele diagrams in ${file.path}`);
    return guardOutput(await materialiseFor(plugin).cli(file, parseIndexParam(p.index, count, file.path), p, cliFlag));
  });

  // The retired pele-excalidraw plugin registers its own pele:excalidraw while enabled: stand down.
  // Otherwise the handler stays registered and follows the "excalidraw" toggle at call time.
  if (!plugin.excalidrawStandsDown()) {
    reg(
      "pele:excalidraw",
      "Convert a diagram in a note to an Excalidraw drawing",
      {
        path: { value: "<path>", description: "Note path" },
        index: { value: "<n>", description: "Diagram index (0-based; mermaid/pele/mehrpele fences in document order)" },
        out: { value: "<path>", description: "Vault-relative output path ending in .excalidraw.md or .excalidraw" },
        force: { description: "Overwrite out= if it already exists" },
        format: { value: "json|text", description: "Output format" },
      },
      async (p) => {
        const api = plugin.excalidraw;
        if (!api) throw new Error("pele: Excalidraw conversion is off (Settings › Mehrpele › Excalidraw conversion)");
        return api.cliConvert(p);
      },
    );
  }
}
