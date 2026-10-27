import type { SessionCreateOptions } from "@cognia/agent-contracts/adapter"
import type {
  AgentApprovalPolicy,
  AgentDiagnosticRedactor,
  AgentFetch,
  AgentOutboundGate,
  AgentToolPreApproval,
} from "@cognia/agent-contracts/host"
import type {
  AcpPermissionRequest,
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentSession,
} from "@cognia/agent-contracts/external-agent"
import { BaseProtocolAdapter } from "@cognia/agent-runtime-kit/base-adapter"
import { promptInputPassesGate } from "@cognia/agent-runtime-kit/prompt-gate"
import { CrushEventDecoder, readCrushStream } from "./events"
import { CRUSH_EXECUTION_SEMANTICS, CRUSH_PROTOCOL } from "./manifest"

export interface CrushOwnedService {
  endpoint: string
  headers?: Record<string, string>
  close(): Promise<void>
}
export type CrushServiceLauncher = (
  config: ExternalAgentConfig,
  cwd: string,
  signal?: AbortSignal
) => Promise<CrushOwnedService>
export interface CrushClientDeps {
  fetch: AgentFetch
  outboundGate: AgentOutboundGate
  redactDiagnostic: AgentDiagnosticRedactor
  approvalPolicy: AgentApprovalPolicy
  isToolPreApproved?: AgentToolPreApproval
  launch?: CrushServiceLauncher
}
interface NativeSession {
  service: CrushOwnedService
  workspaceId: string
  clientId: string
  preamble: string
  abort?: AbortController
  pending: Map<string, Record<string, unknown>>
  cancelled: boolean
}

