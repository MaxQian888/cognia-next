/**
 * Plugin SDK — `protocol-adapter` capability surface.
 *
 * Re-exports the authoring helper, manifest bridge, and provider protocol
 * adapter registries used for declarative and renderer-side code adapters.
 */

export { defineProtocolAdapter } from "../define/define-protocol-adapter"

export {
  registerProtocolAdaptersForPlugin,
  unregisterProtocolAdaptersForPlugin,
} from "@/lib/plugin/bridge/protocol-adapters-bridge"

export type {
  ProtocolAdaptersBridgeError,
  ProtocolAdaptersBridgeOptions,
  ProtocolAdaptersBridgeResult,
} from "@/lib/plugin/bridge/protocol-adapters-bridge"

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
} from "@/types/plugin/plugin-protocol-adapter"
