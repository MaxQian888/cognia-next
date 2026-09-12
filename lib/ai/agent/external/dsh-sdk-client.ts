import type {
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentSession,
  ExternalAgentTokenUsage,
} from "@/types/agent/external-agent"

import { translateDshNotification, type DshCodecWarning } from "./dsh-session-event-codec"
import { BaseProtocolAdapter, type SessionCreateOptions } from "./protocol-adapter"

/**
 * Protocol adapter for the DeepSeek Harness stdio JSON-RPC SDK runtime.
 *
 * This is Cognia's primary DSH channel. It is the observation-rich transport:
 * full `session.event` stream, tool activity, reasoning, usage, and subagent
 * lineage. What it cannot do is ask a question mid-turn or cancel one turn —
 * upstream's server->client requests are a dead capability and the wire has no
 * prompt-cancel method — so authority is fixed at launch by the composition and
 * cancellation closes the process.
 *
 * The runtime is reached through an injected {@link DshRuntimeTransport} rather
 * than importing `@deepseek-ai/dsh-sdk-client` here. That package spawns a
 * subprocess and must never enter the browser bundle; keeping it behind a seam
 * also makes this adapter testable without a live runtime.
 */

/** A raw notification frame as it arrived from the runtime. */
export type DshRawNotification = unknown

export interface DshRuntimeTransportHandlers {
  onNotification: (notification: DshRawNotification) => void
  /** Runtime exited or the transport failed. Carries a redacted stderr tail. */
  onClosed: (reason: string) => void
}

/**
 * The subprocess-owning seam.
 *
 * Implemented by Cognia's native process bridge for desktop, CLI and headless
 * hosts. It owns JSON-RPC framing, initialize/shutdown and process teardown;
 * this adapter owns session identity and admitted-prompt completion.
 */
export type DshPromptContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image"
      data: string
      mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    }

export interface DshRuntimeTransport {
  start(handlers: DshRuntimeTransportHandlers): Promise<void>
  /** Enqueue a prompt. Resolves with the inbox-admission message id. */
  prompt(sessionId: string, contentBlocks: DshPromptContentBlock[]): Promise<string>
  close(): Promise<void>
  isRunning(): boolean
}

export interface DshSdkClientAdapterOptions {
  /** Builds a transport for a given agent config. */
  createTransport: (config: ExternalAgentConfig) => DshRuntimeTransport
  /** Bounded sink for codec warnings; defaults to dropping them. */
  onCodecWarning?: (warning: DshCodecWarning) => void
}

/** Queue bridging pushed notifications to a pulled async iterator. */
class EventQueue {
  private readonly buffer: ExternalAgentEvent[] = []
  private waiting?: {
    resolve: (value: IteratorResult<ExternalAgentEvent>) => void
    reject: (error: Error) => void
  }
  private ended = false
  private failure?: Error

  push(event: ExternalAgentEvent): void {
    if (this.ended) return
    const waiting = this.waiting
    if (waiting) {
      this.waiting = undefined
      waiting.resolve({ value: event, done: false })
      return
    }
    this.buffer.push(event)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    const waiting = this.waiting
    if (waiting) {
      this.waiting = undefined
      waiting.resolve({ value: undefined, done: true })
    }
  }

  /**
   * Terminate the stream with an error.
   *
   * A consumer already parked in `next()` must be rejected, not resolved as
   * done: a silent `done` would present a failed turn as a completed one.
   */
  fail(error: Error): void {
    this.failure ??= error
    if (this.ended) return
    this.ended = true
    const waiting = this.waiting
    if (waiting) {
      this.waiting = undefined
      this.failure = undefined
      waiting.reject(error)
    }
  }

  async next(): Promise<IteratorResult<ExternalAgentEvent>> {
    const buffered = this.buffer.shift()
    if (buffered) return { value: buffered, done: false }
    // A failure is raised only once the buffer has drained, so events observed
    // before the fault still reach the consumer.
    if (this.failure) {
      const error = this.failure
      this.failure = undefined
      throw error
    }
    if (this.ended) return { value: undefined, done: true }
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject }
    })
  }
}

