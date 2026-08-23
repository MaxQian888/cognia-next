import { CLIENT_CAPABILITIES } from "./capabilities"
import {
  ConnectionLostError,
  IncompatibleHostError,
  IndeterminateCommandError,
  ReconnectFailedError,
  RpcError,
} from "./errors"
import { HostNotFoundError } from "./host-errors"
import type { CogniaHostOption, OpenHostResult } from "./host"
import type { RpcReadable, RpcWritable } from "./rpc/duplex"
import { RpcPeer } from "./rpc/peer"
import {
  RPC_PROTOCOL_VERSION,
  isRetryableMethod,
  type RpcMethod,
  type RpcMethodMap,
} from "./rpc/protocol"
import type {
  AgentEventEnvelope,
  CogniaDiagnostic,
  InitializeResult,
  ProtocolLimits,
} from "./types"
import { SDK_PACKAGE_NAME, SDK_VERSION } from "./version"

export interface ReconnectPolicy {
  /** Off by default only for a `streams` host with no `factory`. */
  enabled: boolean
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  enabled: true,
  maxAttempts: 5,
  initialDelayMs: 250,
  maxDelayMs: 8_000,
}

export interface ConnectionHooks {
  onAgentEvent(sessionId: string, envelope: AgentEventEnvelope): void
  onTraceEvent(subscriptionId: string, span: Record<string, unknown>): void
  onDiagnostic(diagnostic: CogniaDiagnostic): void
  invokeTool(
    params: Record<string, unknown>
  ): Promise<{ ok: boolean; output?: unknown; error?: Record<string, unknown> }>
  invokeHook(
    params: Record<string, unknown>
  ): Promise<{ ok: boolean; output?: unknown; error?: Record<string, unknown> }>
  /**
   * Rebuild everything the host forgot when it died: tool and hook handlers,
   * session handles, trace subscriptions. Runs before any queued caller is
   * released onto the new peer.
   */
  onReattach(info: InitializeResult): Promise<void>
  /** Reconnection is over and the client is unusable. */
  onGiveUp(error: Error): void
}

export interface ConnectionOptions {
  host?: CogniaHostOption
  requestTimeoutMs: number
  client?: { name?: string; version?: string }
  reconnect?: Partial<ReconnectPolicy>
  hooks: ConnectionHooks
  /** Injected in tests; real callers get `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
}

interface ActiveTransport {
  peer: RpcPeer
  close(): Promise<void>
  searchedLocations: readonly string[]
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

function normalizeLimits(raw: Record<string, unknown>): ProtocolLimits {
  const read = (key: keyof ProtocolLimits, fallback: number): number => {
    const value = raw[key]
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
  }
  return {
    maxOpenSessions: read("maxOpenSessions", 32),
    maxActiveTurns: read("maxActiveTurns", 8),
    maxFrameBytes: read("maxFrameBytes", 16 * 1024 * 1024),
    maxReplayEvents: read("maxReplayEvents", 10_000),
    maxOutboundBufferBytes: read("maxOutboundBufferBytes", 32 * 1024 * 1024),
  }
}

/**
 * Owns the transport to the host, the handshake, and the reconnect state
 * machine, so that every API surface above it can call `connection.call(...)`
 * without knowing which peer instance is currently live.
 *
 * The reconnect contract is deliberately narrow: the SDK re-establishes the
 * *connection* and the *registrations*, and it never re-sends a command whose
 * outcome it does not know. Those callers get an `IndeterminateCommandError`
 * naming the command id so they can decide — the host's receipt table makes a
 * retry under the same id idempotent, which is a decision only the caller has
 * the context to take.
 */
export class HostConnection {
  private transport!: ActiveTransport
  private initialized!: InitializeResult
  private limits!: ProtocolLimits
  private reconnecting: Promise<void> | null = null
  private readonly policy: ReconnectPolicy
  private readonly sleep: (ms: number) => Promise<void>
  private closed = false
  private generation = 0

