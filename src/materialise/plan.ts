/**
 * Materialise plan types and keys. A leaf module: settings read
 * DEFAULT_EDGE_KEY at load, so this must not pull in the planner
 * (planner.ts) or anything else of the feature.
 */
import type { MaterialiseType } from "./graph";

export type ExistingPolicy = "link" | "skip" | "suffix";
export type KeyStyle = "slug" | "verbatim";

export interface MaterialiseOptions {
  /** Root folder (vault-relative, already expanded); "" = vault root. */
  root: string;
  /** Property for unlabelled edges. */
  defaultKey: string;
  keyStyle: KeyStyle;
  /** Rewrite the block so nodes embed their notes. */
  rewrite: boolean;
  onExisting: ExistingPolicy;
}

/** Read-only vault lookups the planner needs (case-insensitive like the filesystem). */
export interface VaultView {
  /** What exists at `path`: a Markdown note (with its frontmatter), another file, a folder, or nothing. */
  lookup(path: string): { kind: "note"; frontmatter: Record<string, unknown> | null } | { kind: "file" | "folder" } | null;
  /** Vault path a link path (no `#subpath`) resolves to from `sourcePath`, or null. */
  resolve(linkpath: string, sourcePath: string): string | null;
}

export const PROVENANCE_KEY = "pele-materialised";
export const NODE_KEY = "pele-node";
export const DEFAULT_EDGE_KEY = "canvas-link";

export type NoteAction = "create" | "reuse" | "link" | "skip" | "media";

export interface PlannedNote {
  nodeId: string;
  /** Label Markdown as written in the diagram. */
  label: string;
  /** Vault path of the note (or media file) the node maps to; "" for skip without a target. */
  path: string;
  action: NoteAction;
  reason?: string;
  /** Full file text, for `create`. */
  content?: string;
  /** Properties written into a created note (links per key). */
  properties?: Record<string, string[]>;
}

export interface PlannedFolder {
  path: string;
  groupId: string;
  status: "create" | "exists";
}

export interface PropertyLink {
  /** `[[linktext]]` as written. */
  link: string;
  /** Normalised target identity (see targetKey) for duplicate checks. */
  target: string;
}

export interface PropertyWrite {
  /** Existing note the property goes on. */
  path: string;
  key: string;
  add: PropertyLink[];
  before: unknown;
  after: unknown;
}

export interface MaterialisePlan {
  type: MaterialiseType;
  notePath: string;
  blockId: string;
  provenance: string;
  root: string;
  folders: PlannedFolder[];
  notes: PlannedNote[];
  properties: PropertyWrite[];
  /** Block body before/after; null when the block stays as is. */
  rewrite: { before: string; after: string } | null;
  warnings: string[];
  /** Nothing to create, write or rewrite. */
  empty: boolean;
}

export interface PlanInput {
  source: string;
  /** Block is Mehrpele already (mehrpele fence, directive, or "always" mode). */
  isMehrpele: boolean;
  notePath: string;
  blockId: string;
  options: MaterialiseOptions;
  vault: VaultView;
}

export type PlanResult = { ok: true; plan: MaterialisePlan } | { ok: false; reason: string };
