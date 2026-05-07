/**
 * ACP (Agent Client Protocol) Client Adapter
 *
 * Implements the Agent Client Protocol for communication with ACP-compatible agents
 * such as Claude Code (claude-code-acp).
 *
 * @see https://github.com/anthropics/agent-client-protocol
 * @see https://github.com/zed-industries/claude-code-acp
 */

import { isTauri } from "@/lib/utils"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { loggers } from "@/lib/logger"
import {
  acpTerminalCreate,
  acpTerminalKill,
  acpTerminalOutput,
  acpTerminalRelease,
  acpTerminalWaitForExit,
} from "@/lib/native/external-agent"
import { BaseProtocolAdapter, type SessionCreateOptions } from "./protocol-adapter"
import {
  createExternalAgentUnsupportedSessionExtensionError,
  isExternalAgentMethodNotFoundError,
  isExternalAgentSessionExtensionUnsupportedForMethod,
} from "./session-extension-errors"

const log = loggers.agent
import type {
  ExternalAgentConfig,
  ExternalAgentSession,
  ExternalAgentMessage,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  AcpCapabilities,
  AcpToolInfo,
  AcpPermissionMode,
  AcpPermissionResponse,
  ExternalAgentTokenUsage,
  AcpClientCapabilities,
  AcpAgentCapabilities,
  AcpImplementationInfo,
  AcpAuthMethod,
  AcpStopReason,
  AcpSessionUpdate,
  AcpMcpServerConfig,
  AcpSessionModelState,
  AcpSessionModesState,
  AcpConfigOption,
  AcpReadTextFileParams,
  AcpTerminalCreateParams,
  AcpTerminalOutputParams,
  AcpTerminalOutputResult,
  AcpPermissionRequest,
  AcpPermissionOption,
  AcpToolCallKind,
  AcpToolCallStatus,
  AcpToolCallLocation,
  ExternalAgentBranchReasonCode,
  ExternalAgentSessionExtensionMethod,
  ExternalAgentSessionExtensionSupport,
  ExternalAgentExtensionSupportStatus,
} from "@/types/agent/external-agent"

// ============================================================================
// ACP Protocol Types (JSON-RPC based)
// ============================================================================

/**
 * JSON-RPC request structure
 */
interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: Record<string, unknown>
}

/**
 * JSON-RPC response structure
 */
interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string | null
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

/**
 * JSON-RPC notification structure
 */
interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
}

/**
 * ACP Initialize request params
 * @see https://agentclientprotocol.com/protocol/initialization
 */
interface AcpInitializeParams {
  /** Protocol version (integer) */
  protocolVersion: number
  /** Client capabilities */
  clientCapabilities: AcpClientCapabilities
  /** Client implementation info */
  clientInfo: AcpImplementationInfo
}

/**
 * ACP Initialize response result
 * @see https://agentclientprotocol.com/protocol/initialization
 */
interface AcpInitializeResult {
  /** Negotiated protocol version */
  protocolVersion: number
  /** Agent capabilities */
  agentCapabilities: AcpAgentCapabilities
  /** Agent implementation info */
  agentInfo: AcpImplementationInfo
  /** Available authentication methods */
  authMethods?: AcpAuthMethod[]
}

/**
 * ACP session/new request params
 * @see https://agentclientprotocol.com/protocol/session-setup
 */
interface AcpNewSessionParams {
  /** Working directory (absolute path, required) */
  cwd: string
  /** MCP servers to connect to */
  mcpServers?: AcpMcpServerConfig[]
  /** Custom metadata */
  _meta?: {
    /** System prompt configuration */
    systemPrompt?: string | { append?: string }
    /** Disable built-in tools */
    disableBuiltInTools?: boolean
    /** Claude Code specific options */
    claudeCode?: {
      options?: Record<string, unknown>
    }
    /** Codex ACP specific options */
    codex?: {
      options?: Record<string, unknown>
    }
    /** Cognia-specific session metadata */
    cognia?: Record<string, unknown>
  }
}

/**
 * ACP session/new response result
 * @see https://agentclientprotocol.com/protocol/session-setup
 */
interface AcpNewSessionResult {
  /** Session ID */
  sessionId: string
  /** Available models */
  models?: AcpSessionModelState
  /** Available modes */
  modes?: AcpSessionModesState
  /** Session config options (supersedes modes) */
  configOptions?: AcpConfigOption[]
}

/**
 * ACP unstable session/list item
 * (supported by Zed ACP adapters and compatible implementations)
 */
interface AcpSessionListItem {
  sessionId: string
  title?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * ACP session/prompt request params
 * @see https://agentclientprotocol.com/protocol/prompt-turn
 */
interface AcpPromptParams {
  /** Session ID */
  sessionId: string
  /** Prompt content blocks */
  prompt: Array<AcpPromptContentBlock>
}

/**
 * ACP prompt content block types
 */
type AcpPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data?: string; uri?: string; mimeType: string }
  | { type: "resource_link"; uri: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }

/**
 * ACP session/prompt response result
 */
interface AcpPromptResult {
  /** Reason the turn stopped */
  stopReason: AcpStopReason
}

/**
 * ACP Session notification types
 * Note: ACP spec uses 'session/update' for most streaming updates
 */
type AcpNotificationType =
  | "session/update" // Primary notification type per ACP spec
  | "session/started"
  | "session/ended"
  | "message/start"
  | "message/delta"
  | "message/end"
  | "tool/start"
  | "tool/delta"
  | "tool/end"
  | "tool/result"
  | "permission/request"
  | "thinking"
  | "progress"
  | "error"

/**
 * Pending request tracking
 */
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

type AcpSessionRequestMeta = NonNullable<AcpNewSessionParams["_meta"]>

function createDefaultExtensionSupportStatus(): ExternalAgentExtensionSupportStatus {
  return {
    state: "unknown",
  }
}

function createDefaultSessionExtensionSupport(): ExternalAgentSessionExtensionSupport {
  return {
    "session/list": createDefaultExtensionSupportStatus(),
    "session/fork": createDefaultExtensionSupportStatus(),
    "session/resume": createDefaultExtensionSupportStatus(),
  }
}

// ============================================================================
// ACP Client Adapter Implementation
// ============================================================================

/**
 * Pure helper exported for testing. Computes the final spawn args by appending
 * the `--bare` / `--debug` flags when their convenience toggles are on, while
 * preserving any user-supplied raw args verbatim. Idempotent — never adds a
 * flag that's already present.
 */
export function buildSpawnArgs(
  proc: Pick<NonNullable<ExternalAgentConfig["process"]>, "args" | "bare" | "debug">
): string[] {
  const out = [...(proc.args ?? [])]
  if (proc.bare && !out.includes("--bare")) out.push("--bare")
  if (proc.debug && !out.includes("--debug")) out.push("--debug")
  return out
}

/**
 * ACP Client Adapter
 *
 * Handles communication with ACP-compatible agents via stdio (local process)
 * or HTTP/WebSocket (remote agents).
 */
export class AcpClientAdapter extends BaseProtocolAdapter {
  readonly protocol = "acp"

  private messageId = 0
  private pendingRequests: Map<number | string, PendingRequest> = new Map()
  private processId?: string
  private networkSocket?: WebSocket
  private networkEventSource?: EventSource
  private eventListeners: Map<string, Set<(event: ExternalAgentEvent) => void>> = new Map()
  private reconnectAttempts = 0
  private maxReconnectAttempts = 3
  private reconnectDelay = 1000
  private messageBuffer: string[] = []
  private isProcessingMessages = false

  // Tauri event unsubscribe functions
  private unsubscribeFunctions: Array<() => void> = []

  // Pending permission requests waiting for UI response
  private pendingPermissions: Map<
    string,
    {
      resolve: (response: { outcome: { outcome: string; optionId?: string } }) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
      request: AcpPermissionRequest
    }
  > = new Map()

  // Extension method handlers for custom "_" methods
  private extensionHandlers: Map<
    string,
    (params?: Record<string, unknown>) => Promise<unknown> | unknown
  > = new Map()

  // Cached unsupported methods discovered via probing (-32601)
  private unsupportedMethods: Set<string> = new Set()

