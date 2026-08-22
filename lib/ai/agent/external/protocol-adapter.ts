/**
 * Protocol Adapter Interface
 *
 * Defines the common interface for all external agent protocol adapters.
 * Each protocol (ACP, A2A, HTTP, etc.) implements this interface.
 */

import type {
  ExternalAgentConfig,
  ExternalAgentSession,
  ExternalAgentMessage,
  ExternalAgentEvent,
  ExternalAgentResult,
  ExternalAgentExecutionOptions,
  AcpCapabilities,
  AcpToolInfo,
  AcpPermissionResponse,
  AcpElicitationResponse,
  AcpPermissionMode,
  AcpAuthMethod,
  AcpImplementationInfo,
  AcpAgentCapabilities,
  AcpSessionModelState,
  AcpConfigOption,
  ExternalAgentConnectionStatus,
  ExternalAgentSessionExtensionSupport,
  AcpAvailableCommand,
  ExternalAgentTokenUsage,
} from "@/types/agent/external-agent"
import {
  resolveCommandCompactionCapability,
  resolveProviderUndoCapability,
  type ExternalAgentCompactionCapability,
  type ExternalAgentCompactionOptions,
  type ExternalAgentProviderUndoCapability,
} from "./session-capabilities"
import type { ExternalAgentCapabilityMatrix } from "@cognia/agent-config-types/external-agent-capability"

/**
 * Protocol adapter interface
 * All protocol implementations must implement this interface
 */
export interface ProtocolAdapter {
  /** Protocol identifier */
  readonly protocol: string

  /** Current connection status */
  readonly connectionStatus: ExternalAgentConnectionStatus

  /** Discovered capabilities after connection */
  readonly capabilities?: AcpCapabilities

  /** Available tools after connection */
  readonly tools?: AcpToolInfo[]

  /**
   * Connect to the external agent
   * @param config Agent configuration
   * @returns Promise that resolves when connected
   */
  connect(config: ExternalAgentConfig): Promise<void>

  /**
   * Disconnect from the external agent
   * @returns Promise that resolves when disconnected
   */
  disconnect(): Promise<void>

  /**
   * Check if connected
   */
  isConnected(): boolean

  /**
   * Create a new session with the agent
   * @param options Session creation options
   * @returns Created session
   */
  createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession>

  /**
   * Close an existing session
   * @param sessionId Session ID to close
   */
  closeSession(sessionId: string): Promise<void>

  /**
   * Send a prompt to the agent and receive streaming responses
   * @param sessionId Session ID
   * @param message Message to send
   * @param options Execution options
   * @returns AsyncIterable of events
   */
  prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent>

  /**
   * Execute a complete interaction (non-streaming)
   * @param sessionId Session ID
   * @param message Message to send
   * @param options Execution options
   * @returns Execution result
   */
  execute(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): Promise<ExternalAgentResult>

  /**
   * Respond to a permission request
   * @param sessionId Session ID
   * @param response Permission response
   */
  respondToPermission(sessionId: string, response: AcpPermissionResponse): Promise<void>

  /** Respond to a feature-gated ACP v1 elicitation request. */
  respondToElicitation?(response: AcpElicitationResponse): Promise<void>

  /** Cancel a JSON-RPC request by its wire id using `$/cancel_request`. */
  cancelRequest?: (requestId: number | string) => Promise<void>

  /**
   * Optional: Set session permission mode (ACP)
   */
  setSessionMode?: (sessionId: string, modeId: AcpPermissionMode) => Promise<void>

  /**
   * Optional: Set session model (ACP)
   */
  setSessionModel?: (sessionId: string, modelId: string) => Promise<void>

  /**
   * Optional: Get session model state (ACP)
   *
   * Synchronous for ACP, which keeps the state locally. `PiRpcClientAdapter`
   * implements it with two RPC round-trips instead, so the promise form is part
   * of the contract — and {@link AgentManager.getSessionModels} rejects it as
   * unsupported rather than handing a pending promise back as model state.
   */
  getSessionModels?: (
    sessionId: string
  ) => AcpSessionModelState | undefined | Promise<AcpSessionModelState | undefined>

