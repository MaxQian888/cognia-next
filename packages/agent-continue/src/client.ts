import type { SessionCreateOptions } from "@cognia/agent-contracts/adapter"
import type {
  AgentDiagnosticRedactor,
  AgentFileHost,
  AgentLaunchEnvironmentResolver,
  AgentOutboundGate,
  AgentProcessHost,
} from "@cognia/agent-contracts/host"
import type {
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentSession,
} from "@cognia/agent-contracts/external-agent"
import { BaseProtocolAdapter } from "@cognia/agent-runtime-kit/base-adapter"
import { promptInputPassesGate } from "@cognia/agent-runtime-kit/prompt-gate"
import { CONTINUE_EXECUTION_SEMANTICS, CONTINUE_PROTOCOL } from "./manifest"
import { parseContinueOutput } from "./output"

export interface ContinueClientDeps {
  processHost: AgentProcessHost
  fileHost: AgentFileHost
  outboundGate: AgentOutboundGate
  redactDiagnostic: AgentDiagnosticRedactor
  resolveLaunchEnvironment?: AgentLaunchEnvironmentResolver
}
interface RecordState {
  version: 1
  agentId: string
  cwd: string
  session: ExternalAgentSession
  preamble: string
  history: Array<{ role: "user" | "assistant"; text: string }>
}
interface Turn {
  id: string
  cancelled: boolean
  spawned: boolean
  exited: boolean
  wakeCancel?(): void
}
interface State {
  record: RecordState
  turn?: Turn
}
const ID = /^continue-[0-9a-f-]{36}$/

