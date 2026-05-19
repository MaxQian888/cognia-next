/**
 * Plugin Chat Middleware API.
 *
 * Lets a plugin register an around-style middleware via `ctx.chat.use(...)`.
 * Each middleware can inspect/transform the outgoing chat request, short-
 * circuit it, and post-process the response. Safety net (timeout, error
 * isolation, 3-strike circuit breaker) is enforced by the runner in
 * `lib/claude/chat-middleware/runner.ts`.
 *
 * Auto-cleanup on plugin disable is wired through
 * `clearChatMiddlewaresForPlugin(pluginId)` from the registry module.
 *
 * ADR-0026 §4 §A.
 */

import { nanoid } from "nanoid"
import { createPluginSystemLogger } from "../core/logger"
import type { ChatMiddleware } from "@/types/plugin/plugin-chat-middleware"
import {
  registerChatMiddleware,
  unregisterChatMiddleware,
  type ChatMiddlewareRegistration as _Reg,
} from "@/lib/claude/chat-middleware/registry"

export interface PluginChatAPI {
  /**
   * Register a middleware. Returns a disposer the plugin can call to
   * unregister explicitly (the host also unregisters automatically on
   * plugin disable). The optional `id` argument lets the plugin pin a
   * stable id for telemetry and the circuit-breaker key — when omitted a
   * random id is generated.
   */
  use(
    fn: ChatMiddleware,
    options?: { id?: string; priority?: number; timeoutMs?: number }
  ): () => void
}

const ownedByPlugin = new Map<string, Set<string>>()

export function createChatAPI(pluginId: string): PluginChatAPI {
  const logger = createPluginSystemLogger(pluginId)
  return {
    use(fn, options) {
      const middlewareId = options?.id ?? `m_${nanoid(8)}`
      const owned = ownedByPlugin.get(pluginId) ?? new Set<string>()
      const fullId = `${pluginId}:${middlewareId}`
      if (owned.has(fullId)) {
        throw new Error(
          `[chat-api] plugin ${pluginId} already registered middleware "${middlewareId}"`
        )
      }
      const dispose = registerChatMiddleware({
        pluginId,
        middlewareId,
        fn,
        priority: options?.priority,
        timeoutMs: options?.timeoutMs,
      })
      owned.add(fullId)
      ownedByPlugin.set(pluginId, owned)
      logger.info(`[chat] registered middleware "${fullId}"`)
      return () => {
        if (!owned.has(fullId)) return
        dispose()
        owned.delete(fullId)
        if (owned.size === 0) ownedByPlugin.delete(pluginId)
        logger.info(`[chat] unregistered middleware "${fullId}"`)
      }
    },
  }
}

/** Plugin-disable hook — drop every middleware the plugin owns. */
export function clearChatMiddlewaresForPluginContext(pluginId: string): void {
  const owned = ownedByPlugin.get(pluginId)
  if (!owned) return
  for (const fullId of owned) {
    unregisterChatMiddleware(fullId)
  }
  ownedByPlugin.delete(pluginId)
}

/** Test-only. */
export function __resetChatApiForTesting(): void {
  ownedByPlugin.clear()
}
