/**
 * Protocol adapter registry (host side).
 *
 * The adapter contract lives in `@cognia/agent-contracts/adapter` and the
 * shared base in `@cognia/agent-runtime-kit/base-adapter` (ADR-0217). This
 * module owns what is the host's: the registry adapters are created from and
 * the plugin-contributed overlay with its ownership and metadata. It also
 * re-exports the contract so existing importers keep one path.
 */

import type { ProtocolAdapter, ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import { adaptPluginProtocolAdapter } from "@cognia/agent-runtime-kit/plugin-compat"
import type { ExternalAgentCapabilityMatrix } from "@cognia/agent-contracts/external-agent-capability"

export type {
  ExternalAgentAdapterCore,
  ExternalAgentAdapterOptionalCapabilities,
  ExternalAgentListedSession,
  ProtocolAdapter,
  ProtocolAdapterFactory,
  SessionCreateOptions,
  SessionListOptions,
} from "@cognia/agent-contracts/adapter"
export {
  BaseProtocolAdapter,
  foldUsageUpdate,
  mergeTurnUsage,
} from "@cognia/agent-runtime-kit/base-adapter"

/**
 * Registry for protocol adapters
 */
export class ProtocolAdapterRegistry {
  private adapters: Map<string, () => ProtocolAdapter> = new Map()

  /**
   * Register a protocol adapter factory
   * @param protocol Protocol identifier
   * @param factory Factory function to create adapter instances
   */
  register(protocol: string, factory: () => ProtocolAdapter): void {
    this.adapters.set(protocol, factory)
  }

  /**
   * Unregister a protocol adapter
   * @param protocol Protocol identifier
   */
  unregister(protocol: string): void {
    this.adapters.delete(protocol)
  }

  /**
   * Create a new adapter instance for a protocol
   * @param protocol Protocol identifier
   * @returns New adapter instance or undefined if not registered
   */
  create(protocol: string): ProtocolAdapter | undefined {
    const factory = this.adapters.get(protocol)
    return factory?.()
  }

  /**
   * Check if a protocol is registered
   * @param protocol Protocol identifier
   */
  has(protocol: string): boolean {
    return this.adapters.has(protocol)
  }

  /**
   * Get all registered protocol identifiers
   */
  getProtocols(): string[] {
    return Array.from(this.adapters.keys())
  }
}

/**
 * Global protocol adapter registry
 */
export const protocolAdapterRegistry = new ProtocolAdapterRegistry()

// ============================================================================
// Plugin-contributed adapter overlay
//
// Plugins contribute external-agent protocol adapters through the
// `external-agent-adapter` capability. The contribution flows into the SAME
// `protocolAdapterRegistry` the four built-ins use (so resolution stays
// uniform — `addAgent` calls `create(protocol)` and never branches on origin),
// but every plugin registration is namespaced `${pluginId}:${id}` and tracked
// by owner so disabling a plugin removes exactly its adapters and never a
// built-in. This is the targeted-behaviour twin of the preset overlay in
// `presets.ts`: presets contribute configuration, adapters contribute protocol.
// ============================================================================

/** protocol id → owning pluginId, for bulk cleanup on plugin disable. */
const pluginAdapterOwners = new Map<string, string>()

/**
 * protocol id → what the contributing manifest DECLARED about it.
 *
 * Kept beside the factory rather than inside it because the declaration has to
 * be readable without instantiating an adapter: the static preflight answers
 * "can this configuration possibly work?" before anything is spawned, and
 * constructing an adapter to ask would defeat the point of a preflight.
 */
const pluginAdapterMetadata = new Map<string, PluginProtocolAdapterMetadata>()

/**
 * Registration metadata for a plugin-contributed protocol.
 *
 * `capabilities` being absent is a real state, not a missing field: a plugin
 * that predates capability declarations registers fine and every capability
 * stays `unknown`, which fails closed against a hard requirement while still
 * letting the handshake prove the adapter works.
 */
export interface PluginProtocolAdapterMetadata {
  pluginId: string
  /** The bare contribution id, i.e. the half after the colon. */
  adapterId: string
  /** Adapter version, if the manifest declared one. */
  version?: string
  /** Layer-2 capability refinement from the manifest, if declared. */
  capabilities?: ExternalAgentCapabilityMatrix
}

// ----------------------------------------------------------------------------
// Registry change notifications
//
// The agent selector, settings panel, and the startup rehydrator need to react
// the moment a plugin-contributed adapter becomes available or unavailable
// (a plugin enabling/disabling its `external-agent-adapter`). Polling the
// registry can't catch that transition, so the overlay emits a tiny synchronous
// change event. A faulty listener must never break plugin enable/disable, so
// dispatch is wrapped per-listener.
// ----------------------------------------------------------------------------

export interface ProtocolAdapterRegistryChange {
  /** "register" when adapters became available, "unregister" when removed. */
  kind: "register" | "unregister"
  /** Affected protocol ids (namespaced `${pluginId}:${id}` for plugin adapters). */
  protocols: string[]
  /** Owning pluginId for the overlay mutation that produced this change. */
  pluginId: string
}

type ProtocolAdapterRegistryListener = (change: ProtocolAdapterRegistryChange) => void

const registryChangeListeners = new Set<ProtocolAdapterRegistryListener>()

/** Subscribe to plugin-overlay registry changes. Returns an unsubscribe fn. */
export function onProtocolAdapterRegistryChange(
  listener: ProtocolAdapterRegistryListener
): () => void {
  registryChangeListeners.add(listener)
  return () => {
    registryChangeListeners.delete(listener)
  }
}

function emitProtocolAdapterRegistryChange(change: ProtocolAdapterRegistryChange): void {
  if (change.protocols.length === 0) {
    return
  }
  for (const listener of registryChangeListeners) {
    try {
      listener(change)
    } catch {
      // Swallow: a UI listener throwing must not abort the enable/disable flow.
    }
  }
}

/**
 * Register a plugin-contributed protocol adapter. Refuses (returns `false`) if
 * the protocol is already registered by the host or another plugin — with the
 * `${pluginId}:${id}` namespacing the bridge applies, that collision is
 * unreachable in practice, but the honest signal lets the bridge report it.
 * Re-registering the SAME plugin's protocol replaces it (idempotent re-enable).
 */
export function registerPluginProtocolAdapter(
  protocol: string,
  factory: ProtocolAdapterFactory,
  opts: {
    pluginId: string
    adapterId?: string
    version?: string
    capabilities?: ExternalAgentCapabilityMatrix
  }
): boolean {
  const existingOwner = pluginAdapterOwners.get(protocol)
  if (protocolAdapterRegistry.has(protocol) && existingOwner !== opts.pluginId) {
    return false
  }
  // Plugin adapters are untyped at runtime (JavaScript factories, Python
  // proxies). Read each one against the adapter core when it is created, so a
  // missing member fails the agent's creation instead of a later turn.
  protocolAdapterRegistry.register(protocol, () => adaptPluginProtocolAdapter(factory(), protocol))
  pluginAdapterOwners.set(protocol, opts.pluginId)
  pluginAdapterMetadata.set(protocol, {
    pluginId: opts.pluginId,
    adapterId: opts.adapterId ?? protocol.slice(opts.pluginId.length + 1),
    ...(opts.version ? { version: opts.version } : {}),
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
  })
  emitProtocolAdapterRegistryChange({
    kind: "register",
    protocols: [protocol],
    pluginId: opts.pluginId,
  })
  return true
}

/**
 * Drop every protocol adapter contributed by `pluginId`. Returns the number
 * removed. Called by the plugin manager on disable / uninstall.
 */
export function unregisterPluginProtocolAdaptersByPlugin(pluginId: string): number {
  const removedProtocols: string[] = []
  for (const [protocol, owner] of pluginAdapterOwners) {
    if (owner === pluginId) {
      protocolAdapterRegistry.unregister(protocol)
      pluginAdapterOwners.delete(protocol)
      pluginAdapterMetadata.delete(protocol)
      removedProtocols.push(protocol)
    }
  }
  emitProtocolAdapterRegistryChange({ kind: "unregister", protocols: removedProtocols, pluginId })
  return removedProtocols.length
}

/** Returns the owning pluginId for a protocol, or undefined for a built-in. */
export function getPluginProtocolAdapterOwner(protocol: string): string | undefined {
  return pluginAdapterOwners.get(protocol)
}

/**
 * What the manifest declared about a plugin-contributed protocol.
 *
 * `undefined` for a built-in protocol — which is not a gap: a built-in's
 * capability row lives in `protocol/agent-capabilities.json`, and answering
 * from here as well would be the second source of truth this contract removes.
 */
export function getPluginProtocolAdapterMetadata(
  protocol: string
): PluginProtocolAdapterMetadata | undefined {
  return pluginAdapterMetadata.get(protocol)
}

/**
 * Protocols currently contributed by `pluginId` (namespaced `${pluginId}:${id}`),
 * in registration order. Lets the disable path capture a plugin's protocols
 * *before* {@link unregisterPluginProtocolAdaptersByPlugin} drops them, so the
 * external-agent manager can tear down exactly the agents those protocols back.
 */
export function getPluginProtocolAdapterProtocols(pluginId: string): string[] {
  const protocols: string[] = []
  for (const [protocol, owner] of pluginAdapterOwners) {
    if (owner === pluginId) {
      protocols.push(protocol)
    }
  }
  return protocols
}

/** Every plugin-contributed adapter as `{ protocol, pluginId }`, registration order. */
export function listPluginProtocolAdapters(): Array<{ protocol: string; pluginId: string }> {
  return Array.from(pluginAdapterOwners, ([protocol, pluginId]) => ({ protocol, pluginId }))
}

/**
 * Test-only escape hatch: drop every plugin-contributed adapter (and its
 * registry entry) so a suite can reset the overlay without disturbing the four
 * built-ins. Production code uses `unregisterPluginProtocolAdaptersByPlugin`.
 */
export function __resetPluginProtocolAdaptersForTesting(): void {
  for (const protocol of pluginAdapterOwners.keys()) {
    protocolAdapterRegistry.unregister(protocol)
  }
  pluginAdapterOwners.clear()
}