interface DshSessionState {
  session: ExternalAgentSession
  instructions?: SessionCreateOptions
  sentPreamble?: string
  queue?: EventQueue
  admitted?: boolean
  started?: boolean
  idle?: boolean
  terminal?: Extract<ExternalAgentEvent, { type: "done" }>
  usage?: ExternalAgentTokenUsage
  cleanup?: () => void
  messageId?: string
  consumedMessageIds?: Set<string>
}

/** One initialized SDK process; the public adapter below isolates conversations. */
export class DshSdkRuntimeAdapter extends BaseProtocolAdapter {
  readonly protocol = "dsh-sdk"

  private transport?: DshRuntimeTransport
  private readonly options: DshSdkClientAdapterOptions
  private readonly states = new Map<string, DshSessionState>()
  private readonly sessionParents = new Map<string, string>()

  constructor(options: DshSdkClientAdapterOptions) {
    super()
    this.options = options
  }

  async connect(config: ExternalAgentConfig): Promise<void> {
    if (this._connectionStatus === "connected" && this.transport?.isRunning()) return
    const previousTransport = this.transport
    this.transport = undefined
    if (previousTransport) {
      try {
        await previousTransport.close()
      } catch (error) {
        this.transport = previousTransport
        this._connectionStatus = "error"
        throw error
      }
    }
    this.forgetSessions()
    this._config = config
    this._connectionStatus = "connecting"
    const transport = this.options.createTransport(config)
    this.transport = transport
    try {
      await transport.start({
        onNotification: (notification) => {
          if (this.transport === transport) this.handleNotification(notification)
        },
        onClosed: (reason) => {
          if (this.transport === transport) this.handleClosed(reason)
        },
      })
      if (!transport.isRunning() || this.transport !== transport)
        throw new Error("DeepSeek Harness runtime closed during initialization")
    } catch (error) {
      this._connectionStatus = "error"
      this.transport = undefined
      try {
        await transport.close()
      } catch (cleanupError) {
        this.transport = transport
        throw new AggregateError(
          [error, cleanupError],
          "DeepSeek Harness initialization and runtime cleanup failed"
        )
      }
      throw error
    }
    this._connectionStatus = "connected"
  }

  async disconnect(): Promise<void> {
    const transport = this.transport
    this.transport = undefined
    this._connectionStatus = "disconnected"
    // Every live session dies with the process: the wire has no per-session
    // close, so sessions cannot outlive their runtime.
    for (const state of this.states.values()) {
      state.session.status = "closed"
      if (state.queue) {
        state.queue.push({
          type: "done",
          sessionId: state.session.id,
          timestamp: new Date(),
          success: false,
          stopReason: "cancelled",
        })
        state.queue.end()
        state.cleanup?.()
        state.queue = undefined
      }
    }
    this.sessionParents.clear()
    this.states.clear()
    this._sessions.clear()
    if (transport) {
      try {
        await transport.close()
      } catch (error) {
        this.transport = transport
        this._connectionStatus = "error"
        throw error
      }
    }
  }

  override forgetSessions(): void {
    for (const state of this.states.values()) {
      state.queue?.fail(new Error("DeepSeek Harness runtime session was forgotten"))
      state.cleanup?.()
    }
    this.states.clear()
    this.sessionParents.clear()
    super.forgetSessions()
  }

  async createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession> {
    if (!this.transport?.isRunning()) {
      throw new Error("DeepSeek Harness runtime is not connected.")
    }
    this.validateSessionOptions(options)
    const now = new Date()
    const session: ExternalAgentSession = {
      id: `dsh-${crypto.randomUUID()}`,
      agentId: this._config?.id ?? "deepseek-harness-sdk",
      status: "active",
      permissionMode: options?.permissionMode,
      allowedTools: options?.allowedTools,
      createdAt: now,
      lastActivityAt: now,
    }
    this.states.set(session.id, { session, instructions: options })
    this._sessions.set(session.id, session)
    return session
  }

