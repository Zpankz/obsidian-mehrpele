/** DOM-free classification of diagram link hrefs. */

export type LinkKind =
  | "internal"
  | "obsidian"
  | "external"
  | "blocked"
  | "obsidian-blocked"
  | "other";

/** User policy for Advanced/Core Obsidian command URIs. Writes are never allowed. */
export interface ObsidianUriPolicy {
  /** Master switch for `commandid` URIs. Default false. */
  allowCommandUris?: boolean;
  /** Exact command ids allowed when the master switch is on. */
  commandAllowlist?: readonly string[];
}

export type ObsidianUriClassification =
  | {
      outcome: "navigation";
      action: string;
      parameters: readonly string[];
    }
  | {
      outcome: "command";
      action: string;
      commandId: string;
      parameters: readonly string[];
    }
  | {
      outcome: "blocked";
      action?: string;
      reason: string;
      blockedParameters: readonly string[];
    };

const BLOCKED_RE = /^(javascript|data|vbscript):/i;
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Pre-process an href the way the WHATWG URL parser does before it looks at
 * the scheme: strip leading/trailing C0 controls and spaces (U+0000–U+0020)
 * and remove every ASCII tab/LF/CR. `"\u0001obsidian://…"` is navigated as
 * `obsidian://…` by the browser, so it must be classified as one too.
 */
export function urlStandardClean(href: string): string {
  // `[^\P{Cc}\u007f-\u009f]` is the C0 range U+0000–U+001F (Cc minus DEL and the C1 controls).
  return href.replace(/^(?:[^\P{Cc}\u007f-\u009f]| )+|(?:[^\P{Cc}\u007f-\u009f]| )+$/gu, "").replace(/[\t\n\r]/g, "");
}

/**
 * `internal` is Pele's flag (href holds a note name). Without it, scheme-less
 * hrefs are treated as internal note references; obsidian:// and web schemes
 * get their own kinds; dangerous schemes are blocked.
 */
export function classifyLink(
  href: string,
  internal = false,
  policy: ObsidianUriPolicy = {},
): LinkKind {
  if (internal) return "internal";
  const h = urlStandardClean(href).trim();
  if (BLOCKED_RE.test(h)) return "blocked";
  const m = SCHEME_RE.exec(h);
  if (!m) return "internal";
  const scheme = (m[1] ?? "").toLowerCase();
  if (scheme === "obsidian") {
    return classifyObsidianUri(h, policy).outcome === "blocked"
      ? "obsidian-blocked"
      : "obsidian";
  }
  if (scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel") {
    return "external";
  }
  return "other";
}

const NAVIGATION_PARAMETERS: Record<string, ReadonlySet<string>> = {
  open: new Set(["vault", "file", "path"]),
  "adv-uri": new Set([
    "vault",
    "filepath",
    "filename",
    "file",
    "heading",
    "block",
    "line",
    "uid",
    "openmode",
    "viewmode",
  ]),
  "advanced-uri": new Set([
    "vault",
    "filepath",
    "filename",
    "file",
    "heading",
    "block",
    "line",
    "uid",
    "openmode",
    "viewmode",
  ]),
};

/** Parameters that can execute, write, replace, change settings/plugins, or invoke callbacks. */
const DANGEROUS_PARAMETERS = new Set([
  "commandid",
  "commandname",
  "data",
  "content",
  "mode",
  "clipboard",
  "settingid",
  "settingsection",
  "eval",
  "enableplugin",
  "disableplugin",
  "workspace",
  "saveworkspace",
  "search",
  "searchregex",
  "replace",
  "frontmatterkey",
  "updateplugins",
  "daily",
  "exists",
  "separator",
  "xsuccess",
  "xerror",
  "confirm",
  "awaitsync",
  "overwrite",
  "silent",
  "openwith",
  "name",
]);

function safeDecode(value: string): string {
  let out = value;
  for (let i = 0; i < 4; i++) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch {
      break;
    }
  }
  return out;
}