  /**
   * Optional: Set a session config option (ACP)
   * @see https://agentclientprotocol.com/protocol/session-config-options
   */
  setConfigOption?: (
    sessionId: string,
    configId: string,
    value: string | boolean
  ) => Promise<AcpConfigOption[]>

  /**
   * Optional: Get session config options (ACP)
   * @see https://agentclientprotocol.com/protocol/session-config-options
   */
  /**
   * Synchronous for ACP; `PiRpcClientAdapter` asks the process instead, so the
   * promise form is part of the contract. {@link AgentManager.getConfigOptions}
   * reports a promise as unsupported rather than passing it off as the list.
   */
  getConfigOptions?: (
    sessionId: string
  ) => AcpConfigOption[] | undefined | Promise<AcpConfigOption[] | undefined>

  /**
   * Optional: Append user input to the session's in-flight turn without
   * interrupting it (Codex app-server `turn/steer`). Rejects when no turn is
   * active or the backend lacks the method — callers keep their
   * queue-and-replay fallback for that case.
   */
  steerTurn?: (sessionId: string, text: string) => Promise<void>

  /** Optional: discover native or advertised context-compaction routes. */
  getCompactionCapability?: (sessionId: string) => Promise<ExternalAgentCompactionCapability>

  /** Optional: compact a session and resolve after provider-confirmed completion. */
  compactSession?: (sessionId: string, options?: ExternalAgentCompactionOptions) => Promise<void>

  /** Optional: discover the provider's advertised `/undo` command. */
  getProviderUndoCapability?: (sessionId: string) => Promise<ExternalAgentProviderUndoCapability>

  /** Optional: execute provider-specific undo semantics. */
  undoLastProviderChange?: (sessionId: string) => Promise<void>

  /**
   * Optional: List sessions (stable ACP v1)
   */
  listSessions?: (options?: SessionListOptions) => Promise<
    Array<{
      sessionId: string
      cwd?: string
      additionalDirectories?: string[]
      title?: string
      createdAt?: string
      updatedAt?: string
    }>
  >

  /**
   * Optional: Fork session (ACP extension / unstable)
   */
  forkSession?: (sessionId: string, options?: SessionCreateOptions) => Promise<ExternalAgentSession>

  /**
   * Optional: Resume session (stable ACP v1)
   */
  resumeSession?: (
    sessionId: string,
    options?: SessionCreateOptions
  ) => Promise<ExternalAgentSession>

  /**
   * Optional: Get available auth methods (ACP)
   */
  getAuthMethods?: () => AcpAuthMethod[]

  /**
   * Optional: Check if auth is required (ACP)
   */
  isAuthenticationRequired?: () => boolean

  /**
   * Optional: Authenticate with the agent (ACP)
   */
  authenticate?: (methodId: string, credentials?: Record<string, unknown>) => Promise<void>

  /**
   * Optional: Log out of the agent's authenticated session (ACP v1 `logout`).
   */
  logout?: () => Promise<void>

  /**
   * Optional: Delete a session from the agent's listings (ACP v1
   * `session/delete`), as opposed to {@link closeSession} which only ends it.
   * The return is `void` (ACP) or a `boolean` success flag (OpenCode SDK).
   */
  deleteSession?: (sessionId: string) => Promise<void | boolean>

  /**
   * Optional: Expose ACP initialization metadata from negotiated handshake.
   */
  getAcpInitializationMetadata?: () => {
    protocolVersion?: number
    agentInfo?: AcpImplementationInfo
    agentCapabilities?: AcpAgentCapabilities
    authMethods?: AcpAuthMethod[]
  }

  /**
   * Optional: Expose support state for unstable ACP session extension methods.
   */
  getSessionExtensionSupport?: () => ExternalAgentSessionExtensionSupport

  /**
   * Optional: Reset cached extension-support probes for a new connection lifecycle.
   */
  clearSessionExtensionSupportCache?: () => void

  /**
   * Cancel an ongoing execution
   * @param sessionId Session ID
   */
  cancel(sessionId: string): Promise<void>

  /**
   * Get session by ID
   * @param sessionId Session ID
   */
  getSession(sessionId: string): ExternalAgentSession | undefined

  /**
   * Get all active sessions
   */
  getSessions(): ExternalAgentSession[]

