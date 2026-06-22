/**
 * Plugin SDK helper for agent context providers (Package E).
 *
 * Pure typesafety pass-through — wrapping a provider in
 * `defineContextProvider()` gives plugin authors autocomplete and a
 * compile-time check that the shape matches `PluginContextProvider`.
 *
 * Usage:
 *   const recentDecisions = defineContextProvider({
 *     id: "recent-decisions",
 *     provide: async () => "Recent decisions: ...",
 *   })
 */

import type { PluginContextProvider } from "@/types/plugin/plugin-context-provider"

export function defineContextProvider(provider: PluginContextProvider): PluginContextProvider {
  return provider
}
