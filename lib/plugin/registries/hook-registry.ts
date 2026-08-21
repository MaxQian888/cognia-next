/**
 * Plugin hook registry — the single home for "which plugin contributes which
 * hook, and is it live right now?".
 *
 * Before this module the same registration lived in TWO unreconciled places,
 * written together at `lib/plugin/core/manager.ts` but read apart:
 *
 *   - `PluginLifecycleHooks.registeredHooks` — a class-private `Map`, read with
 *     NO enabled check, so a disabled plugin still received lifecycle and team
 *     hooks.
 *   - `PluginEventHooks.getPluginsByPriority` — the Zustand plugin store, read
 *     WITH a `status === "enabled"` filter.
 *
 * Two stores plus two different liveness rules meant a plugin could be visible
 * to one dispatcher and invisible to the other, which is exactly the sort of
 * split that produces "the hook ran but the other hook didn't" bug reports.
 *
 * This registry owns the registration; `isPluginHooksEnabled` owns the single
 * liveness rule. Enablement itself is deliberately NOT duplicated here — it
 * lives in the plugin store and changes at runtime, so this module reads it
 * rather than mirroring it. One store, one rule, two dispatchers.
 *
 * Also the lookup path for the `{ type: "plugin" }` settings.json hook handler:
 * a lifecycle hook configured in settings.json resolves its target through
 * `getPluginHookHandler`.
 */

import type { PluginHooksAll } from "@/types/plugin/plugin-hooks"
import { usePluginStore } from "@/stores/plugin-runtime"
import { createOverlayRegistry } from "./createOverlayRegistry"

/** One plugin's hook contribution. */
export interface RegisteredPluginHooks {
  hooks: PluginHooksAll
  /** Higher runs first; ties break on plugin id for determinism. */
  priority: number
}

const registry = createOverlayRegistry<RegisteredPluginHooks>({
  name: "plugin-hooks",
  // Keyed by plugin id, so "last wins" is simply re-registration by the same
  // plugin (hot reload, snapshot restore). There is no cross-plugin collision
  // to arbitrate — a plugin can only ever own its own id.
  conflictPolicy: "last-wins",
})

/** Register (or refresh) one plugin's hooks. */
export function registerPluginHookContribution(
  pluginId: string,
  hooks: PluginHooksAll,
  priority = 0
): void {
  registry.register(pluginId, { hooks, priority }, { pluginId })
}

/** Drop one plugin's hooks. Returns true when something was removed. */
export function unregisterPluginHookContribution(pluginId: string): boolean {
  return registry.unregisterById(pluginId)
}

/** Raw contribution, ignoring enablement. Used by lifecycle transitions. */
export function getPluginHookContribution(pluginId: string): RegisteredPluginHooks | undefined {
  return registry.get(pluginId)
}

/**
 * The ONE liveness rule, shared by both dispatchers.
 *
 * A plugin's hooks run only while the plugin is enabled. Reads the plugin store
 * rather than caching, because enablement flips at runtime and a cached copy is
 * how the two dispatchers drifted apart in the first place. A plugin that has
 * registered hooks but has no store row yet (mid-activation) counts as live so
 * an `onEnable` hook can still fire for its own activation.
 */
export function isPluginHooksEnabled(pluginId: string): boolean {
  const row = usePluginStore.getState().plugins[pluginId]
  if (!row) return true
  return row.status === "enabled"
}

/**
 * Every ENABLED plugin with hooks, in priority order (descending), tie-broken
 * on plugin id. The fan-out dispatchers iterate this and check for their own
 * hook; `listHookContributors` is the per-hook variant.
 */
export function listEnabledHookPlugins(): string[] {
  return registry
    .entries()
    .filter(({ id }) => isPluginHooksEnabled(id))
    .sort((a, b) => {
      const byPriority = b.entry.priority - a.entry.priority
      return byPriority !== 0 ? byPriority : a.id.localeCompare(b.id)
    })
    .map(({ id }) => id)
}

/**
 * Plugin ids contributing `hookName`, enabled-filtered and ordered:
 * priority descending, then plugin id ascending for a deterministic tie-break.
 */
export function listHookContributors(hookName: keyof PluginHooksAll): string[] {
  return registry
    .entries()
    .filter(({ id, entry }) => {
      if (typeof entry.hooks?.[hookName] !== "function") return false
      return isPluginHooksEnabled(id)
    })
    .sort((a, b) => {
      const byPriority = b.entry.priority - a.entry.priority
      return byPriority !== 0 ? byPriority : a.id.localeCompare(b.id)
    })
    .map(({ id }) => id)
}

/**
 * Resolve one plugin hook handler by plugin id + hook name, for the
 * `{ type: "plugin" }` settings.json handler. Returns undefined when the plugin
 * is absent, disabled, or does not contribute that hook — the caller treats all
 * three as "nothing to run" and fails open.
 */
export function getPluginHookHandler(
  pluginId: string,
  hookName: string
): ((...args: never[]) => unknown) | undefined {
  const entry = registry.get(pluginId)
  if (!entry || !isPluginHooksEnabled(pluginId)) return undefined
  const fn = (entry.hooks as Record<string, unknown>)[hookName]
  return typeof fn === "function" ? (fn as (...args: never[]) => unknown) : undefined
}

/** Every registered plugin id, enabled or not. */
export function listRegisteredHookPlugins(): string[] {
  return registry.list()
}

/** Test-only: drop every registration. */
export function __resetHookRegistryForTesting(): void {
  for (const pluginId of listRegisteredHookPlugins()) registry.unregisterById(pluginId)
}
