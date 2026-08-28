/**
 * Plugin SDK — context-provider authoring surface.
 *
 * Re-exports the `defineContextProvider()` helper plugin authors use for
 * runtime provider implementations and declarative lazy factory entries in
 * `manifest.contextProviders[]`.
 *
 * Sources:
 *  - `packages/plugin-sdk/src/define/define-context-provider.ts`
 *  - `types/plugin/plugin-context-provider.ts`
 */

export { defineContextProvider } from "../define/define-context-provider"

export type {
  PluginContextProvider,
  PluginContextProviderDef,
} from "@/types/plugin/plugin-context-provider"

/**
 * Dynamic registration. A plugin that computes its providers at activation
 * time (rather than declaring them statically in the manifest) registers them
 * through the same bridge the plugin manager uses, so disable/uninstall
 * cleanup stays symmetric.
 */
export {
  registerContextProvidersForPlugin,
  unregisterContextProvidersForPlugin,
} from "@/lib/plugin/bridge/context-providers-bridge"

export type {
  ContextProvidersBridgeError,
  ContextProvidersBridgeOptions,
  ContextProvidersBridgeResult,
} from "@/lib/plugin/bridge/context-providers-bridge"

export {
  getContextProvider,
  listContextProviderEntries,
  listContextProviderIds,
  registerContextProvider,
  unregisterContextProviderById,
  unregisterContextProvidersByPlugin,
} from "@/lib/plugin/registries/context-provider-registry"

export type { PluginContextProviderFactoryContext } from "@/types/plugin/plugin-context-provider"