  async closeSession(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId)
    if (!state) return
    if (state.queue) {
      await this.cancel(sessionId)
      return
    }
    state.session.status = "closed"
    this.states.delete(sessionId)
    this._sessions.delete(sessionId)
  }

  prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    const state = this.states.get(sessionId)
    if (!state) throw new Error(`Unknown DeepSeek Harness session: ${sessionId}`)
    const transport = this.transport
    if (!transport?.isRunning()) throw new Error("DeepSeek Harness runtime is not connected.")

    if (state.queue) throw new Error("DeepSeek Harness session already has a prompt in flight")
    this.validateSessionOptions({
      cwd: options?.workingDirectory,
      systemPrompt: options?.systemPrompt,
      instructionEnvelope: options?.instructionEnvelope,
      context: options?.context as Record<string, unknown> | undefined,
      allowedTools: options?.allowedTools,
      permissionMode: options?.permissionMode,
      metadata: { selectedModel: options?.model, reasoningEffort: options?.reasoningEffort },
    })
    if (options?.files?.length || options?.maxSteps) {
      throw new Error("DeepSeek Harness SDK cannot apply per-prompt files or maxSteps")
    }
    const preamble = sessionPreamble({
      ...state.instructions,
      ...(options?.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      ...(options?.instructionEnvelope === undefined
        ? {}
        : { instructionEnvelope: options.instructionEnvelope }),
      ...(options?.context === undefined
        ? {}
        : { context: options.context as Record<string, unknown> }),
      ...(options?.briefMode === undefined ? {} : { briefMode: options.briefMode }),
    })
    const contentBlocks = messageBlocks(message)
    if (preamble && preamble !== state.sentPreamble)
      contentBlocks.unshift({
        type: "text",
        text: `[Cognia session instructions]\n${preamble}\n[/Cognia session instructions]\n\n`,
      })
    const queue = new EventQueue()
    state.queue = queue
    state.admitted = false
    state.started = false
    state.idle = false
    state.terminal = undefined
    state.usage = undefined
    state.messageId = undefined
    state.consumedMessageIds = new Set()
    state.session.status = "executing"
    state.session.error = undefined
    state.session.lastActivityAt = new Date()
    const signal = options?.signal
    const onAbort = () => {
      void this.cancel(sessionId).catch((error: unknown) => queue.fail(asError(error)))
    }
    const timeout = options?.timeout ?? this._config?.timeout
    let timer: ReturnType<typeof setTimeout> | undefined
    state.cleanup = () => {
      signal?.removeEventListener("abort", onAbort)
      if (timer) clearTimeout(timer)
      state.cleanup = undefined
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else {
      if (timeout && timeout > 0)
        timer = setTimeout(() => {
          if (state.queue !== queue) return
          queue.push({
            type: "error",
            sessionId,
            timestamp: new Date(),
            error: "DeepSeek Harness execution timed out",
            recoverable: false,
          })
          onAbort()
        }, timeout)
      void transport
        .prompt(sessionId, contentBlocks)
        .then((messageId) => {
          if (state.queue !== queue) return
          if (!messageId) throw new Error("DeepSeek Harness prompt receipt is missing messageId")
          state.sentPreamble = preamble
          state.messageId = messageId
          state.admitted = true
          this.finishIfIdle(state)
        })
        .catch((error: unknown) => {
          if (state.queue !== queue) return
          state.session.status = "error"
          state.session.error = asError(error).message
          queue.fail(asError(error))
          state.cleanup?.()
          state.queue = undefined
          // A lost receipt may hide accepted work. Closing is the only way to
          // guarantee a rejected/timed-out request cannot continue off-screen.
          void this.disconnect().catch(() => undefined)
        })
    }
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<ExternalAgentEvent> => ({
        next: () => queue.next(),
        return: async () => {
          if (state.queue === queue) await this.cancel(sessionId)
          return { value: undefined, done: true }
        },
      }),
    }
  }

  /**
   * There is no permission request to answer on this transport.
   *
   * Reaching here means a caller believed the SDK channel could gate a tool
   * call. It cannot, and treating the response as applied would misreport the
   * session's authority, so this fails loudly.
   */
  async respondToPermission(_sessionId: string, _response: AcpPermissionResponse): Promise<void> {
    throw new Error(
      "The DeepSeek Harness SDK transport cannot carry permission requests: upstream " +
        "server-to-client requests are unimplemented. Authority for this channel is fixed " +
        "by the composition at launch. Use the ACP channel for per-call approval."
    )
  }

  /**
   * Cancel by closing the runtime.
   *
   * Upstream: "No mid-turn cancel -- the wire has no prompt-cancel method;
   * abandoning a turn means closing the runtime." In-flight work is reported as
   * interrupted rather than completed, so a cancelled turn is never mistaken
   * for a finished one.
   */
  async cancel(sessionId: string): Promise<void> {
    if (!this.states.has(sessionId)) return
    await this.disconnect()
  }

  private validateSessionOptions(options?: SessionCreateOptions): void {
    if (!options) return
    const workspace = this._config?.process?.env?.COGNIA_DSH_WORKSPACE ?? this._config?.process?.cwd
    const model = this._config?.process?.env?.COGNIA_DSH_MODEL ?? "deepseek-v4-flash"
    const effort = this._config?.process?.env?.COGNIA_DSH_REASONING_EFFORT
    const profile = this._config?.metadata?.dshProfileId
    const profileMode =
      profile === "cognia-sdk-readonly"
        ? "plan"
        : profile === "cognia-sdk-workspace"
          ? "acceptEdits"
          : "default"
    const context = options.context
    const custom = context?.custom as Record<string, unknown> | undefined
    const contextCwd = context?.workingDirectory ?? custom?.workingDirectory ?? custom?.cwd
    if (
      (options.cwd && options.cwd !== workspace) ||
      (contextCwd && contextCwd !== workspace) ||
      !matchesMounted(
        options.additionalDirectories,
        this._config?.process?.env?.COGNIA_DSH_ADDITIONAL_DIRECTORIES
      ) ||
      !matchesMounted(options.mcpServers, this._config?.process?.env?.COGNIA_DSH_MCP_SERVERS) ||
      !matchesMounted(custom?.mcpServers, this._config?.process?.env?.COGNIA_DSH_MCP_SERVERS) ||
      !matchesMounted(
        custom?.additionalDirectories,
        this._config?.process?.env?.COGNIA_DSH_ADDITIONAL_DIRECTORIES
      ) ||
      !matchesMounted(options.allowedTools, this._config?.process?.env?.COGNIA_DSH_ALLOWED_TOOLS) ||
      (options.permissionMode &&
        options.permissionMode !== "default" &&
        options.permissionMode !== profileMode) ||
      (options.metadata?.selectedModel && options.metadata.selectedModel !== model) ||
      (options.metadata?.reasoningEffort && options.metadata.reasoningEffort !== effort)
    ) {
      throw new Error(
        "DeepSeek Harness SDK fixes workspace, model, reasoning, tools and authority at process launch; per-session overrides are unsupported"
      )
    }
  }

  private handleNotification(notification: DshRawNotification): void {
    try {
      const result = translateDshNotification(notification)
      for (const warning of result.warnings) this.options.onCodecWarning?.(warning)
      const frame = notification as {
        method: string
        params: {
          sessionId?: string
          parentSessionId?: string
          childSessionId?: string
          status?: string
          event?: { type: string; data: Record<string, unknown> }
        }
      }
      const params = frame.params
      if (frame.method === "subagent.started" && params.childSessionId && params.parentSessionId)
        this.sessionParents.set(params.childSessionId, params.parentSessionId)
      const runtimeSessionId = params.sessionId ?? params.parentSessionId
      const state = this.resolveState(runtimeSessionId)
      if (!state?.queue) return
      // Descendant boundaries and answers must never complete or contaminate
      // the parent answer. Lineage is still projected as progress.
      if (runtimeSessionId !== state.session.id) {
        if (frame.method.startsWith("subagent.")) {
          for (const event of result.events)
            state.queue.push({ ...event, sessionId: state.session.id })
        }
        return
      }
      if (params.event?.type === "turn/start") {
        state.started = true
        state.idle = false
      }
      if (params.event?.type === "user/message" && typeof params.event.data.id === "string")
        state.consumedMessageIds?.add(params.event.data.id)
      if (frame.method === "session.status") {
        if (params.status === "running") state.idle = false
        if (params.status === "idle" && state.started) state.idle = true
      }
      for (const event of result.events) {
        if (event.type === "done") {
          // A later idle or goal continuation cannot turn a failure into success.
          if (!state.terminal || state.terminal.success) state.terminal = event
        } else {
          if (event.type === "message_end" && event.tokenUsage) {
            const total = state.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
            for (const key of [
              "promptTokens",
              "completionTokens",
              "totalTokens",
              "cacheReadTokens",
              "cacheWriteTokens",
              "reasoningTokens",
            ] as const) {
              if (event.tokenUsage[key] !== undefined)
                total[key] = (total[key] ?? 0) + event.tokenUsage[key]
            }
            state.usage = total
          }
          state.queue.push({ ...event, sessionId: state.session.id })
        }
      }
      state.session.lastActivityAt = new Date()
      this.finishIfIdle(state)
    } catch (error) {
      this.failAllSessions(asError(error))
      void this.transport?.close().catch(() => undefined)
    }
  }

  private finishIfIdle(state: DshSessionState): void {
    if (!state.queue || !state.admitted || !state.started || !state.idle) return
    const terminal = state.terminal
    if (!terminal) throw new Error("DeepSeek Harness became idle without a turn/end verdict")
    // Completed work must include the exact inbox identity we admitted.
    // Blocked/error turns can fail before consuming any user message.
    if (terminal.success && !state.consumedMessageIds?.has(state.messageId!))
      throw new Error("DeepSeek Harness completed without consuming the admitted prompt")
    state.queue.push({ ...terminal, tokenUsage: state.usage })
    state.queue.end()
    state.cleanup?.()
    state.queue = undefined
    state.session.status = terminal.success ? "idle" : "error"
    state.session.tokenUsage = state.usage
  }

  private resolveState(sessionId: string | undefined): DshSessionState | undefined {
    const seen = new Set<string>()
    while (sessionId && !seen.has(sessionId)) {
      const state = this.states.get(sessionId)
      if (state) return state
      seen.add(sessionId)
      sessionId = this.sessionParents.get(sessionId)
    }
    return undefined
  }

  private handleClosed(reason: string): void {
    this._connectionStatus = "disconnected"
    this.transport = undefined
    for (const state of this.states.values()) {
      if (state.session.status === "closed") continue
      state.session.status = "error"
      state.session.error = reason
      state.queue?.push({
        type: "error",
        sessionId: state.session.id,
        timestamp: new Date(),
        error: reason,
        recoverable: false,
      })
      state.queue?.end()
      state.cleanup?.()
      state.queue = undefined
    }
  }

  private failAllSessions(error: Error): void {
    this._connectionStatus = "error"
    for (const state of this.states.values()) {
      state.session.status = "error"
      state.session.error = error.message
      state.queue?.fail(error)
      state.cleanup?.()
      state.queue = undefined
    }
  }
}

