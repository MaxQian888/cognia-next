import type { ProviderConfig } from "./provider"

/**
 * Plugin-contributed providers are registered at runtime by the host app
 * (`lib/ai/providers/provider-loader`). This package must not import the app,
 * so the merge in `getAllProviders()` reads through an injected getter instead
 * of a hard import. The default returns an empty map — identical to the host's
 * `getDynamicProviders()` before any plugin has registered — so behaviour is
 * unchanged when nothing wires the registry.
 */
export type DynamicProviderRegistry = () => Record<string, ProviderConfig>

let _getDynamicProviders: DynamicProviderRegistry = () => ({})

/** Wire the host's dynamic-provider source. Called once at app boot. */
export function setDynamicProviderRegistry(fn: DynamicProviderRegistry): void {
  _getDynamicProviders = fn
}

/** Read the currently-registered dynamic providers (empty until wired). */
export function getDynamicProviders(): Record<string, ProviderConfig> {
  return _getDynamicProviders()
}
