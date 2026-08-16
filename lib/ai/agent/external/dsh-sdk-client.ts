import type {
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentSession,
} from "@/types/agent/external-agent"

import {
  DshVersionDriftError,
  translateDshNotification,
  type DshCodecWarning,
} from "./dsh-session-event-codec"
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
 * Implemented over `@deepseek-ai/dsh-sdk-client`'s `HarnessClient` in Node,
 * Tauri, and headless hosts. `close()` maps to that client's own
 * `shutdown` -> stdin-EOF -> SIGTERM -> SIGKILL ladder, which is why this
 * adapter does not implement a kill gradient of its own.
 */
export interface DshRuntimeTransport {
  start(handlers: DshRuntimeTransportHandlers): Promise<void>
  /** Enqueue a prompt. Resolves with the inbox-admission message id. */
  prompt(sessionId: string, text: string): Promise<string>
  close(): Promise<void>
  isRunning(): boolean
}

export interface DshSdkClientAdapterOptions {
  /** Builds a transport for a given agent config. */
  createTransport: (config: ExternalAgentConfig) => DshRuntimeTransport
  /** Bounded sink for codec warnings; defaults to dropping them. */
  onCodecWarning?: (warning: DshCodecWarning) => void
}

/** Bounded queue bridging pushed notifications to a pulled async iterator. */
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
  queue?: EventQueue
}

export class DshSdkClientAdapter extends BaseProtocolAdapter {
  readonly protocol = "dsh-sdk"

  private transport?: DshRuntimeTransport
  private readonly options: DshSdkClientAdapterOptions
  private readonly states = new Map<string, DshSessionState>()
  private sessionCounter = 0

  constructor(options: DshSdkClientAdapterOptions) {
    super()
    this.options = options
  }

  async connect(config: ExternalAgentConfig): Promise<void> {
    if (this.transport?.isRunning()) return
    this._config = config
    this._connectionStatus = "connecting"
    const transport = this.options.createTransport(config)
    try {
      await transport.start({
        onNotification: (notification) => this.handleNotification(notification),
        onClosed: (reason) => this.handleClosed(reason),
      })
    } catch (error) {
      this._connectionStatus = "error"
      throw error
    }
    this.transport = transport
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
      state.queue?.end()
    }
    this.states.clear()
    this._sessions.clear()
    if (transport) await transport.close()
  }

  async createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession> {
    if (!this.transport?.isRunning()) {
      throw new Error("DeepSeek Harness runtime is not connected.")
    }
    this.sessionCounter += 1
    const now = new Date()
    const session: ExternalAgentSession = {
      id: `dsh-${this.sessionCounter}`,
      agentId: this._config?.id ?? "deepseek-harness-sdk",
      status: "active",
      permissionMode: options?.permissionMode,
      allowedTools: options?.allowedTools,
      createdAt: now,
      lastActivityAt: now,
    }
    this.states.set(session.id, { session })
    this._sessions.set(session.id, session)
    return session
  }

  async closeSession(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId)
    if (!state) return
    state.session.status = "closed"
    state.queue?.end()
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

    const queue = new EventQueue()
    state.queue = queue
    state.session.status = "active"
    state.session.lastActivityAt = new Date()

    const text = messageText(message)
    void transport.prompt(sessionId, text).catch((error: unknown) => {
      queue.fail(error instanceof Error ? error : new Error(String(error)))
    })

    // The caller's AbortSignal cannot cancel one turn on this transport, so it
    // closes the runtime. Silently ignoring it would leave the model working
    // after the user asked it to stop.
    const signal = options?.signal
    const onAbort = () => {
      void this.cancel(sessionId)
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    return {
      [Symbol.asyncIterator]: (): AsyncIterator<ExternalAgentEvent> => ({
        next: () => queue.next(),
        return: async () => {
          signal?.removeEventListener("abort", onAbort)
          queue.end()
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
    const state = this.states.get(sessionId)
    if (state) {
      state.session.status = "closed"
      state.queue?.push({
        type: "done",
        sessionId,
        timestamp: new Date(),
        success: false,
        stopReason: "cancelled",
      })
      state.queue?.end()
    }
    await this.disconnect()
  }

  private handleNotification(notification: DshRawNotification): void {
    let events: ExternalAgentEvent[]
    let warnings: DshCodecWarning[]
    try {
      const result = translateDshNotification(notification)
      events = result.events
      warnings = result.warnings
    } catch (error) {
      if (error instanceof DshVersionDriftError) {
        // The installed channel no longer matches the codec, so nothing after
        // this frame can be trusted to mean what we assume. Fail the session
        // rather than silently dropping events.
        this.failAllSessions(error)
        return
      }
      throw error
    }

    for (const warning of warnings) this.options.onCodecWarning?.(warning)
    if (events.length === 0) return

    const sessionId = notificationSessionId(notification)
    const state = this.resolveState(sessionId)
    if (!state?.queue) return

    for (const event of events) {
      state.queue.push({ ...event, sessionId: state.session.id })
    }
    state.session.lastActivityAt = new Date()
  }

  /**
   * Map a runtime-side session id onto a Cognia session.
   *
   * DSH notifies for every session in the runtime, unfiltered, and generates
   * its own ids. Cognia runs one prompt at a time per runtime, so the single
   * session with a live queue is the addressee; the id is used only to keep
   * that unambiguous if more than one is ever open.
   */
  private resolveState(_runtimeSessionId: string | undefined): DshSessionState | undefined {
    for (const state of this.states.values()) {
      if (state.queue) return state
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
    }
  }

  private failAllSessions(error: Error): void {
    for (const state of this.states.values()) {
      state.session.status = "error"
      state.session.error = error.message
      state.queue?.fail(error)
    }
  }
}

function messageText(message: ExternalAgentMessage): string {
  const content = message.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
          ? part.text
          : ""
      )
      .join("")
  }
  return ""
}

function notificationSessionId(notification: unknown): string | undefined {
  if (typeof notification !== "object" || notification === null) return undefined
  const params = (notification as { params?: unknown }).params
  if (typeof params !== "object" || params === null) return undefined
  const sessionId = (params as { sessionId?: unknown }).sessionId
  return typeof sessionId === "string" ? sessionId : undefined
}