/**
 * SDK MCP configuration is immutable at process startup. Each Cognia session
 * therefore owns a runtime, while discovery carries no conversation tools.
 * This also makes SDK process cancellation local to the requested conversation.
 */
export class DshSdkClientAdapter extends BaseProtocolAdapter {
  readonly protocol = "dsh-sdk"
  private readonly discovery: DshSdkRuntimeAdapter
  private readonly owners = new Map<string, DshSdkRuntimeAdapter>()
  private readonly children = new Set<DshSdkRuntimeAdapter>()
  private readonly disposals = new Map<DshSdkRuntimeAdapter, Promise<void>>()
  private readonly pending = new Set<Promise<unknown>>()
  private generation = 0
  private stopping?: Promise<void>

  constructor(private readonly options: DshSdkClientAdapterOptions) {
    super()
    this.discovery = new DshSdkRuntimeAdapter(options)
    this._capabilities = { mcpTools: true }
  }

  override get connectionStatus() {
    return this._connectionStatus === "connected"
      ? this.discovery.connectionStatus
      : this._connectionStatus
  }

  override isConnected() {
    return this.connectionStatus === "connected"
  }

  async connect(config: ExternalAgentConfig): Promise<void> {
    if (this.isConnected()) return
    const stopping = this.disconnect()
    const generation = this.generation
    await stopping
    if (generation !== this.generation) throw new Error("DeepSeek Harness connection cancelled")
    this._config = config
    this._connectionStatus = "connecting"
    const env = { ...config.process?.env }
    delete env.COGNIA_DSH_MCP_SERVERS
    delete env.COGNIA_DSH_MCP_CONFIGS
    const connecting = this.discovery.connect({ ...config, process: { ...config.process!, env } })
    this.pending.add(connecting)
    try {
      await connecting
      if (generation !== this.generation) throw new Error("DeepSeek Harness connection cancelled")
      this._connectionStatus = "connected"
    } catch (error) {
      if (generation === this.generation) this._connectionStatus = "error"
      throw error
    } finally {
      this.pending.delete(connecting)
    }
  }