  /**
   * Connect to an ACP agent
   */
  async connect(config: ExternalAgentConfig): Promise<void> {
    if (this._connectionStatus === "connected") {
      return
    }

    this._config = config
    this._connectionStatus = "connecting"
    this.clearSessionExtensionSupportCache()

    try {
      if (config.transport === "stdio") {
        await this.connectViaStdio(config)
      } else if (
        config.transport === "http" ||
        config.transport === "websocket" ||
        config.transport === "sse"
      ) {
        await this.connectViaNetwork(config)
      } else {
        throw new Error(`Unsupported transport: ${config.transport}`)
      }

      // Initialize the protocol
      const initResult = await this.initialize()
      // Map agent capabilities to legacy format for backward compatibility
      this._capabilities = {
        streaming: true,
        toolExecution: true,
        fileOperations: initResult.agentCapabilities?.promptCapabilities?.embeddedContext,
        mcpTools:
          initResult.agentCapabilities?.mcpCapabilities?.http ||
          initResult.agentCapabilities?.mcpCapabilities?.sse,
        multiTurn: initResult.agentCapabilities?.loadSession,
      }
      this._tools = []

      this._connectionStatus = "connected"
      this.reconnectAttempts = 0

      log.info("Connected to agent", { name: config.name, capabilities: this._capabilities })
    } catch (error) {
      this._connectionStatus = "error"
      log.error("Connection failed", { error })
      throw error
    }
  }

  /**
   * Connect via stdio (local process) using Tauri
   */
  private async connectViaStdio(config: ExternalAgentConfig): Promise<void> {
    if (!isTauri()) {
      throw new Error("stdio transport requires Tauri desktop environment")
    }

    if (!config.process) {
      throw new Error("Process configuration required for stdio transport")
    }

    const { invoke } = await import("@tauri-apps/api/core")
    const { listen } = await import("@tauri-apps/api/event")

    const finalArgs = buildSpawnArgs(config.process)

    // Spawn the external agent process
    this.processId = await invoke<string>("spawn_external_agent", {
      config: {
        id: config.id,
        command: config.process.command,
        args: finalArgs,
        env: config.process.env || {},
        cwd: config.process.cwd,
      },
    })

    log.info("Spawned process", { processId: this.processId })

    // Listen for stdout messages
    const unlistenStdout = await listen<{ agentId: string; data: string }>(
      "external-agent://stdout",
      (event) => {
        if (event.payload.agentId === this.processId) {
          this.handleIncomingMessage(event.payload.data)
        }
      }
    )
    this.unsubscribeFunctions.push(unlistenStdout)

    // Listen for stderr messages
    const unlistenStderr = await listen<{ agentId: string; data: string }>(
      "external-agent://stderr",
      (event) => {
        if (event.payload.agentId === this.processId) {
          log.warn("stderr", { data: event.payload.data })
        }
      }
    )
    this.unsubscribeFunctions.push(unlistenStderr)

    // Listen for process exit
    const unlistenExit = await listen<{ agentId: string; code: number }>(
      "external-agent://exit",
      (event) => {
        if (event.payload.agentId === this.processId) {
          log.info("Process exited", { code: event.payload.code })
          this.handleProcessExit(event.payload.code)
        }
      }
    )
    this.unsubscribeFunctions.push(unlistenExit)
  }

  /**
   * Connect via HTTP/WebSocket (remote agent)
   */
  private async connectViaNetwork(config: ExternalAgentConfig): Promise<void> {
    if (!config.network?.endpoint) {
      throw new Error("Network endpoint required for HTTP/WebSocket transport")
    }

    this._rpcEndpoint = this.resolveRpcEndpoint(config)
    this._eventsEndpoint = this.resolveEventsEndpoint(config)

    // Advisory HTTP connectivity check.
    // Some ACP servers do not expose /health but are protocol-valid through initialize.
    try {
      const response = await proxyFetch(`${config.network.endpoint}/health`, {
        method: "GET",
        headers: this.buildHeaders(config),
      })
      if (!response.ok && response.status !== 404 && response.status !== 405) {
        throw new Error(`Health check failed: ${response.status} ${response.statusText}`)
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
      if (!message.includes("404") && !message.includes("405")) {
        throw error
      }
      log.warn("ACP network health endpoint unavailable; continuing with protocol initialization.")
    }

    if (config.transport === "websocket") {
      const socketUrl = this._rpcEndpoint || config.network.endpoint
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(socketUrl)
        this.networkSocket = socket

        socket.onopen = () => resolve()
        socket.onerror = () => reject(new Error("WebSocket connection failed"))
        socket.onmessage = (event) => {
          if (typeof event.data === "string") {
            this.handleIncomingMessage(event.data)
          }
        }
        socket.onclose = () => {
          this.handleProcessExit(0)
        }
      })
    }

    if (config.transport === "sse" && this._eventsEndpoint) {
      await new Promise<void>((resolve, reject) => {
        const source = new EventSource(this._eventsEndpoint!)
        this.networkEventSource = source
        source.onopen = () => resolve()
        source.onerror = () => reject(new Error("EventSource connection failed"))
        source.onmessage = (event) => {
          this.handleIncomingMessage(event.data)
        }
      })
    }

