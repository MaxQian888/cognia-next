import { HostNotFoundError } from "./host-errors"
import type { CogniaHostOption, OpenHostResult } from "./host"
import { randomUUID } from "./ids"
import type { RpcReadable, RpcWritable } from "./rpc/duplex"
import { RpcError, RpcPeer } from "./rpc/peer"
import { RPC_ERROR_CODES, RPC_PROTOCOL_VERSION, type RpcMethodMap } from "./rpc/protocol"
import type {
  AgentEventEnvelope,
  AgentInput,
  AgentPermissionMode,
  AgentTurnOutcome,
  AuditPage,
  CanonicalSession,
  CanonicalTurn,
  ClientHookHandler,
  ClientHookRegistration,
  ClientInvocationContext,
  ClientToolHandler,
  ClientToolRegistration,
  CloneOptions,
  CogniaDiagnostic,
  CommandOptions,
  CommandReceipt,
  CompactOptions,
  CompactionResult,
  ElicitationResponse,
  ExternalToolResponse,
  EntryPage,
  EntryPageOptions,
  ForkOptions,
  InitializeResult,
  PermissionDecision,
  ResolvedAgentExecutionSpec,
  RunOptions,
  SandboxSnapshot,
  SandboxStatus,
  SessionCreateOptions,
  SessionState,
  SessionSummary,
  ThinkingLevel,
  WaitOptions,
} from "./types"

export { HostNotFoundError, RpcError }

export interface CogniaClientOptions {
  host?: CogniaHostOption
  requestTimeoutMs?: number
  onDiagnostic?: (diagnostic: CogniaDiagnostic) => void
  client?: { name?: string; version?: string }
}

export class IncompatibleHostError extends Error {
  readonly code = "incompatible_host"
  readonly hostProtocolVersion: number
  readonly supportedProtocolVersions = [RPC_PROTOCOL_VERSION] as const

  constructor(hostProtocolVersion: number) {
    super(
      `host selected protocol v${hostProtocolVersion}; this SDK supports v${RPC_PROTOCOL_VERSION}`
    )
    this.name = "IncompatibleHostError"
    this.hostProtocolVersion = hostProtocolVersion
  }
}

export interface RuntimeApi {
  readonly info: InitializeResult
  status(): Promise<Record<string, unknown>>
  capabilities(): Promise<{ methods: readonly string[]; capabilities: readonly string[] }>
}

export interface ModelApi {
  list(): Promise<readonly unknown[]>
  refresh(): Promise<readonly unknown[]>
}

export interface SessionApi {
  create(options?: SessionCreateOptions): Promise<CogniaSession>
  open(sessionId: string): Promise<CogniaSession>
  list(): Promise<readonly SessionSummary[]>
  import(session: CanonicalSession): Promise<CogniaSession>
  tree(sessionId: string): Promise<readonly unknown[]>
}

export interface AuthApi {
  status(): Promise<Record<string, unknown>>
}

export interface McpApi {
  configure(servers: readonly Record<string, unknown>[]): Promise<Record<string, unknown>>
  status(): Promise<Record<string, unknown>>
}

export interface PluginApi {
  reload(pluginId?: string): Promise<Record<string, unknown>>
}

export interface SkillApi {
  reload(skillId?: string): Promise<Record<string, unknown>>
}

export interface TaskApi {
  list(sessionId?: string): Promise<readonly unknown[]>
  stop(taskId: string, options?: CommandOptions): Promise<CommandReceipt>
  background(taskId: string, options?: CommandOptions): Promise<CommandReceipt>
}

export interface TraceApi {
  subscribe(sessionId?: string): Promise<AsyncIterable<Record<string, unknown>>>
  export(options?: { sessionId?: string; format?: string }): Promise<Record<string, unknown>>
}

export interface AuditApi {
  query(options?: { sessionId?: string; cursor?: string; limit?: number }): Promise<AuditPage>
}

export interface ToolApi {
  register(registration: ClientToolRegistration, handler: ClientToolHandler): Promise<void>
  unregister(handlerId: string): Promise<void>
}

export interface HookApi {
  register(registration: ClientHookRegistration, handler: ClientHookHandler): Promise<void>
  unregister(handlerId: string): Promise<void>
}

