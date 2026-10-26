/**
 * The plugin contract's share of `lib/plugin/api/hooks-api.ts`, which re-exports these.
 */
import type { HookEvent } from "../../claude/hooks"
import type { PluginHooksAll } from "../../../types/plugin/plugin-hooks"

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
