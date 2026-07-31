/**
 * Plugin SDK helper for agent context providers (Package E).
 *
 * Pure typesafety pass-through — wrapping a runtime provider implementation or
 * a declarative `manifest.contextProviders[]` entry in
 * `defineContextProvider()` gives plugin authors autocomplete and compile-time
 * shape checks.
 *
 * Usage:
 *   const recentDecisions = defineContextProvider({
 *     id: "recent-decisions",
 *     provide: async () => "Recent decisions: ...",
 *   })
 */

import type {
  PluginContextProvider,
  PluginContextProviderDef,
} from "@/types/plugin/plugin-context-provider"

export function defineContextProvider(provider: PluginContextProvider): PluginContextProvider
export function defineContextProvider(provider: PluginContextProviderDef): PluginContextProviderDef
export function defineContextProvider(
  provider: PluginContextProvider | PluginContextProviderDef
): PluginContextProvider | PluginContextProviderDef {
  return provider
}