export interface CogniaClient extends AsyncDisposable {
  readonly runtime: RuntimeApi
  readonly models: ModelApi
  readonly auth: AuthApi
  readonly sessions: SessionApi
  readonly tools: ToolApi
  readonly hooks: HookApi
  readonly mcp: McpApi
  readonly plugins: PluginApi
  readonly skills: SkillApi
  readonly tasks: TaskApi
  readonly traces: TraceApi
  readonly audit: AuditApi
  close(): Promise<void>
}

export interface CogniaSession extends AsyncDisposable {
  readonly id: string
  readonly spec: ResolvedAgentExecutionSpec
  run(input: AgentInput, options?: RunOptions): Promise<AgentTurnOutcome>
  events(options?: {
    afterEventId?: string
    signal?: AbortSignal
  }): AsyncIterable<AgentEventEnvelope>
  steer(input: AgentInput, options?: CommandOptions): Promise<CommandReceipt>
  followUp(input: AgentInput, options?: CommandOptions): Promise<CommandReceipt>
  abort(options?: CommandOptions): Promise<CommandReceipt>
  waitForIdle(options?: WaitOptions): Promise<SessionState>
  resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    options?: CommandOptions
  ): Promise<CommandReceipt>
  resolveElicitation(
    requestId: string,
    response: ElicitationResponse,
    options?: CommandOptions
  ): Promise<CommandReceipt>
  resolveExternalTool(
    requestId: string,
    response: ExternalToolResponse,
    options?: CommandOptions
  ): Promise<CommandReceipt>
  rename(name: string, options?: CommandOptions): Promise<CommandReceipt>
  tag(tags: readonly string[], options?: CommandOptions): Promise<CommandReceipt>
  delete(options?: CommandOptions): Promise<CommandReceipt>
  setModel(model: string, options?: CommandOptions): Promise<CommandReceipt>
  setThinking(level: ThinkingLevel, options?: CommandOptions): Promise<CommandReceipt>
  setPermissionMode(mode: AgentPermissionMode, options?: CommandOptions): Promise<CommandReceipt>
  compact(options?: CompactOptions): Promise<CompactionResult>
  undoCompact(boundaryId: string, options?: CommandOptions): Promise<CommandReceipt>
  fork(options?: ForkOptions): Promise<CogniaSession>
  clone(options?: CloneOptions): Promise<CogniaSession>
  state(): Promise<SessionState>
  messages(): Promise<CanonicalTurn[]>
  entries(options?: EntryPageOptions): Promise<EntryPage>
  export(): Promise<CanonicalSession>
  tree(): Promise<readonly unknown[]>
  sandboxStatus(): Promise<SandboxStatus>
  snapshot(options?: CommandOptions): Promise<SandboxSnapshot>
  restoreSnapshot(snapshotId: string, options?: CommandOptions): Promise<CommandReceipt>
  close(): Promise<void>
}

type EventWaiter = (result: IteratorResult<AgentEventEnvelope>) => void

type SessionCommandMethod =
  | "turn/steer"
  | "turn/followUp"
  | "turn/abort"
  | "permission/respond"
  | "elicitation/respond"
  | "externalTool/respond"
  | "session/rename"
  | "session/tag"
  | "session/delete"
  | "session/model/set"
  | "session/thinking/set"
  | "session/permissionMode/set"
  | "session/compact"
  | "session/compact/undo"
  | "session/close"
  | "sandbox/snapshot"
  | "sandbox/restore"

type SessionCommandResult<Method extends SessionCommandMethod> = Method extends "session/compact"
  ? CompactionResult
  : Method extends "sandbox/snapshot"
    ? SandboxSnapshot
    : CommandReceipt

class SessionEventChannel {
  private readonly queue: AgentEventEnvelope[] = []
  private readonly waiters: EventWaiter[] = []
  private readonly seenEventIds = new Set<string>()
  private closed = false

