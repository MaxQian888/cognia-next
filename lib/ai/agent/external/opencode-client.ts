/**
 * OpenCode Client Adapter
 *
 * Implements a protocol adapter for OpenCode Server using the official
 * @opencode-ai/sdk package. Provides type-safe communication with OpenCode
 * instances for session management, message prompting, file operations,
 * slash commands, real-time events via SSE, and more.
 *
 * @see https://opencode.ai/docs/sdk
 * @see https://opencode.ai/docs/server/
 */

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"
import type {
  Session as OcSession,
  Message as OcMessage,
  Part as OcPart,
  Event as OcEvent,
  Todo as OcTodo,
  FileDiff as OcFileDiff,
  Permission as OcPermission,
  SessionStatus as OcSessionStatus,
  TextPart as OcTextPart,
  ToolPart as OcToolPart,
  ReasoningPart as OcReasoningPart,
  Pty as OcPty,
} from "@opencode-ai/sdk/client"

import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/utils"
import { BaseProtocolAdapter, type SessionCreateOptions } from "./protocol-adapter"
import { isExternalAgentAlreadyRunningError } from "./spawn-reclaim"
import type {
  ExternalAgentConfig,
  ExternalAgentSession,
  ExternalAgentMessage,
  ExternalAgentEvent,
  ExternalAgentContent,
  ExternalAgentExecutionOptions,
  ExternalAgentTokenUsage,
  AcpToolInfo,
  AcpPermissionResponse,
  AcpPermissionMode,
  AcpConfigOption,
  AcpConfigOptionValue,
  AcpSessionModelState,
  ExternalAgentSessionExtensionSupport,
  ExternalAgentExtensionSupportStatus,
  AcpAvailableCommand,
  AcpPlanEntry,
} from "@/types/agent/external-agent"

const log = loggers.agent.child("opencode-client")

// ============================================================================
// Logging helper
// ============================================================================

function toLogContext(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  if (error && typeof error === "object" && !Array.isArray(error)) {
    return error as Record<string, unknown>
  }
  if (error === undefined) return undefined
  return { error: String(error) }
}

// ============================================================================
// SDK response helper
// ============================================================================

/**
 * Unwrap SDK response, throwing on error.
 * The SDK returns `{ data, error }` with `responseStyle: 'fields'`.
 */
function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error !== undefined) {
    const errMsg =
      result.error && typeof result.error === "object" && "message" in result.error
        ? (result.error as { message: string }).message
        : JSON.stringify(result.error)
    throw new Error(`OpenCode SDK error: ${errMsg}`)
  }
  return result.data as T
}

/**
 * Encode a UTF-8 string as base64 across runtimes (Node/jsdom have `Buffer`,
 * browsers have `btoa`). Used for HTTP Basic Auth headers.
 */
function toBase64(input: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(input, "utf-8").toString("base64")
  }
  const bytes = new TextEncoder().encode(input)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/** Map an OpenCode AssistantMessage `tokens` object to canonical token usage. */
function mapOpenCodeTokens(tokens?: {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}): ExternalAgentTokenUsage | undefined {
  if (!tokens) return undefined
  const input = tokens.input ?? 0
  const output = tokens.output ?? 0
  const reasoning = tokens.reasoning ?? 0
  if (input === 0 && output === 0 && reasoning === 0) return undefined
  return {
    promptTokens: input,
    completionTokens: output + reasoning,
    totalTokens: input + output + reasoning,
    cacheReadTokens: tokens.cache?.read,
    cacheWriteTokens: tokens.cache?.write,
  }
}

/**
 * Map Cognia content blocks to OpenCode `file` prompt parts. Images and files
 * become `{ type: "file", mime, filename?, url }` where the url is the remote
 * URL, the local path, or a `data:` URI for inline base64. Text blocks are
 * handled separately by the caller.
 */
function buildOpenCodeFileParts(
  content: ExternalAgentContent[]
): Array<{ type: "file"; mime: string; filename?: string; url: string }> {
  const parts: Array<{ type: "file"; mime: string; filename?: string; url: string }> = []
  for (const c of content) {
    if (c.type === "image") {
      const mime = c.source.mediaType || "application/octet-stream"
      if (c.source.type === "url" && c.source.url) {
        parts.push({ type: "file", mime, url: c.source.url, ...(c.alt ? { filename: c.alt } : {}) })
      } else if (c.source.data) {
        parts.push({
          type: "file",
          mime,
          url: `data:${mime};base64,${c.source.data}`,
          ...(c.alt ? { filename: c.alt } : {}),
        })
      }
    } else if (c.type === "file") {
      const mime = c.mimeType || "application/octet-stream"
      const filename = c.path.split("/").pop() || c.path
      if (c.content && c.encoding === "base64") {
        parts.push({ type: "file", mime, filename, url: `data:${mime};base64,${c.content}` })
      } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(c.path)) {
        // Already a URL/URI reference.
        parts.push({ type: "file", mime, filename, url: c.path })
      } else if (c.content) {
        // utf-8 inline content → a data URI so it still reaches the agent.
        parts.push({
          type: "file",
          mime,
          filename,
          url: `data:${mime};base64,${toBase64(c.content)}`,
        })
      }
      // A bare local path with no content cannot be turned into a fetchable
      // url here; the OpenCode server resolves file references by url only.
    }
  }
  return parts
}

/** The SDK's SSE helpers resolve to `{ stream }`; this is the slice we consume. */
type OcEventStream = { stream: AsyncIterable<OcEvent> }

type OpenCodeInteractionKind = "permission" | "permissionV2" | "question" | "questionV2"

interface PendingOpenCodeInteraction {
  kind: OpenCodeInteractionKind
  sessionId: string
  questionIds?: string[]
}

interface OpenCodeWireEvent {
  type: string
  properties?: Record<string, unknown>
  data?: Record<string, unknown>
}

function interactionKey(sessionId: string, requestId: string): string {
  return JSON.stringify([sessionId, requestId])
}

// ============================================================================
// Provider info type (SDK doesn't export a named type for this aggregate)
// ============================================================================

interface ProviderListData {
  all: Array<{
    id: string
    name?: string
    models?: Record<
      string,
      {
        id?: string
        name?: string
        attachment?: boolean
        reasoning?: boolean
        cost?: {
          input: number
          output: number
        }
      }
    >
  }>
  default: Record<string, string>
  connected: string[]
}

// ============================================================================
// OpenCode Client Adapter
// ============================================================================

/**
 * Protocol adapter for OpenCode Server using the official @opencode-ai/sdk.
 *
 * Supports both local server connection (via `opencode serve`) and
 * direct connection to a running server endpoint.
 */
export class OpenCodeClientAdapter extends BaseProtocolAdapter {
  readonly protocol = "opencode"

  private client!: OpencodeClient
  private abortControllers: Map<string, AbortController> = new Map()
  private sessionSystemPrompts: Map<string, string> = new Map()
  // Latest assistant-message outcome (tokens / cost / error / finish) per
  // session, captured from `message.updated` and folded into the turn's `done`.
  private assistantOutcome: Map<
    string,
    { tokenUsage?: ExternalAgentTokenUsage; error?: string; finishReason?: string }
  > = new Map()
  private sessionModels: Map<string, AcpSessionModelState> = new Map()
  private sessionConfigOptions: Map<string, AcpConfigOption[]> = new Map()
  private availableAgents: Array<{ id: string; name?: string; description?: string }> = []
  private availableCommands: Array<{
    name: string
    description?: string
    args?: Record<string, unknown>
  }> = []
  private providerInfo: ProviderListData | null = null
  private baseUrl = ""
  private requestFetch?: (request: Request) => ReturnType<typeof fetch>
  private pendingInteractions = new Map<string, PendingOpenCodeInteraction>()

  /** Agent id of an auto-spawned `opencode serve` process, if any. */
  private spawnedServerId: string | null = null

  // ============================================================================
  // Connection Lifecycle
  // ============================================================================