  private constructor(private readonly options: ConnectionOptions) {
    const streamsWithoutFactory =
      options.host?.kind === "streams" && typeof options.host.factory !== "function"
    this.policy = {
      ...DEFAULT_RECONNECT_POLICY,
      ...options.reconnect,
      // A caller-supplied stream pair cannot be rebuilt without a factory, so
      // reconnection is not merely disabled — it is impossible.
      ...(streamsWithoutFactory && options.reconnect?.enabled !== true ? { enabled: false } : {}),
    }
    this.sleep = options.sleep ?? defaultSleep
  }

  static async open(options: ConnectionOptions): Promise<HostConnection> {
    const connection = new HostConnection(options)
    await connection.connect(true)
    return connection
  }

  get info(): InitializeResult {
    return this.initialized
  }

  get negotiatedLimits(): ProtocolLimits {
    return this.limits
  }

  get reconnectEnabled(): boolean {
    return this.policy.enabled
  }

  async call<Method extends RpcMethod>(
    method: Method,
    params: RpcMethodMap[Method]["params"],
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<RpcMethodMap[Method]["result"]> {
    if (this.closed) throw new ConnectionLostError("the Cognia client is closed")
    if (this.reconnecting) await this.reconnecting

    const generationAtCall = this.generation
    try {
      return await this.transport.peer.call(method, params, options)
    } catch (error) {
      if (!isTransportFailure(error) || this.closed) throw error

      const recovered = await this.recover(generationAtCall)
      if (!recovered) throw error

      if (isRetryableMethod(method)) {
        return await this.transport.peer.call(method, params, options)
      }
      throw indeterminate(method, params, error)
    }
  }

  async notify<Method extends RpcMethod>(
    method: Method,
    params: RpcMethodMap[Method]["params"]
  ): Promise<void> {
    if (this.closed) throw new ConnectionLostError("the Cognia client is closed")
    await this.transport.peer.notify(method, params)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.transport.peer.close()
    await this.transport.close()
  }

  /**
   * Reconnect once per generation.
   *
   * Concurrent callers that all hit the same dropped transport must not each
   * spawn their own reconnect: they wait on the one in flight and then see the
   * generation they were handed is stale, which is the signal to retry or to
   * report the outcome as unknown.
   */
  private async recover(generationAtCall: number): Promise<boolean> {
    if (this.generation > generationAtCall) return true
    if (!this.policy.enabled) return false
    if (this.reconnecting) {
      await this.reconnecting
      return this.generation > generationAtCall && !this.closed
    }
    this.reconnecting = this.reconnectLoop()
    try {
      await this.reconnecting
    } finally {
      this.reconnecting = null
    }
    return this.generation > generationAtCall && !this.closed
  }

  private async reconnectLoop(): Promise<void> {
    let delay = this.policy.initialDelayMs
    let lastError: unknown
    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt += 1) {
      if (this.closed) return
      try {
        await this.transport.close()
      } catch {
        // The old transport is already gone; that is the condition we are in.
      }
      try {
        await this.connect(false)
        this.options.hooks.onDiagnostic({
          level: "info",
          code: "host_reconnected",
          message: `reconnected to the Cognia host after ${attempt} attempt(s)`,
        })
        await this.options.hooks.onReattach(this.initialized)
        return
      } catch (error) {
        lastError = error
        this.options.hooks.onDiagnostic({
          level: "warn",
          code: "host_reconnect_attempt_failed",
          message: `reconnect attempt ${attempt}/${this.policy.maxAttempts} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        })
        if (attempt < this.policy.maxAttempts) {
          await this.sleep(delay)
          delay = Math.min(delay * 2, this.policy.maxDelayMs)
        }
      }
    }
    const failure = new ReconnectFailedError(this.policy.maxAttempts, lastError)
    this.closed = true
    this.options.hooks.onGiveUp(failure)
    throw failure
  }

  private async connect(first: boolean): Promise<void> {
    const opened = await this.openTransport(first)
    const peer = new RpcPeer({
      readable: opened.readable as unknown as RpcReadable,
      writable: opened.writable as unknown as RpcWritable,
    })
    this.wire(peer)
    this.transport = {
      peer,
      close: opened.close,
      searchedLocations: opened.searchedLocations,
    }

    try {
      const handshake = peer.call(
        "initialize",
        {
          client: {
            name: this.options.client?.name ?? SDK_PACKAGE_NAME,
            version: this.options.client?.version ?? SDK_VERSION,
          },
          protocolVersions: [RPC_PROTOCOL_VERSION],
          capabilities: [...CLIENT_CAPABILITIES],
          limits: {},
        },
        { timeoutMs: opened.startupTimeoutMs }
      )
      const result = await (opened.startupFailure
        ? Promise.race([handshake, opened.startupFailure])
        : handshake)
      if (result.protocolVersion !== RPC_PROTOCOL_VERSION) {
        throw new IncompatibleHostError(result.protocolVersion, [RPC_PROTOCOL_VERSION])
      }
      this.initialized = result as unknown as InitializeResult
      this.limits = normalizeLimits(result.limits)
      peer.applyLimits(this.limits)
      await peer.notify("initialized", {})
      // Only now is this peer usable. Advancing earlier would let `recover()`
      // read a failed handshake as a successful reconnect.
      this.generation += 1
    } catch (error) {
      peer.close(error instanceof Error ? error : new Error(String(error)))
      await opened.close()
      if (first && (error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HostNotFoundError(opened.searchedLocations)
      }
      throw error
    }
  }

  private async openTransport(
    first: boolean
  ): Promise<OpenHostResult | (OpenHostResult & { startupFailure?: Promise<never> })> {
    const host = this.options.host
    if (host?.kind === "streams") {
      // The caller's own streams are used for the first connect; the factory
      // exists to replace them once they are gone, not to bypass them.
      const useFactory = !first && typeof host.factory === "function"
      const streams = useFactory ? await host.factory!() : host
      return {
        readable: streams.readable,
        writable: streams.writable,
        startupTimeoutMs: 15_000,
        searchedLocations: [useFactory ? "stream factory" : "injected streams"],
        async close() {},
      }
    }
    const { openHost } = await import("./host")
    return openHost(host, (diagnostic) => this.options.hooks.onDiagnostic(diagnostic))
  }

  private wire(peer: RpcPeer): void {
    peer.onNotification("agent/event", (params) => {
      const sessionId = params.sessionId
      const envelope = params.envelope
      if (typeof sessionId !== "string" || !envelope || typeof envelope !== "object") return
      this.options.hooks.onAgentEvent(sessionId, envelope as AgentEventEnvelope)
    })
    peer.onNotification("runtime/diagnostic", (params) => {
      this.options.hooks.onDiagnostic(params as unknown as CogniaDiagnostic)
    })
    peer.onNotification("trace/event", (params) => {
      if (typeof params.subscriptionId !== "string") return
      if (!params.span || typeof params.span !== "object") return
      this.options.hooks.onTraceEvent(params.subscriptionId, params.span as Record<string, unknown>)
    })
    peer.handle("client/tool/invoke", (params) =>
      this.options.hooks.invokeTool(params as unknown as Record<string, unknown>)
    )
    peer.handle("client/hook/invoke", (params) =>
      this.options.hooks.invokeHook(params as unknown as Record<string, unknown>)
    )
  }
}

/** A failure that means "the transport is gone", not "the host said no". */
export function isTransportFailure(error: unknown): boolean {
  if (error instanceof ConnectionLostError) return true
  if (error instanceof RpcError) return error.code === "connection_lost"
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED"
  }
  return false
}

function indeterminate(method: string, params: unknown, cause: unknown): IndeterminateCommandError {
  const record = (params ?? {}) as Record<string, unknown>
  const commandId = typeof record.commandId === "string" ? record.commandId : "unknown"
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined
  return new IndeterminateCommandError({
    commandId,
    method,
    ...(sessionId !== undefined ? { sessionId } : {}),
    cause,
  })
}
