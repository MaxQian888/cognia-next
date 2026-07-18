/**
 * A2A (Agent2Agent) protocol adapter — interop with external A2A-speaking
 * agents over the JSON-RPC binding (Thread D).
 *
 * A2A is Google's / the Linux Foundation's open agent-interop protocol. Unlike
 * ACP (a local stdio coding agent), an A2A agent is a remote HTTP service:
 *  - Discovery: GET `<base>/.well-known/agent-card.json` → AgentCard
 *    (name, url, capabilities.streaming, skills).
 *  - Send: JSON-RPC 2.0 `message/send` (await final Task) or `message/stream`
 *    (Server-Sent Events of JSON-RPC responses) to the agent's url.
 *  - Cancel: `tasks/cancel` with the in-flight task id.
 *
 * This adapter maps A2A's Task / Message / status-update / artifact-update
 * results onto Cognia's `ExternalAgentEvent` stream, so an A2A agent can back a
 * team teammate or be dispatched like any other external agent. It reuses the
 * `ProtocolAdapter` contract + `BaseProtocolAdapter.execute()` event collector.
 *
 * Spec: https://a2a-protocol.org/latest/specification/ (JSON-RPC binding).
 */

import type {
  ExternalAgentConfig,
  ExternalAgentSession,
  ExternalAgentMessage,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  AcpCapabilities,
} from "@/types/agent/external-agent"
import { BaseProtocolAdapter, type SessionCreateOptions } from "./protocol-adapter"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

/** A2A TaskState string values (JSON-RPC binding). */
export type A2aTaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "unknown"

type A2aWireTaskState =
  | A2aTaskState
  | "TASK_STATE_UNSPECIFIED"
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED"

interface A2aFilePayload {
  name?: string
  mimeType?: string
  /** Base64-encoded inline bytes (FilePart with FileWithBytes). */
  bytes?: string
  /** Remote URI (FilePart with FileWithUri). */
  uri?: string
}

interface A2aPart {
  kind?: "text" | "file" | "data"
  text?: string
  /** FilePart payload (A2A §6.6). */
  file?: A2aFilePayload
  /** DataPart structured JSON payload (A2A §6.6). */
  data?: unknown
  /** A2A 1.0 file bytes / URL fields (member presence is the discriminator). */
  raw?: string
  url?: string
  filename?: string
  mediaType?: string
}

interface A2aMessage {
  kind?: "message"
  messageId?: string
  role?: "user" | "agent" | "ROLE_USER" | "ROLE_AGENT"
  parts?: A2aPart[]
  contextId?: string
  taskId?: string
}

interface A2aTaskStatus {
  state: A2aWireTaskState
  message?: A2aMessage
  timestamp?: string
}

interface A2aTask {
  kind?: "task"
  id: string
  contextId?: string
  status: A2aTaskStatus
  artifacts?: Array<{ artifactId?: string; parts?: A2aPart[] }>
  history?: A2aMessage[]
}

interface A2aStatusUpdate {
  kind: "status-update"
  taskId: string
  contextId?: string
  status: A2aTaskStatus
  final?: boolean
}

interface A2aArtifactUpdate {
  kind: "artifact-update"
  taskId: string
  contextId?: string
  artifact: { artifactId?: string; parts?: A2aPart[] }
  /**
   * When true, the artifact's parts are appended to the previously-streamed
   * content for the same `artifactId`; when false/absent the parts replace it
   * (the first/only chunk of a fresh artifact). A2A §7.2.1.
   */
  append?: boolean
  /** Marks the final chunk of a multi-part artifact. */
  lastChunk?: boolean
}

/** Any A2A result an RPC / stream event can carry. */
export type A2aResult = A2aMessage | A2aTask | A2aStatusUpdate | A2aArtifactUpdate

interface A2aV1Response {
  task?: A2aTask
  message?: A2aMessage
  statusUpdate?: Omit<A2aStatusUpdate, "kind" | "final">
  artifactUpdate?: Omit<A2aArtifactUpdate, "kind">
}

type A2aWireResult = A2aResult | A2aV1Response

/** JSON-RPC 2.0 error object (A2A §8). */
export interface A2aRpcErrorBody {
  code: number
  message: string
  data?: unknown
}

/** A JSON-RPC error surfaced from an A2A RPC or stream frame. */
export class A2aRpcError extends Error {
  readonly code: number
  readonly data?: unknown
  constructor(method: string, body: A2aRpcErrorBody) {
    super(`A2A ${method} error ${body.code}: ${body.message}`)
    this.name = "A2aRpcError"
    this.code = body.code
    this.data = body.data
  }
}

