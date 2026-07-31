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