  async disconnect(): Promise<void> {
    ++this.generation
    this._connectionStatus = "disconnected"
    if (this.stopping) return this.stopping
    this.stopping = (async () => {
      await Promise.allSettled([...this.pending])
      const results = await Promise.allSettled([
        this.discovery.disconnect(),
        ...[...this.children].map((child) => this.dispose(child)),
      ])
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      )
      if (failures.length) {
        this._connectionStatus = "error"
        throw new AggregateError(failures, "DeepSeek Harness runtime cleanup failed")
      }
    })()
    try {
      await this.stopping
    } finally {
      this.stopping = undefined
    }
  }

  private async dispose(child: DshSdkRuntimeAdapter): Promise<void> {
    const existing = this.disposals.get(child)
    if (existing) return existing
    const disposing = Promise.resolve().then(async () => {
      await child.disconnect()
      this.children.delete(child)
      for (const [id, owner] of this.owners) {
        if (owner !== child) continue
        this.owners.delete(id)
        this._sessions.delete(id)
      }
    })
    this.disposals.set(child, disposing)
    try {
      await disposing
    } finally {
      this.disposals.delete(child)
    }
  }

  createSession(options: SessionCreateOptions = {}): Promise<ExternalAgentSession> {
    if (!this.isConnected()) return Promise.reject(new Error("DeepSeek Harness is not connected"))
    const config = this._config!
    const custom = options.context?.custom as Record<string, unknown> | undefined
    const mcpServers = options.mcpServers ?? custom?.mcpServers ?? []
    const additionalDirectories =
      options.additionalDirectories ?? custom?.additionalDirectories ?? []
    const cwd = options.cwd ?? config.process?.env?.COGNIA_DSH_WORKSPACE ?? config.process?.cwd
    const childConfig: ExternalAgentConfig = {
      ...config,
      id: `${config.id}:dsh:${crypto.randomUUID()}`,
      process: {
        ...config.process!,
        cwd,
        restartOnCrash: false,
        keepAlive: false,
        env: {
          ...config.process?.env,
          ...(cwd ? { COGNIA_DSH_WORKSPACE: cwd } : {}),
          COGNIA_DSH_MCP_SERVERS: JSON.stringify(mcpServers),
          COGNIA_DSH_ADDITIONAL_DIRECTORIES: JSON.stringify(additionalDirectories),
          COGNIA_DSH_ALLOWED_TOOLS: JSON.stringify(options.allowedTools ?? []),
          ...(typeof options.metadata?.selectedModel === "string"
            ? { COGNIA_DSH_MODEL: options.metadata.selectedModel }
            : {}),
          ...(typeof options.metadata?.reasoningEffort === "string"
            ? { COGNIA_DSH_REASONING_EFFORT: options.metadata.reasoningEffort }
            : {}),
        },
      },
    }
    const child = new DshSdkRuntimeAdapter(this.options)
    this.children.add(child)
    const generation = this.generation
    const starting = (async () => {
      try {
        await child.connect(childConfig)
        if (generation !== this.generation) throw new Error("DeepSeek Harness session cancelled")
        const session = await child.createSession(options)
        if (generation !== this.generation) throw new Error("DeepSeek Harness session cancelled")
        session.agentId = config.id
        session.metadata = {
          cwd,
          additionalDirectories,
          cogniaSessionId: options.metadata?.cogniaSessionId,
          instructionEnvelope: options.instructionEnvelope,
        }
        this.owners.set(session.id, child)
        this._sessions.set(session.id, session)
        return session
      } catch (error) {
        try {
          await this.dispose(child)
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "DeepSeek Harness session startup and cleanup failed"
          )
        }
        throw error
      }
    })()
    this.pending.add(starting)
    void starting.then(
      () => this.pending.delete(starting),
      () => this.pending.delete(starting)
    )
    return starting
  }

  private owner(sessionId: string): DshSdkRuntimeAdapter {
    const child = this.owners.get(sessionId)
    if (!child) throw new Error(`Unknown DeepSeek Harness session: ${sessionId}`)
    return child
  }
  async closeSession(sessionId: string): Promise<void> {
    const child = this.owners.get(sessionId)
    if (child) await this.dispose(child)
  }
  cancel(sessionId: string): Promise<void> {
    return this.closeSession(sessionId)
  }
  prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ) {
    return this.owner(sessionId).prompt(sessionId, message, options)
  }
  respondToPermission(sessionId: string, response: AcpPermissionResponse) {
    return this.owner(sessionId).respondToPermission(sessionId, response)
  }
  override forgetSessions() {
    void this.disconnect().catch(() => {
      this._connectionStatus = "error"
    })
  }
  override getSession(sessionId: string) {
    const session = this.owners.get(sessionId)?.getSession(sessionId)
    return session?.status === "closed" ? undefined : session
  }
  override getSessions() {
    return [...this.owners.keys()].flatMap((id) => this.getSession(id) ?? [])
  }
  override async healthCheck() {
    for (const child of this.children) {
      if (!child.isConnected()) await this.dispose(child)
    }
    return this.isConnected()
  }
}