    log.info("Connected to remote agent", {
      endpoint: config.network.endpoint,
      transport: config.transport,
    })
  }

  /**
   * Build HTTP headers for network requests
   */
  private buildHeaders(config: ExternalAgentConfig): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }

    if (config.network?.authMethod === "bearer" && config.network.bearerToken) {
      headers["Authorization"] = `Bearer ${config.network.bearerToken}`
    } else if (config.network?.authMethod === "api-key" && config.network.apiKey) {
      headers["X-API-Key"] = config.network.apiKey
    }

    if (config.network?.headers) {
      Object.assign(headers, config.network.headers)
    }

    return headers
  }

  // Store agent capabilities from initialization
  private _protocolVersion?: number
  private _agentCapabilities?: AcpAgentCapabilities
  private _agentInfo?: AcpImplementationInfo
  private _authMethods?: AcpAuthMethod[]
  private _sessionExtensionSupport: ExternalAgentSessionExtensionSupport =
    createDefaultSessionExtensionSupport()
  private _rpcEndpoint?: string
  private _eventsEndpoint?: string

  private resolveRpcEndpoint(config: ExternalAgentConfig): string {
    return config.network?.rpcEndpoint || `${config.network?.endpoint}/message`
  }

  private resolveEventsEndpoint(config: ExternalAgentConfig): string {
    return config.network?.eventsEndpoint || `${config.network?.endpoint}/events`
  }

  private setExtensionSupport(
    method: ExternalAgentSessionExtensionMethod,
    state: ExternalAgentExtensionSupportStatus["state"],
    reasonCode?: ExternalAgentBranchReasonCode,
    reason?: string
  ): void {
    this._sessionExtensionSupport = {
      ...this._sessionExtensionSupport,
      [method]: {
        state,
        reasonCode,
        reason,
        lastCheckedAt: new Date(),
      },
    }
  }

  clearSessionExtensionSupportCache(): void {
    this._sessionExtensionSupport = createDefaultSessionExtensionSupport()
    this.unsupportedMethods.clear()
  }

  getSessionExtensionSupport(): ExternalAgentSessionExtensionSupport {
    return { ...this._sessionExtensionSupport }
  }

  getAcpInitializationMetadata(): {
    protocolVersion?: number
    agentInfo?: AcpImplementationInfo
    agentCapabilities?: AcpAgentCapabilities
    authMethods?: AcpAuthMethod[]
  } {
    return {
      protocolVersion: this._protocolVersion,
      agentInfo: this._agentInfo,
      agentCapabilities: this._agentCapabilities,
      authMethods: this._authMethods,
    }
  }

  private buildSessionRequestMeta(
    options?: SessionCreateOptions
  ): AcpSessionRequestMeta | undefined {
    const customContext = options?.context || {}
    const instructionEnvelope = options?.instructionEnvelope
    const effectiveCwd =
      options?.cwd ||
      this._config?.process?.cwd ||
      (typeof process !== "undefined" && process.cwd?.()) ||
      "/"
    const codexOptions = {
      developer_instructions: instructionEnvelope?.developerInstructions,
      project_doc_fallback_filenames: ["AGENTS.md", "CLAUDE.md", "README.md"],
      project_doc_max_bytes: 32768,
      skills: instructionEnvelope?.skillsSummary,
      instruction_hash: instructionEnvelope?.hash,
      working_directory: effectiveCwd,
    }
    const filteredCodexOptions = Object.fromEntries(
      Object.entries(codexOptions).filter(([, value]) => value !== undefined && value !== "")
    )

    // Brief-mode: prepend cognia's concise-output snippet to whatever
    // systemPrompt the caller supplied (or set it as the only instruction
    // when no systemPrompt was given). Agents that don't honour
    // `_meta.systemPrompt` silently ignore this — best-effort by design.
    const briefSnippet =
      "Respond concisely. Skip preamble, headers, and bullet-list filler. Direct answers only — match length to the question."
    let resolvedSystemPrompt = options?.systemPrompt
    if (options?.briefMode) {
      resolvedSystemPrompt = resolvedSystemPrompt
        ? `${briefSnippet}\n\n${resolvedSystemPrompt}`
        : briefSnippet
    }

    const meta: AcpSessionRequestMeta = {
      systemPrompt: resolvedSystemPrompt ? { append: resolvedSystemPrompt } : undefined,
      claudeCode: Object.keys(customContext).length > 0 ? { options: customContext } : undefined,
      codex:
        Object.keys(filteredCodexOptions).length > 0
          ? {
              options: filteredCodexOptions,
            }
          : undefined,
      cognia:
        options?.metadata || instructionEnvelope
          ? {
              traceContext: options?.metadata,
              instructionEnvelope,
            }
          : undefined,
    }

    if (!meta.systemPrompt && !meta.claudeCode && !meta.codex && !meta.cognia) {
      return undefined
    }

    return meta
  }

  private buildSessionMetadata(
    options?: SessionCreateOptions,
    result?: Pick<AcpNewSessionResult, "models" | "modes" | "configOptions">,
    inheritedMetadata?: Record<string, unknown>
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      ...(inheritedMetadata ?? {}),
      ...(options?.metadata ?? {}),
    }

    if (options?.instructionEnvelope) {
      metadata.instructionEnvelope = options.instructionEnvelope
    }

    const codexMetadata = {
      ...(typeof inheritedMetadata?.codex === "object" && inheritedMetadata?.codex
        ? (inheritedMetadata.codex as Record<string, unknown>)
        : {}),
      route:
        this._config?.metadata?.ecosystemSurfaceId ??
        this._config?.metadata?.preset ??
        (typeof metadata.codex === "object" && metadata.codex
          ? (metadata.codex as Record<string, unknown>).route
          : undefined),
      workingDirectory:
        options?.cwd ||
        this._config?.process?.cwd ||
        (typeof metadata.codex === "object" && metadata.codex
          ? (metadata.codex as Record<string, unknown>).workingDirectory
          : undefined),
    }

    const filteredCodexMetadata = Object.fromEntries(
      Object.entries(codexMetadata).filter(([, value]) => value !== undefined && value !== "")
    )
    if (Object.keys(filteredCodexMetadata).length > 0) {
      metadata.codex = filteredCodexMetadata
    }

    if (result) {
      metadata.models = result.models
      metadata.modes = result.modes
      metadata.configOptions = result.configOptions
    }

    return metadata
  }

  /**
   * Initialize the ACP protocol
   * @see https://agentclientprotocol.com/protocol/initialization
   */
  private async initialize(): Promise<AcpInitializeResult> {
    const supportsNative = isTauri()
    const clientCapabilities: AcpClientCapabilities = supportsNative
      ? {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        }
      : {}
    const params: AcpInitializeParams = {
      protocolVersion: 1,
      clientCapabilities,
      clientInfo: {
        name: "cognia",
        title: "Cognia",
        version: "1.0.0",
      },
    }

    const result = await this.sendRequest<AcpInitializeResult>(
      "initialize",
      params as unknown as Record<string, unknown>
    )

    // Store agent info for later use
    this._protocolVersion = result.protocolVersion
    this._agentCapabilities = result.agentCapabilities
    this._agentInfo = result.agentInfo
    this._authMethods = result.authMethods

    return result
  }

  /**
   * Authenticate with the agent
   * @see https://agentclientprotocol.com/protocol/initialization#authentication
   */
  async authenticate(methodId: string, credentials?: Record<string, unknown>): Promise<void> {
    if (!this._authMethods || this._authMethods.length === 0) {
      throw new Error("Agent does not require authentication")
    }

    const method = this._authMethods.find((m) => m.id === methodId)
    if (!method) {
      throw new Error(
        `Unknown authentication method: ${methodId}. Available: ${this._authMethods.map((m) => m.id).join(", ")}`
      )
    }

    await this.sendRequest("authenticate", {
      method: methodId,
      ...credentials,
    })

    log.info("Authenticated with agent", { method: methodId })
  }

  /**
   * Get available authentication methods
   */
  getAuthMethods(): AcpAuthMethod[] {
    return this._authMethods || []
  }

  /**
   * Check if authentication is required
   */
  isAuthenticationRequired(): boolean {
    return (this._authMethods?.length ?? 0) > 0
  }

  /**
   * Disconnect from the agent
   */
  async disconnect(): Promise<void> {
    if (this._connectionStatus === "disconnected") {
      return
    }

    // Close all sessions
    for (const session of this._sessions.values()) {
      try {
        await this.closeSession(session.id)
      } catch (error) {
        log.warn("Error closing session", { sessionId: session.id, error })
      }
    }

    // Unsubscribe from Tauri events
    for (const unsubscribe of this.unsubscribeFunctions) {
      unsubscribe()
    }
    this.unsubscribeFunctions = []

    // Kill the process if using stdio
    if (this.processId && isTauri()) {
      try {
        const { invoke } = await import("@tauri-apps/api/core")
        await invoke("kill_external_agent", { agentId: this.processId })
      } catch (error) {
        log.warn("Error killing process", { error })
      }
    }

    if (this.networkSocket) {
      this.networkSocket.close()
      this.networkSocket = undefined
    }
    if (this.networkEventSource) {
      this.networkEventSource.close()
      this.networkEventSource = undefined
    }
    this._rpcEndpoint = undefined
    this._eventsEndpoint = undefined

    // Clear state
    this.processId = undefined
    this._sessions.clear()
    for (const [, pending] of this.pendingPermissions) {
      clearTimeout(pending.timeout)
      pending.resolve({ outcome: { outcome: "cancelled" } })
    }
    this.pendingPermissions.clear()
    this.pendingRequests.clear()
    this.clearSessionExtensionSupportCache()
    this._connectionStatus = "disconnected"

    log.info("Disconnected")
  }

  /**
   * Create a new session
   * @see https://agentclientprotocol.com/protocol/session-setup
   */
  async createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession> {
    if (!this.isConnected()) {
      throw new Error("Not connected to agent")
    }

    // Build session params according to ACP spec
    const params: AcpNewSessionParams = {
      cwd:
        options?.cwd ||
        this._config?.process?.cwd ||
        (typeof process !== "undefined" && process.cwd?.()) ||
        "/",
      mcpServers: options?.mcpServers,
      _meta: this.buildSessionRequestMeta(options),
    }

    // Use correct ACP method name: session/new
    const result = await this.sendRequest<AcpNewSessionResult>(
      "session/new",
      params as unknown as Record<string, unknown>
    )

    // Store model, mode, and config options info if available
    const sessionModels = result.models
    const sessionModes = result.modes
    const sessionConfigOptions = result.configOptions

    // Derive mode from configOptions (preferred) or modes (legacy)
    let initialMode: AcpPermissionMode = (options?.permissionMode || "default") as AcpPermissionMode
    if (sessionConfigOptions) {
      const modeOption = sessionConfigOptions.find((opt) => opt.category === "mode")
      if (modeOption) {
        initialMode = modeOption.currentValue as AcpPermissionMode
      }
    } else if (sessionModes?.currentModeId) {
      initialMode = sessionModes.currentModeId
    }

    const session: ExternalAgentSession = {
      id: result.sessionId,
      agentId: this._config!.id,
      status: "active",
      permissionMode: initialMode,
      capabilities: this._capabilities,
      tools: this._tools ?? [],
      messages: [],
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: this.buildSessionMetadata(options, {
        models: sessionModels,
        modes: sessionModes,
        configOptions: sessionConfigOptions,
      }),
    }

    this._sessions.set(session.id, session)

    log.info("Created session", { sessionId: session.id })
    return session
  }

  /**
   * Close a session
   * Note: ACP protocol does not define a closeSession method.
   * Sessions are managed by the agent internally.
   * This method only cleans up local client state.
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this._sessions.get(sessionId)
    if (!session) {
      return
    }

    // Clean up any pending permissions for this session
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.request.sessionId === sessionId || requestId.startsWith(sessionId)) {
        clearTimeout(pending.timeout)
        pending.resolve({ outcome: { outcome: "cancelled" } })
        this.pendingPermissions.delete(requestId)
      }
    }

    this._sessions.delete(sessionId)
    log.info("Closed session", { sessionId })
  }

  /**
   * Send a prompt to the agent (streaming)
   */
  async *prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    const session = this._sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // Update session status
    this.updateSession(sessionId, { status: "executing" })

    // Add message to session history
    ;(session.messages ?? (session.messages = [])).push(message)

    // Create a queue for events
    const eventQueue: ExternalAgentEvent[] = []
    let resolveNext: (() => void) | null = null
    let isDone = false
    let error: Error | null = null

    // Register event listener for this session
    const listener = (event: ExternalAgentEvent) => {
      if (event.sessionId !== sessionId) return

      eventQueue.push(event)
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }

      if (event.type === "done" || event.type === "error") {
        isDone = true
        if (event.type === "error") {
          error = new Error(event.error)
        }
      }
    }
    this.addEventListener(sessionId, listener)

    const promptBlocks: AcpPromptContentBlock[] = message.content.map((content) => {
      switch (content.type) {
        case "text":
          return { type: "text", text: content.text }
        case "image":
          if (content.source.type === "base64") {
            return {
              type: "image",
              data: content.source.data,
              mimeType: content.source.mediaType,
            }
          }
          return {
            type: "image",
            uri: content.source.url,
            mimeType: content.source.mediaType,
          }
        case "file": {
          const uri = content.path.startsWith("file://") ? content.path : `file://${content.path}`
          if (content.content) {
            return {
              type: "resource",
              resource: {
                uri,
                mimeType: content.mimeType,
                text: content.content,
              },
            }
          }
          return { type: "resource_link", uri }
        }
        default:
          return { type: "text", text: JSON.stringify(content) }
      }
    })

    if (options?.files?.length) {
      const fileBlocks = options.files.map((file) => {
        const uri = file.path.startsWith("file://") ? file.path : `file://${file.path}`
        return {
          type: "resource",
          resource: {
            uri,
            mimeType: file.content ? "text/plain" : undefined,
            text: file.content,
          },
        } satisfies AcpPromptContentBlock
      })
      promptBlocks.unshift(...fileBlocks)
    }

    const promptParams: AcpPromptParams = {
      sessionId,
      prompt: promptBlocks,
    }

    try {
      // session/prompt is a REQUEST (not notification) that returns stopReason
      // We send it and handle streaming updates via session/update notifications
      this.sendPromptRequest(sessionId, promptParams)

      // Yield events as they come
      while (!isDone) {
        if (eventQueue.length > 0) {
          const event = eventQueue.shift()!
          yield event
        } else {
          // Wait for next event
          await new Promise<void>((resolve) => {
            resolveNext = resolve
            // Timeout to prevent infinite waiting
            setTimeout(resolve, 100)
          })
        }

        // Check for abort signal
        if (options?.signal?.aborted) {
          await this.cancel(sessionId)
          break
        }
      }

      // Yield any remaining events
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!
      }

      if (error) {
        throw error
      }
    } finally {
      this.removeEventListener(sessionId, listener)
      this.updateSession(sessionId, { status: "idle" })
    }
  }

  /**
   * Respond to a permission request from the UI
   * This resolves the pending Promise created by handlePermissionRequest
   */
  async respondToPermission(_sessionId: string, response: AcpPermissionResponse): Promise<void> {
    const pending = this.pendingPermissions.get(response.requestId)
    if (pending) {
      clearTimeout(pending.timeout)
      pending.resolve({
        outcome: {
          outcome: response.granted ? "selected" : "cancelled",
          optionId: response.optionId,
        },
      })
      this.emitEvent({
        type: "permission_response",
        sessionId: pending.request.sessionId || _sessionId,
        timestamp: new Date(),
        response,
      })
      this.pendingPermissions.delete(response.requestId)
      return
    }

    // Backward-compatible fallback for legacy request ID format
    for (const [requestId, entry] of this.pendingPermissions.entries()) {
      if (
        entry.request.id === response.requestId ||
        entry.request.requestId === response.requestId
      ) {
        clearTimeout(entry.timeout)
        entry.resolve({
          outcome: {
            outcome: response.granted ? "selected" : "cancelled",
            optionId: response.optionId,
          },
        })
        this.emitEvent({
          type: "permission_response",
          sessionId: entry.request.sessionId || _sessionId,
          timestamp: new Date(),
          response,
        })
        this.pendingPermissions.delete(requestId)
        return
      }
    }
  }

  /**
   * Cancel an ongoing execution
   * @see https://agentclientprotocol.com/protocol/prompt-turn#cancellation
   * Note: session/cancel is a NOTIFICATION (no response expected)
   */
  async cancel(sessionId: string): Promise<void> {
    const session = this._sessions.get(sessionId)
    if (!session || session.status !== "executing") {
      return
    }

    // session/cancel is a notification, not a request
    this.sendNotification("session/cancel", { sessionId })
    this.updateSession(sessionId, { status: "idle" })
  }

  /**
   * Send a prompt request and handle the response
   * session/prompt is a REQUEST that returns a stopReason
   */
  private sendPromptRequest(sessionId: string, params: AcpPromptParams): void {
    // Send as request but handle response asynchronously
    this.sendRequest<AcpPromptResult>(
      "session/prompt",
      params as unknown as Record<string, unknown>
    )
      .then((result) => {
        // Emit done event when prompt completes
        this.emitEvent({
          type: "done",
          sessionId,
          timestamp: new Date(),
          success: result.stopReason !== "cancelled" && result.stopReason !== "refusal",
          stopReason: result.stopReason,
        })
      })
      .catch((error) => {
        // Emit error event on failure
        this.emitEvent({
          type: "error",
          sessionId,
          timestamp: new Date(),
          error: error.message,
          recoverable: false,
        })
      })
  }

  /**
   * Set session mode
   * @see https://agentclientprotocol.com/protocol/session-modes
   */
  async setSessionMode(sessionId: string, modeId: AcpPermissionMode): Promise<void> {
    await this.sendRequest("session/set_mode", { sessionId, modeId } as unknown as Record<
      string,
      unknown
    >)
    this.updateSession(sessionId, { permissionMode: modeId })
  }

  /**
   * Set session model
   * @see https://agentclientprotocol.com/protocol/session-setup#models
   */
  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const session = this._sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const models = session.metadata?.models as AcpSessionModelState | undefined
    if (!models?.availableModels?.length) {
      throw new Error("Agent does not support model selection")
    }

    const modelExists = models.availableModels.some((m) => m.modelId === modelId)
    if (!modelExists) {
      throw new Error(
        `Unknown model: ${modelId}. Available: ${models.availableModels.map((m) => m.modelId).join(", ")}`
      )
    }

    await this.sendRequest("session/set_model", { sessionId, modelId } as unknown as Record<
      string,
      unknown
    >)

    // Update session metadata with new model
    this.updateSession(sessionId, {
      metadata: {
        ...session.metadata,
        models: {
          ...models,
          currentModelId: modelId,
        },
      },
    })

    log.info("Session model changed", { sessionId, modelId })
  }

  /**
   * Get available models for a session
   */
  getSessionModels(sessionId: string): AcpSessionModelState | undefined {
    const session = this._sessions.get(sessionId)
    return session?.metadata?.models as AcpSessionModelState | undefined
  }

  /**
   * Get session config options
   * @see https://agentclientprotocol.com/protocol/session-config-options
   */
  getConfigOptions(sessionId: string): AcpConfigOption[] | undefined {
    const session = this._sessions.get(sessionId)
    return session?.metadata?.configOptions as AcpConfigOption[] | undefined
  }

  /**
   * Set a session config option
   * @see https://agentclientprotocol.com/protocol/session-config-options
   */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<AcpConfigOption[]> {
    const session = this._sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const configOptions = session.metadata?.configOptions as AcpConfigOption[] | undefined
    if (!configOptions?.length) {
      throw new Error("Agent does not support config options")
    }

    const option = configOptions.find((opt) => opt.id === configId)
    if (!option) {
      throw new Error(
        `Unknown config option: ${configId}. Available: ${configOptions.map((o) => o.id).join(", ")}`
      )
    }

    const validValue = option.options.find((o) => o.value === value)
    if (!validValue) {
      throw new Error(
        `Invalid value '${value}' for option '${configId}'. Available: ${option.options.map((o) => o.value).join(", ")}`
      )
    }

    const result = await this.sendRequest<{ configOptions: AcpConfigOption[] }>(
      "session/set_config_option",
      { sessionId, configId, value } as unknown as Record<string, unknown>
    )

    // Update session metadata with new config state
    const updatedOptions = result.configOptions
    session.metadata = { ...session.metadata, configOptions: updatedOptions }

    // Sync mode from config options if applicable
    const modeOpt = updatedOptions.find((opt) => opt.category === "mode")
    if (modeOpt) {
      this.updateSession(sessionId, { permissionMode: modeOpt.currentValue as AcpPermissionMode })
    }

    log.info("Config option changed", { sessionId, configId, value })
    return updatedOptions
  }

  /**
   * Load an existing session (if agent supports loadSession capability)
   * @see https://agentclientprotocol.com/protocol/session-setup#loading-sessions
   */
  async loadSession(
    sessionId: string,
    options?: SessionCreateOptions
  ): Promise<ExternalAgentSession> {
    if (!this._agentCapabilities?.loadSession) {
      throw new Error("Agent does not support loading sessions")
    }

    const params = {
      sessionId,
      cwd: options?.cwd || this._config?.process?.cwd || "/",
      mcpServers: options?.mcpServers,
      _meta: this.buildSessionRequestMeta(options),
    }

    await this.sendRequest("session/load", params as unknown as Record<string, unknown>)

    // Session will be restored via session/update notifications
    const session: ExternalAgentSession = {
      id: sessionId,
      agentId: this._config!.id,
      status: "active",
      permissionMode: (options?.permissionMode || "default") as AcpPermissionMode,
      capabilities: this._capabilities,
      tools: this._tools ?? [],
      messages: [],
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: this.buildSessionMetadata(options),
    }

    this._sessions.set(session.id, session)
    return session
  }

  /**
   * List existing sessions (ACP extension / unstable)
   */
  async listSessions(): Promise<AcpSessionListItem[]> {
    const method = "session/list"
    if (this.unsupportedMethods.has(method)) {
      this.setExtensionSupport(
        method,
        "unsupported",
        "extension_unsupported",
        "Agent does not support session listing"
      )
      throw createExternalAgentUnsupportedSessionExtensionError(method)
    }

    try {
      const result = await this.sendRequest<
        { sessions?: AcpSessionListItem[] } | AcpSessionListItem[]
      >(method, {})
      this.setExtensionSupport(method, "supported", "ok")
      if (Array.isArray(result)) {
        return result
      }
      return result.sessions ?? []
    } catch (error) {
      if (
        isExternalAgentMethodNotFoundError(error) ||
        isExternalAgentSessionExtensionUnsupportedForMethod(error, method)
      ) {
        this.unsupportedMethods.add(method)
        this.setExtensionSupport(
          method,
          "unsupported",
          "extension_unsupported",
          "Agent does not support session listing"
        )
        throw createExternalAgentUnsupportedSessionExtensionError(method)
      }
      this.setExtensionSupport(
        method,
        "unknown",
        "extension_unknown",
        error instanceof Error ? error.message : String(error)
      )
      throw error
    }
  }

  /**
   * Fork a session (ACP extension / unstable)
   */
  async forkSession(sessionId: string): Promise<ExternalAgentSession> {
    const method = "session/fork"
    if (
      this._agentCapabilities?.sessionCapabilities &&
      !this._agentCapabilities.sessionCapabilities.fork
    ) {
      this.setExtensionSupport(
        method,
        "unsupported",
        "extension_unsupported",
        "Agent does not advertise session forking support"
      )
      throw createExternalAgentUnsupportedSessionExtensionError(
        method,
        "Agent does not advertise session forking support"
      )
    }
    if (this.unsupportedMethods.has(method)) {
      this.setExtensionSupport(
        method,
        "unsupported",
        "extension_unsupported",
        "Agent does not support session forking"
      )
      throw createExternalAgentUnsupportedSessionExtensionError(method)
    }

    try {
      const result = await this.sendRequest<AcpNewSessionResult>(method, { sessionId } as Record<
        string,
        unknown
      >)
      const inheritedMetadata = this._sessions.get(sessionId)?.metadata as
        | Record<string, unknown>
        | undefined
      const forkedSession: ExternalAgentSession = {
        id: result.sessionId,
        agentId: this._config!.id,
        status: "active",
        permissionMode: "default",
        capabilities: this._capabilities,
        tools: this._tools ?? [],
        messages: [],
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: this.buildSessionMetadata(
          undefined,
          {
            models: result.models,
            modes: result.modes,
            configOptions: result.configOptions,
          },
          inheritedMetadata
        ),
      }
      this._sessions.set(forkedSession.id, forkedSession)
      this.setExtensionSupport(method, "supported", "ok")
      return forkedSession
    } catch (error) {
      if (
        isExternalAgentMethodNotFoundError(error) ||
        isExternalAgentSessionExtensionUnsupportedForMethod(error, method)
      ) {
        this.unsupportedMethods.add(method)
        this.setExtensionSupport(
          method,
          "unsupported",
          "extension_unsupported",
          "Agent does not support session forking"
        )
        throw createExternalAgentUnsupportedSessionExtensionError(method)
      }
      this.setExtensionSupport(
        method,
        "unknown",
        "extension_unknown",
        error instanceof Error ? error.message : String(error)
      )
      throw error
    }
  }

  /**
   * Resume a session (ACP extension / unstable)
   */
  async resumeSession(
    sessionId: string,
    options?: SessionCreateOptions
  ): Promise<ExternalAgentSession> {
    const method = "session/resume"
    if (
      this._agentCapabilities?.sessionCapabilities &&
      !this._agentCapabilities.sessionCapabilities.resume
    ) {
      if (this._agentCapabilities.loadSession) {
        this.setExtensionSupport(
          method,
          "supported",
          "ok",
          "session/resume unsupported; using session/load fallback"
        )
        return this.loadSession(sessionId, options)
      }
      this.setExtensionSupport(
        method,
        "unsupported",
        "extension_unsupported",
        "Agent does not advertise session resume support"
      )
      throw createExternalAgentUnsupportedSessionExtensionError(
        method,
        "Agent does not advertise session resume support"
      )
    }
    if (this.unsupportedMethods.has(method)) {
      if (this._agentCapabilities?.loadSession) {
        this.setExtensionSupport(
          method,
          "supported",
          "ok",
          "session/resume unsupported; using session/load fallback"
        )
        return this.loadSession(sessionId, options)
      }
      this.setExtensionSupport(
        method,
        "unsupported",
        "extension_unsupported",
        "Agent does not support session resume"
      )
      throw createExternalAgentUnsupportedSessionExtensionError(method)
    }

    try {
      const result = await this.sendRequest<AcpNewSessionResult>(method, {
        sessionId,
        cwd: options?.cwd || this._config?.process?.cwd || "/",
        mcpServers: options?.mcpServers,
        _meta: this.buildSessionRequestMeta(options),
      } as Record<string, unknown>)

      const resumedSession: ExternalAgentSession = {
        id: result.sessionId || sessionId,
        agentId: this._config!.id,
        status: "active",
        permissionMode: (options?.permissionMode || "default") as AcpPermissionMode,
        capabilities: this._capabilities,
        tools: this._tools ?? [],
        messages: [],
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: this.buildSessionMetadata(options, {
          models: result.models,
          modes: result.modes,
          configOptions: result.configOptions,
        }),
      }
      this._sessions.set(resumedSession.id, resumedSession)
      this.setExtensionSupport(method, "supported", "ok")
      return resumedSession
    } catch (error) {
      if (
        isExternalAgentMethodNotFoundError(error) ||
        isExternalAgentSessionExtensionUnsupportedForMethod(error, method)
      ) {
        this.unsupportedMethods.add(method)
        if (this._agentCapabilities?.loadSession) {
          this.setExtensionSupport(
            method,
            "supported",
            "ok",
            "session/resume unsupported; using session/load fallback"
          )
          return this.loadSession(sessionId, options)
        }
        this.setExtensionSupport(
          method,
          "unsupported",
          "extension_unsupported",
          "Agent does not support session resume"
        )
        throw createExternalAgentUnsupportedSessionExtensionError(method)
      }
      this.setExtensionSupport(
        method,
        "unknown",
        "extension_unknown",
        error instanceof Error ? error.message : String(error)
      )
      throw error
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isConnected()) {
      return false
    }

    try {
      await this.sendRequest("ping", {}, 5000)
      return true
    } catch {
      return false
    }
  }

  /**
   * Register an ACP extension method handler (method starts with "_")
   */
  registerExtensionHandler(
    method: string,
    handler: (params?: Record<string, unknown>) => Promise<unknown> | unknown
  ): void {
    if (!method.startsWith("_")) {
      throw new Error('ACP extension methods must start with "_"')
    }
    this.extensionHandlers.set(method, handler)
  }

  /**
   * Unregister an ACP extension method handler
   */
  unregisterExtensionHandler(method: string): void {
    this.extensionHandlers.delete(method)
  }

  private normalizePermissionOptionKind(kind: string | undefined): string {
    return (kind || "").toLowerCase()
  }

  private pickAllowPermissionOption(
    options?: AcpPermissionOption[]
  ): AcpPermissionOption | undefined {
    if (!options?.length) return undefined
    const preferred = options.find((opt) =>
      this.normalizePermissionOptionKind(opt.kind).includes("allow_once")
    )
    if (preferred) return preferred
    const defaultAllow = options.find(
      (opt) => opt.isDefault && this.normalizePermissionOptionKind(opt.kind).includes("allow")
    )
    if (defaultAllow) return defaultAllow
    return options.find((opt) => this.normalizePermissionOptionKind(opt.kind).includes("allow"))
  }

  // ============================================================================
  // JSON-RPC Message Handling
  // ============================================================================

  /**
   * Send a JSON-RPC request and wait for response
   */
  private async sendRequest<T>(
    method: string,
    params?: Record<string, unknown>,
    timeout = 30000
  ): Promise<T> {
    const id = ++this.messageId
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, timeout)

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: timeoutId,
      })

      this.sendMessage(JSON.stringify(request)).catch((error) => {
        clearTimeout(timeoutId)
        this.pendingRequests.delete(id)
        reject(error)
      })
    })
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    }

    this.sendMessage(JSON.stringify(notification)).catch((error) => {
      log.error("Failed to send notification", { error })
    })
  }

  /**
   * Send a message to the agent
   */
  private async sendMessage(message: string): Promise<void> {
    if (this._config?.transport === "stdio" && this.processId && isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("send_to_external_agent", {
        agentId: this.processId,
        message,
      })
    } else if (this._config?.transport === "websocket" && this.networkSocket) {
      this.networkSocket.send(message)
    } else if (this._config?.transport === "http" && this._config.network?.endpoint) {
      const response = await proxyFetch(
        this._rpcEndpoint || `${this._config.network.endpoint}/message`,
        {
          method: "POST",
          headers: this.buildHeaders(this._config),
          body: message,
        }
      )

      if (response.ok) {
        const data = await response.text()
        this.handleIncomingMessage(data)
      }
    } else if (this._config?.transport === "sse" && this._config.network?.endpoint) {
      const response = await proxyFetch(
        this._rpcEndpoint || `${this._config.network.endpoint}/message`,
        {
          method: "POST",
          headers: this.buildHeaders(this._config),
          body: message,
        }
      )

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status} ${response.statusText}`)
      }

      const data = await response.text()
      if (data) {
        this.handleIncomingMessage(data)
      }
    } else {
      throw new Error("No active connection")
    }
  }

  /**
   * Handle incoming message from the agent
   */
  private handleIncomingMessage(data: string): void {
    // Buffer the message
    this.messageBuffer.push(data)

    // Process messages if not already processing
    if (!this.isProcessingMessages) {
      this.processMessageBuffer()
    }
  }

  /**
   * Process buffered messages
   */
  private async processMessageBuffer(): Promise<void> {
    this.isProcessingMessages = true

    while (this.messageBuffer.length > 0) {
      const data = this.messageBuffer.shift()!

      try {
        // Split by newlines in case multiple messages are received
        const lines = data.split("\n").filter((line) => line.trim())

        for (const line of lines) {
          const parsed = JSON.parse(line)

          if ("id" in parsed && parsed.id !== null && "method" in parsed) {
            // This is a REQUEST from the agent to the client (e.g., fs/read_text_file)
            this.handleAgentRequest(parsed as JsonRpcRequest)
          } else if ("id" in parsed && parsed.id !== null) {
            // This is a response to a request we sent
            this.handleResponse(parsed as JsonRpcResponse)
          } else if ("method" in parsed) {
            // This is a notification
            this.handleNotification(parsed as JsonRpcNotification)
          }
        }
      } catch (error) {
        log.error("Failed to parse message", { error, data })
      }
    }

    this.isProcessingMessages = false
  }

  /**
   * Handle a JSON-RPC response
   */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id!)
    if (!pending) {
      log.warn("Received response for unknown request", { id: response.id })
      return
    }

    clearTimeout(pending.timeout)
    this.pendingRequests.delete(response.id!)

    if (response.error) {
      pending.reject(new Error(`${response.error.code}: ${response.error.message}`))
    } else {
      pending.resolve(response.result)
    }
  }

  /**
   * Handle an incoming request from the agent (Client methods)
   * @see https://agentclientprotocol.com/protocol/file-system
   * @see https://agentclientprotocol.com/protocol/terminals
   */
  private async handleAgentRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method, params } = request

    try {
      let result: unknown

      switch (method) {
        case "fs/read_text_file":
          result = await this.handleReadTextFile(params as unknown as AcpReadTextFileParams)
          break

        case "fs/write_text_file":
          result = await this.handleWriteTextFile(params as { path: string; content: string })
          break

        case "session/request_permission":
          result = await this.handlePermissionRequest(params as unknown as AcpPermissionRequest)
          break

        case "terminal/create":
          result = await this.handleTerminalCreate(params as unknown as AcpTerminalCreateParams)
          break

        case "terminal/output":
          result = await this.handleTerminalOutput(params as unknown as AcpTerminalOutputParams)
          break

        case "terminal/kill":
          result = await this.handleTerminalKill(params as { terminalId: string })
          break

        case "terminal/release":
          result = await this.handleTerminalRelease(params as { terminalId: string })
          break

        case "terminal/wait_for_exit":
          result = await this.handleTerminalWaitForExit(
            params as { terminalId: string; timeout?: number }
          )
          break

        default:
          if (method.startsWith("_")) {
            const extensionHandler = this.extensionHandlers.get(method)
            if (!extensionHandler) {
              await this.sendErrorResponse(id, -32601, `Method not found: ${method}`)
              return
            }
            result = await extensionHandler(params)
            break
          }
          await this.sendErrorResponse(id, -32601, `Method not found: ${method}`)
          return
      }

      // Send success response
      await this.sendResponse(id, result)
    } catch (error) {
      // Send error response
      await this.sendErrorResponse(id, -32603, (error as Error).message)
    }
  }

  /**
   * Send a JSON-RPC response
   */
  private async sendResponse(id: number | string, result: unknown): Promise<void> {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      result,
    }
    await this.sendMessage(JSON.stringify(response))
  }

  /**
   * Send a JSON-RPC error response
   */
  private async sendErrorResponse(
    id: number | string,
    code: number,
    message: string
  ): Promise<void> {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    }
    await this.sendMessage(JSON.stringify(response))
  }

  /**
   * Handle fs/read_text_file request
   * @see https://agentclientprotocol.com/protocol/file-system
   */
  private async handleReadTextFile(params: AcpReadTextFileParams): Promise<{ content: string }> {
    if (isTauri()) {
      const { readTextFile } = await import("@tauri-apps/plugin-fs")
      const fullContent = await readTextFile(params.path)
      const hasLineParams = typeof params.line === "number" || typeof params.limit === "number"
      if (!hasLineParams) {
        return { content: fullContent }
      }

      const lines = fullContent.split(/\r?\n/)
      const start = Math.max((params.line ?? 1) - 1, 0)
      const limit = params.limit !== undefined ? Math.max(params.limit, 0) : undefined
      const end = limit !== undefined ? start + limit : lines.length
      const content = lines.slice(start, end).join("\n")
      return { content }
    } else {
      // In browser, use fetch for local files (limited)
      throw new Error("File system access not available in browser")
    }
  }

  /**
   * Handle fs/write_text_file request
   * @see https://agentclientprotocol.com/protocol/file-system
   */
  private async handleWriteTextFile(params: { path: string; content: string }): Promise<void> {
    if (isTauri()) {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs")
      await writeTextFile(params.path, params.content)
    } else {
      throw new Error("File system access not available in browser")
    }
  }

  /**
   * Handle session/request_permission request
   * @see https://agentclientprotocol.com/protocol/tool-calls
   *
   * This method creates a Promise that waits for UI response via respondToPermission.
   * The ACP protocol expects synchronous response to the request, so we return the
   * Promise which will resolve when the UI responds or timeout occurs.
   */
  private async handlePermissionRequest(params: {
    sessionId?: string
    toolCallId?: string
    title?: string
    kind?: string
    requestId?: string
    options?: AcpPermissionOption[]
    rawInput?: Record<string, unknown>
    locations?: AcpToolCallLocation[]
    _meta?: Record<string, unknown>
    toolInfo?: AcpToolInfo
    id?: string
    reason?: string
    riskLevel?: "low" | "medium" | "high" | "critical"
    autoApproveTimeout?: number
    metadata?: Record<string, unknown>
  }): Promise<{ outcome: { outcome: string; optionId?: string } }> {
    const sessionId = params.sessionId || ""
    const session = sessionId ? this._sessions.get(sessionId) : undefined
    if (sessionId && !session) {
      return { outcome: { outcome: "cancelled" } }
    }

    const toolInfo: AcpToolInfo = params.toolInfo || {
      id: params.toolCallId || "tool_call",
      name: params.title || "Tool request",
      category: params.kind,
    }
    const requestId =
      params.requestId ||
      params.id ||
      (sessionId && toolInfo.id ? `${sessionId}:${toolInfo.id}` : `permission:${Date.now()}`)
    const request: AcpPermissionRequest = {
      id: requestId,
      requestId,
      sessionId: sessionId || undefined,
      toolCallId: params.toolCallId || toolInfo.id,
      title: params.title || toolInfo.name,
      kind: (params.kind || toolInfo.category || "other") as AcpToolCallKind,
      toolInfo,
      options: params.options,
      rawInput: params.rawInput,
      locations: params.locations,
      _meta: params._meta,
      reason: params.reason || `Tool "${params.title || toolInfo.name}" requires permission`,
      riskLevel: params.riskLevel,
      autoApproveTimeout: params.autoApproveTimeout,
      metadata: params.metadata,
    }

    const allowOption = this.pickAllowPermissionOption(request.options)

    // Check if permission mode allows auto-approval
    if (session?.permissionMode === "bypassPermissions") {
      if (request.options?.length && !allowOption) {
        return { outcome: { outcome: "cancelled" } }
      }
      return { outcome: { outcome: "selected", optionId: allowOption?.optionId } }
    }

    // Auto-approve in acceptEdits mode for file operations
    const kind = request.kind || "other"
    const isWriteKind = kind === "file_write" || kind === "write"
    if (session?.permissionMode === "acceptEdits" && isWriteKind && allowOption) {
      return { outcome: { outcome: "selected", optionId: allowOption.optionId } }
    }

    // Create a Promise that waits for UI response
    return new Promise((resolve, reject) => {
      // Set timeout for permission request (5 minutes)
      const timeoutId = setTimeout(() => {
        if (this.pendingPermissions.has(requestId)) {
          this.pendingPermissions.delete(requestId)
          resolve({ outcome: { outcome: "cancelled" } })
        }
      }, 300000)

      // Store pending permission
      this.pendingPermissions.set(requestId, {
        resolve,
        reject,
        timeout: timeoutId,
        request,
      })

      // Emit permission request event for UI to handle
      this.emitEvent({
        type: "permission_request",
        sessionId,
        timestamp: new Date(),
        request,
      })
    })
  }

  // ============================================================================
  // Terminal Methods (ACP Client → Agent)
  // ============================================================================

  /**
   * Handle terminal/create request from agent
   * @see https://agentclientprotocol.com/protocol/terminals
   */
  private async handleTerminalCreate(
    params: AcpTerminalCreateParams
  ): Promise<{ terminalId: string }> {
    if (!isTauri()) {
      throw new Error("Terminal support requires Tauri desktop environment")
    }

    const terminalId = await acpTerminalCreate(
      params.sessionId,
      params.command,
      params.args || [],
      params.cwd,
      params.env,
      params.outputByteLimit
    )

    return { terminalId }
  }

  /**
   * Handle terminal/output request from agent
   * @see https://agentclientprotocol.com/protocol/terminals
   */
  private async handleTerminalOutput(
    params: AcpTerminalOutputParams
  ): Promise<AcpTerminalOutputResult> {
    if (!isTauri()) {
      throw new Error("Terminal support requires Tauri desktop environment")
    }

    const result = await acpTerminalOutput(params.terminalId, params.outputByteLimit)
    return result
  }

  /**
   * Handle terminal/kill request from agent
   * @see https://agentclientprotocol.com/protocol/terminals
   */
  private async handleTerminalKill(params: { terminalId: string }): Promise<void> {
    if (!isTauri()) {
      throw new Error("Terminal support requires Tauri desktop environment")
    }

    await acpTerminalKill(params.terminalId)
  }

  /**
   * Handle terminal/release request from agent
   * @see https://agentclientprotocol.com/protocol/terminals
   */
  private async handleTerminalRelease(params: { terminalId: string }): Promise<void> {
    if (!isTauri()) {
      throw new Error("Terminal support requires Tauri desktop environment")
    }

    await acpTerminalRelease(params.terminalId)
  }

  /**
   * Handle terminal/wait_for_exit request from agent
   * @see https://agentclientprotocol.com/protocol/terminals
   */
  private async handleTerminalWaitForExit(params: {
    terminalId: string
    timeout?: number
  }): Promise<{
    exitCode: number | null
    exitStatus: { exitCode: number | null; signal: string | null }
  }> {
    if (!isTauri()) {
      throw new Error("Terminal support requires Tauri desktop environment")
    }

    const waitResult = await acpTerminalWaitForExit(params.terminalId, params.timeout)
    return {
      exitCode: waitResult.exitStatus.exitCode,
      exitStatus: waitResult.exitStatus,
    }
  }

  /**
   * Handle a JSON-RPC notification
   */
  private handleNotification(notification: JsonRpcNotification): void {
    const event = this.notificationToEvent(notification)
    if (event) {
      this.emitEvent(event)
    }
  }

  /**
   * Handle ACP session/update notification
   * @see https://agentclientprotocol.com/protocol/prompt-turn
   */
  private handleSessionUpdate(
    sessionId: string,
    timestamp: Date,
    update: AcpSessionUpdate
  ): ExternalAgentEvent | null {
    if (!update || !update.sessionUpdate) {
      log.warn("Invalid session/update: missing sessionUpdate field")
      return null
    }

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return {
          type: "message_delta",
          sessionId,
          timestamp,
          messageId: `msg_${Date.now()}`,
          delta: {
            type: "text",
            text: update.content?.text || "",
          },
        }

      case "thought_message_chunk":
        return {
          type: "thinking",
          sessionId,
          timestamp,
          thinking: update.content?.text || "",
        }

      case "user_message_chunk":
        return {
          type: "message_delta",
          sessionId,
          timestamp,
          messageId: `msg_${Date.now()}`,
          delta: {
            type: "text",
            text: update.content?.text || "",
          },
        }

      case "tool_call":
        return {
          type: "tool_use_start",
          sessionId,
          timestamp,
          toolUseId: update.toolCallId,
          toolName: update.title,
          kind: update.kind,
          rawInput: update.rawInput,
          locations: update.locations,
        }

      case "tool_call_update": {
        // Extract text content from the union type
        const extractToolCallText = (): string => {
          if (!update.content?.length) return ""
          const first = update.content[0]
          if (first.type === "content") return first.content?.text || ""
          if (first.type === "diff") return `Diff: ${first.path}`
          if (first.type === "terminal") return `Terminal: ${first.terminalId}`
          return ""
        }

        if (
          update.status === "completed" ||
          update.status === "error" ||
          update.status === "failed"
        ) {
          return {
            type: "tool_result",
            sessionId,
            timestamp,
            toolUseId: update.toolCallId,
            result: extractToolCallText(),
            isError: update.status === "error" || update.status === "failed",
            toolName: update.title,
            kind: update.kind,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
            locations: update.locations,
            status: update.status,
          }
        }

        // Emit enhanced tool_call_update event with all fields
        if (update.content || update.locations) {
          return {
            type: "tool_call_update" as const,
            sessionId,
            timestamp,
            toolCallId: update.toolCallId,
            status: update.status,
            title: update.title,
            kind: update.kind,
            content: update.content,
            locations: update.locations,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
          }
        }

        return {
          type: "tool_use_delta",
          sessionId,
          timestamp,
          toolUseId: update.toolCallId,
          delta: update.status || "in_progress",
        }
      }

      case "plan":
        // Store plan entries in session metadata
        const session = this._sessions.get(sessionId)
        if (session) {
          session.metadata = {
            ...session.metadata,
            plan: update.entries,
          }
        }
        const completedCount = update.entries.filter((entry) => entry.status === "completed").length
        const totalSteps = update.entries.length
        const currentStep = update.entries.findIndex((entry) => entry.status === "in_progress")
        return {
          type: "plan_update",
          sessionId,
          timestamp,
          entries: update.entries,
          progress: totalSteps > 0 ? (completedCount / totalSteps) * 100 : 0,
          step: currentStep,
          totalSteps,
        }

      case "available_commands_update":
        // Store available commands in session metadata
        const cmdSession = this._sessions.get(sessionId)
        if (cmdSession) {
          cmdSession.metadata = {
            ...cmdSession.metadata,
            availableCommands: update.availableCommands,
          }
        }
        return {
          type: "commands_update",
          sessionId,
          timestamp,
          commands: update.availableCommands,
        }

      case "mode_change":
        this.updateSession(sessionId, { permissionMode: update.modeId })
        return null

      case "current_mode_update": {
        // Agent-initiated mode change
        const modeSession = this._sessions.get(sessionId)
        if (modeSession) {
          this.updateSession(sessionId, { permissionMode: update.modeId as AcpPermissionMode })
          // Also update configOptions if they exist
          const configOpts = modeSession.metadata?.configOptions as AcpConfigOption[] | undefined
          if (configOpts) {
            const updatedOpts = configOpts.map((opt) =>
              opt.category === "mode" ? { ...opt, currentValue: update.modeId } : opt
            )
            modeSession.metadata = { ...modeSession.metadata, configOptions: updatedOpts }
          }
        }
        return {
          type: "mode_update" as const,
          sessionId,
          timestamp,
          modeId: update.modeId,
        }
      }

      case "config_options_update": {
        // Agent-initiated config options change
        const cfgSession = this._sessions.get(sessionId)
        if (cfgSession) {
          cfgSession.metadata = {
            ...cfgSession.metadata,
            configOptions: update.configOptions,
          }
          // Sync mode from config options
          const modeOpt = update.configOptions.find((opt) => opt.category === "mode")
          if (modeOpt) {
            this.updateSession(sessionId, {
              permissionMode: modeOpt.currentValue as AcpPermissionMode,
            })
          }
        }
        return {
          type: "config_options_update" as const,
          sessionId,
          timestamp,
          configOptions: update.configOptions,
        }
      }

      default:
        log.warn("Unknown session update type", {
          type: (update as AcpSessionUpdate).sessionUpdate,
        })
        return null
    }
  }

  /**
   * Convert ACP notification to ExternalAgentEvent
   * @see https://agentclientprotocol.com/protocol/prompt-turn
   */
  private notificationToEvent(notification: JsonRpcNotification): ExternalAgentEvent | null {
    const params = notification.params || {}
    const sessionId = (params.sessionId as string) || ""
    const timestamp = new Date()

    switch (notification.method as AcpNotificationType) {
      // Handle ACP session/update notifications (primary format per spec)
      case "session/update":
        return this.handleSessionUpdate(sessionId, timestamp, params.update as AcpSessionUpdate)

      case "session/started":
        if (Array.isArray(params.tools)) {
          this._tools = params.tools as AcpToolInfo[]
          if (sessionId) {
            const startedSession = this._sessions.get(sessionId)
            if (startedSession) {
              startedSession.tools = this._tools
            }
          }
        }
        return {
          type: "session_start",
          sessionId,
          timestamp,
          capabilities: params.capabilities as AcpCapabilities,
          tools: params.tools as AcpToolInfo[],
        }

      case "session/ended":
        return {
          type: "session_end",
          sessionId,
          timestamp,
          reason: params.reason as "completed" | "cancelled" | "error" | "timeout",
          error: params.error as string,
        }

      case "message/start":
        return {
          type: "message_start",
          sessionId,
          timestamp,
          messageId: params.messageId as string,
          role: params.role as "user" | "assistant" | "system" | "tool",
        }

      case "message/delta":
        return {
          type: "message_delta",
          sessionId,
          timestamp,
          messageId: params.messageId as string,
          delta: {
            type: (params.deltaType as "text" | "thinking") || "text",
            text: params.text as string,
          },
        }

      case "message/end":
        return {
          type: "message_end",
          sessionId,
          timestamp,
          messageId: params.messageId as string,
          tokenUsage: params.tokenUsage as ExternalAgentTokenUsage,
        }

      case "tool/start":
        return {
          type: "tool_use_start",
          sessionId,
          timestamp,
          toolUseId: params.toolUseId as string,
          toolName: params.toolName as string,
          kind: params.kind as AcpToolCallKind,
          rawInput: params.rawInput as Record<string, unknown> | undefined,
          locations: params.locations as AcpToolCallLocation[] | undefined,
        }

      case "tool/delta":
        return {
          type: "tool_use_delta",
          sessionId,
          timestamp,
          toolUseId: params.toolUseId as string,
          delta: params.delta as string,
        }

      case "tool/end":
        return {
          type: "tool_use_end",
          sessionId,
          timestamp,
          toolUseId: params.toolUseId as string,
          input: params.input as Record<string, unknown>,
        }

      case "tool/result":
        return {
          type: "tool_result",
          sessionId,
          timestamp,
          toolUseId: params.toolUseId as string,
          result: params.result as string | Record<string, unknown>,
          isError: params.isError as boolean,
          toolName: params.toolName as string | undefined,
          kind: params.kind as AcpToolCallKind | undefined,
          rawInput: params.rawInput as Record<string, unknown> | undefined,
          rawOutput: params.rawOutput as Record<string, unknown> | undefined,
          locations: params.locations as AcpToolCallLocation[] | undefined,
          status: params.status as AcpToolCallStatus | undefined,
        }

      case "permission/request": {
        const requestId =
          (params.requestId as string) || `${sessionId}:${String(params.toolCallId || "tool_call")}`
        return {
          type: "permission_request",
          sessionId,
          timestamp,
          request: {
            id: requestId,
            requestId,
            sessionId,
            toolCallId: params.toolCallId as string,
            title: params.title as string,
            kind: params.kind as AcpToolCallKind,
            toolInfo: (params.toolInfo as AcpToolInfo) || {
              id: (params.toolCallId as string) || "tool_call",
              name: (params.title as string) || "Tool request",
              category: params.kind as string,
            },
            options: params.options as AcpPermissionOption[] | undefined,
            rawInput: params.rawInput as Record<string, unknown> | undefined,
            locations: params.locations as AcpToolCallLocation[] | undefined,
            reason: params.reason as string,
            riskLevel: params.riskLevel as "low" | "medium" | "high" | "critical",
            autoApproveTimeout: params.autoApproveTimeout as number,
            metadata: params.metadata as Record<string, unknown>,
            _meta: params._meta as Record<string, unknown>,
          },
        }
      }

      case "thinking":
        return {
          type: "thinking",
          sessionId,
          timestamp,
          thinking: params.thinking as string,
        }

      case "progress":
        return {
          type: "progress",
          sessionId,
          timestamp,
          progress: params.progress as number,
          message: params.message as string,
          step: params.step as number,
          totalSteps: params.totalSteps as number,
        }

      case "error":
        return {
          type: "error",
          sessionId,
          timestamp,
          error: params.error as string,
          code: params.code as string,
          recoverable: params.recoverable as boolean,
        }

      default:
        log.warn("Unknown notification type", { method: notification.method })
        return null
    }
  }

  // ============================================================================
  // Event Handling
  // ============================================================================

  /**
   * Add event listener for a session
   */
  private addEventListener(sessionId: string, listener: (event: ExternalAgentEvent) => void): void {
    let listeners = this.eventListeners.get(sessionId)
    if (!listeners) {
      listeners = new Set()
      this.eventListeners.set(sessionId, listeners)
    }
    listeners.add(listener)
  }

  /**
   * Remove event listener for a session
   */
  private removeEventListener(
    sessionId: string,
    listener: (event: ExternalAgentEvent) => void
  ): void {
    const listeners = this.eventListeners.get(sessionId)
    if (listeners) {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.eventListeners.delete(sessionId)
      }
    }
  }

  /**
   * Emit an event to all listeners
   */
  private emitEvent(event: ExternalAgentEvent): void {
    const listeners = this.eventListeners.get(event.sessionId ?? "")
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event)
        } catch (error) {
          log.error("Event listener error", { error })
        }
      }
    }
  }

  // ============================================================================
  // Process Lifecycle
  // ============================================================================

  /**
   * Handle process exit
   */
  private handleProcessExit(code: number): void {
    this._connectionStatus = "disconnected"

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(`Process exited with code ${code}`))
      this.pendingRequests.delete(id)
    }

    // Mark all sessions as closed
    for (const session of this._sessions.values()) {
      this.updateSession(session.id, { status: "closed" })
    }

    // Attempt reconnection if configured
    if (
      this._config?.process?.restartOnCrash &&
      this.reconnectAttempts < this.maxReconnectAttempts
    ) {
      this.attemptReconnection()
    }
  }

  /**
   * Attempt to reconnect
   */
  private async attemptReconnection(): Promise<void> {
    if (!this._config) return

    this.reconnectAttempts++
    this._connectionStatus = "reconnecting"

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)
    log.info("Attempting reconnection", { delay, attempt: this.reconnectAttempts })

    await new Promise((resolve) => setTimeout(resolve, delay))

    try {
      await this.connect(this._config)
      log.info("Reconnection successful")
    } catch (error) {
      log.error("Reconnection failed", { error })
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.attemptReconnection()
      } else {
        this._connectionStatus = "error"
      }
    }
  }
}

/**
 * Create a new ACP client adapter instance
 */
export function createAcpClient(): AcpClientAdapter {
  return new AcpClientAdapter()
}
