/**
 * OpenClaude's published bidirectional stream-json CLI protocol. This needs its
 * own integration package: it is neither ACP nor the OpenCode HTTP contract.
 * All process, policy, privacy and diagnostic authority stays with host ports.
 */
import type { SessionCreateOptions } from "@cognia/agent-contracts/adapter"
import type {
  AgentApprovalPolicy,
  AgentDiagnosticRedactor,
  AgentLaunchEnvironmentResolver,
  AgentLogger,
  AgentOutboundGate,
  AgentProcessHost,
  AgentToolPreApproval,
} from "@cognia/agent-contracts/host"
import type {
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpPermissionRequest,
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentSession,
  ExternalAgentTokenUsage,
} from "@cognia/agent-contracts/external-agent"
import { BaseProtocolAdapter } from "@cognia/agent-runtime-kit/base-adapter"
import { LfFrameDecoder } from "@cognia/agent-runtime-kit/lf-frame-decoder"
import { promptInputPassesGate } from "@cognia/agent-runtime-kit/prompt-gate"
import {
  normalizeAcpElicitationRequest,
  validateAcpElicitationResponse,
} from "@cognia/agent-runtime-kit/elicitation"
import { elicitationFormSchemaSafetyError } from "@cognia/agent-contracts/external-agent"
import { OPENCLAUDE_EXECUTION_SEMANTICS, OPENCLAUDE_PROTOCOL } from "./manifest"

export interface OpenClaudeDeps {
  processHost: AgentProcessHost
  resolveLaunchEnvironment: AgentLaunchEnvironmentResolver
  approvalPolicy: AgentApprovalPolicy
  toolPreApproval: AgentToolPreApproval
  outboundGate: AgentOutboundGate
  redactDiagnostic: AgentDiagnosticRedactor
  logger: AgentLogger
  permissionTimeoutMs?: number
  cancelTimeoutMs?: number
  requestTimeoutMs?: number
}

type ObjectValue = Record<string, unknown>
interface Approval {
  request: AcpPermissionRequest
  input: ObjectValue
  timer: ReturnType<typeof setTimeout>
  elicitation?: AcpElicitationRequest
  questionNames?: Record<string, string>
  hook: boolean
}
interface PendingControl {
  resolve(value: ObjectValue): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
interface NativeSession {
  session: ExternalAgentSession
  processId: string
  decoder: LfFrameDecoder
  events: ExternalAgentEvent[]
  queuedBytes: number
  wake?: () => void
  terminal: boolean
  streamedText: boolean
  streamedThinking: boolean
  hadText: boolean
  currentMessageId?: string
  assistantSnapshots: Set<string>
  toolBlocks: Map<number, { id: string; name: string; fragments: string }>
  startedTools: Set<string>
  completedInputs: Set<string>
  killPromise?: Promise<void>
  running: boolean
  controls: Map<string, PendingControl>
  approvals: Map<string, Approval>
  stopWaiters: Set<(confirmed: boolean) => void>
  turnTimer?: ReturnType<typeof setTimeout>
  turnTimeoutMs?: number
  usage?: ExternalAgentTokenUsage
}

const MAX_FRAME_BYTES = 4 * 1024 * 1024
const MAX_QUEUE_BYTES = 16 * 1024 * 1024
const RESERVED_ARGS =
  /^(?:-[crp]|--(?:dangerously-skip-permissions|allow-dangerously-skip-permissions|permission-mode|permission-prompt-tool|input-format|output-format|resume|continue|session-id|mcp-config|strict-mcp-config|append-system-prompt|system-prompt|settings|setting-sources))(?:=|$)/
const PERMISSION_HOOK = "cognia-openclaude-pre-tool"
function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined
}
function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}
function absolute(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\")
}
function usage(value: unknown): ExternalAgentTokenUsage | undefined {
  const u = object(value)
  if (!u) return undefined
  const number = (key: string) =>
    typeof u[key] === "number" && Number.isFinite(u[key]) && (u[key] as number) >= 0
      ? (u[key] as number)
      : 0
  const promptTokens = number("input_tokens"),
    completionTokens = number("output_tokens")
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheReadTokens: number("cache_read_input_tokens"),
    cacheWriteTokens: number("cache_creation_input_tokens"),
  }
}