  async connect(config: ExternalAgentConfig): Promise<void> {
    this._config = config
    this._connectionStatus = "connecting"

    try {
      // Resolve the base URL (explicit endpoint, desktop auto-spawn, or default).
      const baseUrl = await this.resolveBaseUrl(config)

      // Create the SDK client, injecting auth headers via a custom fetch when
      // the server is password-protected (OPENCODE_SERVER_PASSWORD) or a
      // bearer token / custom headers are configured.
      this.baseUrl = baseUrl
      this.requestFetch = this.buildAuthFetch(config)
      this.client = createOpencodeClient({ baseUrl, fetch: this.requestFetch })

      // Probe reachability with a cheap, non-SSE call. When we auto-spawned the
      // server, retry briefly to cover the gap between the "listening" log line
      // and the HTTP server actually accepting requests.
      await this.waitForReady(this.spawnedServerId ? 5000 : 0)

      log.info(`Connected to OpenCode server at ${baseUrl}`)

      // Discover capabilities
      await this.discoverCapabilities()

      // Build capabilities for the agent system
      this._capabilities = {
        streaming: true,
        toolExecution: true,
        fileOperations: true,
        codeExecution: true,
        multiTurn: true,
        thinking: true,
      }

      this._connectionStatus = "connected"
    } catch (error) {
      this._connectionStatus = "error"
      // Tear down a server we spawned if the connection ultimately failed.
      await this.killSpawnedServer()
      log.error("Failed to connect to OpenCode server:", error)
      throw error
    }
  }

  /**
   * Resolve the OpenCode server base URL. An explicit `network.endpoint` always
   * wins (connect to an already-running server). Otherwise, on desktop, an
   * `opencode serve` process is auto-spawned when requested. Falls back to the
   * default local server.
   */
  private async resolveBaseUrl(config: ExternalAgentConfig): Promise<string> {
    if (config.network?.endpoint) {
      return config.network.endpoint.replace(/\/$/, "")
    }

    const autoSpawn = config.metadata?.autoSpawnServer === true || Boolean(config.process?.command)
    if (autoSpawn) {
      if (!isTauri()) {
        throw new Error(
          "Auto-spawning an OpenCode server requires the desktop (Tauri) runtime; configure a server endpoint instead."
        )
      }
      return await this.spawnServer(config)
    }

    const port = typeof config.metadata?.port === "number" ? config.metadata.port : 4096
    const hostname =
      typeof config.metadata?.hostname === "string" ? config.metadata.hostname : "127.0.0.1"
    return `http://${hostname}:${port}`
  }

