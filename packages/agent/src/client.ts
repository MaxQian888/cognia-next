import type {
  AgentDefinitionChanges,
  AgentDefinitionInput,
  AgentDefinitionSummaryV1,
  AgentDefinitionV1,
} from "./agent-definition"
import { assertSupportedInput } from "./agent-input"
import {
  CAP_AGENT_DEFINITIONS_V1,
  CAP_AGENT_SESSION_BINDING_V1,
  CAP_ASSETS_V1,
  CAP_EVALS_V1,
  CAP_TRACE_UNSUBSCRIBE_V1,
  hasCapability,
} from "./capabilities"
import { HostConnection, type ReconnectPolicy } from "./connection"
import {
  BackpressureError,
  ConnectionLostError,
  HostNotFoundError,
  IncompatibleHostError,
  IndeterminateCommandError,
  ProtocolLimitError,
  ReconnectFailedError,
  RpcError,
} from "./errors"
import { DEFAULT_SUBSCRIBER_CAPACITY, SessionEventHub } from "./event-stream"
import type { CogniaHostOption } from "./host"
import { randomUUID } from "./ids"
import { ReceiptCache } from "./receipt-cache"
import { createRunHandle, type AgentRunHandle, type RunEventOptions } from "./run-handle"
import { RPC_ERROR_CODES, type RpcMethodMap } from "./rpc/protocol"
import type {
  AgentEventEnvelope,
  AgentInput,
  AgentPermissionMode,
  AgentTurnOutcome,
  AssetReference,
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
  EntryPage,
  EntryPageOptions,
  ExternalToolResponse,
  ForkOptions,
  InitializeResult,
  PermissionDecision,
  ProtocolLimits,
  ResolvedAgentExecutionSpec,
  RunOptions,
  SandboxPolicyRecord,
  SandboxStatus,
  SessionCreateOptions,
  SessionState,
  SessionSummary,
  ThinkingLevel,
  WaitOptions,
} from "./types"

export {
  BackpressureError,
  ConnectionLostError,
  HostNotFoundError,
  IncompatibleHostError,
  IndeterminateCommandError,
  ProtocolLimitError,
  ReconnectFailedError,
  RpcError,
}

/** How long a client-side callback memo absorbs a host redelivery. */
const CALLBACK_RECEIPT_TTL_MS = 10 * 60_000
const CALLBACK_RECEIPT_CEILING = 512

export interface CogniaClientOptions {
  host?: CogniaHostOption
  requestTimeoutMs?: number
  onDiagnostic?: (diagnostic: CogniaDiagnostic) => void
  client?: { name?: string; version?: string }
  /**
   * Reconnection is on by default for `bundled` and `path` hosts. A `streams`
   * host needs a `factory` on the host option before it can be reconnected at
   * all; without one this is forced off.
   */
  reconnect?: Partial<ReconnectPolicy>
  /** Default bounded queue capacity for event subscribers. */
  eventQueueCapacity?: number
}

export interface RuntimeApi {
  readonly info: InitializeResult
  /** Limits the host announced, after normalisation, as actually enforced. */
  readonly limits: ProtocolLimits
  status(): Promise<Record<string, unknown>>
  capabilities(): Promise<{ methods: readonly string[]; capabilities: readonly string[] }>
  /** True when the host declared this exact versioned capability. */
  supports(capability: string): boolean
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
  /** The subtree rooted at `sessionId`. For every root, use `forest()`. */
  tree(sessionId: string): Promise<readonly unknown[]>
  /** Every root the host knows about. */
  forest(): Promise<readonly unknown[]>
}

export interface AuthApi {
  status(): Promise<Record<string, unknown>>
}

/**
 * A host-persisted agent definition, plus the calls that operate on it.
 *
 * `definition` is the exact version that was read or written. It never mutates:
 * `update` returns a *new* handle at version N+1, so a caller holding an older
 * handle keeps describing what it actually created sessions from.
 */
export interface AgentHandle {
  readonly id: string
  readonly version: number
  readonly definition: AgentDefinitionV1
  /** Compare-and-swap against this handle's version unless told otherwise. */
  update(
    changes: AgentDefinitionChanges,
    options?: { expectedVersion?: number }
  ): Promise<AgentHandle>
  /** Create a session frozen at this agent's exact version. */
  sessions: { create(options?: Omit<SessionCreateOptions, "agent">): Promise<CogniaSession> }
  /** Create a session at this version and immediately begin a turn on it. */
  start(input: AgentInput, options?: RunOptions): Promise<AgentRunHandle>
  archive(): Promise<AgentDefinitionSummaryV1>
  restore(): Promise<AgentDefinitionSummaryV1>
  versions(): Promise<readonly number[]>
}

