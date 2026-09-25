/**
 * Plugin decision-provider contributions (ADR-0194).
 *
 * A plugin contributes a System-1 decision backend two ways:
 *
 * 1. Declaratively — `manifest.decisionProviders[]`. For a python plugin the
 *    entry needs no `entry`/`export`: the host asks the plugin's
 *    `@cognia.contribution("<id>")` object for its descriptor (`describe()`)
 *    and proxies `decide` / `status` into the Python subprocess. A JS entry
 *    names a module + factory export instead.
 * 2. Imperatively — `ctx.decisions.registerProvider(provider)` from
 *    `activate()`.
 *
 * Either way the provider lands in the host registry as `<pluginId>:<id>` and
 * is dropped on disable. The user must still pick it in Settings → Conversation
 * before anything is sent to it.
 */

import type { PluginContributionBackend } from "./plugin"
import type { DecisionProvider } from "@/types/decisions"

export interface PluginDecisionProviderDef {
  /** Provider id, unprefixed. Registered as `<pluginId>:<id>`. */
  id: string
  /** Name shown in the provider picker. */
  label: string
  /** Plugin i18n key for `label` (`manifest.i18n.locales`). */
  labelKey?: string
  /**
   * Which runtime owns the provider. Omit to inherit the plugin type
   * (`python` plugins default to `"python"`); declaring `entry` pins `"js"`.
   */
  backend?: PluginContributionBackend
  /** JS-backed only: module (relative to the install root) exporting the factory. */
  entry?: string
  /** JS-backed only: named export resolving to a {@link PluginDecisionProviderFactory}. */
  export?: string
  /** Free-text description shown in the picker. */
  description?: string
}

/** What a plugin factory (or `registerProvider`) supplies — the host sets `id` / `pluginId`. */
export type PluginDecisionProviderInput = Omit<DecisionProvider, "id" | "pluginId"> & {
  /** Unprefixed id. */
  id: string
}

export type PluginDecisionProviderFactory = (
  ctx: PluginDecisionProviderFactoryContext
) => PluginDecisionProviderInput | Promise<PluginDecisionProviderInput>

export interface PluginDecisionProviderFactoryContext {
  /** Prefixed id (`<pluginId>:<id>`). */
  providerId: string
  pluginId: string
}

/** Handle from `ctx.decisions.registerProvider`. `unregister()` is idempotent. */
export interface PluginDecisionRegistration {
  providerId: string
  unregister(): void
}