  /**
   * Wait until the server answers a cheap non-SSE request. `maxWaitMs === 0`
   * means a single attempt (fail fast); a positive budget retries every 200ms.
   */
  private async waitForReady(maxWaitMs: number): Promise<void> {
    const deadline = Date.now() + maxWaitMs
    for (;;) {
      try {
        const resp = await this.client.config.get()
        if (resp.error !== undefined) {
          throw new Error(`OpenCode config.get returned an error: ${JSON.stringify(resp.error)}`)
        }
        return
      } catch (error) {
        if (Date.now() >= deadline) {
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
  }

  // ============================================================================
  // Authentication
  // ============================================================================

  /**
   * Build a custom `fetch` that injects authentication headers when the server
   * is protected. Supports custom `network.headers`, a bearer token, and HTTP
   * Basic Auth (OpenCode's `OPENCODE_SERVER_PASSWORD`, default user "opencode").
   * Returns `undefined` when no auth is configured so the SDK uses the default
   * fetch. The same fetch is reused by the SDK for both REST and SSE requests.
   */
  private buildAuthFetch(
    config: ExternalAgentConfig
  ): ((request: Request) => ReturnType<typeof fetch>) | undefined {
    const headers = this.buildAuthHeaders(config)
    if (!headers) return undefined

    return (request: Request) => {
      for (const [key, value] of Object.entries(headers)) {
        request.headers.set(key, value)
      }
      return fetch(request)
    }
  }

  private buildAuthHeaders(config: ExternalAgentConfig): Record<string, string> | undefined {
    const network = config.network
    const headers: Record<string, string> = {}

    if (network?.headers) {
      Object.assign(headers, network.headers)
    }

    // A bearer token or generic API key both map to `Authorization: Bearer`.
    const bearer = network?.bearerToken ?? network?.apiKey
    if (bearer) {
      headers["Authorization"] = `Bearer ${bearer}`
    }

    const password = config.metadata?.serverPassword
    if (typeof password === "string" && password.length > 0) {
      const usernameRaw = config.metadata?.serverUsername
      const username =
        typeof usernameRaw === "string" && usernameRaw.length > 0 ? usernameRaw : "opencode"
      headers["Authorization"] = `Basic ${toBase64(`${username}:${password}`)}`
    }

    return Object.keys(headers).length > 0 ? headers : undefined
  }

  // ============================================================================
  // Desktop Server Lifecycle (auto-spawn `opencode serve`)
  // ============================================================================

  /**
   * Spawn a local `opencode serve` process (desktop only) and resolve its base
   * URL by parsing the "opencode server listening on <url>" stdout line. Reuses
   * the existing external-agent process bridge (PID tracking, Windows-safe kill,
   * stdout/exit events) — no new Rust commands.
   */
  private async spawnServer(config: ExternalAgentConfig): Promise<string> {
    const native = await import("@/lib/native/external-agent")

    const id = `opencode-server-${config.id}`
    const command = config.process?.command ?? "opencode"
    const hostname =
      typeof config.metadata?.hostname === "string" ? config.metadata.hostname : "127.0.0.1"
    // 0 lets OpenCode pick a free port; we read the real URL back from stdout.
    const port = typeof config.metadata?.port === "number" ? config.metadata.port : 0
    const args = [
      "serve",
      `--hostname=${hostname}`,
      `--port=${port}`,
      ...(config.process?.args ?? []),
    ]
    const startupTimeout = config.process?.startupTimeout ?? 10000

    const spawnOnce = () =>
      native.spawnExternalAgent({
        id,
        command,
        args,
        env: config.process?.env,
        cwd: config.process?.cwd,
      })

    // Register listeners before spawning so we never miss the listening line.
    let urlPromise = this.waitForServerUrl(native, id, startupTimeout)

    try {
      await spawnOnce()
    } catch (error) {
      void urlPromise.catch(() => {})
      if (!isExternalAgentAlreadyRunningError(error)) throw error

      // The process manager keys children by this id and outlives the JS realm,
      // so a page reload / dev Fast Refresh leaves a server nothing listens to
      // while every respawn is refused — bricking the agent until the whole app
      // restarts. Reclaim the id. Safe here because `connect()` returns early
      // when already connected, so nothing in this realm consumes that child.
      log.warn("Reclaiming an orphaned OpenCode server process", { id })
      await native.killExternalAgent(id)

      // Re-arm only AFTER the kill: the orphan's exit event carries this same
      // id, and the wait above would read it as "server exited before becoming
      // ready". The supervisor emits that exit asynchronously, so if it still
      // slips into the fresh wait this connect fails and the manager's retry —
      // which now finds the id free — succeeds.
      urlPromise = this.waitForServerUrl(native, id, startupTimeout)
      try {
        await spawnOnce()
      } catch (retryError) {
        void urlPromise.catch(() => {})
        throw retryError
      }
    }

    try {
      const url = await urlPromise
      this.spawnedServerId = id
      return url.replace(/\/$/, "")
    } catch (error) {
      await native.killExternalAgent(id).catch(() => {})
      throw error
    }
  }

  private async waitForServerUrl(
    native: typeof import("@/lib/native/external-agent"),
    id: string,
    timeoutMs: number
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false
      let unlistenStdout: () => void = () => {}
      let unlistenStderr: () => void = () => {}
      let unlistenExit: () => void = () => {}
      // stdout and stderr are buffered separately so an interleaved chunk from
      // one stream can never split the other's "listening" line.
      let stdoutBuffer = ""
      let stderrBuffer = ""

      const cleanup = () => {
        clearTimeout(timer)
        unlistenStdout()
        unlistenStderr()
        unlistenExit()
      }

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for OpenCode server to start`))
      }, timeoutMs)

      const scan = (buffer: string) => {
        const match = buffer.match(/opencode server listening[^\n]*?on\s+(https?:\/\/\S+)/i)
        if (match) {
          settled = true
          cleanup()
          resolve(match[1])
        }
      }

      void native
        .onExternalAgentStdout((event) => {
          if (settled || event.agentId !== id) return
          stdoutBuffer += event.data
          scan(stdoutBuffer)
        })
        .then((un) => {
          if (settled) un()
          else unlistenStdout = un
        })

      // Some runtimes route the startup banner to stderr — scan both streams
      // rather than timing out when stdout stays silent.
      void native
        .onExternalAgentStderr((event) => {
          if (settled || event.agentId !== id) return
          stderrBuffer += event.data
          scan(stderrBuffer)
        })
        .then((un) => {
          if (settled) un()
          else unlistenStderr = un
        })

      void native
        .onExternalAgentExit((event) => {
          if (settled || event.agentId !== id) return
          settled = true
          cleanup()
          reject(new Error(`OpenCode server exited before becoming ready (code ${event.code})`))
        })
        .then((un) => {
          if (settled) un()
          else unlistenExit = un
        })
    })
  }

  private async killSpawnedServer(): Promise<void> {
    if (!this.spawnedServerId) return
    const id = this.spawnedServerId
    this.spawnedServerId = null
    try {
      const native = await import("@/lib/native/external-agent")
      await native.killExternalAgent(id)
    } catch {
      // Best effort — the process may already be gone.
    }
  }

  async disconnect(): Promise<void> {
    for (const [, controller] of this.abortControllers) {
      controller.abort()
    }
    this.abortControllers.clear()

    for (const [sessionId] of this._sessions) {
      try {
        await this.closeSession(sessionId)
      } catch {
        // Best effort
      }
    }

    await this.killSpawnedServer()

    this._sessions.clear()
    this.pendingInteractions.clear()
    this.baseUrl = ""
    this.requestFetch = undefined
    this._connectionStatus = "disconnected"
    this._config = undefined
    log.info("Disconnected from OpenCode server")
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Use config.get() as a lightweight health probe
      const resp = await this.client.config.get()
      return resp.data !== undefined
    } catch {
      return false
    }
  }

  // ============================================================================
  // Capability Discovery
  // ============================================================================

  private async discoverCapabilities(): Promise<void> {
    // Discover providers
    try {
      const resp = await this.client.provider.list()
      if (resp.data) {
        this.providerInfo = resp.data as unknown as ProviderListData
      }
    } catch (error: unknown) {
      log.warn("Failed to discover providers:", toLogContext(error))
    }

    // Discover agents
    try {
      const resp = await this.client.app.agents()
      if (resp.data) {
        this.availableAgents = resp.data as unknown as Array<{
          id: string
          name?: string
          description?: string
        }>
      }
    } catch (error: unknown) {
      log.warn("Failed to discover agents:", toLogContext(error))
    }

    // Discover commands
    try {
      const resp = await this.client.command.list()
      if (resp.data) {
        this.availableCommands = resp.data as unknown as Array<{
          name: string
          description?: string
          args?: Record<string, unknown>
        }>
      }
    } catch (error: unknown) {
      log.warn("Failed to discover commands:", toLogContext(error))
    }

    // Discover tools
    try {
      const defaultModel = this.getDefaultModel()
      if (defaultModel) {
        const resp = await this.client.tool.list({
          query: { provider: defaultModel.providerID, model: defaultModel.modelID },
        })
        if (resp.data) {
          const toolList = resp.data as unknown as Array<{
            name: string
            description?: string
            inputSchema?: Record<string, unknown>
          }>
          this._tools = toolList.map((t) => this.mapToolToAcpTool(t))
        }
      }
    } catch (error: unknown) {
      log.debug("Tool discovery not available:", toLogContext(error))
    }
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  async createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession> {
    const body: Record<string, unknown> = {}
    if (options?.metadata?.title) {
      body.title = options.metadata.title
    }
    if (options?.metadata?.parentID) {
      body.parentID = options.metadata.parentID
    }

    const resp = await this.client.session.create({ body })
    const ocSession = unwrap<OcSession>(resp)

    const session = this.mapOcSessionToExternal(ocSession)
    this._sessions.set(session.id, session)
    if (options?.systemPrompt) {
      this.sessionSystemPrompts.set(session.id, options.systemPrompt)
    }

    // Build config options for this session
    await this.refreshSessionConfigOptions(session.id)

    return session
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.cancel(sessionId)
    } catch {
      // Best effort
    }
    this._sessions.delete(sessionId)
    this.sessionSystemPrompts.delete(sessionId)
    this.sessionModels.delete(sessionId)
    this.sessionConfigOptions.delete(sessionId)
  }

  // ============================================================================
  // Session Extensions (list, fork, resume)
  // ============================================================================

  async listSessions(): Promise<
    Array<{ sessionId: string; title?: string; createdAt?: string; updatedAt?: string }>
  > {
    const resp = await this.client.session.list()
    const sessions = unwrap<OcSession[]>(resp)
    return sessions.map((s) => ({
      sessionId: s.id,
      title: s.title,
      createdAt: s.time?.created ? new Date(s.time.created * 1000).toISOString() : undefined,
      updatedAt: s.time?.updated ? new Date(s.time.updated * 1000).toISOString() : undefined,
    }))
  }

  async forkSession(sessionId: string): Promise<ExternalAgentSession> {
    const resp = await this.client.session.fork({
      path: { id: sessionId },
      body: {},
    })
    const ocSession = unwrap<OcSession>(resp)
    const session = this.mapOcSessionToExternal(ocSession)
    this._sessions.set(session.id, session)
    return session
  }

  async resumeSession(
    sessionId: string,
    options?: SessionCreateOptions
  ): Promise<ExternalAgentSession> {
    const resp = await this.client.session.get({ path: { id: sessionId } })
    const ocSession = unwrap<OcSession>(resp)
    const session = this.mapOcSessionToExternal(ocSession)
    this._sessions.set(session.id, session)

    if (options?.systemPrompt) {
      this.sessionSystemPrompts.set(sessionId, options.systemPrompt)
    }

    return session
  }

  // ============================================================================
  // Execution (Prompt + Streaming)
  // ============================================================================

  async *prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    const now = new Date()
    let donePayload: {
      success: boolean
      stopReason?: "cancelled"
    } | null = null

    yield {
      type: "session_start",
      sessionId,
      timestamp: now,
      capabilities: this._capabilities,
      tools: this._tools,
    }

    // Build prompt body. Text content is concatenated into one text part; image
    // and file content map to OpenCode `file` parts (mime + url, where the url
    // may be a `data:` URI for inline base64). Multimodal input is therefore no
    // longer silently dropped.
    const textContent = message.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("\n")

    type OcTextPartInput = { type: "text"; text: string }
    type OcFilePartInput = { type: "file"; mime: string; filename?: string; url: string }
    const parts: Array<OcTextPartInput | OcFilePartInput> = [
      { type: "text" as const, text: textContent },
    ]
    for (const filePart of buildOpenCodeFileParts(message.content)) {
      parts.push(filePart)
    }

    const promptBody: {
      parts: Array<OcTextPartInput | OcFilePartInput>
      system?: string
      model?: { providerID: string; modelID: string }
      agent?: string
    } = {
      parts,
    }

    const systemPrompt = options?.systemPrompt ?? this.sessionSystemPrompts.get(sessionId)
    if (systemPrompt) {
      promptBody.system = systemPrompt
    }

    // Model override
    const model = this.resolveModel(options)
    if (model) {
      promptBody.model = model
    }

    // Agent override
    if (options?.context?.custom?.agent) {
      promptBody.agent = options.context.custom.agent as string
    }

    const abortController = new AbortController()
    this.abortControllers.set(sessionId, abortController)

    if (options?.signal) {
      if (options.signal.aborted) {
        abortController.abort()
      } else {
        options.signal.addEventListener("abort", () => abortController.abort())
      }
    }

    try {
      // Subscribe to the event stream BEFORE sending the prompt. The SSE stream
      // has no replay, so opening it first guarantees we don't miss the early
      // message.part.updated events the assistant emits right after promptAsync.
      const events = (await this.client.event.subscribe({
        signal: abortController.signal,
      })) as OcEventStream

      // Send the prompt asynchronously (non-blocking; the server responds 204).
      await this.client.session.promptAsync({
        path: { id: sessionId },
        body: promptBody,
      })

      // Translate and forward the streamed events for this session.
      yield* this.streamSessionEvents(sessionId, events, abortController.signal)
      donePayload = { success: true }
    } catch (_error) {
      if (abortController.signal.aborted) {
        donePayload = { success: false, stopReason: "cancelled" }
        return
      }

      // Fallback: use synchronous prompt
      try {
        const resp = await this.client.session.prompt({
          path: { id: sessionId },
          body: promptBody,
        })
        const result = unwrap<{ info: OcMessage; parts: OcPart[] }>(resp)
        yield* this.emitEventsFromMessage(sessionId, result)
        donePayload = { success: true }
      } catch (syncError) {
        yield {
          type: "error",
          sessionId,
          timestamp: new Date(),
          error: syncError instanceof Error ? syncError.message : String(syncError),
          recoverable: false,
        }
        donePayload = { success: false }
      }
    } finally {
      // Aborting the controller tears down the SSE fetch now that the turn is
      // over (whether it completed, errored, or was cancelled).
      abortController.abort()
      this.abortControllers.delete(sessionId)

      if (donePayload) {
        // Fold the assistant's token usage and any provider/output-length error
        // captured from message.updated into the terminal done event, so a
        // streamed turn reports usage and an errored turn is not marked success.
        const outcome = this.assistantOutcome.get(sessionId)
        this.assistantOutcome.delete(sessionId)
        const success = donePayload.success && !outcome?.error
        yield {
          type: "done",
          sessionId,
          timestamp: new Date(),
          ...donePayload,
          success,
          ...(outcome?.tokenUsage ? { tokenUsage: outcome.tokenUsage } : {}),
        }
      }
    }
  }

  // ============================================================================
  // Permission Handling
  // ============================================================================

  async respondToPermission(sessionId: string, response: AcpPermissionResponse): Promise<void> {
    const key = interactionKey(sessionId, response.requestId)
    const pending = this.pendingInteractions.get(key)
    try {
      if (pending) {
        await this.replyToCurrentInteraction(pending, response)
        this.pendingInteractions.delete(key)
        return
      }
      await this.client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: response.requestId },
        body: {
          response: response.granted ? (response.rememberChoice ? "always" : "once") : "reject",
        },
      })
    } catch (error: unknown) {
      log.warn(`Failed to respond to permission ${response.requestId}:`, toLogContext(error))
    }
  }

  private async replyToCurrentInteraction(
    pending: PendingOpenCodeInteraction,
    response: AcpPermissionResponse
  ): Promise<void> {
    const requestId = encodeURIComponent(response.requestId)
    const sessionId = encodeURIComponent(pending.sessionId)
    if (pending.kind === "permission" || pending.kind === "permissionV2") {
      const reply = response.granted
        ? response.rememberChoice || response.scope === "always" || response.scope === "session"
          ? "always"
          : "once"
        : "reject"
      const path =
        pending.kind === "permissionV2"
          ? `/api/session/${sessionId}/permission/${requestId}/reply`
          : `/permission/${requestId}/reply`
      await this.postInteraction(path, { reply })
      return
    }

    const basePath =
      pending.kind === "questionV2"
        ? `/api/session/${sessionId}/question/${requestId}`
        : `/question/${requestId}`
    if (!response.granted) {
      await this.postInteraction(`${basePath}/reject`)
      return
    }
    const answers = (pending.questionIds ?? []).map((id) => response.answers?.[id] ?? [])
    await this.postInteraction(`${basePath}/reply`, { answers })
  }

  private async postInteraction(path: string, body?: Record<string, unknown>): Promise<void> {
    if (!this.baseUrl) throw new Error("OpenCode server is not connected")
    const request = new Request(`${this.baseUrl}${path}`, {
      method: "POST",
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    })
    const response = await (this.requestFetch ? this.requestFetch(request) : fetch(request))
    if (!response.ok) {
      throw new Error(`OpenCode interaction reply failed with HTTP ${response.status}`)
    }
  }

  // ============================================================================
  // Cancellation
  // ============================================================================

  async cancel(sessionId: string): Promise<void> {
    const controller = this.abortControllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.abortControllers.delete(sessionId)
    }

    try {
      await this.client.session.abort({ path: { id: sessionId } })
    } catch {
      // Best effort - session may already be idle
    }
  }

  // ============================================================================
  // Config Options (Models, Agents, etc.)
  // ============================================================================

  async setSessionMode(sessionId: string, modeId: AcpPermissionMode): Promise<void> {
    // OpenCode has no server-side "mode" endpoint, so previously this was a
    // silent no-op (the `mode` config option it looked for is never created).
    // Persist the permission mode on the session so it is actually recorded and
    // the per-turn auto-approval logic can honor it; still forward to a `mode`
    // config option if a plugin/agent contributed one.
    this.updateSession(sessionId, { permissionMode: modeId })
    const configOptions = this.sessionConfigOptions.get(sessionId) ?? []
    const modeOption = configOptions.find((o) => o.category === "mode")
    if (modeOption) {
      await this.setConfigOption(sessionId, modeOption.id, modeId)
    }
  }

  async setSessionModel(_sessionId: string, modelId: string): Promise<void> {
    // NOTE: OpenCode model selection is global (server `config`), not per-session.
    // This sets the server default; per-turn overrides flow through the prompt
    // body `model` field (see `resolveModel` / `prompt`).
    try {
      await this.client.config.update({
        body: { model: modelId },
      })
    } catch (error: unknown) {
      log.warn("Failed to set model:", toLogContext(error))
    }
  }

  getSessionModels(sessionId: string): AcpSessionModelState | undefined {
    return this.sessionModels.get(sessionId)
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<AcpConfigOption[]> {
    try {
      await this.client.config.update({
        body: { [configId]: value },
      })
    } catch (error: unknown) {
      log.warn(`Failed to set config option ${configId}:`, toLogContext(error))
    }

    await this.refreshSessionConfigOptions(sessionId)
    return this.sessionConfigOptions.get(sessionId) ?? []
  }

  getConfigOptions(sessionId: string): AcpConfigOption[] | undefined {
    return this.sessionConfigOptions.get(sessionId)
  }

  // ============================================================================
  // Auth Methods
  // ============================================================================

  getAuthMethods(): import("@/types/agent/external-agent").AcpAuthMethod[] {
    if (!this.providerInfo) return []
    return this.providerInfo.connected.map((id) => ({
      id,
      name: this.providerInfo!.all.find((p) => p.id === id)?.name ?? id,
      description: `OpenCode provider: ${id}`,
    }))
  }

  isAuthenticationRequired(): boolean {
    return false
  }

  async authenticate(methodId: string, credentials?: Record<string, unknown>): Promise<void> {
    if (credentials?.key) {
      await this.client.auth.set({
        path: { id: methodId },
        body: {
          type: "api",
          key: credentials.key as string,
        },
      })
    }
  }

  // ============================================================================
  // Session Extension Support
  // ============================================================================

  getSessionExtensionSupport(): ExternalAgentSessionExtensionSupport {
    // The OpenCode SDK statically guarantees session list/fork/continuation
    // (`session.children`/`session.fork`/`session.prompt` exist in the typed v1
    // client), so support is a compile-time contract rather than a runtime probe.
    // We still gate on the live connection: before connect there is no server to
    // talk to, so report `unknown` instead of asserting a capability we cannot
    // yet exercise. This keeps the manager's gating honest about readiness.
    const connected = this.isConnected()
    const status: ExternalAgentExtensionSupportStatus = connected
      ? { state: "supported", lastCheckedAt: new Date() }
      : { state: "unknown", reason: "OpenCode server not connected yet." }
    return {
      "session/list": status,
      "session/fork": status,
      "session/resume": status,
    }
  }

  clearSessionExtensionSupportCache(): void {
    // Support is derived from the SDK contract + live connection state, so there
    // is no probe result to cache or clear.
  }

  getAcpInitializationMetadata() {
    return {
      protocolVersion: 1,
      agentInfo: {
        name: "opencode",
        title: "OpenCode",
        version: "latest",
      },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          fork: {},
          resume: {},
        },
      },
    }
  }

  // ============================================================================
  // OpenCode-Specific Operations (using SDK)
  // ============================================================================

  /**
   * Execute a slash command in a session
   */
  async executeCommand(
    sessionId: string,
    command: string,
    args?: string
  ): Promise<{ info: OcMessage; parts: OcPart[] }> {
    const resp = await this.client.session.command({
      path: { id: sessionId },
      body: {
        command,
        arguments: args ?? "",
      },
    })
    return unwrap(resp)
  }

  /**
   * Run a shell command in a session
   */
  async executeShell(
    sessionId: string,
    command: string,
    agent?: string,
    model?: { providerID: string; modelID: string }
  ): Promise<unknown> {
    const resp = await this.client.session.shell({
      path: { id: sessionId },
      body: {
        command,
        agent: agent ?? "default",
        model,
      },
    })
    return resp.data
  }

  /**
   * Get session diff
   */
  async getSessionDiff(sessionId: string, messageID?: string): Promise<OcFileDiff[]> {
    const resp = await this.client.session.diff({
      path: { id: sessionId },
      query: messageID ? { messageID } : undefined,
    })
    return unwrap(resp)
  }

  /**
   * Get session todos
   */
  async getSessionTodos(sessionId: string): Promise<OcTodo[]> {
    const resp = await this.client.session.todo({
      path: { id: sessionId },
    })
    return unwrap(resp)
  }

  /**
   * Get session messages
   */
  async getSessionMessages(
    sessionId: string,
    limit?: number
  ): Promise<Array<{ info: OcMessage; parts: OcPart[] }>> {
    const resp = await this.client.session.messages({
      path: { id: sessionId },
      query: limit ? { limit } : undefined,
    })
    return unwrap(resp)
  }

  /**
   * Get a specific message
   */
  async getSessionMessage(
    sessionId: string,
    messageID: string
  ): Promise<{ info: OcMessage; parts: OcPart[] }> {
    const resp = await this.client.session.message({
      path: { id: sessionId, messageID },
    })
    return unwrap(resp)
  }

  /**
   * Update session title
   */
  async updateSessionTitle(sessionId: string, title: string): Promise<OcSession> {
    const resp = await this.client.session.update({
      path: { id: sessionId },
      body: { title },
    })
    return unwrap(resp)
  }

  /**
   * Search for text in files
   */
  async findText(pattern: string): Promise<unknown[]> {
    const resp = await this.client.find.text({
      query: { pattern },
    })
    return unwrap(resp)
  }

  /**
   * Find files by name
   */
  async findFiles(query: string, options?: { type?: "file" | "directory" }): Promise<string[]> {
    const resp = await this.client.find.files({
      query: {
        query,
        // `dirs: "false"` restricts results to files only.
        ...(options?.type === "file" ? { dirs: "false" as const } : {}),
      },
    })
    return unwrap(resp)
  }

  /**
   * Find workspace symbols
   */
  async findSymbols(query: string): Promise<unknown[]> {
    const resp = await this.client.find.symbols({
      query: { query },
    })
    return unwrap(resp)
  }

  /**
   * Read a file
   */
  async readFile(path: string): Promise<{ type: string; content: string }> {
    const resp = await this.client.file.read({
      query: { path },
    })
    return unwrap(resp)
  }

  /**
   * List files and directories
   */
  async listFiles(path: string): Promise<unknown[]> {
    const resp = await this.client.file.list({
      query: { path },
    })
    return unwrap(resp)
  }

  /**
   * Get file status (tracked files)
   */
  async getFileStatus(): Promise<unknown[]> {
    const resp = await this.client.file.status()
    return unwrap(resp)
  }

  /**
   * Get VCS info
   */
  async getVcsInfo(): Promise<unknown> {
    const resp = await this.client.vcs.get()
    return unwrap(resp)
  }

  /**
   * Get current project info
   */
  async getProject(): Promise<unknown> {
    const resp = await this.client.project.current()
    return unwrap(resp)
  }

  /**
   * List all projects
   */
  async listProjects(): Promise<unknown[]> {
    const resp = await this.client.project.list()
    return unwrap(resp)
  }

  /**
   * Get MCP server status
   */
  async getMcpStatus(): Promise<unknown> {
    const resp = await this.client.mcp.status()
    return unwrap(resp)
  }

  /**
   * Add an MCP server dynamically
   */
  async addMcpServer(name: string, config: Record<string, unknown>): Promise<void> {
    await this.client.mcp.add({
      body: { name, config } as unknown as Parameters<typeof this.client.mcp.add>[0] extends {
        body?: infer B
      }
        ? B
        : never,
    })
  }

  /**
   * Connect an MCP server
   */
  async connectMcpServer(name: string): Promise<void> {
    await this.client.mcp.connect({
      path: { name },
    })
  }

  /**
   * Disconnect an MCP server
   */
  async disconnectMcpServer(name: string): Promise<void> {
    await this.client.mcp.disconnect({
      path: { name },
    })
  }

  /**
   * Get LSP server status
   */
  async getLspStatus(): Promise<unknown> {
    const resp = await this.client.lsp.status()
    return unwrap(resp)
  }

  /**
   * Get formatter status
   */
  async getFormatterStatus(): Promise<unknown> {
    const resp = await this.client.formatter.status()
    return unwrap(resp)
  }

  /**
   * Share a session
   */
  async shareSession(sessionId: string): Promise<OcSession> {
    const resp = await this.client.session.share({ path: { id: sessionId } })
    return unwrap(resp)
  }

  /**
   * Unshare a session
   */
  async unshareSession(sessionId: string): Promise<OcSession> {
    const resp = await this.client.session.unshare({ path: { id: sessionId } })
    return unwrap(resp)
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const resp = await this.client.session.delete({ path: { id: sessionId } })
    return unwrap(resp)
  }

  /**
   * Summarize a session
   */
  async summarizeSession(sessionId: string, providerID: string, modelID: string): Promise<boolean> {
    const resp = await this.client.session.summarize({
      path: { id: sessionId },
      body: { providerID, modelID },
    })
    return unwrap(resp)
  }

  /**
   * Revert a message in a session
   */
  async revertMessage(sessionId: string, messageID: string, partID?: string): Promise<void> {
    await this.client.session.revert({
      path: { id: sessionId },
      body: { messageID, partID },
    })
  }

  /**
   * Unrevert all reverted messages in a session
   */
  async unrevertMessages(sessionId: string): Promise<void> {
    await this.client.session.unrevert({ path: { id: sessionId } })
  }

  /**
   * Initialize a session (analyze app, create AGENTS.md)
   */
  async initSession(
    sessionId: string,
    messageID: string,
    providerID: string,
    modelID: string
  ): Promise<boolean> {
    const resp = await this.client.session.init({
      path: { id: sessionId },
      body: { messageID, providerID, modelID },
    })
    return unwrap(resp)
  }

  /**
   * Get child sessions
   */
  async getChildSessions(sessionId: string): Promise<OcSession[]> {
    const resp = await this.client.session.children({ path: { id: sessionId } })
    return unwrap(resp)
  }

  /**
   * Get session status for all sessions
   */
  async getSessionStatus(): Promise<Record<string, OcSessionStatus>> {
    const resp = await this.client.session.status()
    return unwrap(resp)
  }

  // ============================================================================
  // PTY Operations (new via SDK)
  // ============================================================================

  /**
   * List all PTY sessions
   */
  async listPty(): Promise<OcPty[]> {
    const resp = await this.client.pty.list()
    return unwrap(resp)
  }

  /**
   * Create a new PTY session
   */
  async createPty(command: string, args?: string[], cwd?: string): Promise<OcPty> {
    const resp = await this.client.pty.create({
      body: { command, args: args ?? [], cwd },
    })
    return unwrap(resp)
  }

  /**
   * Get PTY session info
   */
  async getPty(id: string): Promise<OcPty> {
    const resp = await this.client.pty.get({ path: { id } })
    return unwrap(resp)
  }

  /**
   * Remove a PTY session
   */
  async removePty(id: string): Promise<boolean> {
    const resp = await this.client.pty.remove({ path: { id } })
    return unwrap(resp)
  }

  // ============================================================================
  // Tool Discovery
  // ============================================================================

  /**
   * List all tool IDs (built-in and dynamically registered)
   */
  async listToolIds(): Promise<string[]> {
    const resp = await this.client.tool.ids()
    return unwrap(resp)
  }

  /**
   * List tools with JSON schema parameters for a specific model
   */
  async listToolsForModel(providerID: string, modelID: string): Promise<unknown> {
    const resp = await this.client.tool.list({
      query: { provider: providerID, model: modelID },
    })
    return unwrap(resp)
  }

  // ============================================================================
  // TUI Operations
  // ============================================================================

  async tuiAppendPrompt(text: string): Promise<boolean> {
    const resp = await this.client.tui.appendPrompt({ body: { text } })
    return unwrap(resp)
  }

  async tuiSubmitPrompt(): Promise<boolean> {
    const resp = await this.client.tui.submitPrompt()
    return unwrap(resp)
  }

  async tuiClearPrompt(): Promise<boolean> {
    const resp = await this.client.tui.clearPrompt()
    return unwrap(resp)
  }

  async tuiExecuteCommand(command: string): Promise<boolean> {
    const resp = await this.client.tui.executeCommand({ body: { command } })
    return unwrap(resp)
  }

  async tuiShowToast(
    message: string,
    variant?: "info" | "success" | "warning" | "error",
    title?: string
  ): Promise<boolean> {
    const resp = await this.client.tui.showToast({
      body: { message, variant: variant ?? "info", title },
    })
    return unwrap(resp)
  }

  async tuiOpenHelp(): Promise<boolean> {
    const resp = await this.client.tui.openHelp()
    return unwrap(resp)
  }

  async tuiOpenSessions(): Promise<boolean> {
    const resp = await this.client.tui.openSessions()
    return unwrap(resp)
  }

  async tuiOpenThemes(): Promise<boolean> {
    const resp = await this.client.tui.openThemes()
    return unwrap(resp)
  }

  async tuiOpenModels(): Promise<boolean> {
    const resp = await this.client.tui.openModels()
    return unwrap(resp)
  }

  // ============================================================================
  // Provider Operations
  // ============================================================================

  /**
   * Get provider authentication methods
   */
  async getProviderAuthMethods(): Promise<unknown> {
    const resp = await this.client.provider.auth()
    return unwrap(resp)
  }

  /**
   * Authorize a provider using OAuth
   */
  async authorizeProviderOAuth(providerID: string): Promise<unknown> {
    const resp = await this.client.provider.oauth.authorize({
      path: { id: providerID },
    })
    return unwrap(resp)
  }

  // ============================================================================
  // Logging
  // ============================================================================

  async writeLog(
    service: string,
    level: "error" | "info" | "debug" | "warn",
    message: string,
    extra?: Record<string, unknown>
  ): Promise<boolean> {
    const resp = await this.client.app.log({
      body: { service, level, message, extra },
    })
    return unwrap(resp)
  }

  // ============================================================================
  // Instance
  // ============================================================================

  async disposeInstance(): Promise<boolean> {
    const resp = await this.client.instance.dispose()
    return unwrap(resp)
  }

  // ============================================================================
  // Config
  // ============================================================================

  /**
   * Get full config
   */
  async getConfig(): Promise<unknown> {
    const resp = await this.client.config.get()
    return unwrap(resp)
  }

  /**
   * Get providers with default models
   */
  async getConfigProviders(): Promise<unknown> {
    const resp = await this.client.config.providers()
    return unwrap(resp)
  }

  // ============================================================================
  // Path
  // ============================================================================

  /**
   * Get current path information
   */
  async getPath(): Promise<unknown> {
    const resp = await this.client.path.get()
    return unwrap(resp)
  }

  // ============================================================================
  // Accessors
  // ============================================================================

  getAvailableAgents(): Array<{ id: string; name?: string; description?: string }> {
    return this.availableAgents
  }

  getAvailableCommands(): AcpAvailableCommand[] {
    return this.availableCommands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description ?? "",
      input: cmd.args ? { hint: JSON.stringify(cmd.args) } : null,
    }))
  }

  getProviders(): ProviderListData | null {
    return this.providerInfo
  }

  /**
   * Get the underlying SDK client for advanced use cases
   */
  getSdkClient(): OpencodeClient {
    return this.client
  }

  // ============================================================================
  // Internal: SSE Event Streaming via SDK
  // ============================================================================

  private async *streamSessionEvents(
    sessionId: string,
    events: OcEventStream,
    signal: AbortSignal
  ): AsyncIterable<ExternalAgentEvent> {
    let receivedAssistantMessage = false

    // `event.subscribe()` yields `Event` objects directly (a `{ type, properties }`
    // discriminated union) — unlike `global.event()`, there is no `.payload`
    // wrapper. The stream is torn down by aborting the signal passed to
    // `subscribe()`, which makes this loop end.
    for await (const event of events.stream) {
      if (signal.aborted) break

      const translated = this.translateSdkEvent(sessionId, event)

      for (const evt of translated) {
        yield evt

        if (evt.type === "message_delta" || evt.type === "message_end") {
          receivedAssistantMessage = true
        }

        if (evt.type === "done") {
          return
        }
      }

      // Check if session is idle after receiving assistant messages
      if (receivedAssistantMessage && event.type === "session.status") {
        const statusEvt = event as { properties: { sessionID: string; status: OcSessionStatus } }
        if (statusEvt.properties.sessionID === sessionId) {
          const status = statusEvt.properties.status
          if (status.type === "idle") {
            return
          }
        }
      }

      if (receivedAssistantMessage && event.type === "session.idle") {
        const idleEvt = event as { properties: { sessionID: string } }
        if (idleEvt.properties.sessionID === sessionId) {
          return
        }
      }
    }
  }

  // ============================================================================
  // Internal: Event Translation (SDK Event → Cognia Event)
  // ============================================================================

  /**
   * Translate SDK events to Cognia external agent events.
   * The SDK provides typed discriminated union events.
   */
  translateSdkEvent(sessionId: string, event: OcEvent): ExternalAgentEvent[] {
    const now = new Date()
    const events: ExternalAgentEvent[] = []
    const interactive = this.translateCurrentInteractionEvent(sessionId, event, now)
    if (interactive) return interactive

    switch (event.type) {
      case "server.connected":
        break

      case "session.created":
      case "session.updated":
      case "session.deleted":
        break

      case "message.updated": {
        const { info } = event.properties
        // Only process assistant messages. Parts arrive via message.part.updated;
        // this event carries the turn-level token usage, cost, error, and finish
        // reason that were previously dropped (so streamed turns reported no
        // usage and silently swallowed provider/output-length errors).
        if (info.role !== "assistant") break
        const assistant = info as {
          tokens?: {
            input?: number
            output?: number
            reasoning?: number
            cache?: { read?: number; write?: number }
          }
          cost?: number
          error?: { name?: string; data?: { message?: string } }
          finish?: string
          time?: { completed?: number }
        }
        const tokenUsage = mapOpenCodeTokens(assistant.tokens)
        const errorMessage = assistant.error
          ? assistant.error.data?.message || assistant.error.name || "Assistant error"
          : undefined
        const prev = this.assistantOutcome.get(sessionId) ?? {}
        this.assistantOutcome.set(sessionId, {
          tokenUsage: tokenUsage ?? prev.tokenUsage,
          error: errorMessage ?? prev.error,
          finishReason: assistant.finish ?? prev.finishReason,
        })
        if (errorMessage) {
          events.push({
            type: "error",
            sessionId,
            timestamp: now,
            error: errorMessage,
            code: assistant.error?.name,
            recoverable: false,
          })
        }
        // The message is finalized once `time.completed` is set — emit a
        // message_end carrying the token usage so the renderer/trace see it.
        if (assistant.time?.completed) {
          events.push({
            type: "message_end",
            sessionId,
            timestamp: now,
            messageId: info.id,
            ...(tokenUsage ? { tokenUsage } : {}),
          })
        }
        break
      }

      case "permission.replied": {
        // A permission resolved (possibly by another client / the TUI). Emit a
        // permission_response so our UI clears the stale pending request.
        const { sessionID, permissionID, response } = event.properties
        if (sessionID !== sessionId) break
        events.push({
          type: "permission_response",
          sessionId,
          timestamp: now,
          response: {
            requestId: permissionID,
            granted: response !== "reject",
          },
        })
        break
      }

      case "message.part.removed":
      case "message.removed": {
        // Out-of-band retraction (e.g. after a revert). The canonical event
        // stream has no retraction primitive, so this is acknowledged here
        // rather than falling through to the unhandled-event log.
        break
      }

      case "message.part.updated": {
        const { part, delta } = event.properties
        // Filter to parts belonging to this session
        if (part.sessionID !== sessionId) break

        switch (part.type) {
          case "text": {
            const textPart = part as OcTextPart
            // Use delta if available, otherwise use full text with dedup
            const text = delta ?? textPart.text
            if (text) {
              events.push({
                type: "message_delta",
                sessionId,
                timestamp: now,
                delta: { type: "text", text },
              })
            }
            break
          }

          case "reasoning": {
            const reasoningPart = part as OcReasoningPart
            const thinking = delta ?? reasoningPart.text
            if (thinking) {
              events.push({
                type: "thinking",
                sessionId,
                timestamp: now,
                thinking,
              })
            }
            break
          }

          case "tool": {
            const toolPart = part as OcToolPart
            const { state } = toolPart

            if (state.status === "pending" || state.status === "running") {
              events.push({
                type: "tool_use_start",
                sessionId,
                timestamp: now,
                toolUseId: toolPart.callID ?? toolPart.id,
                toolName: toolPart.tool ?? "unknown",
                rawInput: state.input,
              })
            } else if (state.status === "completed") {
              events.push({
                type: "tool_result",
                sessionId,
                timestamp: now,
                toolUseId: toolPart.callID ?? toolPart.id,
                result: state.output,
                isError: false,
                toolName: toolPart.tool,
              })
            } else if (state.status === "error") {
              events.push({
                type: "tool_result",
                sessionId,
                timestamp: now,
                toolUseId: toolPart.callID ?? toolPart.id,
                result: state.error,
                isError: true,
                toolName: toolPart.tool,
              })
            }
            break
          }
        }
        break
      }

      case "todo.updated": {
        const { sessionID, todos } = event.properties
        if (sessionID !== sessionId) break

        const planEntries: AcpPlanEntry[] = todos.map((t: OcTodo) => ({
          content: t.content,
          priority: (t.priority as "high" | "medium" | "low") ?? "medium",
          status:
            t.status === "completed"
              ? ("completed" as const)
              : t.status === "in_progress"
                ? ("in_progress" as const)
                : t.status === "cancelled"
                  ? ("completed" as const)
                  : ("pending" as const),
        }))
        events.push({
          type: "plan_update",
          sessionId,
          timestamp: now,
          entries: planEntries,
          progress:
            (planEntries.filter((e) => e.status === "completed").length /
              Math.max(planEntries.length, 1)) *
            100,
          step: planEntries.findIndex((e) => e.status === "in_progress"),
          totalSteps: planEntries.length,
        })
        break
      }

      case "permission.updated": {
        const perm: OcPermission = event.properties
        if (perm.sessionID !== sessionId) break

        // Carry the callID (links the permission to the specific tool
        // invocation already surfaced as tool_use_start), plus metadata and
        // pattern, so the prompt can show what is being authorized.
        const metadata =
          perm.metadata && typeof perm.metadata === "object"
            ? (perm.metadata as Record<string, unknown>)
            : undefined
        events.push({
          type: "permission_request",
          sessionId,
          timestamp: now,
          request: {
            id: perm.id,
            requestId: perm.id,
            sessionId,
            ...(perm.callID ? { toolCallId: perm.callID } : {}),
            toolInfo: {
              id: perm.type ?? "unknown",
              name: perm.title ?? perm.type ?? "unknown",
              description: perm.title,
            },
            ...(metadata ? { metadata } : {}),
            ...(perm.pattern ? { rawInput: { pattern: perm.pattern } } : {}),
            reason: perm.title,
          },
        })
        break
      }

      case "session.error": {
        const { sessionID, error } = event.properties
        if (sessionID && sessionID !== sessionId) break

        const errorMessage = error
          ? "message" in error.data
            ? (error.data as { message: string }).message
            : JSON.stringify(error)
          : "Unknown error"
        events.push({
          type: "error",
          sessionId,
          timestamp: now,
          error: errorMessage,
          recoverable: true,
        })
        break
      }

      case "session.status": {
        // Handled in the streaming loop for idle detection
        break
      }

      case "session.idle": {
        // Handled in the streaming loop for completion detection
        break
      }

      default:
        log.debug(`Unhandled OpenCode event type: ${event.type}`)
    }

    return events
  }

  /**
   * Translate the current OpenCode permission/question events that are newer
   * than the root SDK client's generated Event union. Runtime SSE still carries
   * them, so this structural compatibility layer prevents headless sessions
   * from stalling while retaining the existing SDK surface for older servers.
   */
  private translateCurrentInteractionEvent(
    sessionId: string,
    event: OcEvent,
    timestamp: Date
  ): ExternalAgentEvent[] | undefined {
    const wire = event as unknown as OpenCodeWireEvent
    const properties = wire.properties ?? wire.data
    const type = wire.type
    if (!properties) return undefined

    if (type === "permission.asked" || type === "permission.v2.asked") {
      const eventSessionId = asOpenCodeString(properties.sessionID)
      if (eventSessionId !== sessionId) return []
      const requestId = asOpenCodeString(properties.id)
      if (!requestId) return []
      const isV2 = type === "permission.v2.asked"
      const action = asOpenCodeString(isV2 ? properties.action : properties.permission) ?? "unknown"
      const tool = asOpenCodeRecord(isV2 ? properties.source : properties.tool)
      const metadata = asOpenCodeRecord(properties.metadata)
      const resources = isV2
        ? asOpenCodeStringArray(properties.resources)
        : asOpenCodeStringArray(properties.patterns)
      const persistentResources = isV2
        ? asOpenCodeStringArray(properties.save)
        : asOpenCodeStringArray(properties.always)

      this.pendingInteractions.set(interactionKey(sessionId, requestId), {
        kind: isV2 ? "permissionV2" : "permission",
        sessionId,
      })
      return [
        {
          type: "permission_request",
          sessionId,
          timestamp,
          request: {
            id: requestId,
            requestId,
            sessionId,
            ...(asOpenCodeString(tool?.callID)
              ? { toolCallId: asOpenCodeString(tool?.callID) }
              : {}),
            title: action,
            toolInfo: { id: action, name: action, category: action },
            rawInput: {
              ...(isV2 ? { resources } : { patterns: resources }),
              ...(persistentResources.length > 0
                ? { [isV2 ? "save" : "always"]: persistentResources }
                : {}),
            },
            ...(metadata ? { metadata } : {}),
            reason: action,
          },
        },
      ]
    }

    if (type === "question.asked" || type === "question.v2.asked") {
      const eventSessionId = asOpenCodeString(properties.sessionID)
      if (eventSessionId !== sessionId) return []
      const requestId = asOpenCodeString(properties.id)
      const rawQuestions = Array.isArray(properties.questions) ? properties.questions : []
      if (!requestId || rawQuestions.length === 0) return []
      const questions = rawQuestions.flatMap((rawQuestion, index) => {
        const question = asOpenCodeRecord(rawQuestion)
        const text = asOpenCodeString(question?.question)
        if (!question || !text) return []
        const options = Array.isArray(question.options)
          ? question.options.flatMap((rawOption) => {
              const option = asOpenCodeRecord(rawOption)
              const label = asOpenCodeString(option?.label)
              if (!label) return []
              const description = asOpenCodeString(option?.description)
              return [description ? { label, description } : { label }]
            })
          : []
        if (Array.isArray(question.options) && options.length !== question.options.length) return []
        return [
          {
            id: `${requestId}:${index}`,
            header: asOpenCodeString(question.header),
            question: text,
            options,
            multiple: question.multiple === true,
            isOther: question.custom === true,
          },
        ]
      })
      // Do not partially accept malformed payloads: answer ordering is positional in
      // both OpenCode question APIs, so dropping a question would shift every reply.
      if (questions.length !== rawQuestions.length) {
        const isV2 = type === "question.v2.asked"
        const encodedSessionId = encodeURIComponent(sessionId)
        const encodedRequestId = encodeURIComponent(requestId)
        const path = isV2
          ? `/api/session/${encodedSessionId}/question/${encodedRequestId}/reject`
          : `/question/${encodedRequestId}/reject`
        void this.postInteraction(path).catch((error) => {
          log.warn(
            `Failed to reject malformed OpenCode question ${requestId}:`,
            toLogContext(error)
          )
        })
        return []
      }
      const tool = asOpenCodeRecord(properties.tool)
      const questionIds = questions.map((question) => question.id)
      this.pendingInteractions.set(interactionKey(sessionId, requestId), {
        kind: type === "question.v2.asked" ? "questionV2" : "question",
        sessionId,
        questionIds,
      })
      return [
        {
          type: "permission_request",
          sessionId,
          timestamp,
          request: {
            id: requestId,
            requestId,
            sessionId,
            ...(asOpenCodeString(tool?.callID)
              ? { toolCallId: asOpenCodeString(tool?.callID) }
              : {}),
            title: questions[0].header ?? questions[0].question,
            kind: "other",
            toolInfo: { id: requestId, name: "request_user_input", category: "other" },
            metadata: {
              codexUserInput: { requestId, questions },
              openCodeQuestion: { version: type === "question.v2.asked" ? 2 : 1 },
            },
          },
        },
      ]
    }

    const permissionReply = type === "permission.v2.replied" || type === "permission.replied"
    const questionReply =
      type === "question.replied" ||
      type === "question.rejected" ||
      type === "question.v2.replied" ||
      type === "question.v2.rejected"
    const requestId = asOpenCodeString(properties.requestID)
    if ((permissionReply || questionReply) && requestId) {
      const eventSessionId = asOpenCodeString(properties.sessionID)
      if (eventSessionId !== sessionId) return []
      this.pendingInteractions.delete(interactionKey(sessionId, requestId))
      const rejected = type.endsWith(".rejected") || properties.reply === "reject"
      return [
        {
          type: "permission_response",
          sessionId,
          timestamp,
          response: { requestId, granted: !rejected },
        },
      ]
    }

    return undefined
  }

  /**
   * Emit events from a synchronous message response
   */
  private *emitEventsFromMessage(
    sessionId: string,
    message: { info: OcMessage; parts: OcPart[] }
  ): Iterable<ExternalAgentEvent> {
    const now = new Date()

    yield {
      type: "message_start",
      sessionId,
      timestamp: now,
      messageId: message.info.id,
      role: "assistant",
    }

    for (const part of message.parts) {
      switch (part.type) {
        case "text": {
          const textPart = part as OcTextPart
          if (textPart.text) {
            yield {
              type: "message_delta",
              sessionId,
              timestamp: now,
              delta: { type: "text", text: textPart.text },
            }
          }
          break
        }

        case "reasoning": {
          const reasoningPart = part as OcReasoningPart
          if (reasoningPart.text) {
            yield {
              type: "thinking",
              sessionId,
              timestamp: now,
              thinking: reasoningPart.text,
            }
          }
          break
        }

        case "tool": {
          const toolPart = part as OcToolPart
          yield {
            type: "tool_use_start",
            sessionId,
            timestamp: now,
            toolUseId: toolPart.callID ?? toolPart.id,
            toolName: toolPart.tool ?? "unknown",
            rawInput: toolPart.state.input,
          }

          if (toolPart.state.status === "completed") {
            yield {
              type: "tool_result",
              sessionId,
              timestamp: now,
              toolUseId: toolPart.callID ?? toolPart.id,
              result: toolPart.state.output,
              isError: false,
              toolName: toolPart.tool,
            }
          } else if (toolPart.state.status === "error") {
            yield {
              type: "tool_result",
              sessionId,
              timestamp: now,
              toolUseId: toolPart.callID ?? toolPart.id,
              result: toolPart.state.error,
              isError: true,
              toolName: toolPart.tool,
            }
          }
          break
        }
      }
    }

    yield {
      type: "message_end",
      sessionId,
      timestamp: now,
      messageId: message.info.id,
    }
  }

  // ============================================================================
  // Internal: Mapping Helpers
  // ============================================================================

  private mapOcSessionToExternal(ocSession: OcSession): ExternalAgentSession {
    const now = new Date()
    return {
      id: ocSession.id,
      agentId: this._config?.id ?? "opencode",
      status: "active",
      createdAt: ocSession.time?.created ? new Date(ocSession.time.created * 1000) : now,
      lastActivityAt: ocSession.time?.updated ? new Date(ocSession.time.updated * 1000) : now,
      metadata: {
        title: ocSession.title,
        parentID: ocSession.parentID,
        shared: !!ocSession.share,
        shareUrl: ocSession.share?.url,
        version: ocSession.version,
        projectID: ocSession.projectID,
        directory: ocSession.directory,
      },
    }
  }

  private mapToolToAcpTool(tool: {
    name: string
    description?: string
    inputSchema?: Record<string, unknown>
  }): AcpToolInfo {
    return {
      id: tool.name,
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }
  }

  private resolveModel(
    options?: ExternalAgentExecutionOptions
  ): { providerID: string; modelID: string } | undefined {
    const ctxModel = options?.context?.custom?.model as
      { providerID: string; modelID: string } | undefined
    if (ctxModel?.providerID && ctxModel?.modelID) {
      return ctxModel
    }

    const metaModel = this._config?.metadata?.model as string | undefined
    if (metaModel && metaModel.includes("/")) {
      const [providerID, modelID] = metaModel.split("/", 2)
      return { providerID, modelID }
    }

    return undefined
  }

  private getDefaultModel(): { providerID: string; modelID: string } | undefined {
    if (!this.providerInfo?.default) return undefined

    const entries = Object.entries(this.providerInfo.default)
    if (entries.length === 0) return undefined

    const [providerID, modelID] = entries[0]
    return { providerID, modelID }
  }

  private async refreshSessionConfigOptions(sessionId: string): Promise<void> {
    const options: AcpConfigOption[] = []

    if (this.providerInfo) {
      const modelValues: AcpConfigOptionValue[] = []
      for (const provider of this.providerInfo.all) {
        if (provider.models) {
          for (const [modelKey, model] of Object.entries(provider.models)) {
            modelValues.push({
              value: `${provider.id}/${model.id ?? modelKey}`,
              name: model.name ?? model.id ?? modelKey,
              description: `Provider: ${provider.name ?? provider.id}`,
            })
          }
        }
      }

      if (modelValues.length > 0) {
        const defaultModel = this.getDefaultModel()
        options.push({
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: defaultModel
            ? `${defaultModel.providerID}/${defaultModel.modelID}`
            : modelValues[0].value,
          options: modelValues,
        })

        this.sessionModels.set(sessionId, {
          availableModels: modelValues.map((v) => ({
            modelId: v.value,
            name: v.name,
            description: v.description,
          })),
          currentModelId: defaultModel
            ? `${defaultModel.providerID}/${defaultModel.modelID}`
            : modelValues[0].value,
        })
      }
    }

    if (this.availableAgents.length > 0) {
      options.push({
        id: "agent",
        name: "Agent",
        category: "_agent",
        type: "select",
        currentValue: this.availableAgents[0].id,
        options: this.availableAgents.map((a) => ({
          value: a.id,
          name: a.name ?? a.id,
          description: a.description,
        })),
      })
    }

    this.sessionConfigOptions.set(sessionId, options)
  }
}

function asOpenCodeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asOpenCodeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asOpenCodeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []
}