  /**
   * Health check
   * @returns True if healthy
   */
  healthCheck(): Promise<boolean>
}

/** Optional filters for protocol-backed session discovery. */
export interface SessionListOptions {
  /** Absolute working directory filter defined by ACP session/list. */
  cwd?: string
}

/**
 * Options for creating a session
 * @see https://agentclientprotocol.com/protocol/session-setup
 */
export interface SessionCreateOptions {
  /** Working directory for the session (absolute path, required by ACP) */
  cwd?: string
  /** Additional absolute workspace roots (ACP `additionalDirectories`). */
  additionalDirectories?: string[]
  /** MCP servers to connect to */
  mcpServers?: import("@/types/agent/external-agent").AcpMcpServerConfig[]
  /** Permission mode for the session */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk"
  /**
   * Pre-approved tool allow-list, consulted only under `dontAsk` to silently
   * approve matching tools (see `ExternalAgentExecutionOptions.allowedTools`).
   */
  allowedTools?: string[]
  /** Context to pass to the agent */
  context?: Record<string, unknown>
  /** Structured instruction payload for protocol-specific metadata bridging */
  instructionEnvelope?: {
    hash: string
    developerInstructions: string
    customInstructions?: string
    skillsSummary?: string
    sourceFlags?: Record<string, boolean>
    projectContextSummary?: string
  }
  /** System prompt override */
  systemPrompt?: string
  /**
   * Cognia-specific brief-output mode. When true, the adapter prepends a
   * concise-output instruction to the resolved `systemPrompt` so the agent
   * favours short answers. No-op for agents that ignore `_meta.systemPrompt`.
   */
  briefMode?: boolean
  /** Session timeout (ms) */
  timeout?: number
  /** Session metadata */
  metadata?: Record<string, unknown>
}

/**
 * Base class for protocol adapters providing common functionality
 */
/**
 * Fold a context-window `usage_update` into the running usage.
 *
 * The protocol reports OCCUPANCY (`used` / `size`) and a cumulative cost, not a
 * prompt/completion split — see `canonical-contract.ts`. So `used` becomes
 * `contextTokens`, `size` becomes the window, and `totalTokens` is only filled
 * when nothing better has arrived: overwriting a real breakdown with an
 * occupancy figure would silently halve a caller's token accounting.
 */
export function foldUsageUpdate(
  current: ExternalAgentTokenUsage | undefined,
  event: { used: number; size: number; cost?: { amount: number; currency: string } | null }
): ExternalAgentTokenUsage {
  const base: ExternalAgentTokenUsage = current ?? {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  }
  return {
    ...base,
    contextTokens: event.used,
    ...(event.size > 0 ? { modelContextWindow: event.size } : {}),
    ...(base.totalTokens === 0 ? { totalTokens: event.used } : {}),
    ...(event.cost
      ? { providerCost: { amount: event.cost.amount, currency: event.cost.currency } }
      : {}),
  }
}

/**
 * The turn's usage: the terminal figure when there is one, otherwise the last
 * streamed one.
 *
 * Not a deep merge. When `done` reports usage it is the adapter's final,
 * authoritative accounting and must not be diluted by an earlier partial —
 * except for the two fields `done` structurally cannot carry on some adapters
 * (the live context window, and a provider-reported cost that only ever
 * arrives on a `usage_update`), which are carried forward when the final
 * figure is silent about them.
 */
export function mergeTurnUsage(
  final: ExternalAgentTokenUsage | undefined,
  streamed: ExternalAgentTokenUsage | undefined
): ExternalAgentTokenUsage | undefined {
  if (!final) return streamed
  if (!streamed) return final
  return {
    ...final,
    ...(final.contextTokens === undefined && streamed.contextTokens !== undefined
      ? { contextTokens: streamed.contextTokens }
      : {}),
    ...(final.modelContextWindow === undefined && streamed.modelContextWindow !== undefined
      ? { modelContextWindow: streamed.modelContextWindow }
      : {}),
    ...(final.providerCost === undefined && streamed.providerCost !== undefined
      ? { providerCost: streamed.providerCost }
      : {}),
  }
}