interface AgentCard {
  name?: string
  description?: string
  url?: string
  capabilities?: { streaming?: boolean; pushNotifications?: boolean }
  skills?: Array<{ name?: string; description?: string }>
  /** §5.7 — agent serves an authenticated extended card with more detail. */
  supportsAuthenticatedExtendedCard?: boolean
  /** A2A 1.0 interfaces, ordered by preference. */
  supportedInterfaces?: Array<{
    url: string
    protocolBinding: string
    protocolVersion: string
    tenant?: string
  }>
}

/** Per-session A2A context (the contextId threads a multi-turn conversation). */
interface A2aSessionCtx {
  contextId: string
  taskId?: string
}

/**
 * Render an A2A part list to a text representation. Text parts pass through;
 * file and data parts are surfaced as a compact, human-readable marker rather
 * than being silently dropped (the canonical event stream has no file/data
 * delta, so a textual projection is the lossless-enough fallback).
 */
function textOfParts(parts: A2aPart[] | undefined): string {
  if (!parts) return ""
  const out: string[] = []
  for (const p of parts) {
    const kind =
      p.kind ??
      (typeof p.text === "string"
        ? "text"
        : p.raw !== undefined || p.url !== undefined
          ? "file"
          : p.data !== undefined
            ? "data"
            : "text")
    if (kind === "text" && typeof p.text === "string") {
      out.push(p.text)
    } else if (kind === "file" && (p.file || p.raw !== undefined || p.url !== undefined)) {
      const label = p.file?.name ?? p.filename ?? p.file?.uri ?? p.url ?? "file"
      const uri = p.file?.uri ?? p.url
      const inline = p.file?.bytes ?? p.raw
      const where = uri ? ` (${uri})` : inline ? " (inline)" : ""
      const mimeType = p.file?.mimeType ?? p.mediaType
      const mime = mimeType ? ` ${mimeType}` : ""
      out.push(`[file: ${label}${mime}${where}]`)
    } else if (kind === "data" && p.data !== undefined) {
      try {
        out.push(`\n\`\`\`json\n${JSON.stringify(p.data, null, 2)}\n\`\`\`\n`)
      } catch {
        out.push("[data]")
      }
    }
  }
  return out.join("")
}

/**
 * Map one A2A result object onto Cognia events, threading the session ctx
 * (taskId / contextId). Pure + exported so the marshaling is unit-testable
 * without a live HTTP server.
 */
export function mapA2aResult(
  wireResult: A2aWireResult,
  ctx: A2aSessionCtx
): { events: ExternalAgentEvent[]; done: boolean } {
  const result = unwrapA2aResult(wireResult)
  const now = new Date()
  const events: ExternalAgentEvent[] = []
  const pushText = (text: string) => {
    if (text) events.push({ type: "message_delta", timestamp: now, delta: { type: "text", text } })
  }
  const kind =
    result.kind ??
    ("artifact" in result
      ? "artifact-update"
      : "status" in result
        ? "id" in result
          ? "task"
          : "status-update"
        : "message")

  if (kind === "message") {
    const msg = result as A2aMessage
    if (msg.contextId) ctx.contextId = msg.contextId
    if (msg.taskId) ctx.taskId = msg.taskId
    pushText(textOfParts(msg.parts))
    // A bare message reply (no task) is a complete turn.
    events.push({ type: "done", timestamp: now, success: true })
    return { events, done: true }
  }

  if (kind === "artifact-update") {
    const upd = result as A2aArtifactUpdate
    ctx.taskId = upd.taskId
    if (upd.contextId) ctx.contextId = upd.contextId
    pushText(textOfParts(upd.artifact?.parts))
    return { events, done: false }
  }

  // task or status-update — both carry a TaskStatus.
  const status = (result as A2aTask | A2aStatusUpdate).status
  const taskId = "id" in result ? (result as A2aTask).id : (result as A2aStatusUpdate).taskId
  if (taskId) ctx.taskId = taskId
  const contextId = (result as A2aTask | A2aStatusUpdate).contextId
  if (contextId) ctx.contextId = contextId

  // The status carries an optional message; emit its text.
  pushText(textOfParts(status?.message?.parts))
  // A full Task object may also carry artifacts.
  if (kind === "task") {
    for (const art of (result as A2aTask).artifacts ?? []) pushText(textOfParts(art.parts))
  }

  const state = normalizeTaskState(status?.state)
  const isFinal = "final" in result ? Boolean((result as A2aStatusUpdate).final) : false

  switch (state) {
    case "submitted":
    case "working":
      events.push({ type: "progress", timestamp: now, progress: 0, message: state })
      return { events, done: false }
    case "input-required":
    case "auth-required":
      // The agent paused for more input or for credentials — both are
      // *interrupted* (resumable) states per the spec, not failures. Treat as
      // an end-of-turn done so the caller surfaces the prompt and can re-drive
      // the same contextId (with credentials, for auth-required) to continue.
      events.push({ type: "done", timestamp: now, success: true, stopReason: "end_turn" })
      return { events, done: true }
    case "completed":
      events.push({ type: "done", timestamp: now, success: true })
      return { events, done: true }
    case "canceled":
      events.push({ type: "done", timestamp: now, success: false, stopReason: "cancelled" })
      return { events, done: true }
    case "failed":
    case "rejected":
      events.push({
        type: "error",
        timestamp: now,
        error: `A2A task ${state}${status?.message ? `: ${textOfParts(status.message.parts)}` : ""}`,
        code: state,
      })
      return { events, done: true }
    default:
      // Unknown — only terminate if the stream said this was the final event.
      if (isFinal) events.push({ type: "done", timestamp: now, success: true })
      return { events, done: isFinal }
  }
}