function canonicalParameterName(raw: string): string {
  return safeDecode(raw)
    .normalize("NFKC")
    .replace(/[\p{Cc} ]/gu, "") // C0 + C1 controls (U+0000–U+001F, U+007F–U+009F) and space
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function canonicalParameterValue(raw: string): string {
  return safeDecode(raw).normalize("NFKC").trim();
}

interface ParsedParameter {
  name: string;
  value: string;
  /**
   * Found only by decoding a value / the whole query (legacy double-encoding
   * forms). Nested names still block when dangerous, but an *unknown* nested
   * name is just text inside a value (a filename/heading with `&` or `=`).
   */
  nested?: boolean;
}

function addSearchParameters(query: string, out: Map<string, ParsedParameter[]>, nested = false): void {
  try {
    for (const [rawName, rawValue] of new URLSearchParams(query)) {
      // A whole encoded query can surface as one decoded “name” containing
      // `name=value&…`; parse that form instead of inventing a giant name.
      if (/[=&]/.test(rawName)) {
        addSearchParameters(rawName, out, nested);
        if (rawValue) addSearchParameters(rawValue, out, nested);
        continue;
      }
      const name = canonicalParameterName(rawName);
      if (!name) continue;
      const list = out.get(name) ?? [];
      list.push({ name, value: canonicalParameterValue(rawValue), nested });
      out.set(name, list);
    }
  } catch {
    /* malformed query: caller treats unknown/missing action fail-closed */
  }
}

/**
 * Collect parameters from the visible query and from encoded legacy forms.
 * Advanced URI's legacy action used double encoding, so a decoded parameter
 * value can itself contain `&name=value`; those nested names are inspected too.
 * This is deliberately fail-closed: a value crafted to look like a nested
 * dangerous parameter is blocked even if a handler might have treated it as text.
 */
function collectParameters(query: string, strictWholeQuery = false): Map<string, ParsedParameter[]> {
  const out = new Map<string, ParsedParameter[]>();
  if (!query) return out;
  addSearchParameters(query, out);

  // Whole-query encoded forms (`vault%3D…%26commandid%3D…`, incl. double).
  let decodedQuery = query;
  for (let i = 0; i < 3; i++) {
    if (!/%(?:25)?(?:3d|26)/i.test(decodedQuery)) break;
    const next = safeDecode(decodedQuery);
    if (next === decodedQuery) break;
    decodedQuery = next;
    // Legacy `advanced-uri` double-encodes its real parameter list, so names found
    // by decoding the whole query are top-level for that handler: keep them strict
    // (unknown → blocked). For other actions they are value text.
    addSearchParameters(decodedQuery, out, !strictWholeQuery);
  }

  // Nested encoded parameter lists in individual decoded values.
  const initial = [...out.values()].flat();
  for (const param of initial) {
    if (!/[&=]/.test(param.value)) continue;
    const nested = param.value.startsWith("?") ? param.value.slice(1) : param.value;
    addSearchParameters(nested, out, true);
    const decodedNested = safeDecode(nested);
    if (decodedNested !== nested) addSearchParameters(decodedNested, out, true);
  }
  return out;
}

function parseObsidianUri(href: string): { action: string; query: string } | null {
  // Same pre-processing as the URL parser before it looks at the scheme.
  const cleaned = urlStandardClean(href);
  const match = /^obsidian:(.*)$/i.exec(cleaned);
  if (!match) return null;
  let rest = match[1] ?? "";
  if (/[\\]/.test(rest)) return null;
  rest = rest.replace(/^\/+/, "");
  const actionEnd = rest.search(/[/?#]/);
  const rawAction = actionEnd >= 0 ? rest.slice(0, actionEnd) : rest;
  const tail = actionEnd >= 0 && rest[actionEnd] === "/" ? rest.slice(actionEnd) : "";
  // Obsidian actions are a single segment (`open`, `adv-uri`, …). Extra path
  // segments are not a documented navigation form, so fail closed.
  if (tail.startsWith("/") && tail !== "/" && !tail.startsWith("/?") && !tail.startsWith("/#")) {
    return { action: "__extra_path__", query: "" };
  }
  const queryStart = rest.indexOf("?");
  const fragmentStart = rest.indexOf("#", queryStart >= 0 ? queryStart : undefined);
  const query =
    queryStart >= 0
      ? rest.slice(queryStart + 1, fragmentStart >= 0 ? fragmentStart : undefined)
      : "";
  const fragment = fragmentStart >= 0 ? rest.slice(fragmentStart + 1) : "";
  // A query-looking fragment cannot reach the documented handlers, but inspect
  // it anyway so encoded dangerous names are not hidden after `#`.
  const combinedQuery =
    fragment && (/=|%(?:25)?3d/i.test(fragment))
      ? `${query}${query ? "&" : ""}${fragment.replace(/^\/+/, "")}`
      : query;
  return {
    // Exact decoded action, ASCII case-folded only (no normalising `o.pen` →
    // `open`): anything that is not literally a known action fails closed.
    action: safeDecode(rawAction).replace(/[A-Z]/g, (c) => c.toLowerCase()),
    query: combinedQuery,
  };
}

/**
 * Classify an `obsidian://` href.
 *
 * Allowed by default: pure navigation only (`open`, current/legacy Advanced URI
 * with read/navigation parameters). Command URIs require the policy switch and
 * an exact command-id allowlist entry. Write/replace/settings/plugin/workspace
 * parameters are blocked regardless of policy.
 */
export function classifyObsidianUri(
  href: string,
  policy: ObsidianUriPolicy = {},
): ObsidianUriClassification {
  const parsed = parseObsidianUri(href);
  if (!parsed) {
    return { outcome: "blocked", reason: "malformed Obsidian URI", blockedParameters: [] };
  }
  const action = parsed.action;
  const allowed = Object.prototype.hasOwnProperty.call(NAVIGATION_PARAMETERS, action)
    ? NAVIGATION_PARAMETERS[action]
    : undefined;
  if (!allowed) {
    return {
      outcome: "blocked",
      action,
      reason: `unknown Obsidian URI action “${action || "(missing)"}”`,
      blockedParameters: [],
    };
  }

  const parameters = collectParameters(parsed.query, action === "advanced-uri");
  const names = [...parameters.keys()];
  const dangerous = names.filter((n) => DANGEROUS_PARAMETERS.has(n));
  const hasCommandName = parameters.has("commandname");
  const commandValues = (parameters.get("commandid") ?? []).map((p) => p.value);
  const distinctCommandIds = [...new Set(commandValues.filter(Boolean))];
  const isCommandAttempt = parameters.has("commandid") || hasCommandName;

  // A command URI may only carry navigation parameters besides commandid.
  // Unknown names that only surfaced by decoding a value are value text.
  const unknown = names.filter(
    (n) =>
      !allowed.has(n) &&
      n !== "commandid" &&
      !DANGEROUS_PARAMETERS.has(n) &&
      (parameters.get(n) ?? []).some((p) => !p.nested),
  );

  if (hasCommandName) {
    return {
      outcome: "blocked",
      action,
      reason:
        "command URIs must use an allowlisted commandid; commandname cannot be verified against the id allowlist",
      blockedParameters: ["commandname"],
    };
  }

  if (isCommandAttempt) {
    if (commandValues.length === 0 || distinctCommandIds.length !== 1) {
      return {
        outcome: "blocked",
        action,
        reason: "command URI does not contain exactly one commandid",
        blockedParameters: ["commandid"],
      };
    }
    const commandId = distinctCommandIds[0];
    const hardBlocked = dangerous.filter((n) => n !== "commandid");
    if (hardBlocked.length > 0) {
      return {
        outcome: "blocked",
        action,
        reason: `write or privileged Obsidian URI parameter(s): ${hardBlocked.join(", ")}`,
        blockedParameters: hardBlocked,
      };
    }
    if (unknown.length > 0) {
      return {
        outcome: "blocked",
        action,
        reason: `unknown Obsidian URI parameter(s): ${unknown.join(", ")}`,
        blockedParameters: unknown,
      };
    }
    if (!policy.allowCommandUris) {
      return {
        outcome: "blocked",
        action,
        reason:
          "command URIs from diagrams are disabled. Enable “Allow command URIs from diagrams” and add this command id to the allowlist to permit it",
        blockedParameters: ["commandid"],
      };
    }
    const allowlist = new Set((policy.commandAllowlist ?? []).map((id) => id.trim()).filter(Boolean));
    if (!allowlist.has(commandId)) {
      return {
        outcome: "blocked",
        action,
        reason: `command id “${commandId}” is not in the diagram command allowlist`,
        blockedParameters: ["commandid"],
      };
    }
    return { outcome: "command", action, commandId, parameters: names };
  }

  if (dangerous.length > 0) {
    const writeLike = dangerous.filter((n) =>
      ["data", "content", "mode", "search", "searchregex", "replace", "frontmatterkey", "eval"].includes(n),
    );
    return {
      outcome: "blocked",
      action,
      reason:
        writeLike.length > 0
          ? `write-capable Obsidian URI parameter(s) are never allowed from diagrams: ${dangerous.join(", ")}`
          : `privileged Obsidian URI parameter(s) are not allowed from diagrams: ${dangerous.join(", ")}`,
      blockedParameters: dangerous,
    };
  }
  if (unknown.length > 0) {
    return {
      outcome: "blocked",
      action,
      reason: `unknown Obsidian URI parameter(s): ${unknown.join(", ")}`,
      blockedParameters: unknown,
    };
  }
  return { outcome: "navigation", action, parameters: names };
}

export function isObsidianUri(href: string): boolean {
  return /^obsidian:/i.test(urlStandardClean(href));
}

/** One-line explanation suitable for a Notice. */
export function obsidianUriBlockedMessage(classification: ObsidianUriClassification): string {
  if (classification.outcome !== "blocked") return "";
  return `Pele blocked an Obsidian link: ${classification.reason}. Navigation links are allowed; command URIs need Settings → Mehrpele → “Allow command URIs from diagrams” plus the exact command id in the allowlist. Write/replace URIs are never allowed from diagrams.`;
}

export interface LinkRouter {
  /** Open a note link (`openLinkText`). */
  internal(href: string): void;
  /** Open an obsidian:// or web link (`window.open`). */
  open(href: string): void;
}

/**
 * Route a diagram link click: one path for DiagramFrame, the lightbox and
 * Pele's own SVG anchors inside Mehrpele shells. Blocked/unknown schemes never
 * navigate. Returns the classification.
 */
export function routeDiagramLink(
  href: string,
  internal: boolean,
  policy: ObsidianUriPolicy,
  router: LinkRouter,
): LinkKind {
  const kind = classifyLink(href, internal, policy);
  if (kind === "internal") router.internal(href);
  else if (kind === "obsidian" || kind === "external") router.open(href);
  return kind;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Whether an anchor is part of Pele's SVG (vs. an HTML overlay label link). */
export function isSvgAnchor(el: { namespaceURI?: string | null } | null | undefined): boolean {
  return el?.namespaceURI === SVG_NS;
}
