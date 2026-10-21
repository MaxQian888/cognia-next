/**
 * Plugin SDK — `protocol-adapter` capability surface.
 *
 * Exports the authoring helper and the provider protocol adapter registries
 * used for declarative and renderer-side code adapters. The host registers
 * manifest-declared adapters itself.
 */

export { defineProtocolAdapter } from "../define/define-protocol-adapter"

export type {
  ProtocolAdaptersBridgeError,
  ProtocolAdaptersBridgeOptions,
  ProtocolAdaptersBridgeResult,
} from "@cognia/plugin-contract/lib/plugin/bridge/protocol-adapters-bridge"

export {
  getCodeAdapterExecutor,
  getProtocolAdapter,
  listProtocolAdapters,
  registerCodeAdapterExecutor,
  registerProtocolAdapter,
  unregisterCodeAdapterExecutor,
  unregisterCodeAdapterExecutorsByPlugin,
  unregisterProtocolAdapter,
  unregisterProtocolAdaptersByPlugin,
} from "@cognia/provider-core/providers/protocol-adapter-registry"

export type {
  CodeAdapterChunk,
  CodeAdapterRequest,
  CodeProtocolAdapterContext,
  CodeProtocolAdapterFactory,
  CodeProtocolAdapterLike,
  OpenAiCompatibleVariantResponsePaths,
  OpenAiCompatibleVariantSpec,
  PluginProtocolAdapterDef,
  ProtocolAdapterSpec,
  SidecarCodeAdapterSpec,
} from "@cognia/plugin-contract/types/plugin/plugin-protocol-adapter"