function matchesMounted(value: unknown, mounted?: string): boolean {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return true
  return Array.isArray(value) && JSON.stringify(value) === mounted
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Reject unsupported content before admission rather than silently truncating it. */
function messageBlocks(message: ExternalAgentMessage): DshPromptContentBlock[] {
  if (message.role !== "user")
    throw new Error("DeepSeek Harness SDK prompt requires a user message")
  const content = message.content
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!Array.isArray(content) || content.length === 0)
    throw new Error("DeepSeek Harness prompt requires content")
  return content.map((part): DshPromptContentBlock => {
    if (part.type === "text" && typeof part.text === "string")
      return { type: "text", text: part.text }
    if (
      part.type === "image" &&
      part.source?.type === "base64" &&
      part.source.data &&
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(part.source.mediaType)
    ) {
      return {
        type: "image",
        data: part.source.data,
        mimeType: part.source.mediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
      }
    }
    throw new Error(
      `DeepSeek Harness SDK does not support prompt content ${part.type}; use text or an inline raster image`
    )
  })
}

/** The SDK has no system-role input. Carry Cognia instructions explicitly as
 * user content, once per distinct instruction bundle; transport owns PII checks.
 * Unlike Pi's buildPiSystemPrompt this must not claim system-role authority or
 * import the unrelated Pi subprocess adapter into the SDK's module graph.
 */
