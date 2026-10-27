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
import { readRovoStream } from "./events"
import { ROVO_EXECUTION_SEMANTICS, ROVO_PROTOCOL } from "./manifest"

export interface RovoDevOwnedService {
  endpoint: string
  headers?: Record<string, string>
  close(): Promise<void>
}
export type RovoDevServiceLauncher = (
  config: ExternalAgentConfig,
  cwd: string,
  signal?: AbortSignal
) => Promise<RovoDevOwnedService>
export interface RovoDevClientDeps {
  fetch: AgentFetch
  outboundGate: AgentOutboundGate
  redactDiagnostic: AgentDiagnosticRedactor
  approvalPolicy: AgentApprovalPolicy
  isToolPreApproved?: AgentToolPreApproval
  launch?: RovoDevServiceLauncher
}
interface NativeSession {
  service: RovoDevOwnedService
  cwd: string
  preamble: string
  abort?: AbortController
  pending: Map<string, { request: AcpPermissionRequest; decision?: boolean }>
  cancelled: boolean
}

/** First-party native HTTP/SSE protocol, not ACP or rendered terminal scraping. */
export class RovoDevAdapter extends BaseProtocolAdapter {
  readonly protocol = ROVO_PROTOCOL
  readonly semantics = ROVO_EXECUTION_SEMANTICS
  private states = new Map<string, NativeSession>()
  private activeEndpoint = new Set<string>()
  constructor(private readonly deps: RovoDevClientDeps) {
    super()
  }

