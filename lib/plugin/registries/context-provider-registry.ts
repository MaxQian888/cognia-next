/**
 * Context-Provider Registry — dynamic overlay for plugin-registered agent
 * context providers (ADR-0026 §Agent-SDK, Package E).
 *
 * Providers registered via `ctx.agent.context.registerProvider(...)` contribute
 * ambient text into the plugin's agent runs. On plugin disable the manager
 * calls `unregisterContextProvidersByPlugin(pluginId)`.
 *
 * Resolution + execution lives in `lib/plugin/agent-sdk/context-providers.ts`.
 */

import type { PluginContextProvider } from "@/types/plugin/plugin-context-provider"
import { createOverlayRegistry } from "./createOverlayRegistry"

const registry = createOverlayRegistry<PluginContextProvider>({ name: "context-provider" })

/** Register a plugin-contributed context provider. */
export const registerContextProvider = registry.register
/** Drop a single provider by id. */
export const unregisterContextProviderById = registry.unregisterById
/** Drop every provider contributed by `pluginId`. Returns the number removed. */
export const unregisterContextProvidersByPlugin = registry.unregisterByPlugin
/** Get a provider by id. */
export const getContextProvider = registry.get
/** List every registered provider id in registration order. */
export const listContextProviderIds = registry.list
/** List every registered entry (id + provider + pluginId). */
export const listContextProviderEntries = registry.entries
/** Test-only: clear every registered provider. */
export const __resetContextProvidersForTesting = registry.__resetForTesting