/** Released Crush v1 HTTP API. Every machine operation remains behind host ports. */
export class CrushAdapter extends BaseProtocolAdapter {
  readonly protocol = CRUSH_PROTOCOL
  readonly semantics = CRUSH_EXECUTION_SEMANTICS
  private states = new Map<string, NativeSession>()
  constructor(private readonly deps: CrushClientDeps) {
    super()
  }
  async connect(config: ExternalAgentConfig): Promise<void> {
    await this.disconnect()
    this._connectionStatus = "connecting"
    try {
      if (config.requireApprovalFor?.length)
        throw new Error(
          "Crush cannot force an approval for native tools that do not request permission"
        )
      if (!config.network?.endpoint && !this.deps.launch)
        throw new Error("Crush needs a confined service launcher or loopback endpoint")
      if (config.network?.endpoint) {
        endpoint(config.network.endpoint)
        await this.request(fromConfig(config), "/v1/health")
      }
      this._config = config
      this._capabilities = { streaming: true, mcpTools: false }
      this._connectionStatus = "connected"
    } catch (error) {
      this._connectionStatus = "error"
      throw error
    }
  }
  async disconnect(): Promise<void> {
    await Promise.all([...this.states.keys()].map((id) => this.closeSession(id)))
    this._sessions.clear()
    this._connectionStatus = "disconnected"
  }
  async createSession(options: SessionCreateOptions = {}): Promise<ExternalAgentSession> {
    return this.open(undefined, options)
  }
  async resumeSession(
    id: string,
    options: SessionCreateOptions = {}
  ): Promise<ExternalAgentSession> {
    if (this.states.has(id)) return this._sessions.get(id)!
    return this.open(id, options)
  }
  private async open(
    id: string | undefined,
    options: SessionCreateOptions
  ): Promise<ExternalAgentSession> {
    if (!this.isConnected() || !this._config) throw new Error("Crush is not connected")
    rejectUnsupported(options)
    const cwd = options.cwd ?? this._config.process?.cwd
    if (!cwd || !/^(?:\/|[A-Za-z]:[\\/])/.test(cwd) || cwd.includes("\0"))
      throw new Error("Crush requires an absolute workspace")
    const preamble = instructions(options)
    if (!this.deps.outboundGate(preamble))
      throw new Error("Crush instructions blocked by the PII gate")
    const service = this.deps.launch
      ? await this.deps.launch(this._config, cwd)
      : fromConfig(this._config)
    let state: NativeSession | undefined
    try {
      endpoint(service.endpoint)
      await this.request(service, "/v1/health")
      const clientId = crypto.randomUUID()
      const workspace = object(
        await (
          await this.request(service, "/v1/workspaces", "POST", {
            path: cwd,
            client_id: clientId,
            yolo: false,
          })
        ).json()
      )
      const workspaceId = nonempty(workspace.id)
      if (!workspaceId) throw new Error("Crush did not return a workspace identity")
      state = { service, workspaceId, clientId, preamble, pending: new Map(), cancelled: false }
      await this.request(service, path(state, "/agent/init"), "POST", { interactive: true })
      const native = object(
        await (
          await this.request(
            service,
            path(state, id ? `/sessions/${encodeURIComponent(id)}` : "/sessions"),
            id ? "GET" : "POST",
            id ? undefined : { title: "Cognia" }
          )
        ).json()
      )
      if (!nonempty(native.id) || (id && native.id !== id))
        throw new Error("Crush did not return the requested native session")
      id = String(native.id)
      const now = new Date()
      const session: ExternalAgentSession = {
        id,
        agentId: this._config.id,
        status: "active",
        permissionMode: options.permissionMode ?? this._config.defaultPermissionMode ?? "default",
        allowedTools: options.allowedTools,
        createdAt: now,
        lastActivityAt: now,
        metadata: { cwd, workspaceId, nativeSessionId: id },
      }
      this.states.set(id, state)
      this._sessions.set(id, session)
      return session
    } catch (error) {
      if (state)
        await this.request(
          service,
          `/v1/clients/${encodeURIComponent(state.clientId)}`,
          "DELETE"
        ).catch(() => {})
      await service.close()
      throw error
    }
  }
  async closeSession(id: string): Promise<void> {
    const state = this.states.get(id)
    if (!state) return
    try {
      await this.cancel(id)
      await this.request(
        state.service,
        `/v1/clients/${encodeURIComponent(state.clientId)}`,
        "DELETE"
      )
    } finally {
      await state.service.close()
      this.states.delete(id)
      this._sessions.delete(id)
    }
  }
  async cancel(id: string): Promise<void> {
    const state = this.states.get(id)
    if (!state?.abort) return
    state.cancelled = true
    try {
      await this.request(
        state.service,
        path(state, `/agent/sessions/${encodeURIComponent(id)}/cancel`),
        "POST"
      )
    } finally {
      state.pending.clear()
      state.abort.abort()
    }
  }
  async respondToPermission(id: string, response: AcpPermissionResponse): Promise<void> {
    const state = this.state(id),
      native = state.pending.get(response.requestId)
    if (!native) throw new Error("Crush permission request is not pending")
    await this.request(state.service, path(state, "/permissions/grant"), "POST", {
      permission: native,
      action: response.granted
        ? response.scope === "session"
          ? "allow_session"
          : "allow"
        : "deny",
    })
    state.pending.delete(response.requestId)
  }
  async *prompt(
    id: string,
    message: ExternalAgentMessage,
    options: ExternalAgentExecutionOptions = {}
  ): AsyncIterable<ExternalAgentEvent> {
    const state = this.state(id),
      session = this._sessions.get(id)!
    if (state.abort) throw new Error("Crush session already has a turn in flight")
    rejectUnsupported(options)
    const prompt = [
      state.preamble,
      instructions(options),
      ...message.content.map((part) => {
        if (part.type === "text") return part.text
        if (part.type === "file" && part.content !== undefined && part.encoding !== "base64")
          return `File context (${part.path}):\n${part.content}`
        throw new Error(`Crush does not support ${part.type} content through this adapter`)
      }),
    ]
      .filter(Boolean)
      .join("\n\n")
    if (
      !promptInputPassesGate(message, this.deps.outboundGate, { options }) ||
      !this.deps.outboundGate(prompt)
    )
      throw new Error("Crush prompt blocked by the PII gate")
    const controller = new AbortController()
    state.abort = controller
    state.cancelled = false
    const base = () => ({ sessionId: id, timestamp: new Date() })
    const messageId = this.generateMessageId(),
      runId = crypto.randomUUID(),
      prior = new Set<string>(),
      decoder = new CrushEventDecoder(id, runId, messageId, prior)
    const abort = () => {
      void this.cancel(id).catch(() => {})
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(abort, options.timeout ?? this._config?.timeout ?? 300_000)
    session.status = "executing"
    try {
      options.signal?.throwIfAborted()
      const history: unknown = await (
        await this.request(
          state.service,
          path(state, `/sessions/${encodeURIComponent(id)}/messages`)
        )
      ).json()
      if (!Array.isArray(history)) throw new Error("Malformed Crush session history")
      for (const message of history) {
        const native = object(message)
        if (typeof native.id !== "string") throw new Error("Malformed Crush message identity")
        prior.add(native.id)
      }
      await this.request(
        state.service,
        path(state, `/current-session?client_id=${encodeURIComponent(state.clientId)}`),
        "POST",
        { session_id: id }
      )
      const events = await this.request(
        state.service,
        path(state, `/events?client_id=${encodeURIComponent(state.clientId)}`),
        "GET",
        undefined,
        controller.signal
      )
      if (!events.body) throw new Error("Crush returned no event stream")
      // The subscription is established before posting, so a fast turn cannot outrun it.
      await this.request(
        state.service,
        path(state, "/agent"),
        "POST",
        { session_id: id, run_id: runId, prompt },
        controller.signal
      )
      yield { ...base(), type: "message_start", messageId, role: "assistant" }
      for await (const raw of readCrushStream(events.body)) {
        const wire = object(JSON.parse(raw))
        const inner = ["permission_request", "question_batch_request"].includes(String(wire.type))
          ? object(object(wire.payload).payload)
          : {}
        // The first-party server scopes this client's stream to the current
        // session and its descendants. Preserve child-session permissions so
        // native delegation cannot stall or lose the host approval boundary.
        if (wire.type === "permission_request" && nonempty(inner.session_id)) {
          const requestId = nonempty(inner.id),
            name = nonempty(inner.tool_name)
          if (!requestId || !name) throw new Error("Malformed Crush permission request")
          const request: AcpPermissionRequest = {
            id: requestId,
            requestId,
            sessionId: id,
            toolCallId: nonempty(inner.tool_call_id),
            title: nonempty(inner.description) ?? name,
            toolInfo: { id: name, name },
            rawInput: object(inner.params ?? {}),
          }
          state.pending.set(requestId, inner)
          const configured = this.deps.approvalPolicy(this._config, request),
            mode = options.permissionMode ?? session.permissionMode
          const granted =
            mode === "plan"
              ? false
              : configured === "ask"
                ? undefined
                : configured === "approve"
                  ? true
                  : mode === "bypassPermissions"
                    ? true
                    : mode === "dontAsk"
                      ? (this.deps.isToolPreApproved?.(
                          name,
                          request.rawInput,
                          options.allowedTools ?? session.allowedTools
                        ) ?? false)
                      : undefined
          if (granted === undefined) yield { ...base(), type: "permission_request", request }
          else await this.respondToPermission(id, { requestId, granted })
        } else if (wire.type === "question_batch_request" && nonempty(inner.session_id))
          throw new Error("Crush interactive questions require an unsupported elicitation control")
        for (const event of decoder.decode(wire))
          yield event.type === "error" && event.error
            ? { ...event, error: this.deps.redactDiagnostic(event.error) }
            : event
        if (decoder.ended) break
      }
      if (!decoder.ended && !state.cancelled)
        throw new Error("Crush stream ended without its run_complete event")
      if (!decoder.ended) yield { ...base(), type: "done", success: false, stopReason: "cancelled" }
    } catch (error) {
      if (!state.cancelled)
        yield {
          ...base(),
          type: "error",
          error: this.deps.redactDiagnostic(error instanceof Error ? error.message : String(error)),
        }
      yield {
        ...base(),
        type: "done",
        success: false,
        stopReason: state.cancelled ? "cancelled" : "refusal",
      }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      if (!decoder.ended)
        await this.request(
          state.service,
          path(state, `/agent/sessions/${encodeURIComponent(id)}/cancel`),
          "POST"
        ).catch(() => {})
      controller.abort()
      state.abort = undefined
      state.pending.clear()
      session.status = "active"
      session.lastActivityAt = new Date()
    }
  }
  private state(id: string): NativeSession {
    const value = this.states.get(id)
    if (!value) throw new Error("Unknown Crush session")
    return value
  }
  private async request(
    service: CrushOwnedService,
    route: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    if (body !== undefined && !this.deps.outboundGate(body))
      throw new Error("Crush payload blocked by the PII gate")
    const response = await this.deps.fetch(endpoint(service.endpoint) + route, {
      method,
      redirect: "error",
      headers: { "Content-Type": "application/json", ...service.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      timeout: route.includes("/events?") ? undefined : 15_000,
    })
    if (!response.ok) throw new Error(`Crush HTTP ${response.status}`)
    return response
  }
}
function path(state: NativeSession, suffix: string): string {
  return `/v1/workspaces/${encodeURIComponent(state.workspaceId)}${suffix}`
}
function endpoint(raw: string): string {
  const u = new URL(raw)
  if (
    !["http:", "https:"].includes(u.protocol) ||
    !["127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error("Crush requires a confined loopback origin")
  return u.origin
}
function fromConfig(config: ExternalAgentConfig): CrushOwnedService {
  return {
    endpoint: config.network!.endpoint,
    headers: {
      ...config.network?.headers,
      ...(config.network?.bearerToken
        ? { Authorization: `Bearer ${config.network.bearerToken}` }
        : {}),
    },
    close: async () => {},
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed Crush response")
  return value as Record<string, unknown>
}
function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}
function rejectUnsupported(options: SessionCreateOptions | ExternalAgentExecutionOptions): void {
  const o = options as SessionCreateOptions & ExternalAgentExecutionOptions
  if (o.mcpServers?.length || o.context?.custom?.mcpServers)
    throw new Error("Crush host MCP injection is not supported")
  if (o.additionalDirectories?.length || o.files?.length || o.model || o.reasoningEffort)
    throw new Error("Unsupported Crush workspace, model, or file control")
}
function instructions(options: SessionCreateOptions | ExternalAgentExecutionOptions): string {
  const o = options as SessionCreateOptions
  return [
    o.systemPrompt,
    o.instructionEnvelope?.developerInstructions,
    o.instructionEnvelope?.customInstructions,
    o.briefMode ? "Answer concisely." : undefined,
  ]
    .filter(Boolean)
    .join("\n\n")
}