export interface AgentApi {
  create(definition: AgentDefinitionInput): Promise<AgentHandle>
  get(agentId: string, version?: number): Promise<AgentHandle>
  list(options?: { includeArchived?: boolean }): Promise<readonly AgentDefinitionSummaryV1[]>
  update(
    agentId: string,
    options: { expectedVersion: number; changes: AgentDefinitionChanges }
  ): Promise<AgentHandle>
  archive(agentId: string): Promise<AgentDefinitionSummaryV1>
  restore(agentId: string): Promise<AgentDefinitionSummaryV1>
  versions(agentId: string): Promise<readonly number[]>
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

/**
 * A live trace subscription.
 *
 * Releasing it matters: the host holds a record per subscription, and before
 * `trace/unsubscribe` existed the only way one was ever dropped was an emit
 * that happened to throw.
 */
export interface TraceSubscription extends AsyncIterable<Record<string, unknown>>, AsyncDisposable {
  readonly subscriptionId: string
  unsubscribe(): Promise<void>
}

export interface TraceSubscribeOptions {
  sessionId?: string
  /**
   * Include prompt and tool previews on the spans.
   *
   * Off by default. Turning it on does not bypass the host's PII gate — a
   * preview that fails it is dropped and the span says so.
   */
  includeContent?: boolean
}

export interface TraceApi {
  subscribe(options?: string | TraceSubscribeOptions): Promise<TraceSubscription>
  export(options?: {
    sessionId?: string
    format?: "json" | "otlp-json"
  }): Promise<Record<string, unknown>>
}

/**
 * Content-addressed bytes the host holds on the client's behalf.
 *
 * A turn references an asset; it never carries the bytes or a host path. That
 * is what keeps large or host-local content out of the canonical event log,
 * which is replayed, exported and shared.
 */
export interface AssetApi {
  /** Upload bytes. Bounded by the host's `maxAssetBytes`. */
  upload(
    data: Uint8Array | string,
    options: { mediaType: string; name?: string }
  ): Promise<AssetReference>
  /** Register a path the *host* can read. No bytes cross the transport. */
  registerPath(path: string, options?: { mediaType?: string }): Promise<AssetReference>
  stat(assetId: string): Promise<AssetReference>
  delete(assetId: string): Promise<void>
}

export interface ReplayResult {
  ok: boolean
  scenarioId?: string
  requests: number
  unmatched: number
  summary: string
  errors?: readonly string[]
  report?: Record<string, unknown>
}

/** An open recording proxy. Stop it to get the fixture it captured. */
export interface RecordingHandle extends AsyncDisposable {
  readonly recordingId: string
  /** Point the provider at this URL while driving the session being recorded. */
  readonly proxyUrl: string
  stop(): Promise<{ fixture: Record<string, unknown>; actors: readonly string[] }>
}

/**
 * Record and replay, on the host's existing engine.
 *
 * A replay runs the real agent loop — real build-options assembly, real tools,
 * real permission gate, real persistence — and substitutes only the model
 * endpoint, so it needs no provider credential and cannot reach a provider even
 * if something tries.
 */
export interface EvalApi {
  replay(
    fixture: Record<string, unknown>,
    options?: { requireSynthetic?: boolean; provider?: string }
  ): Promise<ReplayResult>
  /** Re-derive a fixture's digests after an intentional edit. */
  refreshFixture(fixture: Record<string, unknown>): Promise<Record<string, unknown>>
  record(
    scenario: Record<string, unknown>,
    options?: { upstream?: string; provider?: string; port?: number }
  ): Promise<RecordingHandle>
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
  readonly agents: AgentApi
  readonly assets: AssetApi
  readonly evals: EvalApi
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

export interface SessionEventOptions extends RunEventOptions {
  afterEventId?: string
}

export interface CogniaSession extends AsyncDisposable {
  readonly id: string
  readonly spec: ResolvedAgentExecutionSpec
  /**
   * Run a turn and wait for its terminal outcome, settling any interaction the
   * client registered a handler for along the way. Use `start()` when the
   * caller has to observe the turn while it runs.
   */
  run(input: AgentInput, options?: RunOptions): Promise<AgentTurnOutcome>
  /** Begin a turn and get a handle to its events, result and cancellation. */
  start(input: AgentInput, options?: RunOptions): Promise<AgentRunHandle>
  events(options?: SessionEventOptions): AsyncIterable<AgentEventEnvelope>
  steer(input: AgentInput, options?: CommandOptions): Promise<CommandReceipt>
  followUp(input: AgentInput, options?: CommandOptions): Promise<CommandReceipt>
  abort(options?: CommandOptions & { reason?: string }): Promise<CommandReceipt>
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
  /** The subtree rooted at this session. */
  tree(): Promise<readonly unknown[]>
  sandboxStatus(): Promise<SandboxStatus>
  /**
   * Record the sandbox resource policy in force. This is not a workspace
   * checkpoint — nothing on disk is captured. See `SandboxPolicyRecord`.
   */
  captureSandboxPolicy(options?: CommandOptions): Promise<SandboxPolicyRecord>
  restoreSandboxPolicy(policyRecordId: string, options?: CommandOptions): Promise<CommandReceipt>
  close(): Promise<void>
}

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
  | "sandbox/policy/capture"
  | "sandbox/policy/restore"

type SessionCommandResult<Method extends SessionCommandMethod> = Method extends "session/compact"
  ? CompactionResult
  : Method extends "sandbox/policy/capture"
    ? SandboxPolicyRecord
    : CommandReceipt

class TraceChannel {
  private readonly queue: Record<string, unknown>[] = []
  private readonly waiters: Array<(result: IteratorResult<Record<string, unknown>>) => void> = []
  private closed = false

