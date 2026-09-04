/**
 * Bot Registry, the dynamic overlay for plugin-contributed Bots.
 *
 * A contributed Bot is a manifest entry plus, for the `handler` executor, a
 * resolved durable handler. Both are registered together by
 * `lib/plugin/bridge/bots-bridge.ts` on enable and dropped in one shot on
 * disable, so a disabled plugin can never leave an armed Bot behind.
 *
 * Ids are namespaced by owning plugin (`<pluginId>:<botId>`), because a Bot
 * installation pins a definition id and two plugins picking `daily-digest`
 * must not collide into one another's runs. `first-wins-cross-plugin` keeps
 * the incumbent when they do, and reports the rejection rather than silently
 * hijacking an armed installation.
 *
 * Per-plugin cleanup: `unregisterBotsByPlugin(pluginId)`.
 */

import type { PluginBotDef } from "@/types/plugin/plugin-bot"
import type { BotHandlerV1 } from "@/types/bot/run"

import { reportRegistryConflict } from "@/lib/plugin/contracts/conflict-reporter"
import { createOverlayRegistry } from "./createOverlayRegistry"

export interface RegisteredBot {
  /** The namespaced id installations pin. */
  id: string
  definition: PluginBotDef
  /**
   * Present only for `executor: "handler"`. A Python-backed handler gets a
   * synthesized function here too, so the runtime never branches on backend.
   */
  handler?: BotHandlerV1
}

/**
 * The id an installation stores. Namespacing happens here rather than in the
 * bridge so every reader spells it the same way, which is the difference
 * between a lookup miss and a silently dormant Bot.
 */
export function botDefinitionId(pluginId: string, botId: string): string {
  return `${pluginId}:${botId}`
}

/** Inverse of {@link botDefinitionId}. Returns null for a non-plugin id. */
export function parseBotDefinitionId(id: string): { pluginId: string; botId: string } | null {
  const separator = id.indexOf(":")
  if (separator <= 0 || separator === id.length - 1) return null
  return { pluginId: id.slice(0, separator), botId: id.slice(separator + 1) }
}

const registry = createOverlayRegistry<RegisteredBot>({
  name: "bot",
  keyFn: (id, _entry, opts) => (opts?.pluginId ? botDefinitionId(opts.pluginId, id) : id),
  conflictPolicy: "first-wins-cross-plugin",
  onConflict: (info) => {
    reportRegistryConflict({
      pluginId: info.incomingPluginId ?? "unknown",
      attemptedId: info.key,
      registry: "bot",
      winnerPluginId: info.existingPluginId,
    })
  },
})

/** Register a plugin-contributed Bot. `id` is the raw manifest id. */
export const registerBot = registry.register
/** Drop a single Bot by its NAMESPACED id. */
export const unregisterBotById = registry.unregisterById
/** Drop every Bot contributed by `pluginId`. Returns the number removed. */
export const unregisterBotsByPlugin = registry.unregisterByPlugin
/** Get a Bot by its namespaced id. Undefined when not registered. */
export const getBot = registry.get
/** Get the full registry entry (Bot + pluginId tag) for a namespaced id. */
export const getBotEntry = registry.getEntry
/** List every registered namespaced Bot id in registration order. */
export const listBotIds = registry.list
/** List every registered entry (id + Bot + pluginId) in registration order. */
export const listBotEntries = registry.entries
/** Test-only: clear every dynamically registered Bot. */
export const __resetBotsForTesting = registry.__resetForTesting
