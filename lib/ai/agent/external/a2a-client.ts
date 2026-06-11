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

interface A2aPart {
  kind?: "text" | "file" | "data"
  text?: string
  data?: unknown
}

interface A2aMessage {
  kind?: "message"
  messageId?: string
  role?: "user" | "agent"
  parts?: A2aPart[]
  contextId?: string
  taskId?: string
}

interface A2aTaskStatus {
  state: A2aTaskState
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
}

/** Any A2A result an RPC / stream event can carry. */
export type A2aResult = A2aMessage | A2aTask | A2aStatusUpdate | A2aArtifactUpdate

interface AgentCard {
  name?: string
  description?: string
  url?: string
  capabilities?: { streaming?: boolean; pushNotifications?: boolean }
  skills?: Array<{ name?: string; description?: string }>
}

/** Per-session A2A context (the contextId threads a multi-turn conversation). */
interface A2aSessionCtx {
  contextId: string
  taskId?: string
}

function textOfParts(parts: A2aPart[] | undefined): string {
  if (!parts) return ""
  return parts
    .filter((p) => (p.kind ?? "text") === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
}

/**
 * Map one A2A result object onto Cognia events, threading the session ctx
 * (taskId / contextId). Pure + exported so the marshaling is unit-testable
 * without a live HTTP server.
 */
export function mapA2aResult(
  result: A2aResult,
  ctx: A2aSessionCtx
): { events: ExternalAgentEvent[]; done: boolean } {
  const now = new Date()
  const events: ExternalAgentEvent[] = []
  const pushText = (text: string) => {
    if (text) events.push({ type: "message_delta", timestamp: now, delta: { type: "text", text } })
  }
  const kind = result.kind ?? ("status" in result ? "task" : "message")

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

  const state = status?.state ?? "unknown"
  const isFinal = "final" in result ? Boolean((result as A2aStatusUpdate).final) : false

  switch (state) {
    case "submitted":
    case "working":
      events.push({ type: "progress", timestamp: now, progress: 0, message: state })
      return { events, done: false }
    case "input-required":
      // The agent paused for more input — treat as a completed turn so the
      // caller surfaces the prompt and can decide whether to continue.
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
    case "auth-required":
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
    this.rpcUrl = net.rpcEndpoint ?? this.card?.url ?? this.endpoint
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

    const text = message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")

    const a2aMessage: A2aMessage = {
      kind: "message",
      messageId: this.generateMessageId(),
      role: "user",
      parts: [{ kind: "text", text }],
      contextId: ctx.contextId,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
    }

    const streaming = this.card?.capabilities?.streaming !== false
    try {
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
    const res = await this.rpc("message/send", { message }, signal)
    const result = (res?.result ?? res) as A2aResult
    const { events } = mapA2aResult(result, ctx)
    for (const ev of events) yield ev
  }

  /** Streaming `message/stream` — Server-Sent Events of JSON-RPC responses. */
  private async *streamPrompt(
    message: A2aMessage,
    ctx: A2aSessionCtx,
    signal?: AbortSignal
  ): AsyncIterable<ExternalAgentEvent> {
    const response = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...this.headers },
      body: JSON.stringify(this.jsonRpc("message/stream", { message })),
      ...(signal ? { signal } : {}),
    })
    if (!response.ok || !response.body) {
      throw new Error(`A2A message/stream failed: HTTP ${response.status}`)
    }
    for await (const data of readSse(response.body)) {
      let parsed: { result?: A2aResult } | A2aResult
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }
      const result = ((parsed as { result?: A2aResult }).result ?? parsed) as A2aResult
      const { events, done } = mapA2aResult(result, ctx)
      for (const ev of events) yield ev
      if (done) return
    }
  }

  async respondToPermission(): Promise<void> {
    // A2A has no ACP-style interactive permission prompts — no-op.
  }

  async cancel(sessionId: string): Promise<void> {
    const ctx = this.sessionCtx.get(sessionId)
    if (ctx?.taskId) {
      await this.rpc("tasks/cancel", { id: ctx.taskId }).catch(() => undefined)
    }
  }

  override async healthCheck(): Promise<boolean> {
    if (!this.endpoint) return false
    const card = await this.fetchAgentCard().catch(() => undefined)
    return Boolean(card)
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async fetchAgentCard(): Promise<AgentCard> {
    const url = `${this.endpoint}/.well-known/agent-card.json`
    const res = await this.fetchImpl(url, { headers: this.headers })
    if (!res.ok) throw new Error(`agent card HTTP ${res.status}`)
    return (await res.json()) as AgentCard
  }

  private jsonRpc(method: string, params: unknown) {
    this.rpcId += 1
    return { jsonrpc: "2.0", id: this.rpcId, method, params }
  }

  private async rpc(
    method: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<{ result?: A2aResult } | undefined> {
    const res = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(this.jsonRpc(method, params)),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) throw new Error(`A2A ${method} failed: HTTP ${res.status}`)
    return (await res.json()) as { result?: A2aResult }
  }
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
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep = buffer.indexOf("\n\n")
      while (sep >= 0) {
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data) yield data
        sep = buffer.indexOf("\n\n")
      }
    }
  } finally {
    reader.releaseLock()
  }
}
