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
  AcpPermissionMode,
  AcpAuthMethod,
  AcpImplementationInfo,
  AcpAgentCapabilities,
  AcpSessionModelState,
  AcpConfigOption,
  ExternalAgentConnectionStatus,
  ExternalAgentSessionExtensionSupport,
} from "@/types/agent/external-agent"

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
   */
  getSessionModels?: (sessionId: string) => AcpSessionModelState | undefined

  /**
   * Optional: Set a session config option (ACP)
   * @see https://agentclientprotocol.com/protocol/session-config-options
   */
  setConfigOption?: (
    sessionId: string,
    configId: string,
    value: string
  ) => Promise<AcpConfigOption[]>

  /**
   * Optional: Get session config options (ACP)
   * @see https://agentclientprotocol.com/protocol/session-config-options
   */
  getConfigOptions?: (sessionId: string) => AcpConfigOption[] | undefined

  /**
   * Optional: List sessions (ACP extension / unstable)
   */
  listSessions?: () => Promise<
    Array<{ sessionId: string; title?: string; createdAt?: string; updatedAt?: string }>
  >

  /**
   * Optional: Fork session (ACP extension / unstable)
   */
  forkSession?: (sessionId: string) => Promise<ExternalAgentSession>

  /**
   * Optional: Resume session (ACP extension / unstable)
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

/**
 * Options for creating a session
 * @see https://agentclientprotocol.com/protocol/session-setup
 */
export interface SessionCreateOptions {
  /** Working directory for the session (absolute path, required by ACP) */
  cwd?: string
  /** MCP servers to connect to */
  mcpServers?: import("@/types/agent/external-agent").AcpMcpServerConfig[]
  /** Permission mode for the session */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk"
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
export abstract class BaseProtocolAdapter implements ProtocolAdapter {
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
    let tokenUsage: ExternalAgentResult["tokenUsage"]

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

          case "done":
            success = event.success
            tokenUsage = event.tokenUsage
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
        tokenUsage,
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
