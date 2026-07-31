/**
 * Plugin SDK — `connectors` capability surface (ADR-0009).
 *
 * Re-exports the `defineConnector()` authoring helper so plugin authors get
 * autocomplete + a compile-time check that their connector entry matches
 * `PluginConnectorDef`. The `factory` field names an exported function from the
 * plugin's `main` entrypoint; the connectors bridge
 * (`lib/plugin/bridge/connectors-bridge.ts`) resolves it into a
 * `PlatformAdapter` and registers it with the ConnectorBus — after which the
 * adapter is treated identically to a built-in one (policy, FIFO queue,
 * retries, the plugin⇄IM lifecycle hooks).
 *
 * Sources:
 *  - `packages/plugin-sdk/src/define/define-connector.ts`
 *  - `lib/plugin/bridge/connectors-bridge.ts`
 *  - `types/plugin/plugin.ts` (PluginConnectorDef)
 */

export { defineConnector } from "../define/define-connector"
export { buildA2UICapabilityMatrix } from "@/types/connectors/capability"

export type { PluginConnectorDef } from "@/types/plugin"
export type { PlatformAdapter } from "@/types/connectors"
export type {
  PluginAdapterContext,
  PluginAdapterFactory as AdapterFactory,
} from "@/types/connectors/plugin-adapter"
export type { ConnectorRuntimeCapabilityMatrix } from "@/types/connectors/runtime-capability"
export type {
  RunActivitySnapshot,
  RunPresentationCapabilities,
  RunPresentationDriver,
  RunPresentationMutationOptions,
  RunPresentationRef,
  RunPresentationTarget,
  RunProjectionSnapshot,
} from "@/types/execution/run"