  push(span: Record<string, unknown>): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value: span })
    else this.queue.push(span)
  }

  iterate(): AsyncIterator<Record<string, unknown>> {
    return {
      next: async () => {
        const next = this.queue.shift()
        if (next) return { done: false, value: next }
        if (this.closed) return { done: true, value: undefined }
        return new Promise<IteratorResult<Record<string, unknown>>>((resolve) => {
          this.waiters.push(resolve)
        })
      },
      return: async () => ({ done: true, value: undefined }),
    }
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }
}

interface SessionRuntime {
  connection: HostConnection
  /** What the host declared, so input validation can be capability-aware. */
  hostCapabilities: readonly string[]
  hub: SessionEventHub
  requestTimeoutMs: number
  defaultCapacity: number
  onClosed: (sessionId: string) => void
  materialize: (sessionId: string, spec: ResolvedAgentExecutionSpec) => CogniaSession
  /** Claims a turn slot, or throws `ProtocolLimitError` when the host is full. */
  beginTurn: () => void
  endTurn: () => void
}

class CogniaSessionImpl implements CogniaSession {
  private closed = false

  constructor(
    readonly id: string,
    readonly spec: ResolvedAgentExecutionSpec,
    private readonly runtime: SessionRuntime
  ) {}

  async run(input: AgentInput, options: RunOptions = {}): Promise<AgentTurnOutcome> {
    const handle = await this.start(input, options)
    return handle.result
  }

  async start(input: AgentInput, options: RunOptions = {}): Promise<AgentRunHandle> {
    this.assertOpen()
    assertSupportedInput(input, this.runtime.hostCapabilities)
    const commandId = options.commandId ?? randomUUID()

    if (options.signal?.aborted) {
      await this.abort({ commandId }).catch(() => undefined)
      throw new RpcError(RPC_ERROR_CODES.cancelled, "cancelled")
    }

    // The head before the turn is written is the exact replay point for this
    // run's events, and it costs one small read rather than a guess.
    const head = await this.headEventId()

    this.runtime.beginTurn()
    const onAbort = () => void this.abort({ commandId }).catch(() => undefined)
    options.signal?.addEventListener("abort", onAbort, { once: true })

    const result = (async () => {
      try {
        return (await this.runtime.connection.call(
          "turn/run",
          {
            sessionId: this.id,
            input,
            commandId,
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.idleTimeoutMs !== undefined
              ? { idleTimeoutMs: options.idleTimeoutMs }
              : {}),
            ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
            ...(options.includeDiagnostics !== undefined
              ? { includeDiagnostics: options.includeDiagnostics }
              : {}),
          },
          { signal: options.signal }
        )) as unknown as AgentTurnOutcome
      } finally {
        options.signal?.removeEventListener("abort", onAbort)
        this.runtime.endTurn()
      }
    })()