/** Published Continue headless JSON; history is explicitly Cognia-owned replay. */
export class ContinueAdapter extends BaseProtocolAdapter {
  readonly protocol = CONTINUE_PROTOCOL
  readonly semantics = CONTINUE_EXECUTION_SEMANTICS
  private states = new Map<string, State>()
  constructor(private readonly deps: ContinueClientDeps) {
    super()
  }
  async connect(config: ExternalAgentConfig): Promise<void> {
    await this.disconnect()
    this._connectionStatus = "connecting"
    try {
      if (
        !this.deps.processHost.available ||
        !this.deps.fileHost.available ||
        config.transport !== "stdio" ||
        !config.process?.command
      )
        throw new Error("Continue requires process and workspace-file host ports")
      validateArgs(config.process.args ?? [])
      if (
        !(await this.deps.processHost.commandExists(config.process.command.split(/[\\/]/).pop()!))
      )
        throw new Error("Continue CLI is not installed")
      this._config = config
      this._capabilities = { streaming: false, mcpTools: false }
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
    if (!this.isConnected() || !this._config) throw new Error("Continue is not connected")
    validateOptions(options)
    const cwd = options.cwd ?? this._config.process?.cwd
    if (!cwd || !/^(?:\/|[A-Za-z]:[\\/])/.test(cwd) || cwd.includes("\0"))
      throw new Error("Continue requires an absolute workspace")
    const preamble = instructions(options)
    if (!this.deps.outboundGate(preamble))
      throw new Error("Continue instructions blocked by the PII gate")
    const now = new Date(),
      id = `continue-${crypto.randomUUID()}`
    const session: ExternalAgentSession = {
      id,
      agentId: this._config.id,
      status: "active",
      permissionMode: mode(options.permissionMode ?? this._config.defaultPermissionMode),
      createdAt: now,
      lastActivityAt: now,
      metadata: { cwd, historyOwner: "cognia", resume: "history-replay" },
    }
    const record: RecordState = {
      version: 1,
      agentId: session.agentId,
      cwd,
      session,
      preamble,
      history: [],
    }
    await this.persist(record)
    this.states.set(id, { record })
    this._sessions.set(id, session)
    return session
  }
  async resumeSession(
    id: string,
    options: SessionCreateOptions = {}
  ): Promise<ExternalAgentSession> {
    if (!this.isConnected() || !this._config) throw new Error("Continue is not connected")
    validateOptions(options)
    const cwd = options.cwd ?? this._config.process?.cwd
    if (!cwd || !ID.test(id)) throw new Error("Invalid Continue history identity")
    const existing = this.states.get(id)
    if (existing?.turn) throw new Error("Continue session already has a turn in flight")
    const raw: unknown =
      existing?.record ?? JSON.parse(await this.deps.fileHost.readText(statePath(cwd, id), [cwd]))
    if (!isRecord(raw, this._config.id, cwd, id))
      throw new Error("Continue history belongs to another configuration or workspace")
    if (!this.deps.outboundGate([raw.preamble, raw.history]))
      throw new Error("Continue history blocked by the PII gate")
    raw.session.createdAt = new Date(raw.session.createdAt)
    raw.session.lastActivityAt = new Date()
    raw.session.status = "active"
    if (options.permissionMode) raw.session.permissionMode = mode(options.permissionMode)
    this.states.set(id, { record: raw })
    this._sessions.set(id, raw.session)
    return raw.session
  }
  async closeSession(id: string): Promise<void> {
    const state = this.states.get(id)
    if (!state) return
    await this.cancel(id)
    state.record.session.status = "closed"
    await this.persist(state.record)
    this.states.delete(id)
    this._sessions.delete(id)
  }
  async respondToPermission(_id: string, _response: AcpPermissionResponse): Promise<void> {
    throw new Error("Continue headless mode has fixed permissions and no per-call approval channel")
  }
  async cancel(id: string): Promise<void> {
    const turn = this.states.get(id)?.turn
    if (!turn) return
    turn.cancelled = true
    turn.wakeCancel?.()
    if (turn.spawned && !turn.exited) await this.deps.processHost.kill(turn.id)
  }
  async *prompt(
    id: string,
    message: ExternalAgentMessage,
    options: ExternalAgentExecutionOptions = {}
  ): AsyncIterable<ExternalAgentEvent> {
    const state = this.states.get(id)
    if (!state || !this._config?.process) throw new Error("Unknown Continue session")
    if (state.turn) throw new Error("Continue session already has a turn in flight")
    validateOptions(options)
    const record = state.record
    const permissionMode = mode(options.permissionMode ?? record.session.permissionMode)
    if (this._config.requireApprovalFor?.length || this._config.autoApprovePatterns?.length)
      throw new Error("Continue headless mode cannot enforce per-tool approval rules")
    const parts: string[] = []
    for (const part of message.content) {
      if (part.type === "text") parts.push(part.text)
      else if (part.type === "file" && part.encoding !== "base64") {
        const absolute =
          part.path.startsWith("/") || /^[A-Za-z]:/.test(part.path)
            ? part.path
            : `${record.cwd}/${part.path}`
        if (!this.deps.fileHost.isWithinRoot(absolute, record.cwd))
          throw new Error("Continue file is outside its workspace")
        const content = part.content ?? (await this.deps.fileHost.readText(absolute, [record.cwd]))
        parts.push(`File context (${part.path}):\n${content}`)
      } else throw new Error(`Continue headless adapter does not support ${part.type} content`)
    }
    for (const file of options.files ?? []) {
      const absolute = file.path.startsWith("/") ? file.path : `${record.cwd}/${file.path}`
      if (!this.deps.fileHost.isWithinRoot(absolute, record.cwd))
        throw new Error("Continue file is outside its workspace")
      parts.push(
        `File context (${file.path}):\n${file.content ?? (await this.deps.fileHost.readText(absolute, [record.cwd]))}`
      )
    }
    if (options.context?.files?.length)
      throw new Error("Continue path-only execution context must be supplied as file content")
    const userText = parts.join("\n\n")
    const prompt = [
      record.preamble,
      instructions(options),
      record.history.length
        ? `Prior conversation (context only):\n${JSON.stringify(record.history)}`
        : "",
      `Current request:\n${userText}`,
    ]
      .filter(Boolean)
      .join("\n\n")
    if (prompt.length > 8 * 1024 * 1024)
      throw new Error("Continue conversation exceeded the 8 MiB limit")
    if (
      !promptInputPassesGate(message, this.deps.outboundGate, { options }) ||
      !this.deps.outboundGate(prompt)
    )
      throw new Error("Continue prompt or history blocked by the PII gate")
    const turn: Turn = {
      id: `${this._config.id}:${id}:${crypto.randomUUID()}`,
      cancelled: false,
      spawned: false,
      exited: false,
    }
    state.turn = turn
    const base = () => ({ sessionId: id, timestamp: new Date() }),
      messageId = this.generateMessageId()
    const unlisten: Array<() => void> = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      void this.cancel(id).catch(() => {})
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    let resolve!: (code: number) => void, reject!: (error: Error) => void
    const exited = new Promise<number>((yes, no) => {
      resolve = yes
      reject = no
    })
    void exited.catch(() => {})
    turn.wakeCancel = () => resolve(-1)
    let stdout = "",
      stderr = "",
      bytes = 0
    const decoder = new TextDecoder()
    try {
      options.signal?.throwIfAborted()
      unlisten.push(
        await this.deps.processHost.onStdoutRaw((e) => {
          if (e.processId !== turn.id) return
          try {
            const chunk = Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0))
            bytes += chunk.length
            if (bytes > 8 * 1024 * 1024) throw new Error("Continue output exceeded the 8 MiB limit")
            stdout += decoder.decode(chunk, { stream: true })
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
      )
      unlisten.push(
        await this.deps.processHost.onStderr((e) => {
          if (e.processId === turn.id)
            stderr = this.deps.redactDiagnostic(stderr + e.data).slice(-4096)
        })
      )
      unlisten.push(
        await this.deps.processHost.onExit((e) => {
          if (e.processId === turn.id) {
            turn.exited = true
            resolve(e.code)
          }
        })
      )
      timer = setTimeout(
        () => reject(new Error("Continue execution timed out")),
        options.timeout ?? this._config.timeout ?? 300_000
      )
      const launchEnv = this.deps.resolveLaunchEnvironment
        ? await this.deps.resolveLaunchEnvironment(this._config, this._config.process.env ?? {})
        : this._config.process.env
      const registered = await this.deps.processHost.spawn({
        id: turn.id,
        command: this._config.process.command,
        args: [
          ...(this._config.process.args ?? []),
          "-p",
          "--format",
          "json",
          ...(permissionMode === "plan" ? ["--readonly"] : ["--auto"]),
          ...(options.model ? ["--model", options.model] : []),
          prompt,
        ],
        env: launchEnv,
        cwd: record.cwd,
        framing: "raw",
        sandboxPolicy: this._config.sandboxPolicy,
      })
      if (registered !== turn.id) {
        await this.deps.processHost.kill(registered)
        throw new Error("Continue process identity mismatch")
      }
      turn.spawned = true
      if (turn.cancelled && !turn.exited) await this.deps.processHost.kill(turn.id)
      record.session.status = "executing"
      yield { ...base(), type: "message_start", messageId, role: "assistant" }
      const code = await exited
      stdout += decoder.decode()
      if (turn.cancelled) {
        yield { ...base(), type: "done", success: false, stopReason: "cancelled" }
        return
      }
      if (code !== 0)
        throw new Error(`Continue CLI exited with code ${code}${stderr ? `: ${stderr}` : ""}`)
      const result = parseContinueOutput(stdout)
      record.history.push(
        { role: "user", text: userText },
        { role: "assistant", text: result.text }
      )
      await this.persist(record)
      yield {
        ...base(),
        type: "message_delta",
        messageId,
        delta: { type: "text", text: result.text },
      }
      yield { ...base(), type: "message_end", messageId }
      yield { ...base(), type: "done", success: true, stopReason: "end_turn" }
    } catch (error) {
      if (!turn.cancelled)
        yield {
          ...base(),
          type: "error",
          error: this.deps.redactDiagnostic(error instanceof Error ? error.message : String(error)),
        }
      yield {
        ...base(),
        type: "done",
        success: false,
        stopReason: turn.cancelled ? "cancelled" : "refusal",
      }
    } finally {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      if (turn.spawned && !turn.exited) await this.deps.processHost.kill(turn.id)
      for (const off of unlisten) off()
      state.turn = undefined
      record.session.status = this.states.has(id) ? "active" : "closed"
      record.session.lastActivityAt = new Date()
    }
  }
  private persist(record: RecordState): Promise<void> {
    return this.deps.fileHost.writeText(
      statePath(record.cwd, record.session.id),
      JSON.stringify(record),
      [record.cwd]
    )
  }
}
function statePath(cwd: string, id: string): string {
  if (!ID.test(id)) throw new Error("Invalid Continue history identity")
  return `${cwd.replace(/[\\/]$/, "")}/.cognia/agent-sessions/${id}.json`
}
function mode(value?: string): "plan" | "bypassPermissions" {
  if (!value || value === "default" || value === "plan") return "plan"
  if (value === "bypassPermissions") return value
  throw new Error(`Continue headless adapter cannot enforce permission mode ${value}`)
}
function validateOptions(value: SessionCreateOptions | ExternalAgentExecutionOptions): void {
  const o = value as SessionCreateOptions & ExternalAgentExecutionOptions
  if (o.mcpServers?.length || o.context?.custom?.mcpServers)
    throw new Error("Continue headless adapter does not support host MCP injection")
  if (o.additionalDirectories?.length || o.allowedTools !== undefined)
    throw new Error(
      "Continue headless adapter cannot enforce extra workspaces or per-tool allowlists"
    )
  if (o.reasoningEffort) throw new Error("Continue CLI reasoning controls are not supported")
  if (o.permissionMode) mode(o.permissionMode)
}
function validateArgs(args: string[]): void {
  const allowed = new Set(["--config", "--org", "--rule", "--model", "--agent"])
  for (let i = 0; i < args.length; i += 2)
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith("-"))
      throw new Error(`Unsupported Continue launch argument: ${args[i]}`)
}
function instructions(value: SessionCreateOptions | ExternalAgentExecutionOptions): string {
  const o = value as SessionCreateOptions
  return [
    o.systemPrompt,
    o.instructionEnvelope?.developerInstructions,
    o.instructionEnvelope?.customInstructions,
    o.instructionEnvelope?.projectContextSummary,
    o.instructionEnvelope?.skillsSummary,
    o.context ? JSON.stringify(o.context) : undefined,
    o.briefMode ? "Answer concisely." : undefined,
  ]
    .filter(Boolean)
    .join("\n\n")
}
function isRecord(value: unknown, agentId: string, cwd: string, id: string): value is RecordState {
  if (!value || typeof value !== "object") return false
  const r = value as RecordState
  return (
    r.version === 1 &&
    r.agentId === agentId &&
    r.cwd === cwd &&
    r.session?.id === id &&
    r.session.agentId === agentId &&
    typeof r.preamble === "string" &&
    Array.isArray(r.history) &&
    r.history.every(
      (h) => h && ["user", "assistant"].includes(h.role) && typeof h.text === "string"
    )
  )
}
