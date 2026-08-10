import { ProviderConfig } from "./provider.js"
import "./built-in-provider-catalog.js"
import "./bedrock.js"

/**
 * Plugin-contributed providers are registered at runtime by the host app
 * (`lib/ai/providers/provider-loader`). This package must not import the app,
 * so the merge in `getAllProviders()` reads through an injected getter instead
 * of a hard import. The default returns an empty map — identical to the host's
 * `getDynamicProviders()` before any plugin has registered — so behaviour is
 * unchanged when nothing wires the registry.
 */
type DynamicProviderRegistry = () => Record<string, ProviderConfig>
/** Wire the host's dynamic-provider source. Called once at app boot. */
declare function setDynamicProviderRegistry(fn: DynamicProviderRegistry): void
/** Read the currently-registered dynamic providers (empty until wired). */
declare function getDynamicProviders(): Record<string, ProviderConfig>

export { type DynamicProviderRegistry, getDynamicProviders, setDynamicProviderRegistry }