  push(envelope: AgentEventEnvelope): void {
    if (this.closed || this.seenEventIds.has(envelope.eventId)) return
    this.seenEventIds.add(envelope.eventId)
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value: envelope })
    else this.queue.push(envelope)
  }

  iterate(signal?: AbortSignal): AsyncIterable<AgentEventEnvelope> {
    const queue = this.queue
    const waiters = this.waiters
    const isClosed = () => this.closed
    return {
      [Symbol.asyncIterator]() {
        let done = signal?.aborted ?? false
        let pendingWaiter: EventWaiter | undefined
        const onAbort = () => {
          done = true
          if (pendingWaiter) {
            const index = waiters.indexOf(pendingWaiter)
            if (index >= 0) waiters.splice(index, 1)
            pendingWaiter({ done: true, value: undefined })
            pendingWaiter = undefined
          }
        }
        signal?.addEventListener("abort", onAbort, { once: true })

        return {
          async next(): Promise<IteratorResult<AgentEventEnvelope>> {
            if (done || isClosed()) return { done: true, value: undefined }
            const next = queue.shift()
            if (next) return { done: false, value: next }
            return new Promise<IteratorResult<AgentEventEnvelope>>((resolve) => {
              pendingWaiter = (result) => {
                pendingWaiter = undefined
                resolve(result)
              }
              waiters.push(pendingWaiter)
            })
          },
          async return(): Promise<IteratorResult<AgentEventEnvelope>> {
            onAbort()
            signal?.removeEventListener("abort", onAbort)
            return { done: true, value: undefined }
          },
        }
      },
    }
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }
}

class TraceEventChannel {
  private readonly queue: Record<string, unknown>[] = []
  private readonly waiters: Array<(result: IteratorResult<Record<string, unknown>>) => void> = []
  private closed = false

  push(span: Record<string, unknown>): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value: span })
    else this.queue.push(span)
  }

  iterate(): AsyncIterable<Record<string, unknown>> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (this.closed) return { done: true, value: undefined }
          const next = this.queue.shift()
          if (next) return { done: false, value: next }
          return new Promise<IteratorResult<Record<string, unknown>>>((resolve) => {
            this.waiters.push(resolve)
          })
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    }
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }
}

class CogniaSessionImpl implements CogniaSession {
  private closed = false

  constructor(
    readonly id: string,
    readonly spec: ResolvedAgentExecutionSpec,
    private readonly peer: RpcPeer,
    private readonly eventChannel: SessionEventChannel,
    private readonly removeFromClient: () => void,
    private readonly requestTimeoutMs: number,
    private readonly materialize: (
      sessionId: string,
      spec: ResolvedAgentExecutionSpec
    ) => CogniaSession
  ) {}

  async run(input: AgentInput, options: RunOptions = {}): Promise<AgentTurnOutcome> {
    this.assertOpen()
    if (options.signal?.aborted) {
      await this.abort({ commandId: options.commandId }).catch(() => undefined)
      throw new RpcError(RPC_ERROR_CODES.cancelled, "cancelled")
    }
    const onAbort = () => void this.abort({ commandId: options.commandId }).catch(() => undefined)
    options.signal?.addEventListener("abort", onAbort, { once: true })
    try {
      return (await this.peer.call(
        "turn/run",
        {
          sessionId: this.id,
          input,
          commandId: options.commandId ?? randomUUID(),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
          ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
          ...(options.includeDiagnostics !== undefined
            ? { includeDiagnostics: options.includeDiagnostics }
            : {}),
        },
        { signal: options.signal }
      )) as unknown as AgentTurnOutcome
    } finally {
      options.signal?.removeEventListener("abort", onAbort)
    }
  }

  events(
    options: { afterEventId?: string; signal?: AbortSignal } = {}
  ): AsyncIterable<AgentEventEnvelope> {
    this.assertOpen()
    if (options.afterEventId) {
      void this.entries({ afterEventId: options.afterEventId }).then((page) => {
        for (const entry of page.entries) this.eventChannel.push(entry.envelope)
      })
    }
    return this.eventChannel.iterate(options.signal)
  }

  steer(input: AgentInput, options?: CommandOptions): Promise<CommandReceipt> {
    return this.command("turn/steer", { input }, options)
  }

  followUp(input: AgentInput, options?: CommandOptions): Promise<CommandReceipt> {
    return this.command("turn/followUp", { input }, options)
  }

  abort(options?: CommandOptions): Promise<CommandReceipt> {
    return this.command("turn/abort", {}, options)
  }

  async waitForIdle(options: WaitOptions = {}): Promise<SessionState> {
    this.assertOpen()
    return (await this.peer.call(
      "turn/wait",
      { sessionId: this.id, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
      { signal: options.signal, timeoutMs: options.timeoutMs }
    )) as unknown as SessionState
  }

  resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    options?: CommandOptions
  ): Promise<CommandReceipt> {
    return this.command("permission/respond", { requestId, decision }, options)
  }