export abstract class BaseProtocolAdapter implements ProtocolAdapter {
  respondToElicitation?(response: AcpElicitationResponse): Promise<void>
  abstract readonly protocol: string

  protected _connectionStatus: ExternalAgentConnectionStatus = "disconnected"
  protected _capabilities?: AcpCapabilities
  protected _tools?: AcpToolInfo[]
  protected _config?: ExternalAgentConfig
  protected _sessions: Map<string, ExternalAgentSession> = new Map()

  get connectionStatus(): ExternalAgentConnectionStatus {
    return this._connectionStatus
  }

  get capabilities(): AcpCapabilities | undefined {
    return this._capabilities
  }

  get tools(): AcpToolInfo[] | undefined {
    return this._tools
  }

  abstract connect(config: ExternalAgentConfig): Promise<void>
  abstract disconnect(): Promise<void>
  abstract createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession>
  abstract closeSession(sessionId: string): Promise<void>
  abstract prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent>
  abstract respondToPermission(sessionId: string, response: AcpPermissionResponse): Promise<void>
  abstract cancel(sessionId: string): Promise<void>

  isConnected(): boolean {
    return this._connectionStatus === "connected"
  }

  getSession(sessionId: string): ExternalAgentSession | undefined {
    return this._sessions.get(sessionId)
  }

  getSessions(): ExternalAgentSession[] {
    return Array.from(this._sessions.values())
  }

  async healthCheck(): Promise<boolean> {
    return this.isConnected()
  }

  protected async getAdvertisedCommandCompactionCapability(
    sessionId: string
  ): Promise<ExternalAgentCompactionCapability> {
    const session = this.getSession(sessionId)
    if (!session) {
      return { status: "unknown", routes: [], reason: "session_not_found" }
    }
    return resolveCommandCompactionCapability(
      (session.metadata?.availableCommands as AcpAvailableCommand[] | undefined) ?? []
    )
  }

  protected async compactWithAdvertisedCommand(
    sessionId: string,
    options: ExternalAgentCompactionOptions = {}
  ): Promise<void> {
    const capability = await this.getAdvertisedCommandCompactionCapability(sessionId)
    const route = capability.routes.find(
      (candidate) => candidate.kind === "command" && (!options.focus || candidate.supportsFocus)
    )
    if (!route || route.kind !== "command") {
      throw new Error("Agent does not support context compaction")
    }
    const text = options.focus ? `/${route.command} ${options.focus}` : `/${route.command}`
    const result = await this.execute(sessionId, {
      id: this.generateMessageId(),
      role: "user",
      content: [{ type: "text", text }],
      timestamp: new Date(),
    })
    if (!result.success) {
      throw new Error(result.error || "Context compaction failed")
    }
  }

  protected async getAdvertisedProviderUndoCapability(
    sessionId: string
  ): Promise<ExternalAgentProviderUndoCapability> {
    const session = this.getSession(sessionId)
    if (!session) {
      return { status: "unknown", reason: "session_not_found" }
    }
    return resolveProviderUndoCapability(
      (session.metadata?.availableCommands as AcpAvailableCommand[] | undefined) ?? []
    )
  }

  protected async undoWithAdvertisedCommand(sessionId: string): Promise<void> {
    const capability = await this.getAdvertisedProviderUndoCapability(sessionId)
    if (capability.status !== "supported") {
      throw new Error("Agent does not support provider undo")
    }
    const result = await this.execute(sessionId, {
      id: this.generateMessageId(),
      role: "user",
      content: [{ type: "text", text: "/undo" }],
      timestamp: new Date(),
    })
    if (!result.success) {
      throw new Error(result.error || "Provider undo failed")
    }
  }

