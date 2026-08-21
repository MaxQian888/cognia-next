/**
 * `ctx.hooks` — the plugin-facing view of the lifecycle-hook systems.
 *
 * Two things a plugin author could not do before this API existed:
 *
 *  1. **Know whether their hook is actually reachable.** Hooks are contributed
 *     by returning a `PluginHooks` object from `activate()`. Whether that
 *     object is live depends on the plugin's enabled state, and there was no
 *     way to ask. A plugin whose hook silently never fires had no diagnosis.
 *  2. **Find out how to bind a hook to a settings.json lifecycle event.** The
 *     `{ type: "plugin" }` handler needs an exact `pluginId` + `hookId` pair,
 *     and getting either wrong fails open and silently.
 *
 * Deliberately read-only. Registration stays where it is — the return value of
 * `activate()`, validated once by the plugin manager — because a second
 * registration path would reintroduce exactly the two-sources-of-truth problem
 * `lib/plugin/registries/hook-registry.ts` was created to remove.
 */

import type { PluginHooksAll } from "@/types/plugin/plugin-hooks"
import type { HookEvent } from "@/lib/claude/hooks"
import {
  getPluginHookContribution,
  isPluginHooksEnabled,
  listHookContributors,
} from "@/lib/plugin/registries/hook-registry"
import { BLOCKING_HOOK_EVENTS, HOOK_INTERCEPT_PERMISSION } from "@/lib/claude/plugin-hook-ipc"

/** A ready-to-paste settings.json handler entry for one of the plugin's hooks. */
export interface PluginHookBinding {
  type: "plugin"
  pluginId: string
  hookId: string
}

export interface PluginHooksAPI {
  /** Hook names this plugin currently contributes. Empty when not activated. */
  listOwn(): string[]
  /** Is this plugin's hook contribution live (i.e. the plugin is enabled)? */
  isActive(): boolean
  /** Does `hookName` have at least one live contributor (this plugin or another)? */
  hasListener(hookName: keyof PluginHooksAll): boolean
  /**
   * The exact settings.json handler entry that binds one of this plugin's hooks
   * to a lifecycle event. Returns null when the plugin does not contribute that
   * hook, so a typo surfaces here instead of failing open at run time.
   */
  binding(hookName: string): PluginHookBinding | null
  /**
   * True when binding to `event` additionally requires this plugin to declare
   * `hooks:chat-intercept` — that is, when a decision there can deny the turn.
   */
  requiresInterceptPermission(event: HookEvent | string): boolean
  /** The permission name, so an author does not have to hard-code the string. */
  readonly interceptPermission: string
}

/**
 * Build the per-plugin `ctx.hooks` API. Follows the `create*API` convention in
 * this directory; no permission gate because every method is read-only and
 * scoped to the calling plugin (or to a boolean about the wider runtime).
 */
export function createHooksAPI(pluginId: string): PluginHooksAPI {
  return {
    listOwn() {
      const entry = getPluginHookContribution(pluginId)
      if (!entry) return []
      return Object.keys(entry.hooks).filter(
        (name) => typeof (entry.hooks as Record<string, unknown>)[name] === "function"
      )
    },

    isActive() {
      return Boolean(getPluginHookContribution(pluginId)) && isPluginHooksEnabled(pluginId)
    },

    hasListener(hookName) {
      return listHookContributors(hookName).length > 0
    },

    binding(hookName) {
      const entry = getPluginHookContribution(pluginId)
      const fn = entry && (entry.hooks as Record<string, unknown>)[hookName]
      if (typeof fn !== "function") return null
      return { type: "plugin", pluginId, hookId: hookName }
    },

    requiresInterceptPermission(event) {
      return BLOCKING_HOOK_EVENTS.includes(String(event))
    },

    interceptPermission: HOOK_INTERCEPT_PERMISSION,
  }
}
