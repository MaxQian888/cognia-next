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

/**
 * The abstract base every protocol adapter extends. Subclassing it — rather
 * than implementing `ProtocolAdapter` from scratch — is what gets an adapter
 * the host's usage folding, turn accounting, and lifecycle bookkeeping for
 * free, and keeps a plugin adapter behaving like a built-in one.
 */
export {
  BaseProtocolAdapter,
  foldUsageUpdate,
  mergeTurnUsage,
} from "@/lib/ai/agent/external/protocol-adapter"

export type {
  PluginProtocolAdapterMetadata,
  SessionListOptions,
} from "@/lib/ai/agent/external/protocol-adapter"

/**
 * Why the host would refuse to execute a given external-agent config. An
 * adapter or preset plugin reads this to explain the refusal in its own UI
 * instead of re-deriving the rules and drifting from them.
 */
export {
  getExternalAgentExecutionBlock,
  getExternalAgentExecutionBlockReason,
  isSupportedExternalAgentProtocol,
  SUPPORTED_EXTERNAL_AGENT_PROTOCOLS,
} from "@/lib/ai/agent/external/config-normalizer"

export type { ExternalAgentExecutionBlockAssessment } from "@/lib/ai/agent/external/config-normalizer"

/** The external-agent domain vocabulary an adapter speaks. */
export type {
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentMessageDeltaEvent,
  ExternalAgentProtocol,
  ExternalAgentSession,
  ExternalAgentTransport,
} from "@/types/agent/external-agent"