  /**
   * Execute a complete interaction by collecting all events from prompt
   */
  async execute(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): Promise<ExternalAgentResult> {
    const startTime = Date.now()
    const events: ExternalAgentEvent[] = []
    const messages: ExternalAgentMessage[] = [message]
    const steps: ExternalAgentResult["steps"] = []
    const toolCalls: ExternalAgentResult["toolCalls"] = []

    let currentText = ""
    let currentThinking = ""
    let success = true
    let error: string | undefined
    // Two sources, deliberately kept apart until the end. `done` carries the
    // authoritative final figure when an adapter has one; the streaming
    // `usage_update` / `message_end` events are the running one. Reading only
    // `done` (which is what this used to do) meant every adapter that reports
    // usage mid-stream and settles without repeating it — OpenCode, and any
    // ACP agent that sends `usage_update` — returned a result with no usage at
    // all, while the events the caller had just seen carried it.
    let finalUsage: ExternalAgentResult["tokenUsage"]
    let streamedUsage: ExternalAgentResult["tokenUsage"]

    try {
      for await (const event of this.prompt(sessionId, message, options)) {
        events.push(event)

        // Call event callback if provided
        options?.onEvent?.(event)

        switch (event.type) {
          case "message_delta":
            if (event.delta.type === "text") {
              currentText += event.delta.text
            } else if (event.delta.type === "thinking") {
              currentThinking += event.delta.text
            }
            break

          case "tool_use_start":
            toolCalls.push({
              id: event.toolUseId,
              name: event.toolName,
              input: {},
              status: "pending",
            })
            break

          case "tool_use_end":
            {
              const toolCall = toolCalls.find((tc) => tc.id === event.toolUseId)
              if (toolCall) {
                toolCall.input = event.input
              }
            }
            break

          case "tool_result":
            {
              const toolCall = toolCalls.find((tc) => tc.id === event.toolUseId)
              if (toolCall) {
                toolCall.result = event.result
                toolCall.status = event.isError ? "error" : "completed"
                if (event.isError) {
                  toolCall.error =
                    typeof event.result === "string" ? event.result : JSON.stringify(event.result)
                }
              }
            }
            break

          case "permission_request":
            if (options?.onPermissionRequest) {
              const response = await options.onPermissionRequest(event.request)
              await this.respondToPermission(sessionId, response)
            }
            break

          case "elicitation_request":
            if (options?.onElicitationRequest && this.respondToElicitation) {
              const response = await options.onElicitationRequest(event.request)
              await this.respondToElicitation(response)
            }
            break

          case "plan_update":
            options?.onProgress?.(event.progress)
            break

          case "progress":
            options?.onProgress?.(event.progress, event.message)
            break

          case "error":
            success = false
            error = event.error
            break

          case "usage_update":
            // A context-window report. It carries occupancy rather than a
            // prompt/completion split, so it can only FILL what nothing else
            // has said — never overwrite a real breakdown with zeros.
            streamedUsage = foldUsageUpdate(streamedUsage, event)
            break

          case "message_end":
            if (event.tokenUsage) streamedUsage = event.tokenUsage
            break

          case "done":
            success = event.success
            if (event.tokenUsage) finalUsage = event.tokenUsage
            break
        }
      }

      // Build final response message
      if (currentText || currentThinking) {
        messages.push({
          id: `msg_${Date.now()}`,
          role: "assistant",
          content: [
            ...(currentThinking ? [{ type: "thinking" as const, thinking: currentThinking }] : []),
            ...(currentText ? [{ type: "text" as const, text: currentText }] : []),
          ],
          timestamp: new Date(),
        })
      }

      return {
        success,
        sessionId,
        finalResponse: currentText,
        messages,
        steps,
        toolCalls,
        duration: Date.now() - startTime,
        tokenUsage: mergeTurnUsage(finalUsage, streamedUsage),
        error,
      }
    } catch (err) {
      return {
        success: false,
        sessionId,
        finalResponse: "",
        messages,
        steps,
        toolCalls,
        duration: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Update session in the map
   */
  protected updateSession(
    sessionId: string,
    updates: Partial<ExternalAgentSession>
  ): ExternalAgentSession | undefined {
    const session = this._sessions.get(sessionId)
    if (session) {
      const updated = { ...session, ...updates, lastActivityAt: new Date() }
      this._sessions.set(sessionId, updated)
      return updated
    }
    return undefined
  }

  /**
   * Generate a unique session ID
   */
  protected generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }

  /**
   * Generate a unique message ID
   */
  protected generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }
}

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

/** Factory shape stored in the registry — what a plugin contributes. */
export type ProtocolAdapterFactory = () => ProtocolAdapter

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
  protocolAdapterRegistry.register(protocol, factory)
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
