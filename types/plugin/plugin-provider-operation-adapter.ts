/**
 * Plugin Provider Operation Adapter contract (`provider-operation-adapter`
 * capability, ADR-0163).
 *
 * Opens the provider operation plane to plugins. The host serves fifty
 * operations for the built-in providers. A plugin can serve one of them for a
 * provider, a wire protocol, or every provider by shipping a
 * `providerOperationAdapters[]` manifest entry. The adapter is registered as a
 * handler in the operation registry with `support: "plugin"` and
 * `via: "<pluginId>:<adapterId>"`, so the capability matrix shows it as a
 * plugin-served cell and the executor dispatches to it like any built-in.
 *
 * Adapters run in the host with the same context a built-in handler gets:
 * the resolved provider (credential included), the settings snapshot and the
 * validated request. The executor still owns the PII gate, scope checks and
 * the surface check, so an adapter cannot widen what the descriptor allows.
 */

import type { ProviderOperationId, ResolverProtocol } from "@cognia/provider-types"

import type {
  ProviderOperationHandler,
  ProviderOperationProviderMatch,
} from "@/lib/ai/operations/registry"

export type { ProviderOperationProviderMatch }

export interface PluginProviderOperationAdapterDef {
  /** Stable registry id, `<pluginId>:<adapter>` by convention. */
  id: string
  /** Optional display name for diagnostics and the plugin capability summary. */
  name?: string
  /** The operation this adapter serves. Must be a contract operation id. */
  operationId: ProviderOperationId
  /**
   * Which providers the adapter answers for. `provider` pins one id,
   * `protocol` answers every provider on that wire, `any` answers everyone.
   * Resolution order stays provider, then protocol, then any, so a plugin
   * pinned to a provider wins over a protocol-wide built-in.
   */
  providerMatch:
    | { kind: "provider"; providerId: string }
    | { kind: "protocol"; protocol: ResolverProtocol }
    | { kind: "any" }
  handler: ProviderOperationHandler
}
