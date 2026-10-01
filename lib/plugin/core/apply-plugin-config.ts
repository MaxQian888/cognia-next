/**
 * Apply a plugin's whole config, everywhere it lives.
 *
 * A config change has three homes: the Dexie row (the source of truth), the
 * runtime store the plugin reads through `ctx.configuration`, and the
 * manager's change fan-out (`onConfigChange` hooks, `ctx.configuration`
 * subscribers, the python host). Writing only the row — which the settings
 * form used to do — left a running plugin reading its old values until the
 * next load. Every writer goes through here instead.
 */

import { setPluginConfig } from "@/lib/db/plugins"
import { usePluginStore } from "@/stores/plugin-runtime"

import { loggers } from "./logger"

export interface PluginConfigNotifier {
  notifyPluginConfigChanged: (pluginId: string, config: Record<string, unknown>) => Promise<void>
}

async function defaultNotifier(): Promise<PluginConfigNotifier | null> {
  try {
    const { getPluginManager } = await import("./manager")
    return getPluginManager()
  } catch {
    // Not initialized (web boot race, tests): the row is written, and the
    // plugin reads it on its next load.
    return null
  }
}

/**
 * Persist `config` and notify the running plugin. The persistence step throws
 * (the caller's save failed); the notification is best effort, because the
 * persisted row is already what the plugin will read on its next load.
 */
export async function applyPluginConfig(
  pluginId: string,
  config: Record<string, unknown>,
  notifier?: PluginConfigNotifier
): Promise<void> {
  await setPluginConfig(pluginId, config)
  usePluginStore.getState().setPluginConfig?.(pluginId, config)
  const target = notifier ?? (await defaultNotifier())
  if (!target) return
  try {
    await target.notifyPluginConfigChanged(pluginId, config)
  } catch (error) {
    loggers.manager.warn(`[plugin:${pluginId}] config change notification failed`, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