function unwrapA2aResult(result: A2aWireResult): A2aResult {
  if ("task" in result && result.task) return result.task
  if ("message" in result && result.message) return result.message
  if ("statusUpdate" in result && result.statusUpdate) {
    return { kind: "status-update", ...result.statusUpdate }
  }
  if ("artifactUpdate" in result && result.artifactUpdate) {
    return { kind: "artifact-update", ...result.artifactUpdate }
  }
  return result as A2aResult
}

function normalizeTaskState(state: A2aWireTaskState | undefined): A2aTaskState {
  const states: Record<string, A2aTaskState> = {
    TASK_STATE_UNSPECIFIED: "unknown",
    TASK_STATE_SUBMITTED: "submitted",
    TASK_STATE_WORKING: "working",
    TASK_STATE_COMPLETED: "completed",
    TASK_STATE_FAILED: "failed",
    TASK_STATE_CANCELED: "canceled",
    TASK_STATE_INPUT_REQUIRED: "input-required",
    TASK_STATE_REJECTED: "rejected",
    TASK_STATE_AUTH_REQUIRED: "auth-required",
  }
  return state ? (states[state] ?? (state as A2aTaskState)) : "unknown"
}

export interface A2aClientDeps {
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export class A2aClientAdapter extends BaseProtocolAdapter {
  readonly protocol = "a2a"

  private readonly fetchImpl: typeof fetch
  private endpoint = ""
  private rpcUrl = ""
  private headers: Record<string, string> = {}
  private card?: AgentCard
  private protocolVersion: "0.3" | "1.0" = "0.3"
  private tenant?: string
  private readonly sessionCtx = new Map<string, A2aSessionCtx>()
  private rpcId = 0

  constructor(deps: A2aClientDeps = {}) {
    super()
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  async connect(config: ExternalAgentConfig): Promise<void> {
    this._config = config
    const net = config.network
    if (!net?.endpoint) {
      throw new Error("A2A agent requires network.endpoint")
    }
    this._connectionStatus = "connecting"
    this.endpoint = net.endpoint.replace(/\/$/, "")
    this.headers = buildAuthHeaders(net)

    // Discover the Agent Card. A reachable card sets streaming capability; a
    // missing card degrades to non-streaming rather than failing the connect.
    this.card = await this.fetchAgentCard().catch(() => undefined)
    const jsonRpcInterface = this.card?.supportedInterfaces?.find(
      (candidate) =>
        candidate.protocolBinding.toUpperCase() === "JSONRPC" &&
        (candidate.protocolVersion === "0.3" || candidate.protocolVersion === "1.0")
    )
    if (this.card?.supportedInterfaces !== undefined && !jsonRpcInterface) {
      throw new Error("A2A agent does not advertise a supported JSON-RPC interface")
    }
    this.protocolVersion = jsonRpcInterface?.protocolVersion === "1.0" ? "1.0" : "0.3"
    this.tenant = jsonRpcInterface?.tenant
    this.rpcUrl = net.rpcEndpoint ?? jsonRpcInterface?.url ?? this.card?.url ?? this.endpoint
    this._capabilities = toAcpCapabilities(this.card)
    this._connectionStatus = "connected"
  }

  async disconnect(): Promise<void> {
    this.sessionCtx.clear()
    this._sessions.clear()
    this._connectionStatus = "disconnected"
  }

  async createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession> {
    const id = this.generateSessionId()
    const now = new Date()
    const session: ExternalAgentSession = {
      id,
      agentId: this._config?.id ?? "a2a",
      status: "active",
      ...(options?.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(this._capabilities ? { capabilities: this._capabilities } : {}),
      createdAt: now,
      lastActivityAt: now,
    }
    this._sessions.set(id, session)
    // A fresh A2A contextId threads this session's multi-turn conversation.
    this.sessionCtx.set(id, { contextId: this.generateSessionId() })
    return session
  }

  async closeSession(sessionId: string): Promise<void> {
    this._sessions.delete(sessionId)
    this.sessionCtx.delete(sessionId)
  }

  async *prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    const ctx = this.sessionCtx.get(sessionId) ?? { contextId: this.generateSessionId() }
    this.sessionCtx.set(sessionId, ctx)

    try {
      const isV1 = this.protocolVersion === "1.0"
      const parts = buildA2aParts(message, isV1)

      const a2aMessage: A2aMessage = {
        ...(isV1 ? {} : { kind: "message" as const }),
        messageId: this.generateMessageId(),
        role: isV1 ? "ROLE_USER" : "user",
        parts,
        contextId: ctx.contextId,
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      }
      if (!hasNoLeakingPiiDeep(a2aMessage)) {
        throw new Error("A2A outbound payload blocked by the PII gate")
      }

      const streaming = this.card?.capabilities?.streaming !== false
      if (streaming) {
        yield* this.streamPrompt(a2aMessage, ctx, options?.signal)
      } else {
        yield* this.sendPrompt(a2aMessage, ctx, options?.signal)
      }
    } catch (err) {
      if (options?.signal?.aborted) {
        yield { type: "done", timestamp: new Date(), success: false, stopReason: "cancelled" }
        return
      }
      yield {
        type: "error",
        timestamp: new Date(),
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** Non-streaming `message/send` — one JSON-RPC response carrying a Task/Message. */
  private async *sendPrompt(
    message: A2aMessage,
    ctx: A2aSessionCtx,
    signal?: AbortSignal
  ): AsyncIterable<ExternalAgentEvent> {
    // `rpc` throws an A2aRpcError on a JSON-RPC error body, surfaced by the
    // caller's catch as an `error` event.
    const res = await this.rpc(
      this.method("message/send", "SendMessage"),
      this.params({ message }),
      signal
    )
    const result = (res?.result ?? res) as A2aWireResult
    const { events } = mapA2aResult(result, ctx)
    for (const ev of events) yield ev
  }

  /**
   * Streaming `message/stream` — Server-Sent Events of JSON-RPC responses.
   * If the SSE stream drops before a terminal event and the agent assigned a
   * task id, recover once via `tasks/resubscribe` (A2A §7.9) so a transient
   * disconnect does not strand the turn with no `done`/`error`.
   */
  private async *streamPrompt(
    message: A2aMessage,
    ctx: A2aSessionCtx,
    signal?: AbortSignal
  ): AsyncIterable<ExternalAgentEvent> {
    const initial = await this.openSseStream(
      this.method("message/stream", "SendStreamingMessage"),
      this.params({ message }),
      signal
    )
    let done = yield* this.consumeSse(initial, ctx, signal)
    if (done) return

    // Stream ended without a terminal event. Recover once by resubscribing to
    // the task (if one was created), else fall back to a one-shot tasks/get.
    if (ctx.taskId) {
      try {
        const resub = await this.openSseStream(
          this.method("tasks/resubscribe", "SubscribeToTask"),
          this.params({ id: ctx.taskId }),
          signal
        )
        done = yield* this.consumeSse(resub, ctx, signal)
        if (done) return
      } catch {
        // resubscribe unsupported — fall through to tasks/get.
      }
      const polled = await this.getTask(ctx.taskId, signal).catch(() => undefined)
      if (polled) {
        const { events, done: polledDone } = mapA2aResult(polled, ctx)
        for (const ev of events) yield ev
        if (polledDone) return
      }
    }
    // A stream without a terminal state is incomplete, even if the connection
    // itself closed cleanly. Surface the truncation instead of fabricating a
    // successful turn.
    yield {
      type: "error",
      timestamp: new Date(),
      error: "A2A stream ended before a terminal task state",
      recoverable: false,
    }
    yield { type: "done", timestamp: new Date(), success: false, stopReason: "error" }
  }

  /** Open an SSE POST for a streaming method and validate the response. */
  private async openSseStream(
    method: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    const response = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...this.requestHeaders(),
      },
      body: JSON.stringify(this.jsonRpc(method, params)),
      ...(signal ? { signal } : {}),
    })
    if (!response.ok || !response.body) {
      throw new Error(`A2A ${method} failed: HTTP ${response.status}`)
    }
    return response
  }

  /**
   * Consume one SSE response: yield mapped events, surface JSON-RPC error
   * frames as `error` events, and return whether a terminal event was seen.
   */
  private async *consumeSse(
    response: Response,
    ctx: A2aSessionCtx,
    _signal?: AbortSignal
  ): AsyncGenerator<ExternalAgentEvent, boolean, undefined> {
    for await (const data of readSse(response.body as ReadableStream<Uint8Array>)) {
      let parsed: { result?: A2aWireResult; error?: A2aRpcErrorBody } | A2aWireResult
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }
      const errBody = (parsed as { error?: A2aRpcErrorBody }).error
      if (errBody && typeof errBody.code === "number") {
        yield {
          type: "error",
          timestamp: new Date(),
          error: `A2A stream error ${errBody.code}: ${errBody.message}`,
          code: String(errBody.code),
        }
        yield { type: "done", timestamp: new Date(), success: false }
        return true
      }
      const result = ((parsed as { result?: A2aWireResult }).result ?? parsed) as A2aWireResult
      const { events, done } = mapA2aResult(result, ctx)
      for (const ev of events) yield ev
      if (done) return true
    }
    return false
  }

  /** `tasks/get` — fetch the current state of a task (poll / drop recovery). */
  private async getTask(taskId: string, signal?: AbortSignal): Promise<A2aWireResult | undefined> {
    const res = await this.rpc(
      this.method("tasks/get", "GetTask"),
      this.params({ id: taskId }),
      signal
    )
    return (res?.result ?? res) as A2aWireResult | undefined
  }

  async respondToPermission(): Promise<void> {
    // A2A has no ACP-style interactive permission prompts — no-op.
  }

  async cancel(sessionId: string): Promise<void> {
    const ctx = this.sessionCtx.get(sessionId)
    if (ctx?.taskId) {
      await this.rpc(
        this.method("tasks/cancel", "CancelTask"),
        this.params({ id: ctx.taskId })
      ).catch(() => undefined)
    }
  }

  override async healthCheck(): Promise<boolean> {
    if (!this.endpoint) return false
    const card = await this.fetchAgentCard().catch(() => undefined)
    return Boolean(card)
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async fetchAgentCard(): Promise<AgentCard> {
    // Current spec path is `/.well-known/agent-card.json`; older agents only
    // serve the legacy `/.well-known/agent.json`. Try the canonical path first
    // and fall back so both generations of agents are discoverable.
    try {
      return await this.fetchCardAt(`${this.endpoint}/.well-known/agent-card.json`, "1.0")
    } catch {
      return await this.fetchCardAt(`${this.endpoint}/.well-known/agent.json`)
    }
  }

  private async fetchCardAt(url: string, version?: string): Promise<AgentCard> {
    const res = await this.fetchImpl(url, {
      headers: { ...this.headers, ...(version ? { "A2A-Version": version } : {}) },
    })
    if (!res.ok) throw new Error(`agent card HTTP ${res.status}`)
    return (await res.json()) as AgentCard
  }

  private jsonRpc(method: string, params: unknown) {
    this.rpcId += 1
    return { jsonrpc: "2.0", id: this.rpcId, method, params }
  }

  private method(legacy: string, v1: string): string {
    return this.protocolVersion === "1.0" ? v1 : legacy
  }

  private params<T extends Record<string, unknown>>(params: T): T & { tenant?: string } {
    return this.protocolVersion === "1.0" && this.tenant
      ? { tenant: this.tenant, ...params }
      : params
  }

  private requestHeaders(): Record<string, string> {
    return {
      ...this.headers,
      ...(this.protocolVersion === "1.0" ? { "A2A-Version": "1.0" } : {}),
    }
  }

  private async rpc(
    method: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<{ result?: A2aWireResult } | undefined> {
    const res = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.requestHeaders() },
      body: JSON.stringify(this.jsonRpc(method, params)),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) throw new Error(`A2A ${method} failed: HTTP ${res.status}`)
    const body = (await res.json()) as { result?: A2aWireResult; error?: A2aRpcErrorBody }
    // A JSON-RPC error is delivered with HTTP 200 and an `error` member; without
    // this check a `TaskNotFound` / `UnsupportedOperation` / method-not-found
    // would be mis-read as a successful result.
    if (body?.error && typeof body.error.code === "number") {
      throw new A2aRpcError(method, body.error)
    }
    return body
  }
}

/**
 * Build the A2A parts array for an outbound message from Cognia's content
 * blocks. Text → TextPart; image/file → FilePart (inline base64 or URI);
 * structured data is not produced from chat content (no source block).
 */
function buildA2aParts(message: ExternalAgentMessage, v1: boolean): A2aPart[] {
  const parts: A2aPart[] = []
  for (const c of message.content) {
    if (c.type === "text") {
      if (c.text) parts.push(v1 ? { text: c.text } : { kind: "text", text: c.text })
    } else if (c.type === "image") {
      const hasUrl = c.source.type === "url" && Boolean(c.source.url)
      const hasData = c.source.type !== "url" && c.source.data !== undefined
      if (!hasUrl && !hasData) {
        throw new Error("A2A image content or URL is required")
      }
      if (v1) {
        parts.push({
          ...(hasUrl ? { url: c.source.url } : { raw: c.source.data }),
          ...(c.alt ? { filename: c.alt } : {}),
          mediaType: c.source.mediaType,
        })
      } else {
        const file: A2aFilePayload = { mimeType: c.source.mediaType }
        if (hasUrl) file.uri = c.source.url
        else file.bytes = c.source.data
        if (c.alt) file.name = c.alt
        parts.push({ kind: "file", file })
      }
    } else if (c.type === "file") {
      if (c.content !== undefined && c.encoding !== "base64") {
        parts.push(v1 ? { text: c.content } : { kind: "text", text: c.content })
      } else if (c.content !== undefined && v1) {
        parts.push({
          raw: c.content,
          filename: c.path,
          ...(c.mimeType ? { mediaType: c.mimeType } : {}),
        })
      } else if (c.content !== undefined) {
        const file: A2aFilePayload = { name: c.path }
        if (c.mimeType) file.mimeType = c.mimeType
        file.bytes = c.content
        parts.push({ kind: "file", file })
      } else if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(c.path)) {
        if (v1) {
          parts.push({
            url: c.path,
            filename: c.path,
            ...(c.mimeType ? { mediaType: c.mimeType } : {}),
          })
        } else {
          parts.push({
            kind: "file",
            file: { uri: c.path, name: c.path, ...(c.mimeType ? { mimeType: c.mimeType } : {}) },
          })
        }
      } else {
        throw new Error(`A2A file content or URL is required for path-only file: ${c.path}`)
      }
    }
  }
  // A2A requires at least one part; default to an empty text part.
  if (parts.length === 0) parts.push(v1 ? { text: "" } : { kind: "text", text: "" })
  return parts
}

