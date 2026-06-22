/**
 * Plugin SDK - `external-agent-adapter` capability surface.
 *
 * Re-exports the declarative authoring helper, manifest bridge, and dynamic
 * protocol adapter registry used by plugin-provided external-agent protocols.
 */

export { defineExternalAgentAdapter } from "../define/define-external-agent-adapter"

export {
  registerExternalAgentAdaptersForPlugin,
  unregisterExternalAgentAdaptersForPlugin,
} from "@/lib/plugin/bridge/external-agent-adapters-bridge"

export type {
  ExternalAgentAdaptersBridgeError,
  ExternalAgentAdaptersBridgeOptions,
  ExternalAgentAdaptersBridgeResult,
} from "@/lib/plugin/bridge/external-agent-adapters-bridge"

export {
  getPluginProtocolAdapterOwner,
  getPluginProtocolAdapterProtocols,
  listPluginProtocolAdapters,
  onProtocolAdapterRegistryChange,
  protocolAdapterRegistry,
  ProtocolAdapterRegistry,
  registerPluginProtocolAdapter,
  unregisterPluginProtocolAdaptersByPlugin,
} from "@/lib/ai/agent/external/protocol-adapter"

export type {
  ProtocolAdapter,
  ProtocolAdapterFactory,
  ProtocolAdapterRegistryChange,
  SessionCreateOptions,
} from "@/lib/ai/agent/external/protocol-adapter"

export type { PluginExternalAgentAdapterDef } from "@/types/plugin/plugin-external-agent-adapter"
