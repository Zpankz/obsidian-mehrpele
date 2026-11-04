/**
 * Feature registry types. A feature with code to run at
 * plugin load is a `module`: the registry imports it only when its toggle is
 * on and unloads it when the toggle goes off. A `flag` feature has no load
 * step: core code reads its toggle at render time and loads what it needs
 * on first use.
 */
import type { Component } from "obsidian";
import type { CompanionFeatureDef } from "mehrpele-api";
import type PeleMermaidPlugin from "../../main";
import type { FeatureId } from "./enabled";

/**
 * What a feature's `register` receives. `plugin` is scoped: commands, events,
 * DOM events, intervals and `register` callbacks it adds belong to the
 * feature's child Component, so turning the feature off removes them.
 */
export interface FeatureContext {
  plugin: PeleMermaidPlugin;
  component: Component;
}

export interface FeatureModule {
  register(ctx: FeatureContext): void;
}

interface FeatureDefBase {
  /** A settings toggle id (TOGGLE_IDS). */
  id: FeatureId;
  /** Display name, as in the settings UI. */
  name: string;
}

export interface FlagFeatureDef extends FeatureDefBase {
  kind: "flag";
}

export interface ModuleFeatureDef extends FeatureDefBase {
  kind: "module";
  /**
   * "needed": turning it off takes effect after a plugin reload (the feature
   * registers things Obsidian cannot take back at runtime, e.g. Bases views,
   * code block processors, CLI handlers). Turning it on works at once.
   */
  reload?: "needed";
  /** Dynamic import of the feature entry: never imported statically. */
  load(): Promise<FeatureModule>;
}

export type FeatureDef = FlagFeatureDef | ModuleFeatureDef;

/** A companion's registration (MehrpeleApiV1): the same id/name shape as a feature. */
export type CompanionFeature = CompanionFeatureDef;
