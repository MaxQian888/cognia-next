import type { SessionCreateOptions } from "@cognia/agent-contracts/adapter"
import type {
  AgentApprovalPolicy,
  AgentDiagnosticRedactor,
  AgentFetch,
  AgentFileHost,
  AgentOutboundGate,
  AgentProcessHost,
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
import {
  assertCodebuffNoNativeMcp,
  encodeBridgeFrame,
  parseBridgeFrame,
  type BridgeFrame,
} from "./bridge-protocol"
import { readCodebuffBoundedText } from "./bridge-runtime"
import { CODEBUFF_EXECUTION_SEMANTICS, CODEBUFF_PROTOCOL } from "./manifest"

export interface CodebuffBridgeLaunch {
  command: string
  args: string[]
  env?: Record<string, string>
  networkIsolated: true
}
export interface CodebuffClientDeps {
  processHost: AgentProcessHost
  fileHost: AgentFileHost
  fetch: AgentFetch
  outboundGate: AgentOutboundGate
  redactDiagnostic: AgentDiagnosticRedactor
  approvalPolicy: AgentApprovalPolicy
  resolveBridgeLaunch(config: ExternalAgentConfig): Promise<CodebuffBridgeLaunch>
}
interface Stored {
  version: 1
  agentId: string
  cwd: string
  session: ExternalAgentSession
  preamble: string
  sdkState?: unknown
}
interface Turn {
  id: string
  messageId: string
  events: ExternalAgentEvent[]
  ended: boolean
  streamed: boolean
  failed: boolean
  wake?: () => void
}
interface State {
  record: Stored
  processId: string
  subscriptions: Array<() => void>
  ready(): void
  failReady(error: Error): void
  turn?: Turn
  pending: Map<string, AcpPermissionRequest>
  networks: Map<string, AbortController>
  acks: Map<string, () => void>
  closed: boolean
}
const ID = /^codebuff-[0-9a-f-]{36}$/

/** Runtime-neutral client. The official SDK exists only in ./node-bridge. */
export class CodebuffAdapter extends BaseProtocolAdapter {
  readonly protocol = CODEBUFF_PROTOCOL
  readonly semantics = CODEBUFF_EXECUTION_SEMANTICS
  private states = new Map<string, State>()
  constructor(private readonly deps: CodebuffClientDeps) {
    super()
  }
  async connect(config: ExternalAgentConfig): Promise<void> {
    await this.disconnect()
    if (
      !this.deps.processHost.available ||
      !this.deps.fileHost.available ||
      config.transport !== "stdio"
    )
      throw new Error("Codebuff requires a process and confined file host")
    if (config.requireApprovalFor?.length || config.autoApprovePatterns?.length)
      throw new Error(
        "Codebuff SDK cannot enforce arbitrary native tool-rule matching; use operation approvals"
      )
    this._config = config
    this._capabilities = { streaming: true, mcpTools: false }
    this._connectionStatus = "connected"
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
    const state = this.states.get(id)
    if (state && !state.closed) return this._sessions.get(id)!
    this.states.delete(id)
    return this.open(id, options)
  }
  private async open(
    id: string | undefined,
    options: SessionCreateOptions
  ): Promise<ExternalAgentSession> {
    if (!this.isConnected() || !this._config) throw new Error("Codebuff is not connected")
    validateOptions(options)
    const cwd = options.cwd ?? this._config.process?.cwd
    if (!cwd || !/^(?:\/|[A-Za-z]:[\\/])/.test(cwd) || cwd.includes("\0"))
      throw new Error("Codebuff requires an absolute workspace")
    let record: Stored
    if (id) {
      if (!ID.test(id)) throw new Error("Invalid Codebuff session identity")
      const value: unknown = JSON.parse(
        await this.deps.fileHost.readText(statePath(cwd, id), [cwd])
      )
      if (!isStored(value, this._config.id, cwd, id))
        throw new Error("Codebuff session belongs to another configuration or workspace")
      assertCodebuffNoNativeMcp(value.sdkState)
      if (!this.deps.outboundGate([value.preamble, value.sdkState]))
        throw new Error("Codebuff resumed state blocked by the PII gate")
      record = value
      record.session.createdAt = new Date(record.session.createdAt)
      record.session.lastActivityAt = new Date()
      record.session.status = "active"
    } else {
      id = `codebuff-${crypto.randomUUID()}`
      const now = new Date()
      record = {
        version: 1,
        agentId: this._config.id,
        cwd,
        preamble: instructions(options),
        session: {
          id,
          agentId: this._config.id,
          status: "active",
          permissionMode: options.permissionMode ?? this._config.defaultPermissionMode ?? "default",
          createdAt: now,
          lastActivityAt: now,
          metadata: { cwd, stateOwner: "cognia-sdk-run-state" },
        },
      }
    }
    if (!this.deps.outboundGate(record.preamble))
      throw new Error("Codebuff instructions blocked by the PII gate")
    const launch = await this.deps.resolveBridgeLaunch(this._config)
    if (launch.networkIsolated !== true)
      throw new Error("Codebuff bridge requires enforced OS network isolation")
    let ready!: () => void, failReady!: (error: Error) => void
    const readiness = new Promise<void>((yes, no) => {
      ready = yes
      failReady = no
    })
    void readiness.catch(() => {})
    const state: State = {
      record,
      processId: `${this._config.id}:codebuff:${crypto.randomUUID()}`,
      subscriptions: [],
      ready,
      failReady,
      pending: new Map(),
      networks: new Map(),
      acks: new Map(),
      closed: false,
    }
    this.states.set(id, state)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      state.subscriptions.push(
        await this.deps.processHost.onStdoutLine((e) => {
          if (e.processId === state.processId) {
            void this.receive(state, e.data).catch((error) => this.fail(state, error))
          }
        })
      )
      state.subscriptions.push(
        await this.deps.processHost.onStderr((e) => {
          if (e.processId === state.processId && e.data.length > 4096)
            this.fail(state, new Error("Codebuff bridge diagnostic limit exceeded"))
        })
      )
      state.subscriptions.push(
        await this.deps.processHost.onExit((e) => {
          if (e.processId === state.processId && !state.closed)
            this.fail(state, new Error(`Codebuff bridge exited with code ${e.code}`))
        })
      )
      const registered = await this.deps.processHost.spawn({
        id: state.processId,
        command: launch.command,
        args: launch.args,
        env: { ...this._config.process?.env, ...launch.env },
        cwd,
        framing: "line",
        sandboxPolicy: {
          ...this._config.sandboxPolicy,
          network: "off",
          allowedHosts: [],
          readableScope: "workspace",
        },
      })
      if (registered !== state.processId) {
        await this.deps.processHost.kill(registered)
        throw new Error("Codebuff bridge process identity mismatch")
      }
      timer = setTimeout(
        () => state.failReady(new Error("Codebuff bridge startup timed out")),
        this._config.process?.startupTimeout ?? 15_000
      )
      await this.send(state, { type: "init", cwd })
      await readiness
      await this.persist(record)
      this._sessions.set(id, record.session)
      return record.session
    } catch (error) {
      await this.release(state)
      this.states.delete(id)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  async closeSession(id: string): Promise<void> {
    const state = this.states.get(id)
    if (!state) return
    await this.cancel(id)
    await this.release(state)
    state.record.session.status = "closed"
    await this.persist(state.record)
    this.states.delete(id)
    this._sessions.delete(id)
  }
  async cancel(id: string): Promise<void> {
    const state = this.states.get(id)
    if (!state?.turn || state.turn.ended) return
    await this.send(state, { type: "cancel", turnId: state.turn.id }).catch(() => {})
    this.emit(state, { ...base(state), type: "done", success: false, stopReason: "cancelled" })
    state.turn.ended = true
    state.turn.wake?.()
    await this.release(state)
    this._sessions.delete(id)
  }
  async respondToPermission(id: string, response: AcpPermissionResponse): Promise<void> {
    const state = this.states.get(id)
    if (!state || !state.pending.has(response.requestId))
      throw new Error("Codebuff operation approval is not pending")
    await this.send(state, {
      type: "host-result",
      requestId: response.requestId,
      result: response.granted,
    })
    state.pending.delete(response.requestId)
  }
  async *prompt(
    id: string,
    message: ExternalAgentMessage,
    options: ExternalAgentExecutionOptions = {}
  ): AsyncIterable<ExternalAgentEvent> {
    const state = this.states.get(id)
    if (!state || state.closed || !this._sessions.has(id))
      throw new Error("Codebuff session must be reopened after its process ended")
    if (state.turn) throw new Error("Codebuff session already has a turn in flight")
    validateOptions(options)
    if (options.permissionMode && options.permissionMode !== state.record.session.permissionMode)
      throw new Error("Codebuff operation permissions are fixed for the session")
    const text = message.content
      .map((part) => {
        if (part.type === "text") return part.text
        if (part.type === "file" && part.content !== undefined && part.encoding !== "base64")
          return `File context (${part.path}):\n${part.content}`
        throw new Error(`Unsupported Codebuff prompt content: ${part.type}`)
      })
      .join("\n\n")
    const prompt = [state.record.preamble, instructions(options), text].filter(Boolean).join("\n\n")
    if (
      !promptInputPassesGate(message, this.deps.outboundGate, { options }) ||
      !this.deps.outboundGate([prompt, state.record.sdkState])
    )
      throw new Error("Codebuff prompt or resumed state blocked by the PII gate")
    const turn: Turn = {
      id: crypto.randomUUID(),
      messageId: this.generateMessageId(),
      events: [],
      ended: false,
      streamed: false,
      failed: false,
    }
    state.turn = turn
    state.record.session.status = "executing"
    const abort = () => {
      void this.cancel(id).catch(() => {})
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(abort, options.timeout ?? this._config?.timeout ?? 300_000)
    try {
      options.signal?.throwIfAborted()
      yield { ...base(state), type: "message_start", messageId: turn.messageId, role: "assistant" }
      await this.send(state, {
        type: "run",
        turnId: turn.id,
        agent: "codebuff/base@0.0.16",
        prompt,
        previousRun: state.record.sdkState,
      })
      for (;;) {
        while (turn.events.length) yield turn.events.shift()!
        if (turn.ended) break
        await new Promise<void>((resolve) => {
          turn.wake = resolve
        })
      }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      if (!turn.ended) await this.cancel(id)
      state.turn = undefined
      state.record.session.status = state.closed ? "closed" : "active"
      state.record.session.lastActivityAt = new Date()
    }
  }
  private emit(state: State, event: ExternalAgentEvent): void {
    const turn = state.turn
    if (!turn || turn.ended) return
    if (turn.events.length >= 2048) throw new Error("Codebuff event queue exceeded the limit")
    turn.events.push(event)
    turn.wake?.()
    turn.wake = undefined
  }
  private async receive(state: State, raw: string): Promise<void> {
    const frame = parseBridgeFrame(raw)
    if (frame.type === "ready") {
      state.ready()
      return
    }
    if (frame.type === "network-ack") {
      state.acks.get(`${frame.requestId}:${frame.seq}`)?.()
      return
    }
    if (frame.type === "network-cancel") {
      state.networks.get(String(frame.requestId))?.abort()
      return
    }
    if (frame.type === "host-request") {
      if (frame.kind === "network") {
        void this.proxyNetwork(state, frame).catch((error) => this.fail(state, error))
        return
      }
      if (
        frame.kind !== "approval" ||
        typeof frame.requestId !== "string" ||
        typeof frame.name !== "string"
      )
        throw new Error("Malformed Codebuff host request")
      const input = object(frame.input)
      const request: AcpPermissionRequest = {
        id: frame.requestId,
        requestId: frame.requestId,
        sessionId: state.record.session.id,
        toolInfo: { id: frame.name, name: frame.name },
        title: frame.name,
        rawInput: input,
      }
      state.pending.set(frame.requestId, request)
      const policy = this.deps.approvalPolicy(this._config, request),
        mode = state.record.session.permissionMode
      const readOnly = frame.name === "read_files"
      const granted =
        mode === "plan" && !readOnly
          ? false
          : policy === "ask"
            ? undefined
            : policy === "approve"
              ? true
              : mode === "bypassPermissions"
                ? true
                : readOnly
                  ? true
                  : undefined
      if (granted === undefined)
        this.emit(state, { ...base(state), type: "permission_request", request })
      else {
        await this.send(state, { type: "host-result", requestId: frame.requestId, result: granted })
        state.pending.delete(frame.requestId)
      }
      return
    }
    const turn = state.turn
    if (!turn || (frame.turnId !== undefined && frame.turnId !== turn.id)) {
      if (frame.type === "error") throw new Error("Codebuff bridge initialization failed")
      return
    }
    if (frame.type === "chunk") {
      const chunk = frame.chunk
      if (typeof chunk === "string") {
        turn.streamed = true
        this.emit(state, {
          ...base(state),
          type: "message_delta",
          messageId: turn.messageId,
          delta: { type: "text", text: chunk },
        })
      } else if (
        chunk &&
        typeof chunk === "object" &&
        (chunk as Record<string, unknown>).type === "reasoning_chunk"
      )
        this.emit(state, {
          ...base(state),
          type: "message_delta",
          messageId: turn.messageId,
          delta: { type: "thinking", text: String((chunk as Record<string, unknown>).chunk ?? "") },
        })
    } else if (frame.type === "event") {
      const event = object(frame.event)
      if (event.type === "tool_call") {
        this.emit(state, {
          ...base(state),
          type: "tool_use_start",
          toolUseId: String(event.toolCallId),
          toolName: String(event.toolName),
          rawInput: object(event.input),
        })
        this.emit(state, {
          ...base(state),
          type: "tool_use_end",
          toolUseId: String(event.toolCallId),
          input: object(event.input),
        })
      } else if (event.type === "tool_result")
        this.emit(state, {
          ...base(state),
          type: "tool_result",
          toolUseId: String(event.toolCallId),
          result: { output: event.output },
        })
      else if (event.type === "text" && !turn.streamed && typeof event.text === "string")
        this.emit(state, {
          ...base(state),
          type: "message_delta",
          messageId: turn.messageId,
          delta: { type: "text", text: event.text },
        })
      else if (event.type === "reasoning_delta")
        this.emit(state, {
          ...base(state),
          type: "message_delta",
          messageId: turn.messageId,
          delta: { type: "thinking", text: String(event.text ?? "") },
        })
      else if (event.type === "error") {
        turn.failed = true
        this.emit(state, {
          ...base(state),
          type: "error",
          error: this.deps.redactDiagnostic(String(event.message ?? "Codebuff provider error")),
        })
      }
    } else if (frame.type === "result") {
      const result = object(frame.state),
        output = object(result.output)
      if (
        !["error", "structuredOutput", "lastMessage", "allMessages"].includes(String(output.type))
      )
        throw new Error("Codebuff SDK returned an unknown output shape")
      state.record.sdkState = result
      await this.persist(state.record)
      if (output.type === "error") {
        turn.failed = true
        this.emit(state, {
          ...base(state),
          type: "error",
          error: this.deps.redactDiagnostic(String(output.message ?? "Codebuff provider error")),
        })
      }
      this.emit(state, { ...base(state), type: "message_end", messageId: turn.messageId })
      this.emit(state, {
        ...base(state),
        type: "done",
        success: !turn.failed,
        stopReason: turn.failed ? "refusal" : "end_turn",
      })
      turn.ended = true
      turn.wake?.()
    } else if (frame.type === "error")
      throw new Error(this.deps.redactDiagnostic(String(frame.error ?? "Codebuff bridge failed")))
  }
  private async proxyNetwork(state: State, frame: BridgeFrame): Promise<void> {
    const id = String(frame.requestId),
      controller = new AbortController()
    state.networks.set(id, controller)
    try {
      const url = new URL(String(frame.url))
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Unsupported Codebuff network URL")
      if (
        url.origin !== "https://www.codebuff.com" ||
        !/^\/api\/(?:v1\/|healthz$|agents\/validate$)/.test(url.pathname)
      )
        throw new Error(
          "Codebuff bridge requires its verified first-party API; native MCP and provider OAuth are unsupported"
        )
      if (!this.deps.outboundGate({ url: url.href, body: frame.body }))
        throw new Error("Codebuff model or tool payload blocked by the PII gate")
      const headers = object(frame.headers ?? {})
      if (Object.values(headers).some((v) => typeof v !== "string"))
        throw new Error("Malformed Codebuff network headers")
      const response = await this.deps.fetch(url.href, {
        method: String(frame.method),
        headers: headers as Record<string, string>,
        body: typeof frame.body === "string" ? frame.body : undefined,
        signal: controller.signal,
        blockPrivateHosts: true,
        redirect: "error",
        connectTimeout: 15_000,
        readTimeout: 60_000,
      })
      // Native SDK MCP executes before overrideTools. Reject remote templates
      // carrying MCP declarations at the proven registry response boundary.
      let body = response.body
      if (/^\/api\/v1\/agents\//.test(url.pathname) && body) {
        const text = await readCodebuffBoundedText(body, 512 * 1024)
        const parsed: unknown = JSON.parse(text)
        assertCodebuffNoNativeMcp(parsed)
        body = new Response(text).body
      }
      await this.send(state, {
        type: "network-head",
        requestId: id,
        status: response.status,
        headers: Object.fromEntries(response.headers),
      })
      if (body) {
        const reader = body.getReader()
        let seq = 0
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            for (let offset = 0; offset < value.length; offset += 64 * 1024) {
              const chunk = value.subarray(offset, offset + 64 * 1024),
                key = `${id}:${seq}`
              let ack!: () => void
              const received = new Promise<void>((resolve) => {
                ack = resolve
                state.acks.set(key, resolve)
              })
              const timer = setTimeout(() => {
                controller.abort()
                ack()
              }, 15_000)
              try {
                await this.send(state, {
                  type: "network-chunk",
                  requestId: id,
                  seq,
                  data: btoa(String.fromCharCode(...chunk)),
                })
                await received
                controller.signal.throwIfAborted()
              } finally {
                clearTimeout(timer)
                state.acks.delete(key)
              }
              seq++
            }
          }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      }
      await this.send(state, { type: "network-end", requestId: id })
    } catch {
      await this.send(state, {
        type: "network-error",
        requestId: id,
        error: "Host network request refused or failed",
      }).catch(() => {})
    } finally {
      state.networks.delete(id)
    }
  }
  private fail(state: State, error: unknown): void {
    const message = this.deps.redactDiagnostic(
      error instanceof Error ? error.message : "Codebuff bridge failed"
    )
    state.failReady(new Error(message))
    if (state.turn && !state.turn.ended) {
      this.emit(state, { ...base(state), type: "error", error: message })
      this.emit(state, { ...base(state), type: "done", success: false, stopReason: "refusal" })
      state.turn.ended = true
      state.turn.wake?.()
    }
    void this.release(state).catch(() => {})
  }
  private async release(state: State): Promise<void> {
    if (state.closed) return
    state.closed = true
    for (const c of state.networks.values()) c.abort()
    state.networks.clear()
    for (const ack of state.acks.values()) ack()
    state.acks.clear()
    state.pending.clear()
    try {
      await this.deps.processHost.kill(state.processId)
    } finally {
      for (const off of state.subscriptions.splice(0)) off()
    }
  }
  private send(state: State, frame: BridgeFrame): Promise<void> {
    if (state.closed) return Promise.reject(new Error("Codebuff bridge is closed"))
    return this.deps.processHost.send(state.processId, encodeBridgeFrame(frame))
  }
  private persist(record: Stored): Promise<void> {
    return this.deps.fileHost.writeText(
      statePath(record.cwd, record.session.id),
      JSON.stringify(record),
      [record.cwd]
    )
  }
}
function base(state: State) {
  return { sessionId: state.record.session.id, timestamp: new Date() }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed Codebuff bridge data")
  return value as Record<string, unknown>
}
function statePath(cwd: string, id: string): string {
  if (!ID.test(id)) throw new Error("Invalid Codebuff session identity")
  return `${cwd.replace(/[\\/]$/, "")}/.cognia/agent-sessions/${id}.json`
}
function validateOptions(value: SessionCreateOptions | ExternalAgentExecutionOptions): void {
  const o = value as SessionCreateOptions & ExternalAgentExecutionOptions
  if (o.mcpServers?.length || o.context?.custom?.mcpServers)
    throw new Error("Codebuff SDK host MCP injection is not supported")
  if (
    o.additionalDirectories?.length ||
    o.allowedTools !== undefined ||
    o.files?.length ||
    o.model ||
    o.reasoningEffort
  )
    throw new Error("Unsupported Codebuff workspace, model, file, or allowlist control")
  if (o.permissionMode && !["default", "plan", "bypassPermissions"].includes(o.permissionMode))
    throw new Error("Unsupported Codebuff permission mode")
}
function instructions(value: SessionCreateOptions | ExternalAgentExecutionOptions): string {
  const o = value as SessionCreateOptions
  return [
    o.systemPrompt,
    o.instructionEnvelope?.developerInstructions,
    o.instructionEnvelope?.customInstructions,
    o.instructionEnvelope?.projectContextSummary,
    o.instructionEnvelope?.skillsSummary,
    o.briefMode ? "Answer concisely." : undefined,
  ]
    .filter(Boolean)
    .join("\n\n")
}
function isStored(value: unknown, agentId: string, cwd: string, id: string): value is Stored {
  if (!value || typeof value !== "object") return false
  const r = value as Stored
  return (
    r.version === 1 &&
    r.agentId === agentId &&
    r.cwd === cwd &&
    r.session?.id === id &&
    r.session.agentId === agentId &&
    typeof r.preamble === "string"
  )
}