  resolveElicitation(
    requestId: string,
    response: ElicitationResponse,
    options?: CommandOptions
  ): Promise<CommandReceipt> {
    return this.command("elicitation/respond", { requestId, response }, options)
  }

  resolveExternalTool(
    requestId: string,
    response: ExternalToolResponse,
    options?: CommandOptions
  ): Promise<CommandReceipt> {
    return this.command("externalTool/respond", { requestId, response }, options)
  }

  rename(name: string, options?: CommandOptions): Promise<CommandReceipt> {
    return this.command("session/rename", { name }, options)
  }

  tag(tags: readonly string[], options?: CommandOptions): Promise<CommandReceipt> {
    return this.command("session/tag", { tags: [...tags] }, options)
  }

  async delete(options?: CommandOptions): Promise<CommandReceipt> {
    const response = await this.command("session/delete", {}, options)
    this.closed = true
    this.eventChannel.close()
    this.removeFromClient()
    return response
  }

  setModel(model: string, options?: CommandOptions): Promise<CommandReceipt> {
    return this.command("session/model/set", { model }, options)
  }

  setThinking(level: ThinkingLevel, options?: CommandOptions): Promise<CommandReceipt> {
    return this.command("session/thinking/set", { level }, options)
  }

  setPermissionMode(mode: AgentPermissionMode, options?: CommandOptions): Promise<CommandReceipt> {
    return this.command("session/permissionMode/set", { mode }, options)
  }

  compact(options: CompactOptions = {}): Promise<CompactionResult> {
    return this.command("session/compact", { instructions: options.instructions }, options)
  }

  undoCompact(boundaryId: string, options?: CommandOptions): Promise<CommandReceipt> {
    return this.command("session/compact/undo", { boundaryId }, options)
  }

  async fork(options: ForkOptions = {}): Promise<CogniaSession> {
    this.assertOpen()
    const result = await this.peer.call(
      "session/fork",
      {
        sessionId: this.id,
        commandId: options.commandId ?? randomUUID(),
        ...(options.turnId ? { turnId: options.turnId } : {}),
        ...(options.name ? { name: options.name } : {}),
      },
      this.callOptions(options)
    )
    return this.materialize(result.sessionId, result.spec as unknown as ResolvedAgentExecutionSpec)
  }

  async clone(options: CloneOptions = {}): Promise<CogniaSession> {
    this.assertOpen()
    const result = await this.peer.call(
      "session/clone",
      {
        sessionId: this.id,
        commandId: options.commandId ?? randomUUID(),
        ...(options.name ? { name: options.name } : {}),
      },
      this.callOptions(options)
    )
    return this.materialize(result.sessionId, result.spec as unknown as ResolvedAgentExecutionSpec)
  }

  async state(): Promise<SessionState> {
    this.assertOpen()
    return (await this.peer.call(
      "session/state",
      { sessionId: this.id },
      this.callOptions()
    )) as SessionState
  }

  async messages(): Promise<CanonicalTurn[]> {
    this.assertOpen()
    const result = await this.peer.call(
      "session/messages",
      { sessionId: this.id },
      this.callOptions()
    )
    return result.messages as CanonicalTurn[]
  }

  async entries(options: EntryPageOptions = {}): Promise<EntryPage> {
    this.assertOpen()
    return (await this.peer.call(
      "session/entries",
      { sessionId: this.id, ...options },
      this.callOptions()
    )) as EntryPage
  }

  async export(): Promise<CanonicalSession> {
    this.assertOpen()
    return (await this.peer.call(
      "session/export",
      { sessionId: this.id },
      this.callOptions()
    )) as CanonicalSession
  }

  async tree(): Promise<readonly unknown[]> {
    this.assertOpen()
    const response = await this.peer.call(
      "session/tree",
      { sessionId: this.id },
      this.callOptions()
    )
    return response.roots as readonly unknown[]
  }

  async sandboxStatus(): Promise<SandboxStatus> {
    this.assertOpen()
    return this.peer.call(
      "sandbox/status",
      { sessionId: this.id },
      this.callOptions()
    ) as unknown as Promise<SandboxStatus>
  }

