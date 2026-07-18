/**
 * Chat-middleware bridge — the declarative half of ADR-0026 §4 §A.
 *
 * Registers every `manifest.chatMiddlewares[]` entry into the chat-middleware
 * registry on enable, importing each entry module and binding its exported
 * `ChatMiddleware` function. Disable drops them all (resetting breaker state).
 *
 * Before this, the registry + runner existed but `manifest.chatMiddlewares`
 * was never dispatched — only the imperative `ctx.chat.use(...)` path
 * registered anything. Mirrors the other async module bridges; wired via
 * `MODULE_BRIDGE_CAPABILITIES` (`manifestField: "chatMiddlewares"`).
 *
 * NOTE: registration ≠ execution. The runner (`runChatMiddlewareChain`) is
 * invoked from a send call-site gated behind a default-off flag — see
 * `lib/claude/chat-middleware/feature-flag.ts`.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type { ChatMiddleware } from "@/types/plugin/plugin-chat-middleware"
import {
  registerChatMiddleware,
  clearChatMiddlewaresForPlugin,
} from "@/lib/claude/chat-middleware/registry"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"

export interface RegisterChatMiddlewaresOptions {
  importer: (entry: string) => Promise<Record<string, unknown>>
}

export async function registerChatMiddlewaresForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: RegisterChatMiddlewaresOptions
): Promise<void> {
  const defs = manifest.chatMiddlewares ?? []
  for (const def of defs) {
    if (!def?.id || !def.entry || !def.export) continue
    const resolved = resolvePluginPath(installRoot, def.entry)
    try {
      const mod = await options.importer(resolved)
      const exported = mod[def.export]
      if (typeof exported !== "function") {
        loggers.manager.warn(
          `[chat-middleware-bridge] ${manifest.id}:${def.id} — export "${def.export}" is not a function`
        )
        continue
      }
      registerChatMiddleware({
        pluginId: manifest.id,
        middlewareId: def.id,
        fn: exported as ChatMiddleware,
        priority: def.priority,
        timeoutMs: def.timeoutMs,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      loggers.manager.warn(
        `[chat-middleware-bridge] failed to register ${manifest.id}:${def.id}: ${message}`
      )
    }
  }
}

export function unregisterChatMiddlewaresForPlugin(pluginId: string): void {
  clearChatMiddlewaresForPlugin(pluginId)
}