    return createRunHandle({
      sessionId: this.id,
      commandId,
      startCursor: head,
      subscribe: (afterEventId, subscribeOptions) =>
        this.runtime.hub.subscribe({
          ...(afterEventId !== undefined ? { afterEventId } : {}),
          ...(subscribeOptions.signal ? { signal: subscribeOptions.signal } : {}),
          capacity: subscribeOptions.capacity ?? this.runtime.defaultCapacity,
        }),
      result,
      abort: (reason) => this.abort(reason !== undefined ? { reason } : {}),
    })
  }

  events(options: SessionEventOptions = {}): AsyncIterable<AgentEventEnvelope> {
    this.assertOpen()
    return this.runtime.hub.subscribe({
      ...(options.afterEventId !== undefined ? { afterEventId: options.afterEventId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      capacity: options.capacity ?? this.runtime.defaultCapacity,
    })
  }

  steer(input: AgentInput, options?: CommandOptions): Promise<CommandReceipt> {
    assertSupportedInput(input, this.runtime.hostCapabilities)
    return this.command("turn/steer", { input }, options)
  }

  followUp(input: AgentInput, options?: CommandOptions): Promise<CommandReceipt> {
    assertSupportedInput(input, this.runtime.hostCapabilities)
    return this.command("turn/followUp", { input }, options)
  }

  abort(options: CommandOptions & { reason?: string } = {}): Promise<CommandReceipt> {
    return this.command(
      "turn/abort",
      options.reason !== undefined ? { reason: options.reason } : {},
      options
    )
  }

  async waitForIdle(options: WaitOptions = {}): Promise<SessionState> {
    this.assertOpen()
    return (await this.runtime.connection.call(
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
    this.markClosed()
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
    const result = await this.runtime.connection.call(
      "session/fork",
      {
        sessionId: this.id,
        commandId: options.commandId ?? randomUUID(),
        ...(options.turnId ? { turnId: options.turnId } : {}),
        ...(options.name ? { name: options.name } : {}),
      },
      this.callOptions(options)
    )
    return this.runtime.materialize(
      result.sessionId,
      result.spec as unknown as ResolvedAgentExecutionSpec
    )
  }

  async clone(options: CloneOptions = {}): Promise<CogniaSession> {
    this.assertOpen()
    const result = await this.runtime.connection.call(
      "session/clone",
      {
        sessionId: this.id,
        commandId: options.commandId ?? randomUUID(),
        ...(options.name ? { name: options.name } : {}),
      },
      this.callOptions(options)
    )
    return this.runtime.materialize(
      result.sessionId,
      result.spec as unknown as ResolvedAgentExecutionSpec
    )
  }

  async state(): Promise<SessionState> {
    this.assertOpen()
    return (await this.runtime.connection.call(
      "session/state",
      { sessionId: this.id },
      this.callOptions()
    )) as SessionState
  }

  async messages(): Promise<CanonicalTurn[]> {
    this.assertOpen()
    const result = await this.runtime.connection.call(
      "session/messages",
      { sessionId: this.id },
      this.callOptions()
    )
    return result.messages as CanonicalTurn[]
  }

  async entries(options: EntryPageOptions = {}): Promise<EntryPage> {
    this.assertOpen()
    return (await this.readEntries(options)) as EntryPage
  }

  async export(): Promise<CanonicalSession> {
    this.assertOpen()
    return (await this.runtime.connection.call(
      "session/export",
      { sessionId: this.id },
      this.callOptions()
    )) as CanonicalSession
  }

  async tree(): Promise<readonly unknown[]> {
    this.assertOpen()
    const response = await this.runtime.connection.call(
      "session/tree",
      { sessionId: this.id },
      this.callOptions()
    )
    return response.roots as readonly unknown[]
  }

  async sandboxStatus(): Promise<SandboxStatus> {
    this.assertOpen()
    return this.runtime.connection.call(
      "sandbox/status",
      { sessionId: this.id },
      this.callOptions()
    ) as unknown as Promise<SandboxStatus>
  }

  captureSandboxPolicy(options?: CommandOptions): Promise<SandboxPolicyRecord> {
    return this.command("sandbox/policy/capture", {}, options)
  }

  restoreSandboxPolicy(policyRecordId: string, options?: CommandOptions): Promise<CommandReceipt> {
    return this.command("sandbox/policy/restore", { policyRecordId }, options)
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.command("session/close", {}).catch(() => undefined)
    this.markClosed()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  /** Newest persisted event, used as a replay anchor. */
  private async headEventId(): Promise<string | undefined> {
    const page = await this.readEntries({ limit: 1 })
    const head = (page as { headEventId?: unknown }).headEventId
    return typeof head === "string" ? head : undefined
  }

  private readEntries(
    options: EntryPageOptions
  ): Promise<RpcMethodMap["session/entries"]["result"]> {
    const limit =
      options.limit !== undefined
        ? Math.min(options.limit, this.runtime.connection.negotiatedLimits.maxReplayEvents)
        : undefined
    return this.runtime.connection.call(
      "session/entries",
      {
        sessionId: this.id,
        ...(options.afterEventId !== undefined ? { afterEventId: options.afterEventId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
      this.callOptions()
    )
  }

  private markClosed(): void {
    this.closed = true
    this.runtime.hub.close()
    this.runtime.onClosed(this.id)
  }

  private async command<Method extends SessionCommandMethod>(
    method: Method,
    params: Record<string, unknown>,
    options: CommandOptions = {}
  ): Promise<SessionCommandResult<Method>> {
    this.assertOpen()
    return this.runtime.connection.call(
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
      timeoutMs: options.timeoutMs ?? this.runtime.requestTimeoutMs,
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new RpcError(RPC_ERROR_CODES.sessionNotFound, "session is closed")
  }
}

export async function createCogniaClient(options: CogniaClientOptions = {}): Promise<CogniaClient> {
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  const defaultCapacity = options.eventQueueCapacity ?? DEFAULT_SUBSCRIBER_CAPACITY

  const sessions = new Map<string, CogniaSessionImpl>()
  const specs = new Map<string, ResolvedAgentExecutionSpec>()
  const hubs = new Map<string, SessionEventHub>()
  const toolHandlers = new Map<
    string,
    { registration: ClientToolRegistration; handler: ClientToolHandler }
  >()
  const hookHandlers = new Map<
    string,
    { registration: ClientHookRegistration; handler: ClientHookHandler }
  >()
  const traceChannels = new Map<
    string,
    { channel: TraceChannel; sessionId?: string; localId: string }
  >()
  const traceByLocalId = new Map<string, string>()
  const callbackReceipts = new ReceiptCache<
    Promise<{ ok: boolean; output?: unknown; error?: Record<string, unknown> }>
  >({ maxEntries: CALLBACK_RECEIPT_CEILING, ttlMs: CALLBACK_RECEIPT_TTL_MS })

  let activeTurns = 0
  let closed = false
  let fatal: Error | undefined

  const connection = await HostConnection.open({
    ...(options.host !== undefined ? { host: options.host } : {}),
    requestTimeoutMs,
    ...(options.client !== undefined ? { client: options.client } : {}),
    ...(options.reconnect !== undefined ? { reconnect: options.reconnect } : {}),
    hooks: {
      onAgentEvent(sessionId, envelope) {
        hubs.get(sessionId)?.publish(envelope)
      },
      onTraceEvent(subscriptionId, span) {
        traceChannels.get(subscriptionId)?.channel.push(span)
      },
      onDiagnostic(diagnostic) {
        options.onDiagnostic?.(diagnostic)
      },
      invokeTool(params) {
        const key = `tool:${String(params.toolCallId)}:${String(params.idempotencyKey)}`
        return callbackReceipts.remember(key, () =>
          invokeHandler(toolHandlers.get(String(params.handlerId))?.handler, params.input, {
            sessionId: String(params.sessionId),
            runId: String(params.runId),
            attemptId: String(params.attemptId),
            invocationId: String(params.toolCallId),
            idempotencyKey: String(params.idempotencyKey),
          })
        )
      },
      invokeHook(params) {
        const key = `hook:${String(params.invocationId)}`
        return callbackReceipts.remember(key, () =>
          invokeHandler(hookHandlers.get(String(params.handlerId))?.handler, params.payload, {
            sessionId: String(params.sessionId),
            runId: String(params.runId),
            attemptId: String(params.attemptId),
            invocationId: String(params.invocationId),
          })
        )
      },
      async onReattach() {
        // The host that died forgot every registration, handle and
        // subscription. Rebuild them before any caller is released onto the
        // new peer, so nothing observes a half-restored client.
        callbackReceipts.clear()
        for (const { registration } of toolHandlers.values()) {
          await connection.call(
            "tool/register",
            { ...registration },
            { timeoutMs: requestTimeoutMs }
          )
        }
        for (const { registration } of hookHandlers.values()) {
          await connection.call(
            "hook/register",
            { ...registration },
            { timeoutMs: requestTimeoutMs }
          )
        }
        for (const sessionId of sessions.keys()) {
          await connection.call("session/open", { sessionId }, { timeoutMs: requestTimeoutMs })
        }
        for (const [hostId, entry] of [...traceChannels]) {
          traceChannels.delete(hostId)
          const response = await connection.call(
            "trace/subscribe",
            { ...(entry.sessionId ? { sessionId: entry.sessionId } : {}) },
            { timeoutMs: requestTimeoutMs }
          )
          const nextId = response.subscriptionId
          if (typeof nextId !== "string") continue
          traceChannels.set(nextId, entry)
          traceByLocalId.set(entry.localId, nextId)
        }
      },
      onGiveUp(error) {
        fatal = error
        closed = true
        for (const hub of hubs.values()) hub.close()
        for (const entry of traceChannels.values()) entry.channel.close()
        options.onDiagnostic?.({
          level: "error",
          code: error instanceof ReconnectFailedError ? "reconnect_failed" : "connection_lost",
          message: error.message,
        })
      },
    },
  })

  function assertUsable(): void {
    if (fatal) throw fatal
    if (closed) throw new ConnectionLostError("the Cognia client is closed")
  }

  function requireAssets(): void {
    if (!hasCapability(connection.info.capabilities, CAP_ASSETS_V1)) {
      throw new RpcError(RPC_ERROR_CODES.capabilityError, `host does not support ${CAP_ASSETS_V1}`)
    }
  }

  function requireEvals(): void {
    if (!hasCapability(connection.info.capabilities, CAP_EVALS_V1)) {
      throw new RpcError(RPC_ERROR_CODES.capabilityError, `host does not support ${CAP_EVALS_V1}`)
    }
  }

  function requireAuthoring(): void {
    if (!hasCapability(connection.info.capabilities, CAP_AGENT_DEFINITIONS_V1)) {
      throw new RpcError(
        RPC_ERROR_CODES.capabilityError,
        `host does not support ${CAP_AGENT_DEFINITIONS_V1}`
      )
    }
  }

  function materializeAgent(definition: AgentDefinitionV1): AgentHandle {
    const createSession = async (options: Omit<SessionCreateOptions, "agent"> = {}) => {
      if (!hasCapability(connection.info.capabilities, CAP_AGENT_SESSION_BINDING_V1)) {
        throw new RpcError(
          RPC_ERROR_CODES.capabilityError,
          `host does not support ${CAP_AGENT_SESSION_BINDING_V1}`
        )
      }
      // The exact version is pinned, not `latest`: a handle describes one
      // version, and a session created from it must run that one even if the
      // agent moves on between this call and the next.
      return client.sessions.create({
        ...options,
        agent: { agentId: definition.agentId, version: definition.version },
      })
    }
    return {
      id: definition.agentId,
      version: definition.version,
      definition,
      sessions: { create: createSession },
      async start(input, runOptions) {
        const session = await createSession()
        return session.start(input, runOptions)
      },
      update(changes, updateOptions = {}) {
        return client.agents.update(definition.agentId, {
          expectedVersion: updateOptions.expectedVersion ?? definition.version,
          changes,
        })
      },
      archive: () => client.agents.archive(definition.agentId),
      restore: () => client.agents.restore(definition.agentId),
      versions: () => client.agents.versions(definition.agentId),
    }
  }

  function materializeSession(
    sessionId: string,
    spec: ResolvedAgentExecutionSpec
  ): CogniaSessionImpl {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    specs.set(sessionId, spec)
    const hub = new SessionEventHub(async ({ afterEventId, limit }) => {
      const page = await connection.call(
        "session/entries",
        {
          sessionId,
          ...(afterEventId !== undefined ? { afterEventId } : {}),
          limit: Math.min(limit, connection.negotiatedLimits.maxReplayEvents),
        },
        { timeoutMs: requestTimeoutMs }
      )
      return page as unknown as {
        entries: readonly { envelope: AgentEventEnvelope }[]
        nextEventId?: string
        headEventId?: string
      }
    })
    hubs.set(sessionId, hub)
    const session = new CogniaSessionImpl(sessionId, spec, {
      connection,
      hostCapabilities: connection.info.capabilities,
      hub,
      requestTimeoutMs,
      defaultCapacity,
      onClosed: (id) => {
        sessions.delete(id)
        hubs.delete(id)
        specs.delete(id)
      },
      materialize: materializeSession,
      beginTurn: () => {
        const ceiling = connection.negotiatedLimits.maxActiveTurns
        if (activeTurns >= ceiling) {
          throw new ProtocolLimitError("maxActiveTurns", ceiling, activeTurns + 1)
        }
        activeTurns += 1
      },
      endTurn: () => {
        activeTurns = Math.max(0, activeTurns - 1)
      },
    })
    sessions.set(sessionId, session)
    return session
  }

  const client: CogniaClient = {
    runtime: {
      info: connection.info,
      limits: connection.negotiatedLimits,
      async status() {
        assertUsable()
        return connection.call("runtime/status", {}, { timeoutMs: requestTimeoutMs })
      },
      async capabilities() {
        assertUsable()
        return connection.call("runtime/capabilities", {}, { timeoutMs: requestTimeoutMs })
      },
      supports(capability) {
        return hasCapability(connection.info.capabilities, capability)
      },
    },
    models: {
      async list() {
        assertUsable()
        return (await connection.call("model/list", {}, { timeoutMs: requestTimeoutMs })).models
      },
      async refresh() {
        assertUsable()
        return (await connection.call("model/refresh", {}, { timeoutMs: requestTimeoutMs })).models
      },
    },
    auth: {
      status() {
        assertUsable()
        return connection.call("auth/status", {}, { timeoutMs: requestTimeoutMs })
      },
    },
    agents: {
      async create(definitionInput) {
        assertUsable()
        requireAuthoring()
        const { agentId, ...definition } = definitionInput
        const created = await connection.call(
          "agent/create",
          {
            definition:
              definition as unknown as RpcMethodMap["agent/create"]["params"]["definition"],
            ...(agentId !== undefined ? { agentId } : {}),
            commandId: randomUUID(),
          },
          { timeoutMs: requestTimeoutMs }
        )
        return materializeAgent(created as unknown as AgentDefinitionV1)
      },
      async get(agentId, version) {
        assertUsable()
        requireAuthoring()
        const found = await connection.call(
          "agent/get",
          { agentId, ...(version !== undefined ? { version } : {}) },
          { timeoutMs: requestTimeoutMs }
        )
        return materializeAgent(found as unknown as AgentDefinitionV1)
      },
      async list(listOptions = {}) {
        assertUsable()
        requireAuthoring()
        const response = await connection.call(
          "agent/list",
          listOptions.includeArchived === true ? { includeArchived: true } : {},
          { timeoutMs: requestTimeoutMs }
        )
        return response.agents as unknown as AgentDefinitionSummaryV1[]
      },
      async update(agentId, updateOptions) {
        assertUsable()
        requireAuthoring()
        const updated = await connection.call(
          "agent/update",
          {
            agentId,
            expectedVersion: updateOptions.expectedVersion,
            changes:
              updateOptions.changes as unknown as RpcMethodMap["agent/update"]["params"]["changes"],
            commandId: randomUUID(),
          },
          { timeoutMs: requestTimeoutMs }
        )
        return materializeAgent(updated as unknown as AgentDefinitionV1)
      },
      async archive(agentId) {
        assertUsable()
        requireAuthoring()
        return (await connection.call(
          "agent/archive",
          { agentId, commandId: randomUUID() },
          { timeoutMs: requestTimeoutMs }
        )) as unknown as AgentDefinitionSummaryV1
      },
      async restore(agentId) {
        assertUsable()
        requireAuthoring()
        return (await connection.call(
          "agent/restore",
          { agentId, commandId: randomUUID() },
          { timeoutMs: requestTimeoutMs }
        )) as unknown as AgentDefinitionSummaryV1
      },
      async versions(agentId) {
        assertUsable()
        requireAuthoring()
        return (
          await connection.call("agent/versions", { agentId }, { timeoutMs: requestTimeoutMs })
        ).versions
      },
    },
    assets: {
      async upload(data, uploadOptions) {
        assertUsable()
        requireAssets()
        const base64 = typeof data === "string" ? data : Buffer.from(data).toString("base64")
        return (await connection.call(
          "asset/put",
          {
            data: base64,
            mediaType: uploadOptions.mediaType,
            ...(uploadOptions.name !== undefined ? { name: uploadOptions.name } : {}),
            commandId: randomUUID(),
          },
          { timeoutMs: requestTimeoutMs }
        )) as unknown as AssetReference
      },
      async registerPath(assetPath, registerOptions = {}) {
        assertUsable()
        requireAssets()
        return (await connection.call(
          "asset/register",
          {
            path: assetPath,
            ...(registerOptions.mediaType !== undefined
              ? { mediaType: registerOptions.mediaType }
              : {}),
            commandId: randomUUID(),
          },
          { timeoutMs: requestTimeoutMs }
        )) as unknown as AssetReference
      },
      async stat(assetId) {
        assertUsable()
        requireAssets()
        return (await connection.call(
          "asset/stat",
          { assetId },
          { timeoutMs: requestTimeoutMs }
        )) as unknown as AssetReference
      },
      async delete(assetId) {
        assertUsable()
        requireAssets()
        await connection.call(
          "asset/delete",
          { assetId, commandId: randomUUID() },
          { timeoutMs: requestTimeoutMs }
        )
      },
    },
    evals: {
      async replay(fixture, replayOptions = {}) {
        assertUsable()
        requireEvals()
        return (await connection.call(
          "eval/replay",
          {
            fixture,
            ...(replayOptions.requireSynthetic !== undefined
              ? { requireSynthetic: replayOptions.requireSynthetic }
              : {}),
            ...(replayOptions.provider !== undefined ? { provider: replayOptions.provider } : {}),
          },
          // A replay drives a whole scenario; the ordinary request timeout is
          // sized for a single control call and would cut it off.
          { timeoutMs: Math.max(requestTimeoutMs, 300_000) }
        )) as unknown as ReplayResult
      },
      async refreshFixture(fixture) {
        assertUsable()
        requireEvals()
        return connection.call("eval/fixture/refresh", { fixture }, { timeoutMs: requestTimeoutMs })
      },
      async record(scenario, recordOptions = {}) {
        assertUsable()
        requireEvals()
        const started = await connection.call(
          "eval/record/start",
          {
            scenario,
            ...(recordOptions.upstream !== undefined ? { upstream: recordOptions.upstream } : {}),
            ...(recordOptions.provider !== undefined ? { provider: recordOptions.provider } : {}),
            ...(recordOptions.port !== undefined ? { port: recordOptions.port } : {}),
            commandId: randomUUID(),
          },
          { timeoutMs: requestTimeoutMs }
        )
        let stopped = false
        const stop = async () => {
          if (stopped)
            throw new RpcError(RPC_ERROR_CODES.invalidParams, "recording already stopped")
          stopped = true
          const finished = await connection.call(
            "eval/record/stop",
            { recordingId: started.recordingId, commandId: randomUUID() },
            { timeoutMs: requestTimeoutMs }
          )
          return {
            fixture: finished.fixture as Record<string, unknown>,
            actors: finished.actors as readonly string[],
          }
        }
        return {
          recordingId: started.recordingId,
          proxyUrl: started.proxyUrl,
          stop,
          async [Symbol.asyncDispose]() {
            if (!stopped) await stop().catch(() => undefined)
          },
        }
      },
    },
    sessions: {
      async create(createOptions = {}) {
        assertUsable()
        if (createOptions.handoff && createOptions.cwd) {
          throw new RpcError(
            RPC_ERROR_CODES.invalidParams,
            "remote handoff session creation does not accept cwd"
          )
        }
        if (createOptions.handoff && !client.runtime.supports("worker-dispatch-v1")) {
          throw new RpcError(
            RPC_ERROR_CODES.capabilityError,
            "host does not support worker-dispatch-v1"
          )
        }
        const ceiling = connection.negotiatedLimits.maxOpenSessions
        if (sessions.size >= ceiling) {
          throw new ProtocolLimitError("maxOpenSessions", ceiling, sessions.size + 1)
        }
        const result = await connection.call(
          "session/create",
          { ...createOptions, commandId: createOptions.commandId ?? randomUUID() },
          { timeoutMs: requestTimeoutMs }
        )
        return materializeSession(
          result.sessionId,
          result.spec as unknown as ResolvedAgentExecutionSpec
        )
      },
      async open(sessionId) {
        assertUsable()
        const result = await connection.call(
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
        assertUsable()
        return (await connection.call("session/list", {}, { timeoutMs: requestTimeoutMs }))
          .sessions as SessionSummary[]
      },
      async import(session) {
        assertUsable()
        const result = await connection.call(
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
        assertUsable()
        const response = await connection.call(
          "session/tree",
          { sessionId },
          { timeoutMs: requestTimeoutMs }
        )
        return response.roots as readonly unknown[]
      },
      async forest() {
        assertUsable()
        const response = await connection.call(
          "session/forest",
          {},
          { timeoutMs: requestTimeoutMs }
        )
        return response.roots as readonly unknown[]
      },
    },
    tools: {
      async register(registration, handler) {
        assertUsable()
        toolHandlers.set(registration.handlerId, { registration, handler })
        try {
          await connection.call(
            "tool/register",
            { ...registration },
            { timeoutMs: requestTimeoutMs }
          )
        } catch (error) {
          toolHandlers.delete(registration.handlerId)
          throw error
        }
      },
      async unregister(handlerId) {
        assertUsable()
        await connection.call("tool/unregister", { handlerId }, { timeoutMs: requestTimeoutMs })
        toolHandlers.delete(handlerId)
      },
    },
    hooks: {
      async register(registration, handler) {
        assertUsable()
        hookHandlers.set(registration.handlerId, { registration, handler })
        try {
          await connection.call(
            "hook/register",
            { ...registration },
            { timeoutMs: requestTimeoutMs }
          )
        } catch (error) {
          hookHandlers.delete(registration.handlerId)
          throw error
        }
      },
      async unregister(handlerId) {
        assertUsable()
        await connection.call("hook/unregister", { handlerId }, { timeoutMs: requestTimeoutMs })
        hookHandlers.delete(handlerId)
      },
    },
    mcp: {
      configure(servers) {
        assertUsable()
        return connection.call(
          "mcp/configure",
          { servers: [...servers] },
          { timeoutMs: requestTimeoutMs }
        )
      },
      status() {
        assertUsable()
        return connection.call("mcp/status", {}, { timeoutMs: requestTimeoutMs })
      },
    },
    plugins: {
      reload(pluginId) {
        assertUsable()
        return connection.call(
          "plugin/reload",
          { ...(pluginId ? { pluginId } : {}) },
          { timeoutMs: requestTimeoutMs }
        )
      },
    },
    skills: {
      reload(skillId) {
        assertUsable()
        return connection.call(
          "skill/reload",
          { ...(skillId ? { skillId } : {}) },
          { timeoutMs: requestTimeoutMs }
        )
      },
    },
    tasks: {
      async list(sessionId) {
        assertUsable()
        const response = await connection.call(
          "task/list",
          { ...(sessionId ? { sessionId } : {}) },
          { timeoutMs: requestTimeoutMs }
        )
        return response.tasks
      },
      stop(taskId, commandOptions = {}) {
        assertUsable()
        return connection.call(
          "task/stop",
          { taskId, commandId: commandOptions.commandId ?? randomUUID() },
          { signal: commandOptions.signal, timeoutMs: commandOptions.timeoutMs ?? requestTimeoutMs }
        ) as Promise<CommandReceipt>
      },
      background(taskId, commandOptions = {}) {
        assertUsable()
        return connection.call(
          "task/background",
          { taskId, commandId: commandOptions.commandId ?? randomUUID() },
          { signal: commandOptions.signal, timeoutMs: commandOptions.timeoutMs ?? requestTimeoutMs }
        ) as Promise<CommandReceipt>
      },
    },
    traces: {
      async subscribe(subscribeOptions) {
        assertUsable()
        const normalized: TraceSubscribeOptions =
          typeof subscribeOptions === "string"
            ? { sessionId: subscribeOptions }
            : (subscribeOptions ?? {})
        const sessionId = normalized.sessionId
        const response = await connection.call(
          "trace/subscribe",
          {
            ...(sessionId ? { sessionId } : {}),
            ...(normalized.includeContent === true ? { includeContent: true } : {}),
          },
          { timeoutMs: requestTimeoutMs }
        )
        const subscriptionId = response.subscriptionId
        if (typeof subscriptionId !== "string") {
          throw new RpcError(
            RPC_ERROR_CODES.internalError,
            "host returned no trace subscription id"
          )
        }
        const localId = randomUUID()
        const channel = new TraceChannel()
        traceChannels.set(subscriptionId, {
          channel,
          localId,
          ...(sessionId !== undefined ? { sessionId } : {}),
        })
        traceByLocalId.set(localId, subscriptionId)

        const release = async () => {
          const hostId = traceByLocalId.get(localId)
          traceByLocalId.delete(localId)
          if (hostId === undefined) return
          traceChannels.delete(hostId)
          channel.close()
          if (!closed && client.runtime.supports(CAP_TRACE_UNSUBSCRIBE_V1)) {
            await connection
              .call(
                "trace/unsubscribe",
                { subscriptionId: hostId },
                { timeoutMs: requestTimeoutMs }
              )
              .catch(() => undefined)
          }
        }

        const subscription: TraceSubscription = {
          get subscriptionId() {
            return traceByLocalId.get(localId) ?? subscriptionId
          },
          [Symbol.asyncIterator]: () => channel.iterate(),
          unsubscribe: release,
          [Symbol.asyncDispose]: release,
        }
        return subscription
      },
      export(traceOptions = {}) {
        assertUsable()
        return connection.call("trace/export", traceOptions, { timeoutMs: requestTimeoutMs })
      },
    },
    audit: {
      query(queryOptions = {}) {
        assertUsable()
        return connection.call("audit/query", queryOptions, {
          timeoutMs: requestTimeoutMs,
        }) as unknown as Promise<AuditPage>
      },
    },
    async close() {
      if (closed) return
      closed = true
      for (const session of [...sessions.values()]) await session.close().catch(() => undefined)
      for (const hub of hubs.values()) hub.close()
      hubs.clear()
      for (const entry of traceChannels.values()) entry.channel.close()
      traceChannels.clear()
      traceByLocalId.clear()
      callbackReceipts.clear()
      await connection.call("shutdown", {}, { timeoutMs: requestTimeoutMs }).catch(() => undefined)
      await connection.close()
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
