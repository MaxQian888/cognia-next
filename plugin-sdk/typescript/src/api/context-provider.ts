/**
 * Plugin SDK — context-provider authoring surface.
 *
 * Re-exports the `defineContextProvider()` helper plugin authors use to
 * declare a lazy context-provider factory the context-providers module
 * bridge registers into the context-provider registry. A typesafe identity
 * pass-through narrowing to `PluginContextProvider`.
 *
 * Sources:
 *  - `lib/plugin/sdk/define-context-provider.ts`
 *  - `types/plugin/plugin-context-provider.ts`
 */

export { defineContextProvider } from "@/lib/plugin/sdk/define-context-provider"

export type { PluginContextProvider } from "@/types/plugin/plugin-context-provider"