export class OpenClaudeAdapter extends BaseProtocolAdapter {
  readonly protocol = OPENCLAUDE_PROTOCOL
  readonly semantics = OPENCLAUDE_EXECUTION_SEMANTICS
  private readonly native = new Map<string, NativeSession>()
  private readonly owners = new Map<string, NativeSession>()
  private unsubscribe: (() => void)[] = []
  private sequence = 0
  private generation = 0

  constructor(private readonly deps: OpenClaudeDeps) {
    super()
  }

  async connect(config: ExternalAgentConfig): Promise<void> {
    if (config.transport !== "stdio" || !config.process?.command)
      throw new Error("OpenClaude requires a stdio CLI launch")
    if (config.process.args?.some((arg) => RESERVED_ARGS.test(arg)))
      throw new Error(
        "OpenClaude launch arguments cannot override host protocol, session or permission policy"
      )
    if (!this.deps.processHost.available)
      throw new Error("OpenClaude processes are unavailable on this host")
    await this.disconnect()
    this._config = config
    if (!(await this.deps.processHost.commandExists(config.process.command)))
      throw new Error("OpenClaude CLI is not installed on this host")
    const host = this.deps.processHost
    try {
      this.unsubscribe.push(
        await host.onStdoutRaw((event) => {
          const record = this.owners.get(event.processId)
          if (!record) return
          try {
            const bytes = Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0))
            for (const frame of record.decoder.push(bytes)) this.receive(record, frame)
          } catch (error) {
            this.fail(record, this.error(error))
          }
        })
      )
      this.unsubscribe.push(
        await host.onStderr((event) => {
          if (this.owners.has(event.processId))
            this.deps.logger.warn("OpenClaude stderr", {
              text: this.deps.redactDiagnostic(event.data.slice(0, 8192)),
            })
        })
      )
      this.unsubscribe.push(
        await host.onExit((event) => {
          const record = this.owners.get(event.processId)
          if (!record) return
          this.fail(
            record,
            new Error(
              `OpenClaude process exited (${event.code})${record.decoder.bufferedBytes ? " with an incomplete JSON frame" : ""}`
            )
          )
          record.session.status = "error"
          this.owners.delete(event.processId)
        })
      )
      this._capabilities = {
        streaming: true,
        toolExecution: true,
        fileOperations: true,
        multiTurn: true,
        imageInput: true,
        mcpTools: true,
      }
      this._connectionStatus = "connected"
    } catch (error) {
      await this.disconnect()
      throw error
    }
  }

  async disconnect(): Promise<void> {
    ++this.generation
    const results = await Promise.allSettled(
      [...this.native.keys()].map((id) => this.closeSession(id))
    )
    for (const release of this.unsubscribe.splice(0)) release()
    this._connectionStatus = "disconnected"
    this._sessions.clear()
    const failure = results.find((result) => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
  }

  async createSession(options: SessionCreateOptions = {}): Promise<ExternalAgentSession> {
    return this.open(crypto.randomUUID(), options, false)
  }
  async resumeSession(
    sessionId: string,
    options: SessionCreateOptions = {}
  ): Promise<ExternalAgentSession> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId))
      throw new Error("Invalid OpenClaude native session id")
    if (this.native.has(sessionId)) return this.native.get(sessionId)!.session
    return this.open(sessionId, options, true)
  }

  private async open(
    id: string,
    options: SessionCreateOptions,
    resume: boolean
  ): Promise<ExternalAgentSession> {
    if (!this.isConnected() || !this._config?.process)
      throw new Error("OpenClaude is not connected")
    const config = this._config,
      proc = config.process!
    const cwd = options.cwd ?? proc.cwd
    if (!cwd || !absolute(cwd))
      throw new Error("OpenClaude requires an absolute workspace directory")
    const mcpServers: ObjectValue = {}
    for (const server of options.mcpServers ?? []) {
      if ("serverId" in server)
        throw new Error("OpenClaude does not support ACP-channel MCP servers")
      if (!server.name || server.name in mcpServers)
        throw new Error("OpenClaude MCP server names must be unique")
      if ("command" in server)
        mcpServers[server.name] = {
          type: "stdio",
          command: server.command,
          args: server.args,
          env: Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])),
        }
      else
        mcpServers[server.name] = {
          type: server.type,
          url: server.url,
          headers: Object.fromEntries(
            (server.headers ?? []).map(({ name, value }) => [name, value])
          ),
        }
    }
    const systemPrompt = [
      options.systemPrompt,
      options.instructionEnvelope?.developerInstructions,
      options.instructionEnvelope?.customInstructions,
      options.instructionEnvelope?.projectContextSummary,
      options.instructionEnvelope?.skillsSummary,
    ]
      .filter(Boolean)
      .join("\n\n")
    if (!this.deps.outboundGate({ systemPrompt, mcpServers, context: options.context }))
      throw new Error("OpenClaude session configuration was blocked by the outbound privacy gate")
    const session: ExternalAgentSession = {
      id,
      agentId: config.id,
      status: "active",
      permissionMode: options.permissionMode ?? "default",
      allowedTools: options.allowedTools,
      capabilities: this._capabilities,
      tools: [],
      messages: [],
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: { ...options.metadata, cwd, nativeSessionId: id },
    }
    const record: NativeSession = {
      session,
      processId: `${config.id}:openclaude:${++this.sequence}`,
      decoder: new LfFrameDecoder({
        label: "OpenClaude stream-json",
        maxFrameBytes: MAX_FRAME_BYTES,
        maxBufferBytes: MAX_FRAME_BYTES,
      }),
      events: [],
      queuedBytes: 0,
      terminal: false,
      streamedText: false,
      streamedThinking: false,
      hadText: false,
      assistantSnapshots: new Set(),
      toolBlocks: new Map(),
      startedTools: new Set(),
      completedInputs: new Set(),
      running: false,
      controls: new Map(),
      approvals: new Map(),
      stopWaiters: new Set(),
    }
    this.native.set(id, record)
    this._sessions.set(id, session)
    this.owners.set(record.processId, record)
    const generation = this.generation
    try {
      const args = [
        ...(proc.args ?? []),
        "--print",
        "--verbose",
        "--input-format=stream-json",
        "--output-format=stream-json",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--setting-sources",
        "",
        "--permission-mode",
        session.permissionMode === "plan" ? "plan" : "default",
        resume ? "--resume" : "--session-id",
        id,
        "--strict-mcp-config",
        "--mcp-config",
        JSON.stringify({ mcpServers }),
      ]
      if (systemPrompt) args.push("--append-system-prompt", systemPrompt)
      const model = options.metadata?.selectedModel
      if (typeof model === "string" && model) args.push("--model", model)
      const env = await this.deps.resolveLaunchEnvironment(config, proc.env ?? {})
      const spawned = await this.deps.processHost.spawn({
        id: record.processId,
        command: proc.command,
        args,
        cwd,
        env,
        sandboxPolicy: config.sandboxPolicy,
        framing: "raw",
      })
      if (generation !== this.generation || !this.native.has(id)) {
        await this.deps.processHost.kill(spawned)
        throw new Error("OpenClaude session launch was cancelled")
      }
      if (spawned !== record.processId) {
        this.owners.delete(record.processId)
        record.processId = spawned
        this.owners.set(spawned, record)
      }
      // PreToolUse runs before native allow rules. The ordinary can_use_tool
      // callback alone is insufficient: native allow lists can bypass it.
      await this.control(record, {
        subtype: "initialize",
        hooks: {
          PreToolUse: [
            {
              hookCallbackIds: [PERMISSION_HOOK],
              timeout: Math.ceil((this.deps.permissionTimeoutMs ?? 1800000) / 1000) + 5,
            },
          ],
        },
      })
      return session
    } catch (error) {
      await this.closeSession(id)
      throw error
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const record = this.native.get(sessionId)
    if (!record) return
    this.native.delete(sessionId)
    this._sessions.delete(sessionId)
    this.owners.delete(record.processId)
    this.fail(record, new Error("OpenClaude session closed"), false)
    await this.kill(record)
  }

  async *prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options: ExternalAgentExecutionOptions = {}
  ): AsyncIterable<ExternalAgentEvent> {
    const record = this.native.get(sessionId)
    if (!record) throw new Error(`OpenClaude session not found: ${sessionId}`)
    if (record.running) throw new Error("OpenClaude session already has an active turn")
    if (record.session.status === "error")
      throw new Error("OpenClaude session must be reopened after transport failure")
    if (
      !promptInputPassesGate(message, this.deps.outboundGate, {
        systemPrompt: options.systemPrompt,
      })
    )
      throw new Error("OpenClaude prompt was blocked by the outbound privacy gate")
    const content = message.content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text }
      if (block.type === "image" && block.source.type === "base64")
        return {
          type: "image",
          source: { type: "base64", media_type: block.source.mediaType, data: block.source.data },
        }
      throw new Error(`OpenClaude does not support this prompt block: ${block.type}`)
    })
    if (options.systemPrompt)
      throw new Error("OpenClaude system instructions must be bound when creating the session")
    if (options.permissionMode && options.permissionMode !== record.session.permissionMode)
      await this.setSessionMode(sessionId, options.permissionMode)
    if (options.model) await this.control(record, { subtype: "set_model", model: options.model })
    record.running = true
    record.terminal = false
    record.streamedText = false
    record.streamedThinking = false
    record.hadText = false
    record.currentMessageId = undefined
    record.assistantSnapshots.clear()
    record.usage = undefined
    record.toolBlocks.clear()
    record.startedTools.clear()
    record.completedInputs.clear()
    record.events = []
    record.queuedBytes = 0
    record.session.status = "executing"
    const abort = () => {
      void this.cancel(sessionId).catch((error) => this.fail(record, this.error(error)))
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    record.turnTimeoutMs = options.timeout ?? this._config?.timeout ?? 300000
    this.refreshTurnDeadline(record)
    try {
      if (options.signal?.aborted) throw new Error("OpenClaude prompt was aborted")
      // promptInputPassesGate already scans decoded text payloads without treating
      // random binary image bytes as user text. Do not scan their raw base64 twice.
      await this.write(
        record,
        {
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          session_id: sessionId,
        },
        true
      )
      while (!record.terminal || record.events.length) {
        const event = record.events.shift()
        if (event) {
          record.queuedBytes -= new TextEncoder().encode(JSON.stringify(event)).length
          yield event
        } else
          await new Promise<void>((resolve) => {
            record.wake = resolve
          })
      }
    } finally {
      clearTimeout(record.turnTimer)
      record.turnTimer = undefined
      options.signal?.removeEventListener("abort", abort)
      if (record.running) {
        try {
          await this.cancel(sessionId)
        } catch (error) {
          this.deps.logger.error("OpenClaude iterator cleanup failed", {
            error: this.deps.redactDiagnostic(String(error)),
          })
        }
      }
      record.running = false
      if (this._sessions.get(sessionId)?.status !== "error") record.session.status = "active"
    }
  }

  async setSessionMode(
    id: string,
    mode: NonNullable<ExternalAgentSession["permissionMode"]>
  ): Promise<void> {
    const record = this.native.get(id)
    if (!record) throw new Error(`OpenClaude session not found: ${id}`)
    await this.control(record, {
      subtype: "set_permission_mode",
      mode: mode === "plan" ? "plan" : "default",
    })
    record.session.permissionMode = mode
  }

  async cancel(id: string): Promise<void> {
    const record = this.native.get(id)
    if (!record?.running) return
    let release: (() => void) | undefined
    const settled = new Promise<void>((resolve, reject) => {
      const stop = (confirmed: boolean) => {
        release?.()
        if (confirmed) resolve()
        else reject(new Error("OpenClaude stop could not be confirmed"))
      }
      const timer = setTimeout(() => {
        release?.()
        reject(new Error("OpenClaude stop was not confirmed before timeout"))
      }, this.deps.cancelTimeoutMs ?? 5000)
      record.stopWaiters.add(stop)
      release = () => {
        clearTimeout(timer)
        record.stopWaiters.delete(stop)
      }
    })
    void settled.catch(() => undefined)
    for (const requestId of [...record.approvals.keys()])
      await this.respondToPermission(id, { requestId, granted: false, reason: "Turn cancelled" })
    try {
      await Promise.all([this.control(record, { subtype: "interrupt" }), settled])
    } catch (error) {
      this.fail(record, this.error(error), false)
      record.session.status = "error"
      await this.kill(record)
      throw error
    } finally {
      release?.()
    }
  }

  async respondToPermission(sessionId: string, response: AcpPermissionResponse): Promise<void> {
    const record = this.native.get(sessionId)
    const pending = record?.approvals.get(response.requestId)
    if (!record || !pending) throw new Error("OpenClaude permission request is no longer pending")
    record.approvals.delete(response.requestId)
    clearTimeout(pending.timer)
    const result = pending.hook
      ? {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: response.granted ? "allow" : "deny",
            permissionDecisionReason: response.reason ?? "Cognia host policy",
            ...(response.granted ? { updatedInput: pending.input } : {}),
          },
        }
      : response.granted
        ? { behavior: "allow", updatedInput: pending.input }
        : { behavior: "deny", message: response.reason ?? "Host denied this tool call" }
    try {
      await this.write(record, {
        type: "control_response",
        response: { subtype: "success", request_id: response.requestId, response: result },
      })
      this.refreshTurnDeadline(record)
    } catch (error) {
      this.fail(record, this.error(error))
      throw error
    }
  }

  async respondToElicitation(response: AcpElicitationResponse): Promise<void> {
    for (const record of this.native.values()) {
      const pending = record.approvals.get(response.requestId)
      if (!pending?.elicitation) continue
      const validated = validateAcpElicitationResponse(pending.elicitation, response)
      if (validated.action === "accept") {
        pending.input = {
          ...pending.input,
          answers: Object.fromEntries(
            Object.entries(validated.content ?? {}).map(([key, value]) => [
              pending.questionNames?.[key] ?? key,
              Array.isArray(value) ? value.join(", ") : String(value),
            ])
          ),
        }
      }
      await this.respondToPermission(record.session.id, {
        requestId: response.requestId,
        granted: validated.action === "accept",
      })
      return
    }
    throw new Error("OpenClaude input request is no longer pending")
  }

  private async write(
    record: NativeSession,
    value: ObjectValue,
    promptAlreadyGated = false
  ): Promise<void> {
    if (!promptAlreadyGated && !this.deps.outboundGate(value))
      throw new Error("OpenClaude outbound payload was blocked by the privacy gate")
    const frame = JSON.stringify(value)
    if (new TextEncoder().encode(frame).length > MAX_FRAME_BYTES)
      throw new Error("OpenClaude outbound frame exceeds size limit")
    await this.deps.processHost.send(record.processId, frame)
  }
  private control(record: NativeSession, request: ObjectValue): Promise<ObjectValue> {
    const id = `oc-control-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.controls.delete(id)
        reject(new Error(`OpenClaude control timeout: ${request.subtype}`))
      }, this.deps.requestTimeoutMs ?? 10000)
      record.controls.set(id, { resolve, reject, timer })
      void this.write(record, { type: "control_request", request_id: id, request }).catch(
        (error) => {
          clearTimeout(timer)
          record.controls.delete(id)
          reject(error)
        }
      )
    })
  }

  private receive(record: NativeSession, raw: string): void {
    const frame = object(JSON.parse(raw))
    if (!frame || typeof frame.type !== "string")
      throw new Error("OpenClaude emitted an invalid stream-json frame")
    if (frame.type === "control_response") {
      const response = object(frame.response),
        id = text(response?.request_id),
        pending = record.controls.get(id)
      if (!pending) return
      record.controls.delete(id)
      clearTimeout(pending.timer)
      if (response?.subtype === "success") pending.resolve(object(response.response) ?? {})
      else
        pending.reject(
          new Error(
            this.deps.redactDiagnostic(
              text(response?.error) || "OpenClaude rejected control request"
            )
          )
        )
      return
    }
    if (frame.type === "control_cancel_request") {
      const id = text(frame.request_id),
        pending = record.approvals.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        record.approvals.delete(id)
        this.refreshTurnDeadline(record)
      }
      return
    }
    if (frame.type === "control_request") {
      void this.permission(record, frame).catch((error) => this.fail(record, this.error(error)))
      return
    }
    if (!record.running) return
    if (["stream_event", "assistant", "user"].includes(frame.type)) this.refreshTurnDeadline(record)
    if (frame.type === "stream_event") {
      const event = object(frame.event),
        delta = object(event?.delta),
        block = object(event?.content_block)
      if (event?.type === "message_start") {
        record.currentMessageId = text(object(event.message)?.id) || undefined
        record.streamedText = false
        record.streamedThinking = false
      }
      if (
        event?.type === "content_block_delta" &&
        (delta?.type === "text_delta" || delta?.type === "thinking_delta")
      ) {
        if (delta.type === "text_delta") {
          record.streamedText = true
          record.hadText = true
        } else record.streamedThinking = true
        this.push(record, {
          type: "message_delta",
          sessionId: record.session.id,
          timestamp: new Date(),
          delta: {
            type: delta.type === "thinking_delta" ? "thinking" : "text",
            text: text(delta.text ?? delta.thinking),
          },
        })
      }
      if (event?.type === "content_block_start" && block?.type === "tool_use") {
        this.tool(record, block, false)
        if (typeof event.index === "number")
          record.toolBlocks.set(event.index, {
            id: text(block.id),
            name: text(block.name),
            fragments: "",
          })
      }
      if (
        event?.type === "content_block_delta" &&
        delta?.type === "input_json_delta" &&
        typeof event.index === "number"
      ) {
        const state = record.toolBlocks.get(event.index)
        if (state) {
          state.fragments += text(delta.partial_json)
          if (state.fragments.length > MAX_FRAME_BYTES)
            throw new Error("OpenClaude tool input exceeded size limit")
        }
      }
      if (event?.type === "content_block_stop" && typeof event.index === "number") {
        const state = record.toolBlocks.get(event.index)
        record.toolBlocks.delete(event.index)
        if (state?.fragments) {
          const input = object(JSON.parse(state.fragments))
          if (!input) throw new Error("OpenClaude tool input is not an object")
          this.tool(record, { id: state.id, name: state.name, input }, true)
        }
      }
      return
    }
    if (frame.type === "assistant") {
      const message = object(frame.message)
      const messageId = text(message?.id) || text(frame.uuid)
      const duplicate = !!messageId && record.assistantSnapshots.has(messageId)
      const current =
        !messageId || !record.currentMessageId || messageId === record.currentMessageId
      for (const value of Array.isArray(message?.content) ? message.content : []) {
        const block = object(value)
        if (block?.type === "tool_use") this.tool(record, block, true)
        if (
          !duplicate &&
          ((block?.type === "text" && !(current && record.streamedText)) ||
            (block?.type === "thinking" && !(current && record.streamedThinking)))
        ) {
          this.push(record, {
            type: "message_delta",
            sessionId: record.session.id,
            timestamp: new Date(),
            delta: {
              type: block.type === "thinking" ? "thinking" : "text",
              text: text(block.text ?? block.thinking),
            },
          })
          if (block.type === "text") record.hadText = true
        }
      }
      if (messageId) record.assistantSnapshots.add(messageId)
      return
    }
    if (frame.type === "user") {
      const message = object(frame.message)
      for (const value of Array.isArray(message?.content) ? message.content : []) {
        const block = object(value)
        if (block?.type === "tool_result")
          this.push(record, {
            type: "tool_result",
            sessionId: record.session.id,
            timestamp: new Date(),
            toolUseId: text(block.tool_use_id),
            result:
              object(block.content) ??
              (typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content ?? null)),
            isError: block.is_error === true,
          })
      }
      return
    }
    if (frame.type === "result") {
      if (frame.session_id && frame.session_id !== record.session.id) {
        this.fail(record, new Error("OpenClaude changed native session identity"))
        return
      }
      const success = frame.is_error !== true && frame.subtype === "success"
      if (!record.hadText && text(frame.result))
        this.push(record, {
          type: "message_delta",
          sessionId: record.session.id,
          timestamp: new Date(),
          delta: { type: "text", text: text(frame.result) },
        })
      record.usage = usage(frame.usage)
      if (!success)
        this.push(record, {
          type: "error",
          sessionId: record.session.id,
          timestamp: new Date(),
          error: this.deps.redactDiagnostic(
            text(frame.result) ||
              (Array.isArray(frame.errors) ? frame.errors.join("; ") : "OpenClaude turn failed")
          ),
          recoverable: false,
        })
      this.push(record, {
        type: "done",
        sessionId: record.session.id,
        timestamp: new Date(),
        success,
        tokenUsage: record.usage,
      })
      record.running = false
      this.refreshTurnDeadline(record)
      record.terminal = true
      for (const stop of [...record.stopWaiters]) stop(true)
      record.wake?.()
      record.wake = undefined
    }
  }

  private tool(record: NativeSession, block: ObjectValue, complete: boolean): void {
    const id = text(block.id),
      name = text(block.name)
    if (!id || !name) throw new Error("OpenClaude emitted a tool without identity")
    if (!record.startedTools.has(id)) {
      record.startedTools.add(id)
      this.push(record, {
        type: "tool_use_start",
        sessionId: record.session.id,
        timestamp: new Date(),
        toolUseId: id,
        toolName: name,
        rawInput: object(block.input),
      })
    }
    if (complete && object(block.input) && !record.completedInputs.has(id)) {
      record.completedInputs.add(id)
      this.push(record, {
        type: "tool_use_end",
        sessionId: record.session.id,
        timestamp: new Date(),
        toolUseId: id,
        input: object(block.input)!,
      })
    }
  }

  private async permission(record: NativeSession, frame: ObjectValue): Promise<void> {
    const id = text(frame.request_id),
      control = object(frame.request)
    const hookInput = object(control?.input)
    const hook =
      control?.subtype === "hook_callback" &&
      control.callback_id === PERMISSION_HOOK &&
      hookInput?.hook_event_name === "PreToolUse"
    const request = hook
      ? { ...hookInput, subtype: "can_use_tool", input: hookInput.tool_input }
      : control
    if (!id || record.approvals.has(id))
      throw new Error("Invalid or duplicate OpenClaude permission request")
    if (request?.subtype !== "can_use_tool" || !record.running) {
      await this.write(record, {
        type: "control_response",
        response: {
          subtype: "error",
          request_id: id,
          error: "Unsupported or inactive control request",
        },
      })
      return
    }
    const input = object(request.input),
      name = text(request.tool_name)
    if (!input || !name || !text(request.tool_use_id))
      throw new Error("OpenClaude sent malformed tool permission input")
    const kind = /^(?:Read|Grep|Glob|LS)$/i.test(name)
      ? "read"
      : /^(?:Write|Edit|MultiEdit|NotebookEdit)$/i.test(name)
        ? "edit"
        : /^(?:Bash|Shell)$/i.test(name)
          ? "execute"
          : "other"
    const permission: AcpPermissionRequest = {
      id,
      requestId: id,
      sessionId: record.session.id,
      toolCallId: text(request.tool_use_id),
      title: text(request.title) || name,
      kind,
      rawInput: input,
      toolInfo: { id: name, name },
    }
    const timer = setTimeout(
      () => {
        void this.respondToPermission(record.session.id, {
          requestId: id,
          granted: false,
          reason: "Host approval timed out",
        }).catch((error) => this.fail(record, this.error(error)))
      },
      this.deps.permissionTimeoutMs ?? 30 * 60000
    )
    record.approvals.set(id, { request: permission, input, timer, hook })
    this.refreshTurnDeadline(record)
    if (name === "AskUserQuestion") {
      const questions = Array.isArray(input.questions) ? input.questions : []
      const names: Record<string, string> = {},
        properties: ObjectValue = {}
      for (const [index, value] of questions.entries()) {
        const question = object(value),
          title = text(question?.question)
        if (!title || index >= 64) continue
        const key = `q${index}`
        names[key] = title
        const choices = Array.isArray(question?.options)
          ? question.options.flatMap((option) => {
              const label = text(object(option)?.label)
              return label ? [{ const: label, title: label }] : []
            })
          : []
        properties[key] =
          question?.multiSelect === true
            ? {
                type: "array",
                title,
                items: { type: "string", ...(choices.length ? { oneOf: choices } : {}) },
              }
            : { type: "string", title, ...(choices.length ? { oneOf: choices } : {}) }
      }
      const schema = { type: "object", properties, required: Object.keys(properties) }
      const normalized = normalizeAcpElicitationRequest(id, {
        mode: "form",
        sessionId: record.session.id,
        message: text(request.title) || "OpenClaude needs your input",
        requestedSchema: schema,
      })
      if (
        !Object.keys(properties).length ||
        elicitationFormSchemaSafetyError(schema) ||
        !normalized.ok
      ) {
        await this.respondToPermission(record.session.id, {
          requestId: id,
          granted: false,
          reason: "Unsupported or sensitive input form",
        })
        return
      }
      record.approvals.get(id)!.elicitation = normalized.request
      record.approvals.get(id)!.questionNames = names
      this.push(record, {
        type: "elicitation_request",
        sessionId: record.session.id,
        timestamp: new Date(),
        request: normalized.request,
      })
      return
    }
    const configured = this.deps.approvalPolicy(this._config, permission)
    const mode = record.session.permissionMode ?? "default"
    const approved =
      configured !== "ask" &&
      (configured === "approve" ||
        mode === "bypassPermissions" ||
        (mode === "dontAsk" &&
          this.deps.toolPreApproval(name, input, record.session.allowedTools)) ||
        (mode === "acceptEdits" && (kind === "read" || kind === "edit")))
    if (approved || mode === "dontAsk" || mode === "plan") {
      const granted = mode === "plan" ? kind === "read" && configured !== "ask" : approved
      await this.respondToPermission(record.session.id, { requestId: id, granted })
      return
    }
    this.push(record, {
      type: "permission_request",
      sessionId: record.session.id,
      timestamp: new Date(),
      request: permission,
    })
  }

  private refreshTurnDeadline(record: NativeSession): void {
    clearTimeout(record.turnTimer)
    record.turnTimer = undefined
    if (!record.running || record.approvals.size || record.turnTimeoutMs === undefined) return
    record.turnTimer = setTimeout(() => {
      void this.cancel(record.session.id).then(
        () => this.fail(record, new Error("OpenClaude turn timed out")),
        (error) => this.fail(record, this.error(error))
      )
    }, record.turnTimeoutMs)
  }

  private push(record: NativeSession, event: ExternalAgentEvent): void {
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length
    if (record.queuedBytes + bytes > MAX_QUEUE_BYTES) {
      this.fail(record, new Error("OpenClaude event buffer exceeded size limit"))
      return
    }
    record.events.push(event)
    record.queuedBytes += bytes
    record.wake?.()
    record.wake = undefined
  }
  private fail(record: NativeSession, error: Error, terminate = true): void {
    clearTimeout(record.turnTimer)
    record.turnTimer = undefined
    for (const pending of record.controls.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    record.controls.clear()
    for (const pending of record.approvals.values()) clearTimeout(pending.timer)
    record.approvals.clear()
    for (const stop of [...record.stopWaiters]) stop(false)
    if (record.running) {
      record.events.push({
        type: "error",
        sessionId: record.session.id,
        timestamp: new Date(),
        error: this.deps.redactDiagnostic(error.message),
        recoverable: false,
      })
    }
    record.session.status = "error"
    if (terminate)
      void this.kill(record).catch((failure) =>
        this.deps.logger.error("OpenClaude process cleanup failed", {
          error: this.deps.redactDiagnostic(String(failure)),
        })
      )
    record.running = false
    record.terminal = true
    record.wake?.()
    record.wake = undefined
  }
  private error(error: unknown): Error {
    return new Error(
      this.deps.redactDiagnostic(error instanceof Error ? error.message : String(error))
    )
  }
  private kill(record: NativeSession): Promise<void> {
    return (record.killPromise ??= this.deps.processHost.kill(record.processId))
  }
}

export function createOpenClaudeAdapter(deps: OpenClaudeDeps): OpenClaudeAdapter {
  return new OpenClaudeAdapter(deps)
}