function sessionPreamble(options: SessionCreateOptions): string {
  const envelope = options.instructionEnvelope
  const pieces = [
    options.systemPrompt,
    envelope?.developerInstructions,
    envelope?.customInstructions,
    envelope?.projectContextSummary,
    envelope?.skillsSummary,
    options.briefMode ? "Answer concisely." : undefined,
  ].filter((piece): piece is string => typeof piece === "string" && piece.trim().length > 0)
  const context = options.context
  if (context) {
    const { workingDirectory: _cwd, custom, ...semantic } = context
    const customContext =
      custom && typeof custom === "object" && !Array.isArray(custom)
        ? Object.fromEntries(
            Object.entries(custom).filter(
              ([key, value]) =>
                ![
                  "cwd",
                  "workingDirectory",
                  "additionalDirectories",
                  "mcpServers",
                  "traceId",
                  "spanId",
                  "parentSpanId",
                  "sessionId",
                  "turnId",
                ].includes(key) && value !== undefined
            )
          )
        : undefined
    const payload = {
      ...semantic,
      ...(customContext && Object.keys(customContext).length > 0 ? { custom: customContext } : {}),
    }
    if (Object.keys(payload).length > 0) pieces.push(`Task context: ${JSON.stringify(payload)}`)
  }
  return pieces.join("\n\n")
}