function buildAuthHeaders(net: ExternalAgentConfig["network"]): Record<string, string> {
  const headers: Record<string, string> = { ...(net?.headers ?? {}) }
  if (net?.authMethod === "bearer" && net.bearerToken) {
    headers.authorization = `Bearer ${net.bearerToken}`
  } else if (net?.authMethod === "api-key" && net.apiKey) {
    headers["x-api-key"] = net.apiKey
  }
  return headers
}

function toAcpCapabilities(card: AgentCard | undefined): AcpCapabilities | undefined {
  if (!card) return undefined
  return { streaming: card.capabilities?.streaming ?? false } as AcpCapabilities
}

/**
 * Read a fetch ReadableStream body as Server-Sent Events, yielding each event's
 * concatenated `data:` payload. Minimal SSE framing (blank-line-delimited
 * blocks); ignores comments + other fields.
 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const dataFromBlock = (block: string): string =>
    block
      .split(/\r\n|\r|\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let separator = /(?:\r\n|\r|\n){2}/.exec(buffer)
      while (separator) {
        const block = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const data = dataFromBlock(block)
        if (data) yield data
        separator = /(?:\r\n|\r|\n){2}/.exec(buffer)
      }
    }
    buffer += decoder.decode()
    const trailingData = dataFromBlock(buffer)
    if (trailingData) yield trailingData
  } finally {
    reader.releaseLock()
  }
}
