/**
 * Plugin OCR Provider API.
 *
 * Lets a plugin contribute a custom `OcrProvider` to the shared OCR
 * registry (`lib/ocr/registry.ts:registerOcrProvider`). Plugins call
 * `ctx.ocr.registerProvider(provider)` from `activate()`, or declare
 * `manifest.ocrProviders[]` and let `lib/plugin/bridge/ocr-providers-bridge.ts`
 * register on enable.
 *
 * The registration handle is auto-revoked when the plugin is disabled
 * (`clearOcrProvidersForPlugin(pluginId)`), so manual cleanup is
 * belt-and-braces.
 *
 * Provider ids are namespaced as `<pluginId>:<providerId>` to prevent
 * collisions with built-ins and across plugins. The registry's internal
 * duplicate check fires if the same plugin tries to register twice.
 *
 * See ADR-0026 §2 §A.
 */

import { createPluginSystemLogger } from "../core/logger"
import { registerOcrProvider, getSharedOcrRegistry } from "@/lib/ocr/registry"
import type { OcrProvider } from "@/types/ocr"
import type { PluginOcrRegistration } from "@/types/plugin/plugin-ocr"

// Track which provider ids each plugin has registered so we can drop them
// all on plugin disable without leaning on the registry's plugin-aware
// helpers (which don't exist — the OCR registry predates plugin lifecycle).
const ownedByPlugin = new Map<string, Set<string>>()

export interface PluginOcrAPI {
  /**
   * Register a custom OCR provider. The given `providerId` is prefixed with
   * the plugin id before reaching the underlying registry. Returns a handle
   * with an `unregister()` method (idempotent — the host also auto-cleans
   * on plugin disable).
   *
   * Throws if the plugin has already registered a provider with the same
   * unprefixed id.
   */
  registerProvider(provider: OcrProvider): PluginOcrRegistration
  /** Snapshot of provider ids this plugin has registered. */
  listRegistered(): string[]
}

export function createOcrAPI(pluginId: string): PluginOcrAPI {
  const logger = createPluginSystemLogger(pluginId)
  return {
    registerProvider(provider) {
      const prefixed = `${pluginId}:${provider.id}`
      const owned = ownedByPlugin.get(pluginId) ?? new Set<string>()
      if (owned.has(prefixed)) {
        throw new Error(
          `[ocr-api] plugin ${pluginId} already registered an OCR provider with id "${provider.id}"`
        )
      }
      const wrapped: OcrProvider = { ...provider, id: prefixed }
      registerOcrProvider(wrapped)
      owned.add(prefixed)
      ownedByPlugin.set(pluginId, owned)
      logger.info(`[ocr] registered provider "${prefixed}"`)
      return {
        providerId: prefixed,
        unregister: () => {
          if (!owned.has(prefixed)) return
          // The registry has `unregister(id)` returning a boolean.
          getSharedOcrRegistry().unregister(prefixed)
          owned.delete(prefixed)
          if (owned.size === 0) ownedByPlugin.delete(pluginId)
          logger.info(`[ocr] unregistered provider "${prefixed}"`)
        },
      }
    },
    listRegistered() {
      return Array.from(ownedByPlugin.get(pluginId) ?? [])
    },
  }
}

/**
 * Plugin-disable hook — drop every OCR provider the plugin owns. Called by
 * the plugin manager when disabling/unloading; safe to call multiple times.
 */
export function clearOcrProvidersForPlugin(pluginId: string): void {
  const owned = ownedByPlugin.get(pluginId)
  if (!owned) return
  for (const id of owned) {
    getSharedOcrRegistry().unregister(id)
  }
  ownedByPlugin.delete(pluginId)
}

/** Test-only. */
export function __resetOcrApiForTesting(): void {
  ownedByPlugin.clear()
}