  snapshot(options?: CommandOptions): Promise<SandboxSnapshot> {
    return this.command("sandbox/snapshot", {}, options)
  }

  restoreSnapshot(snapshotId: string, options?: CommandOptions): Promise<CommandReceipt> {
    return this.command("sandbox/restore", { snapshotId }, options)
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.command("session/close", {}).catch(() => undefined)
    this.closed = true
    this.eventChannel.close()
    this.removeFromClient()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  private async command<Method extends SessionCommandMethod>(
    method: Method,
    params: Record<string, unknown>,
    options: CommandOptions = {}
  ): Promise<SessionCommandResult<Method>> {
    this.assertOpen()
    return this.peer.call(
      method,
      {
        sessionId: this.id,
        commandId: options.commandId ?? randomUUID(),
        ...params,
      } as RpcMethodMap[Method]["params"],
      this.callOptions(options)
    ) as unknown as Promise<SessionCommandResult<Method>>
  }

  private callOptions(options: CommandOptions = {}) {
    return {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.requestTimeoutMs,
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new RpcError(RPC_ERROR_CODES.sessionNotFound, "session is closed")
  }
}

/**
 * Attach to a host that the caller already has a transport for.
 *
 * Kept out of `openHost` so that a caller supplying its own streams never
 * reaches `host.ts` — that module spawns the agent binary and its Node imports
 * would otherwise land in every bundle, including the WebView's. The shape
 * mirrors `openHost`'s own `kind: "streams"` branch exactly.
 */
function attachInjectedStreams(host: Extract<CogniaHostOption, { kind: "streams" }>) {
  return {
    readable: host.readable,
    writable: host.writable,
    startupTimeoutMs: 15_000,
    searchedLocations: ["injected streams"] as readonly string[],
    async close() {},
  }
}

export async function createCogniaClient(options: CogniaClientOptions = {}): Promise<CogniaClient> {
  let host: OpenHostResult | ReturnType<typeof attachInjectedStreams>
  if (options.host?.kind === "streams") {
    host = attachInjectedStreams(options.host)
  } else {
    const { openHost } = await import("./host")
    host = openHost(options.host, options.onDiagnostic)
  }

  const peer = new RpcPeer({
    readable: host.readable as unknown as RpcReadable,
    writable: host.writable as unknown as RpcWritable,
  })
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  const sessions = new Map<string, CogniaSessionImpl>()
  const channels = new Map<string, SessionEventChannel>()
  const toolHandlers = new Map<string, ClientToolHandler>()
  const hookHandlers = new Map<string, ClientHookHandler>()
  const traceChannels = new Map<string, TraceEventChannel>()
  const callbackReceipts = new Map<
    string,
    Promise<{ ok: boolean; output?: unknown; error?: Record<string, unknown> }>
  >()
  let closed = false

  peer.onNotification("agent/event", (params) => {
    const sessionId = params.sessionId
    const envelope = params.envelope
    if (typeof sessionId !== "string" || !envelope || typeof envelope !== "object") return
    channels.get(sessionId)?.push(envelope as AgentEventEnvelope)
  })
  peer.onNotification("runtime/diagnostic", (params) => {
    options.onDiagnostic?.(params as unknown as CogniaDiagnostic)
  })
  peer.onNotification("trace/event", (params) => {
    if (typeof params.subscriptionId !== "string") return
    if (!params.span || typeof params.span !== "object") return
    traceChannels.get(params.subscriptionId)?.push(params.span as Record<string, unknown>)
  })

  peer.handle("client/tool/invoke", async (params) => {
    const cacheKey = `tool:${params.toolCallId}:${params.idempotencyKey}`
    const existing = callbackReceipts.get(cacheKey)
    if (existing) return existing
    const invocation = invokeHandler(toolHandlers.get(params.handlerId), params.input, {
      sessionId: params.sessionId,
      runId: params.runId,
      attemptId: params.attemptId,
      invocationId: params.toolCallId,
      idempotencyKey: params.idempotencyKey,
    })
    callbackReceipts.set(cacheKey, invocation)
    return invocation
  })
  peer.handle("client/hook/invoke", async (params) => {
    const cacheKey = `hook:${params.invocationId}`
    const existing = callbackReceipts.get(cacheKey)
    if (existing) return existing
    const invocation = invokeHandler(hookHandlers.get(params.handlerId), params.payload, {
      sessionId: params.sessionId,
      runId: params.runId,
      attemptId: params.attemptId,
      invocationId: params.invocationId,
    })
    callbackReceipts.set(cacheKey, invocation)
    return invocation
  })

  let initialized: InitializeResult
  try {
    const initializeCall = peer.call(
      "initialize",
      {
        client: {
          name: options.client?.name ?? "@cognia/agent",
          version: options.client?.version ?? "0.1.0",
        },
        protocolVersions: [RPC_PROTOCOL_VERSION],
        capabilities: ["tools", "hooks", "event-replay"],
        limits: {},
      },
      { timeoutMs: host.startupTimeoutMs }
    )
    const startupFailure = "startupFailure" in host ? host.startupFailure : undefined
    const result = await (startupFailure
      ? Promise.race([initializeCall, startupFailure])
      : initializeCall)
    if (result.protocolVersion !== RPC_PROTOCOL_VERSION) {
      throw new IncompatibleHostError(result.protocolVersion)
    }
    initialized = result as unknown as InitializeResult
    await peer.notify("initialized", {})
  } catch (error) {
    peer.close(error instanceof Error ? error : new Error(String(error)))
    await host.close()
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HostNotFoundError(host.searchedLocations)
    }
    throw error
  }

  function materializeSession(
    sessionId: string,
    spec: ResolvedAgentExecutionSpec
  ): CogniaSessionImpl {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    const channel = new SessionEventChannel()
    channels.set(sessionId, channel)
    const session = new CogniaSessionImpl(
      sessionId,
      spec,
      peer,
      channel,
      () => {
        sessions.delete(sessionId)
        channels.delete(sessionId)
      },
      requestTimeoutMs,
      materializeSession
    )
    sessions.set(sessionId, session)
    return session
  }

  const client: CogniaClient = {
    runtime: {
      info: initialized,
      async status() {
        return peer.call("runtime/status", {}, { timeoutMs: requestTimeoutMs })
      },
      async capabilities() {
        return peer.call("runtime/capabilities", {}, { timeoutMs: requestTimeoutMs })
      },
    },
    models: {
      async list() {
        return (await peer.call("model/list", {}, { timeoutMs: requestTimeoutMs })).models
      },
      async refresh() {
        return (await peer.call("model/refresh", {}, { timeoutMs: requestTimeoutMs })).models
      },
    },
    auth: {
      status() {
        return peer.call("auth/status", {}, { timeoutMs: requestTimeoutMs })
      },
    },
    sessions: {
      async create(createOptions = {}) {
        if (createOptions.handoff && createOptions.cwd) {
          throw new RpcError(
            RPC_ERROR_CODES.invalidParams,
            "remote handoff session creation does not accept cwd"
          )
        }
        if (createOptions.handoff && !initialized.capabilities.includes("worker-dispatch-v1")) {
          throw new RpcError(
            RPC_ERROR_CODES.capabilityError,
            "host does not support worker-dispatch-v1"
          )
        }
        const result = await peer.call(
          "session/create",
          { ...createOptions, commandId: createOptions.commandId ?? randomUUID() },
          {
            timeoutMs: requestTimeoutMs,
          }
        )
        return materializeSession(
          result.sessionId,
          result.spec as unknown as ResolvedAgentExecutionSpec
        )
      },
      async open(sessionId) {
        const result = await peer.call(
          "session/open",
          { sessionId },
          { timeoutMs: requestTimeoutMs }
        )
        return materializeSession(
          result.sessionId,
          result.spec as unknown as ResolvedAgentExecutionSpec
        )
      },
      async list() {
        return (await peer.call("session/list", {}, { timeoutMs: requestTimeoutMs }))
          .sessions as SessionSummary[]
      },
      async import(session) {
        const result = await peer.call(
          "session/import",
          { session },
          { timeoutMs: requestTimeoutMs }
        )
        return materializeSession(
          result.sessionId,
          result.spec as unknown as ResolvedAgentExecutionSpec
        )
      },
      async tree(sessionId) {
        const response = await peer.call(
          "session/tree",
          { sessionId },
          { timeoutMs: requestTimeoutMs }
        )
        return response.roots as readonly unknown[]
      },
    },
    tools: {
      async register(registration, handler) {
        toolHandlers.set(registration.handlerId, handler)
        try {
          await peer.call("tool/register", { ...registration }, { timeoutMs: requestTimeoutMs })
        } catch (error) {
          toolHandlers.delete(registration.handlerId)
          throw error
        }
      },
      async unregister(handlerId) {
        await peer.call("tool/unregister", { handlerId }, { timeoutMs: requestTimeoutMs })
        toolHandlers.delete(handlerId)
      },
    },
    hooks: {
      async register(registration, handler) {
        hookHandlers.set(registration.handlerId, handler)
        try {
          await peer.call("hook/register", { ...registration }, { timeoutMs: requestTimeoutMs })
        } catch (error) {
          hookHandlers.delete(registration.handlerId)
          throw error
        }
      },
      async unregister(handlerId) {
        await peer.call("hook/unregister", { handlerId }, { timeoutMs: requestTimeoutMs })
        hookHandlers.delete(handlerId)
      },
    },
    mcp: {
      configure(servers) {
        return peer.call(
          "mcp/configure",
          { servers: [...servers] },
          { timeoutMs: requestTimeoutMs }
        )
      },
      status() {
        return peer.call("mcp/status", {}, { timeoutMs: requestTimeoutMs })
      },
    },
    plugins: {
      reload(pluginId) {
        return peer.call(
          "plugin/reload",
          { ...(pluginId ? { pluginId } : {}) },
          { timeoutMs: requestTimeoutMs }
        )
      },
    },
    skills: {
      reload(skillId) {
        return peer.call(
          "skill/reload",
          { ...(skillId ? { skillId } : {}) },
          { timeoutMs: requestTimeoutMs }
        )
      },
    },
    tasks: {
      async list(sessionId) {
        const response = await peer.call(
          "task/list",
          { ...(sessionId ? { sessionId } : {}) },
          { timeoutMs: requestTimeoutMs }
        )
        return response.tasks
      },
      stop(taskId, commandOptions = {}) {
        return peer.call(
          "task/stop",
          { taskId, commandId: commandOptions.commandId ?? randomUUID() },
          { signal: commandOptions.signal, timeoutMs: commandOptions.timeoutMs ?? requestTimeoutMs }
        ) as Promise<CommandReceipt>
      },
      background(taskId, commandOptions = {}) {
        return peer.call(
          "task/background",
          { taskId, commandId: commandOptions.commandId ?? randomUUID() },
          { signal: commandOptions.signal, timeoutMs: commandOptions.timeoutMs ?? requestTimeoutMs }
        ) as Promise<CommandReceipt>
      },
    },
    traces: {
      async subscribe(sessionId) {
        const response = await peer.call(
          "trace/subscribe",
          { ...(sessionId ? { sessionId } : {}) },
          { timeoutMs: requestTimeoutMs }
        )
        const subscriptionId = response.subscriptionId
        if (typeof subscriptionId !== "string") {
          throw new RpcError(
            RPC_ERROR_CODES.internalError,
            "host returned no trace subscription id"
          )
        }
        const channel = new TraceEventChannel()
        traceChannels.set(subscriptionId, channel)
        return channel.iterate()
      },
      export(traceOptions = {}) {
        return peer.call("trace/export", traceOptions, { timeoutMs: requestTimeoutMs })
      },
    },
    audit: {
      query(queryOptions = {}) {
        return peer.call("audit/query", queryOptions, {
          timeoutMs: requestTimeoutMs,
        }) as unknown as Promise<AuditPage>
      },
    },
    async close() {
      if (closed) return
      closed = true
      for (const session of [...sessions.values()]) await session.close()
      for (const channel of traceChannels.values()) channel.close()
      traceChannels.clear()
      await peer.call("shutdown", {}, { timeoutMs: requestTimeoutMs }).catch(() => undefined)
      peer.close()
      await host.close()
    },
    [Symbol.asyncDispose]() {
      return this.close()
    },
  }

  return client
}

async function invokeHandler(
  handler: ClientToolHandler | ClientHookHandler | undefined,
  input: unknown,
  context: ClientInvocationContext
): Promise<{ ok: boolean; output?: unknown; error?: Record<string, unknown> }> {
  if (!handler) return { ok: false, error: { code: "handler_not_found" } }
  try {
    return { ok: true, output: await handler(input, context) }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "handler_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}