  async connect(config: ExternalAgentConfig): Promise<void> {
    await this.disconnect()
    this._connectionStatus = "connecting"
    try {
      if (!config.network?.endpoint && !this.deps.launch)
        throw new Error("Rovo Dev needs a confined service launcher or loopback endpoint")
      if (config.network?.endpoint) privateEndpoint(config.network.endpoint)
      this._config = config
      this._capabilities = { streaming: true, mcpTools: false }
      if (config.network?.endpoint && !this.deps.launch)
        await this.health(serviceFromConfig(config))
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
    if (!this.isConnected() || !this._config) throw new Error("Rovo Dev is not connected")
    rejectUnsupported(options)
    const cwd = options.cwd ?? this._config.process?.cwd
    if (!cwd || !/^(?:\/|[A-Za-z]:[\\/])/.test(cwd) || cwd.includes("\0"))
      throw new Error("Rovo Dev requires an absolute workspace")
    const preamble = instructions(options)
    if (!this.deps.outboundGate(preamble))
      throw new Error("Rovo Dev instructions blocked by the PII gate")
    const service = this.deps.launch
      ? await this.deps.launch(this._config, cwd)
      : serviceFromConfig(this._config)
    try {
      privateEndpoint(service.endpoint)
      await this.health(service)
      if (id) await this.request(service, `/v3/sessions/${encodeURIComponent(id)}/restore`, "POST")
      else {
        const created = await this.request(service, "/v3/sessions/create", "POST")
        id = created.headers.get("x-session-id") ?? undefined
      }
      const current = object(
        await (await this.request(service, "/v3/sessions/current_session")).json()
      )
      if (!id) id = string(current.id)
      if (!id || (current.id && current.id !== id))
        throw new Error("Rovo Dev did not return the requested native session")
      if (current.workspace_path && current.workspace_path !== cwd)
        throw new Error("Rovo Dev session belongs to another workspace")
      const now = new Date()
      const session: ExternalAgentSession = {
        id,
        agentId: this._config.id,
        status: "active",
        permissionMode: options.permissionMode ?? this._config.defaultPermissionMode ?? "default",
        allowedTools: options.allowedTools,
        createdAt: now,
        lastActivityAt: now,
        metadata: { cwd, nativeSessionId: id },
      }
      this.states.set(id, { service, cwd, preamble, pending: new Map(), cancelled: false })
      this._sessions.set(id, session)
      return session
    } catch (error) {
      await service.close()
      throw error
    }
  }
  async closeSession(id: string): Promise<void> {
    const state = this.states.get(id)
    if (!state) return
    await this.cancel(id)
    await state.service.close()
    this.states.delete(id)
    this._sessions.delete(id)
  }
  async cancel(id: string): Promise<void> {
    const state = this.states.get(id)
    if (!state?.abort) return
    state.cancelled = true
    try {
      await this.request(state.service, "/v3/cancel", "POST")
    } finally {
      state.pending.clear()
      state.abort.abort()
    }
  }
  async respondToPermission(id: string, response: AcpPermissionResponse): Promise<void> {
    const state = this.state(id)
    const pending = state.pending.get(response.requestId)
    if (!pending || pending.decision !== undefined)
      throw new Error("Rovo Dev permission request is not pending")
    pending.decision = response.granted
    await this.flushPermissions(state)
  }
  private async flushPermissions(state: NativeSession): Promise<void> {
    if (!state.pending.size || [...state.pending.values()].some((p) => p.decision === undefined))
      return
    const decisions = [...state.pending.values()].map((p) => ({
      tool_call_id: p.request.toolCallId,
      deny_message: p.decision ? null : "Denied by Cognia permission policy",
    }))
    await this.request(state.service, "/v3/resume_tool_calls", "POST", { decisions })
    state.pending.clear()
  }
  async *prompt(
    id: string,
    message: ExternalAgentMessage,
    options: ExternalAgentExecutionOptions = {}
  ): AsyncIterable<ExternalAgentEvent> {
    const state = this.state(id)
    const session = this._sessions.get(id)!
    if (state.abort || this.activeEndpoint.has(state.service.endpoint))
      throw new Error("Rovo Dev service already has a turn in flight")
    rejectUnsupported(options)
    const prompt = [
      state.preamble,
      instructions(options),
      ...message.content.map((part) => {
        if (part.type === "text") return part.text
        if (part.type === "file" && part.content !== undefined && part.encoding !== "base64")
          return `File context (${part.path}):\n${part.content}`
        throw new Error(`Rovo Dev does not support ${part.type} content through this adapter`)
      }),
    ]
      .filter(Boolean)
      .join("\n\n")
    if (
      !promptInputPassesGate(message, this.deps.outboundGate, { options }) ||
      !this.deps.outboundGate(prompt)
    )
      throw new Error("Rovo Dev prompt blocked by the PII gate")
    const controller = new AbortController()
    state.abort = controller
    state.cancelled = false
    this.activeEndpoint.add(state.service.endpoint)
    const abort = () => {
      void this.cancel(id).catch(() => {})
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(abort, options.timeout ?? this._config?.timeout ?? 300_000)
    const base = () => ({ sessionId: id, timestamp: new Date() })
    const messageId = this.generateMessageId()
    const calls = new Map<string, { name: string; args: string; ended: boolean }>()
    let lastTool = ""
    let complete = false
    let failed = false
    session.status = "executing"
    try {
      options.signal?.throwIfAborted()
      await this.request(state.service, `/v3/sessions/${encodeURIComponent(id)}/restore`, "POST")
      await this.request(
        state.service,
        "/v3/set_chat_message",
        "POST",
        { message: prompt, context: [] },
        controller.signal
      )
      const response = await this.request(
        state.service,
        "/v3/stream_chat?pause_on_call_tools_start=true&enable_deferred_tools=true",
        "GET",
        undefined,
        controller.signal
      )
      if (!response.body) throw new Error("Rovo Dev returned no event stream")
      yield { ...base(), type: "message_start", messageId, role: "assistant" }
      for await (const event of readRovoStream(response.body)) {
        const data = event.data
        if (event.kind === "text") {
          const text = string(data.content_delta) ?? string(data.content)
          if (text)
            yield { ...base(), type: "message_delta", messageId, delta: { type: "text", text } }
        } else if (event.kind === "tool-call") {
          const toolId = string(data.tool_call_id) ?? lastTool
          if (!toolId) throw new Error("Rovo Dev tool call has no identity")
          lastTool = toolId
          let call = calls.get(toolId)
          if (!call) {
            if (!string(data.tool_name)) throw new Error("Rovo Dev tool call has no name")
            call = { name: String(data.tool_name), args: "", ended: false }
            calls.set(toolId, call)
            yield { ...base(), type: "tool_use_start", toolUseId: toolId, toolName: call.name }
          }
          const delta =
            typeof data.args_delta === "string"
              ? data.args_delta
              : data.args !== undefined
                ? (typeof data.args === "string" ? data.args : JSON.stringify(data.args)).slice(
                    call.args.length
                  )
                : ""
          call.args += delta
          if (call.args.length > 1024 * 1024)
            throw new Error("Rovo Dev tool arguments exceeded the limit")
          if (delta) yield { ...base(), type: "tool_use_delta", toolUseId: toolId, delta }
        } else if (event.kind === "tool-return") {
          const toolId = string(data.tool_call_id)
          if (!toolId) throw new Error("Rovo Dev tool result has no identity")
          const call = calls.get(toolId)
          if (call && !call.ended) {
            call.ended = true
            yield {
              ...base(),
              type: "tool_use_end",
              toolUseId: toolId,
              input: object(JSON.parse(call.args || "{}")),
            }
          }
          yield {
            ...base(),
            type: "tool_result",
            toolUseId: toolId,
            result: typeof data.content === "string" ? data.content : object(data.content),
          }
        } else if (event.kind === "on_call_tools_start") {
          if (!Array.isArray(data.parts) || state.pending.size)
            throw new Error("Malformed or overlapping Rovo Dev permission batch")
          for (const raw of data.parts) {
            const tool = object(raw)
            const toolId = string(tool.tool_call_id),
              name = string(tool.tool_name)
            if (!toolId || !name) throw new Error("Malformed Rovo Dev permission tool")
            const input =
              typeof tool.args === "string"
                ? object(JSON.parse(tool.args || "{}"))
                : object(tool.args ?? {})
            const request: AcpPermissionRequest = {
              id: toolId,
              requestId: toolId,
              sessionId: id,
              toolCallId: toolId,
              title: name,
              toolInfo: { id: name, name },
              rawInput: input,
            }
            const configured = this.deps.approvalPolicy(this._config, request)
            const mode = options.permissionMode ?? session.permissionMode
            const native = object(data.permissions ?? {})[toolId]
            const decision =
              native === "DENIED" || mode === "plan"
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
                            input,
                            options.allowedTools ?? session.allowedTools
                          ) ?? false)
                        : undefined
            state.pending.set(toolId, { request, decision })
          }
          for (const p of state.pending.values())
            if (p.decision === undefined)
              yield { ...base(), type: "permission_request", request: p.request }
          await this.flushPermissions(state)
        } else if (event.kind === "exception") {
          failed = true
          yield {
            ...base(),
            type: "error",
            error: this.deps.redactDiagnostic(String(data.message ?? "Rovo Dev provider error")),
          }
        } else if (event.kind === "deferred-request")
          throw new Error(
            "Rovo Dev deferred questions are not supported; turn stopped before execution"
          )
        else if (event.kind === "close") {
          complete = true
          break
        }
      }
      if (!complete && !state.cancelled)
        throw new Error("Rovo Dev stream ended without its close event")
      yield { ...base(), type: "message_end", messageId }
      yield {
        ...base(),
        type: "done",
        success: complete && !failed && !state.cancelled,
        stopReason: state.cancelled ? "cancelled" : failed ? "refusal" : "end_turn",
      }
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
      if (!complete) await this.request(state.service, "/v3/cancel", "POST").catch(() => {})
      controller.abort()
      state.abort = undefined
      state.pending.clear()
      this.activeEndpoint.delete(state.service.endpoint)
      session.status = "active"
      session.lastActivityAt = new Date()
    }
  }
  private state(id: string): NativeSession {
    const state = this.states.get(id)
    if (!state) throw new Error("Unknown Rovo Dev session")
    return state
  }
  private async health(service: RovoDevOwnedService): Promise<void> {
    const value = object(await (await this.request(service, "/healthcheck")).json())
    if (value.status !== "healthy")
      throw new Error("Rovo Dev service is not healthy or needs authentication")
  }
  private async request(
    service: RovoDevOwnedService,
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    if (body !== undefined && !this.deps.outboundGate(body))
      throw new Error("Rovo Dev payload blocked by the PII gate")
    const response = await this.deps.fetch(privateEndpoint(service.endpoint) + path, {
      method,
      redirect: "error",
      headers: { "Content-Type": "application/json", ...service.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      timeout: method === "GET" && path.includes("stream_chat") ? undefined : 15_000,
    })
    if (!response.ok) throw new Error(`Rovo Dev HTTP ${response.status}`)
    return response
  }
}
function privateEndpoint(raw: string): string {
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
    throw new Error("Rovo Dev requires a confined loopback origin")
  return u.origin
}
function serviceFromConfig(config: ExternalAgentConfig): RovoDevOwnedService {
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
    throw new Error("Malformed Rovo Dev response")
  return value as Record<string, unknown>
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}
function rejectUnsupported(options: SessionCreateOptions | ExternalAgentExecutionOptions): void {
  const o = options as SessionCreateOptions & ExternalAgentExecutionOptions
  if (o.mcpServers?.length || o.context?.custom?.mcpServers)
    throw new Error("Rovo Dev host MCP injection is not supported")
  if (o.additionalDirectories?.length || o.files?.length || o.model || o.reasoningEffort)
    throw new Error("Unsupported Rovo Dev workspace, model, or file control")
}
function instructions(options: SessionCreateOptions | ExternalAgentExecutionOptions): string {
  return [
    options.systemPrompt,
    options.instructionEnvelope?.developerInstructions,
    options.instructionEnvelope?.customInstructions,
    options.briefMode ? "Answer concisely." : undefined,
  ]
    .filter(Boolean)
    .join("\n\n")
}
