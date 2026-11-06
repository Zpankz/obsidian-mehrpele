/** Pure parsing and validation of pele:* CLI params and output (DOM/vault-free). */

export const MAX_CLI_OUTPUT = 512 * 1024;

export function guardOutput(text: string): string {
  if (text.length <= MAX_CLI_OUTPUT) return text;
  return `error: output-too-large: result is ${text.length} bytes (limit ${MAX_CLI_OUTPUT}); write to a file with out= instead`;
}

/** Parse an index= param; throws an Error whose message the CLI host prints as `Error: <message>`. */
export function parseIndexParam(raw: string | undefined, count: number, path: string): number {
  if (raw === undefined) {
    if (count === 1) return 0;
    throw new Error(`pele: ${path} has ${count} diagrams; pass index=<n> or out=<folder>`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || String(n) !== raw.trim() || n < 0 || n >= count) {
    throw new Error(`pele: index ${raw} out of range: ${path} has ${count} diagram(s) (0–${count - 1})`);
  }
  return n;
}

/** Whether a vault-relative file path lies in `folder` ("", ".", "/" = whole vault). */
export function inVaultFolder(path: string, folder: string): boolean {
  const f = folder.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (f === "" || f === ".") return true;
  return path === f || path.startsWith(`${f}/`);
}

/** `.mmd`/`.mermaid` files are one whole-file diagram (no fences). */
export function isWholeFileDiagram(extension: string): boolean {
  const ext = extension.toLowerCase();
  return ext === "mmd" || ext === "mermaid";
}

/**
 * Validate a vault-relative output path from a CLI `out=`/`folder=` param.
 * Rejects absolute paths, `~`, drive letters and any `..` segment; when
 * `extensions` is given the path must end with one of them. Returns the
 * normalised path (leading `./` and duplicate slashes removed). Throws an
 * Error (the CLI host prints `Error: <message>`, as for built-in handlers).
 */
export function validateOutPath(raw: string | undefined, extensions?: readonly string[]): string {
  const value = (raw ?? "").trim();
  if (!value) throw new Error("pele: out= must be a vault-relative path");
  if (/^[\\/~]/.test(value) || /^[A-Za-z]:/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new Error(`pele: out=${value} must be vault-relative (no absolute paths or ~)`);
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((s) => s === "..")) throw new Error(`pele: out=${value} must not contain ".." segments`);
  const normalised = segments.filter((s, i) => s !== "." && (s !== "" || i === segments.length - 1)).join("/");
  if (!normalised || normalised === "/") throw new Error("pele: out= must name a file or folder inside the vault");
  if (extensions && extensions.length > 0) {
    const lower = normalised.toLowerCase();
    if (!extensions.some((ext) => lower.endsWith(ext.toLowerCase()) && lower.length > ext.length)) {
      throw new Error(`pele: out=${value} must end with ${extensions.join(" or ")}`);
    }
  }
  return normalised.replace(/\/$/, "");
}

/** CLI boolean flag (`force`, `write`, …): present without value or `=true`. */
export function cliFlag(value: string | undefined): boolean {
  return value === "true" || value === "";
}

/**
 * Output fence lang for `pele:from-canvas`: pele-render sends `lang=mermaid|
 * mehrpele`; the older `mehrpele` flag is still accepted. An explicit choice
 * wins over the Mehrpele setting. Throws on an unknown lang.
 */
export function fromCanvasLang(
  params: { lang?: string; mehrpele?: string },
  mehrpeleByDefault: boolean,
): "mermaid" | "mehrpele" | "pele" {
  if (params.lang !== undefined) {
    const lang = params.lang.trim().toLowerCase();
    if (lang === "mermaid" || lang === "mehrpele" || lang === "pele") return lang;
    throw new Error(`pele: unknown lang "${params.lang}" (expected mermaid|mehrpele)`);
  }
  if (params.mehrpele !== undefined) return cliFlag(params.mehrpele) ? "mehrpele" : "mermaid";
  return mehrpeleByDefault ? "mehrpele" : "mermaid";
}
