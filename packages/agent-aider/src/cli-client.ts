import type {
  AcpPermissionMode,
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentSession,
} from "@cognia/agent-contracts/external-agent"
import type { SessionCreateOptions } from "@cognia/agent-contracts/adapter"
import type {
  AgentDiagnosticRedactor,
  AgentFileHost,
  AgentOutboundGate,
  AgentProcessHost,
} from "@cognia/agent-contracts/host"
import { BaseProtocolAdapter } from "@cognia/agent-runtime-kit/base-adapter"
import { promptInputPassesGate } from "@cognia/agent-runtime-kit/prompt-gate"
import { AIDER_CLI_EXECUTION_SEMANTICS, AIDER_CLI_PROTOCOL } from "./manifest"

const SESSION_ID = /^aider-[0-9a-f-]{36}$/
const VALUE_ARGS = new Set([
  "--model",
  "--weak-model",
  "--editor-model",
  "--edit-format",
  "--editor-edit-format",
  "--reasoning-effort",
  "--thinking-tokens",
  "--openai-api-base",
  "--model-settings-file",
  "--model-metadata-file",
  "--max-chat-history-tokens",
  "--timeout",
])
const MODEL_ENV = new Set([
  "AIDER_MODEL",
  "AIDER_WEAK_MODEL",
  "AIDER_EDITOR_MODEL",
  "AIDER_EDIT_FORMAT",
  "AIDER_EDITOR_EDIT_FORMAT",
  "AIDER_REASONING_EFFORT",
  "AIDER_THINKING_TOKENS",
])

interface SessionRecord {
  version: 1
  agentId: string
  cwd: string
  session: ExternalAgentSession
  preamble: string
  contextFiles?: string[]
  model?: string
  instructions?: Pick<
    SessionCreateOptions,
    "systemPrompt" | "instructionEnvelope" | "context" | "briefMode"
  >
}

interface Turn {
  id: string
  cancelled: boolean
  spawned: boolean
  exited: boolean
  finished: Promise<void>
  finish: () => void
  spawnedOrFailed: Promise<void>
  settleSpawn: () => void
  events: ExternalAgentEvent[]
  wake?: () => void
  ended: boolean
}

interface SessionState {
  record: SessionRecord
  turn?: Turn
}

/** What the host hands the Aider adapter. Every member is required. */
export interface AiderCliClientDeps {
  /** Runs the per-turn CLI process (`raw` framing) and probes its command. */
  processHost: AgentProcessHost
  /** Session state files, workspace context and path containment. */
  fileHost: AgentFileHost
  /** Every prompt, instruction, file context and restored history passes it. */
  outboundGate: AgentOutboundGate
  /** Credential redaction for process output and error text. */
  redactDiagnostic: AgentDiagnosticRedactor
}

/**
 * Official one-shot CLI, with a separate Aider history per Cognia session.
 * Aider owns editing and model calls; Cognia owns process lifetime and history
 * identity. CLI output stays text: it is never fabricated into tool approvals.
 * Every process and file goes through the host's ports, so the same adapter
 * runs in the desktop renderer, the CLI and the headless brain.
 */
export class AiderCliClientAdapter extends BaseProtocolAdapter {
  readonly protocol = AIDER_CLI_PROTOCOL
  readonly semantics = AIDER_CLI_EXECUTION_SEMANTICS
  private readonly states = new Map<string, SessionState>()
  private readonly processHost: AgentProcessHost
  private readonly files: AgentFileHost
  private readonly outboundGate: AgentOutboundGate
  private readonly redactDiagnostic: AgentDiagnosticRedactor

  constructor(deps: AiderCliClientDeps) {
    super()
    this.processHost = deps.processHost
    this.files = deps.fileHost
    this.outboundGate = deps.outboundGate
    this.redactDiagnostic = deps.redactDiagnostic
  }

  async connect(config: ExternalAgentConfig): Promise<void> {
    await this.disconnect()
    this._connectionStatus = "connecting"
    try {
      if (!this.processHost.available || !this.files.available)
        throw new Error("Aider requires a process host with workspace file access")
      if (config.transport !== "stdio" || !config.process?.command)
        throw new Error("Aider requires a configured CLI command over stdio")
      validateArgs(config.process.args ?? [])
      for (const key of Object.keys(config.process.env ?? {}))
        if (key.startsWith("AIDER_") && !MODEL_ENV.has(key))
          throw new Error(`Unsupported Aider environment option: ${key}`)
      const command = config.process.command.split(/[\\/]/).pop()!
      if (!(await this.processHost.commandExists(command)))
        throw new Error("Aider CLI is not installed or its command is unavailable")
      this._config = config
      this._capabilities = { streaming: true, mcpTools: false }
      this._connectionStatus = "connected"
    } catch (error) {
      this._connectionStatus = "error"
      throw error
    }
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.states.keys()].map((id) => this.cancel(id)))
    this.forgetSessions()
    this._capabilities = undefined
    this._connectionStatus = "disconnected"
  }

  override forgetSessions(): void {
    if ([...this.states.values()].some((state) => state.turn))
      throw new Error("Stop Aider turns before forgetting their sessions")
    this.states.clear()
    super.forgetSessions()
  }

  async createSession(options: SessionCreateOptions = {}): Promise<ExternalAgentSession> {
    this.assertConnected()
    validateOptions(options)
    const cwd = this.workspace(options.cwd)
    const now = new Date()
    const session: ExternalAgentSession = {
      id: `aider-${crypto.randomUUID()}`,
      agentId: this._config!.id,
      status: "active",
      permissionMode: permissionMode(options.permissionMode ?? this._config?.defaultPermissionMode),
      createdAt: now,
      lastActivityAt: now,
      metadata: { cwd, historyOwner: "cognia", preset: "aider" },
    }
    const record: SessionRecord = {
      version: 1,
      agentId: session.agentId,
      cwd,
      session,
      preamble: preamble(options),
      instructions: instructionOptions(options),
      contextFiles: Array.isArray(options.context?.files)
        ? options.context.files.map((file) => workspaceFile(this.files, String(file), cwd))
        : [],
      model: textValue(options.metadata?.selectedModel),
    }
    if (!this.outboundGate(record.preamble))
      throw new Error("Aider instructions blocked by the PII gate")
    const files = stateFiles(cwd, session.id)
    // Initialize with the host's symlink-aware writes before the CLI can open
    // these paths. Never use the repository's shared .aider.chat.history.md.
    try {
      await this.files.writeText(files.chat, "", [cwd])
      await this.files.writeText(files.input, "", [cwd])
      await this.files.writeText(files.prompt, "", [cwd])
      await this.persist(record)
    } catch (error) {
      await Promise.allSettled(Object.values(files).map((file) => this.files.delete(file, [cwd])))
      throw error
    }
    this.states.set(session.id, { record })
    this._sessions.set(session.id, session)
    return session
  }

  async closeSession(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId)
    if (!state) return
    await this.cancel(sessionId)
    state.record.session.status = "closed"
    await this.persist(state.record)
    this.states.delete(sessionId)
    this._sessions.delete(sessionId)
  }

  async resumeSession(
    sessionId: string,
    options: SessionCreateOptions = {}
  ): Promise<ExternalAgentSession> {
    this.assertConnected()
    validateOptions(options)
    if (!SESSION_ID.test(sessionId)) throw new Error("Invalid Aider history identifier")
    const known = this.states.get(sessionId)
    if (known) {
      if (known.turn) throw new Error("Aider session already has a turn in flight")
      if (options.cwd && options.cwd !== known.record.cwd)
        throw new Error("Aider workspace cannot change on resume")
    }
    const cwd = known?.record.cwd ?? this.workspace(options.cwd)
    const files = stateFiles(cwd, sessionId)
    const raw: unknown = known
      ? structuredClone(known.record)
      : JSON.parse(await this.files.readText(files.manifest, [cwd]))
    if (!isSessionRecord(this.files, raw, this._config!.id, cwd, sessionId))
      throw new Error("Aider history does not belong to this agent and workspace")
    // Validate state paths and all restored provider-visible history before a
    // new process is allowed to load it.
    const history = await this.files.readText(files.chat, [cwd])
    await this.files.readText(files.input, [cwd])
    await this.files.readText(files.prompt, [cwd])
    if (!this.outboundGate([history, raw.preamble]))
      throw new Error("Aider history blocked by the PII gate")
    raw.session.createdAt = new Date(raw.session.createdAt)
    raw.session.lastActivityAt = new Date(raw.session.lastActivityAt)
    raw.session.status = "active"
    if (options.permissionMode) raw.session.permissionMode = permissionMode(options.permissionMode)
    if (textValue(options.metadata?.selectedModel))
      raw.model = textValue(options.metadata?.selectedModel)
    const updatedInstructions = instructionOptions(options)
    if (Object.keys(updatedInstructions).length > 0) {
      raw.instructions = { ...raw.instructions, ...updatedInstructions }
      raw.preamble = preamble(raw.instructions)
    }
    if (options.context?.files !== undefined) {
      if (
        !Array.isArray(options.context.files) ||
        options.context.files.some((file) => typeof file !== "string")
      )
        throw new Error("Aider context files must be an array of workspace paths")
      raw.contextFiles = options.context.files.map((file: string) =>
        workspaceFile(this.files, file, cwd)
      )
    }
    if (!this.outboundGate(raw.preamble))
      throw new Error("Aider instructions blocked by the PII gate")
    await this.persist(raw)
    this.states.set(sessionId, { record: raw })
    this._sessions.set(sessionId, raw.session)
    return raw.session
  }

  async listSessions(options?: { cwd?: string }) {
    this.assertConnected()
    const cwd = this.workspace(options?.cwd)
    const records = new Map<string, SessionRecord>()
    for (const file of await this.files.listFiles(cwd, [cwd])) {
      const name = file.slice(cwd.length + 1)
      const id =
        name.startsWith(".aider.cognia-") && name.endsWith(".json") ? name.slice(14, -5) : ""
      if (!SESSION_ID.test(id) || file !== stateFiles(cwd, id).manifest) continue
      try {
        const record: unknown = JSON.parse(await this.files.readText(file, [cwd]))
        if (isSessionRecord(this.files, record, this._config!.id, cwd, id)) records.set(id, record)
      } catch {
        /* An invalid or inaccessible manifest cannot become a resumable session. */
      }
    }
    for (const { record } of this.states.values())
      if (!options?.cwd || options.cwd === record.cwd) records.set(record.session.id, record)
    return [...records.values()].map((record) => ({
      sessionId: record.session.id,
      cwd: record.cwd,
      createdAt: new Date(record.session.createdAt).toISOString(),
      updatedAt: new Date(record.session.lastActivityAt).toISOString(),
    }))
  }

  async deleteSession(sessionId: string): Promise<void> {
    const state = this.state(sessionId)
    await this.cancel(sessionId)
    // Manifest first: a partially failed deletion can never reopen stale state.
    const files = stateFiles(state.record.cwd, sessionId)
    await this.files.delete(files.manifest, [state.record.cwd])
    for (const file of [files.chat, files.input, files.prompt])
      await this.files.delete(file, [state.record.cwd])
    this.states.delete(sessionId)
    this._sessions.delete(sessionId)
  }

  async setSessionMode(sessionId: string, mode: AcpPermissionMode): Promise<void> {
    const state = this.idleState(sessionId)
    state.record.session.permissionMode = permissionMode(mode)
    await this.persist(state.record)
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const state = this.idleState(sessionId)
    if (!modelId.trim()) throw new Error("Aider model identifier must not be empty")
    state.record.model = modelId
    await this.persist(state.record)
  }

  async respondToPermission(_sessionId: string, _response: AcpPermissionResponse): Promise<void> {
    throw new Error("Aider CLI has no per-tool approval protocol")
  }

  async cancel(sessionId: string): Promise<void> {
    const turn = this.states.get(sessionId)?.turn
    if (!turn) return
    turn.cancelled = true
    await turn.spawnedOrFailed
    if (turn.spawned && !turn.ended) await this.processHost.kill(turn.id)
    await turn.finished
  }

  async *prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options: ExternalAgentExecutionOptions = {}
  ): AsyncIterable<ExternalAgentEvent> {
    this.assertConnected()
    const state = this.idleState(sessionId)
    validateOptions(options)
    if (options.workingDirectory && options.workingDirectory !== state.record.cwd)
      throw new Error("Aider workspace cannot change during a session")
    if (options.maxSteps !== undefined) throw new Error("Aider CLI cannot enforce maxSteps")
    let finish!: () => void
    let settleSpawn!: () => void
    const turn: Turn = {
      id: `${this._config!.id}:${sessionId}:${crypto.randomUUID()}`,
      cancelled: Boolean(options.signal?.aborted),
      spawned: false,
      exited: false,
      events: [],
      ended: false,
      finished: new Promise<void>((resolve) => {
        finish = resolve
      }),
      finish: () => finish(),
      spawnedOrFailed: new Promise<void>((resolve) => {
        settleSpawn = resolve
      }),
      settleSpawn: () => settleSpawn(),
    }
    state.turn = turn
    const abort = () => {
      void this.cancel(sessionId).catch(() => {})
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    void this.run(state, turn, message, options)
    try {
      while (!turn.ended || turn.events.length) {
        const event = turn.events.shift()
        if (event) yield event
        else
          await new Promise<void>((resolve) => {
            turn.wake = resolve
          })
      }
    } finally {
      options.signal?.removeEventListener("abort", abort)
      if (!turn.ended) await this.cancel(sessionId)
    }
  }

  private async run(
    state: SessionState,
    turn: Turn,
    message: ExternalAgentMessage,
    options: ExternalAgentExecutionOptions
  ): Promise<void> {
    const { record } = state
    const files = stateFiles(record.cwd, record.session.id)
    const emit = (event: ExternalAgentEvent) => {
      turn.events.push(event)
      turn.wake?.()
      turn.wake = undefined
    }
    const base = () => ({ sessionId: record.session.id, timestamp: new Date() })
    const unlisten: Array<() => void> = []
    const attachments: string[] = []
    let timeout: ReturnType<typeof setTimeout> | undefined
    let success = false
    let error: string | undefined
    let errorReported = false
    let timedOut = false
    const secrets = Object.entries(this._config?.process?.env ?? {})
      .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value)
      .map(([, value]) => value)
    const redact = (value: string) =>
      this.redactDiagnostic(
        secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value)
      )
    try {
      if (turn.cancelled) return
      const texts: string[] = []
      const filenames: string[] = [...(record.contextFiles ?? [])]
      const images: Array<{ path: string; data: string }> = []
      const addImage = (data: string, mime: string) => {
        const extension = imageExtension(mime)
        if (
          data.length > 28 * 1024 * 1024 ||
          data.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
        )
          throw new Error("Invalid or oversized Aider image attachment")
        const path = `${record.cwd}/.aider.cognia-${record.session.id}-${crypto.randomUUID()}.${extension}`
        images.push({ path, data })
      }
      for (const block of message.content) {
        if (block.type === "text") texts.push(block.text)
        else if (block.type === "image") {
          if (block.source.type !== "base64" || !block.source.data)
            throw new Error("Aider images require inline content")
          addImage(block.source.data, block.source.mediaType)
        } else if (block.type === "file") {
          if (
            block.encoding === "base64" &&
            block.mimeType?.startsWith("image/") &&
            block.content !== undefined
          ) {
            addImage(block.content, block.mimeType)
            continue
          }
          filenames.push(workspaceFile(this.files, block.path, record.cwd))
          if (block.content !== undefined) {
            if (block.encoding === "base64")
              throw new Error("Aider CLI does not accept base64 file attachments")
            texts.push(`File context (${block.path}):\n${block.content}`)
          }
        } else throw new Error(`Aider CLI does not support ${block.type} prompt content`)
      }
      for (const file of options.files ?? []) {
        filenames.push(workspaceFile(this.files, file.path, record.cwd))
        if (file.content !== undefined) texts.push(`File context (${file.path}):\n${file.content}`)
      }
      for (const file of options.context?.files ?? [])
        filenames.push(workspaceFile(this.files, file, record.cwd))
      const instructions = preamble({
        ...options,
        context: options.context as Record<string, unknown> | undefined,
      })
      const payload = [record.preamble, instructions, ...texts].filter(Boolean).join("\n\n")
      if (!payload.trim() && images.length === 0)
        throw new Error("Aider prompt must contain text or an image")
      const existingFiles = await Promise.all(
        [...new Set(filenames)].map((file) =>
          /\.(png|jpe?g|gif|webp)$/i.test(file)
            ? this.files.readBinary(file, [record.cwd]).then(() => "")
            : this.files.readText(file, [record.cwd])
        )
      )
      const history = await this.files.readText(files.chat, [record.cwd])
      if (
        !promptInputPassesGate(message, this.outboundGate) ||
        !this.outboundGate([payload, filenames, existingFiles, history])
      )
        throw new Error("Aider prompt, file context, or history blocked by the PII gate")
      for (const image of images) {
        attachments.push(image.path)
        await this.files.writeBinary(image.path, image.data, [record.cwd])
        filenames.push(image.path)
      }
      const mode = permissionMode(options.permissionMode ?? record.session.permissionMode)
      const model = options.model ?? record.model
      const args = [
        ...(this._config!.process!.args ?? []),
        "--no-auto-commits",
        "--no-git",
        "--no-dirty-commits",
        "--no-gitignore",
        "--no-auto-lint",
        "--no-auto-test",
        "--no-suggest-shell-commands",
        "--no-detect-urls",
        "--no-check-update",
        "--no-analytics",
        "--no-show-model-warnings",
        "--no-pretty",
        "--no-fancy-input",
        "--no-notifications",
        "--no-watch-files",
        "--no-cache-prompts",
        "--cache-keepalive-pings",
        "0",
        "--no-show-release-notes",
        "--no-gui",
        "--no-copy-paste",
        "--stream",
        "--yes-always",
        "--map-tokens",
        "0",
        "--chat-history-file",
        files.chat,
        "--input-history-file",
        files.input,
        "--restore-chat-history",
        "--message-file",
        files.prompt,
        ...(mode === "plan" ? ["--chat-mode", "ask", "--dry-run"] : []),
        ...(model ? ["--model", model] : []),
        ...(options.reasoningEffort ? ["--reasoning-effort", options.reasoningEffort] : []),
        ...new Set(filenames),
      ]
      // Aider treats a leading slash as a local command even in --message-file.
      // Route all Cognia input as task text, including requests quoting /run.
      await this.files.writeText(files.prompt, `Task request:\n\n${payload}`, [record.cwd])
      if (turn.cancelled) return
      const messageId = this.generateMessageId()
      record.session.status = "executing"
      emit({ ...base(), type: "message_start", messageId, role: "assistant" })
      let output = ""
      let stderr = ""
      let receivedBytes = 0
      const decoder = new TextDecoder()
      // Retain a credential-sized suffix so a secret split across transport
      // chunks cannot be emitted before the next chunk completes it.
      const retained = Math.max(256, ...secrets.map((secret) => secret.length))
      const stream = (text: string, flush = false) => {
        output = redact(output + text)
        const length = flush ? output.length : Math.max(0, output.length - retained)
        if (length) {
          emit({
            ...base(),
            type: "message_delta",
            messageId,
            delta: { type: "text", text: output.slice(0, length) },
          })
          output = output.slice(length)
        }
      }
      let resolveExit!: (code: number) => void
      let rejectExit!: (error: Error) => void
      const exited = new Promise<number>((resolve, reject) => {
        resolveExit = resolve
        rejectExit = reject
      })
      // Observe all channels before spawning: a short-lived CLI may finish
      // before spawn's RPC response arrives.
      unlisten.push(
        await this.processHost.onStdoutRaw((event) => {
          if (event.processId !== turn.id) return
          try {
            const bytes = Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0))
            receivedBytes += bytes.length
            if (receivedBytes > 16 * 1024 * 1024)
              throw new Error("Aider output exceeded the 16 MiB turn limit")
            stream(decoder.decode(bytes, { stream: true }))
          } catch (failure) {
            rejectExit(failure instanceof Error ? failure : new Error(String(failure)))
          }
        })
      )
      unlisten.push(
        await this.processHost.onStderr((event) => {
          if (event.processId === turn.id) stderr = redact(stderr + event.data).slice(-8192)
        })
      )
      unlisten.push(
        await this.processHost.onExit((event) => {
          if (event.processId === turn.id) {
            turn.exited = true
            turn.spawned = false
            resolveExit(event.code)
          }
        })
      )
      // Install a rejection handler immediately, even if the spawn RPC is
      // still pending while an output-limit failure arrives.
      void exited.catch(() => {})
      const registered = await this.processHost.spawn({
        id: turn.id,
        command: this._config!.process!.command,
        args,
        cwd: record.cwd,
        env: this._config!.process!.env ?? {},
        framing: "raw",
      })
      // Output listeners filter on the id chosen before spawn: a host that
      // registered the child under another id would starve them.
      if (registered !== turn.id) {
        await this.processHost.kill(registered)
        throw new Error(`Host registered the Aider process as ${registered}, not ${turn.id}`)
      }
      turn.spawned = !turn.exited
      turn.settleSpawn()
      if (turn.cancelled && turn.spawned) await this.processHost.kill(turn.id)
      timeout = setTimeout(
        () => {
          timedOut = true
          rejectExit(new Error("Aider execution timed out"))
        },
        options.timeout ?? this._config?.timeout ?? 300_000
      )
      const code = await exited
      stream(decoder.decode(), true)
      success = code === 0 && !turn.cancelled
      if (!success && !turn.cancelled)
        throw new Error(`Aider CLI exited with code ${code}${stderr ? `: ${stderr}` : ""}`)
      if (success) {
        const updatedHistory = await this.files.readText(files.chat, [record.cwd])
        // Aider 0.86.2 can catch provider errors and exit zero. Its chat log
        // distinguishes quoted diagnostics from assistant content, so a zero
        // exit without any new assistant reply is a failure, never success.
        if (
          !updatedHistory.startsWith(history) ||
          !hasAssistantReply(updatedHistory.slice(history.length))
        )
          throw new Error(
            `Aider exited without a completed model response${stderr ? `: ${stderr}` : ""}`
          )
      }
      emit({ ...base(), type: "message_end", messageId })
    } catch (failure) {
      error = redact(failure instanceof Error ? failure.message : String(failure))
      errorReported = true
      emit({ ...base(), type: "error", code: timedOut ? "timeout" : "execution_failed", error })
    } finally {
      turn.settleSpawn()
      if (timeout) clearTimeout(timeout)
      if (turn.spawned) {
        try {
          await this.processHost.kill(turn.id)
        } catch (failure) {
          success = false
          error ??= redact(String(failure))
        }
      }
      for (const off of unlisten) off()
      for (const attachment of attachments) {
        try {
          await this.files.delete(attachment, [record.cwd])
        } catch (failure) {
          success = false
          error ??= redact(String(failure))
        }
      }
      try {
        await this.files.writeText(files.prompt, "", [record.cwd])
        record.session.lastActivityAt = new Date()
        record.session.status = error ? "error" : "active"
        record.session.error = error
        await this.persist(record)
      } catch (failure) {
        success = false
        error ??= redact(String(failure))
      }
      if (error && !errorReported) emit({ ...base(), type: "error", error })
      emit({
        ...base(),
        type: "done",
        success: success && !error,
        stopReason: turn.cancelled ? "cancelled" : error ? "refusal" : "end_turn",
      })
      turn.ended = true
      state.turn = undefined
      turn.finish()
      turn.wake?.()
    }
  }

  private workspace(cwd?: string): string {
    const root = cwd ?? this._config?.process?.cwd
    if (!root || !root.startsWith("/") || root.includes("\0"))
      throw new Error("Aider requires an absolute workspace directory")
    return root.replace(/\/+$/, "") || "/"
  }

  private assertConnected(): void {
    if (!this.isConnected()) throw new Error("Aider CLI is not connected")
  }

  private state(sessionId: string): SessionState {
    const state = this.states.get(sessionId)
    if (!state) throw new Error(`Unknown Aider session: ${sessionId}`)
    return state
  }

  private idleState(sessionId: string): SessionState {
    const state = this.state(sessionId)
    if (state.turn) throw new Error("Aider session already has a turn in flight")
    return state
  }

  private persist(record: SessionRecord): Promise<void> {
    return this.files.writeText(
      stateFiles(record.cwd, record.session.id).manifest,
      JSON.stringify(record),
      [record.cwd]
    )
  }
}

function instructionOptions(
  options: SessionCreateOptions
): NonNullable<SessionRecord["instructions"]> {
  return Object.fromEntries(
    ["systemPrompt", "instructionEnvelope", "context", "briefMode"]
      .filter((key) => options[key as keyof SessionCreateOptions] !== undefined)
      .map((key) => [key, options[key as keyof SessionCreateOptions]])
  )
}

function imageExtension(mime: string): string {
  const extension: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
  }
  if (!extension[mime]) throw new Error(`Unsupported Aider image type: ${mime}`)
  return extension[mime]
}

function stateFiles(cwd: string, id: string) {
  if (!SESSION_ID.test(id)) throw new Error("Invalid Aider history identifier")
  const prefix = `${cwd}/.aider.cognia-${id}`
  return {
    manifest: `${prefix}.json`,
    chat: `${prefix}.chat.md`,
    input: `${prefix}.input`,
    prompt: `${prefix}.prompt`,
  }
}

function validateArgs(args: string[]): void {
  for (let index = 0; index < args.length; index++) {
    if (!VALUE_ARGS.has(args[index]) || !args[index + 1] || args[index + 1].startsWith("-"))
      throw new Error(`Unsupported Aider CLI option: ${args[index]}`)
    index++
  }
}

function validateOptions(options: SessionCreateOptions | ExternalAgentExecutionOptions): void {
  const custom = options.context?.custom as Record<string, unknown> | undefined
  if (Array.isArray(custom?.mcpServers) && custom.mcpServers.length)
    throw new Error("Aider CLI does not support MCP servers")
  if (Array.isArray(custom?.additionalDirectories) && custom.additionalDirectories.length)
    throw new Error("Aider CLI supports one workspace per session")
  if ("mcpServers" in options && options.mcpServers?.length)
    throw new Error("Aider CLI does not support MCP servers")
  if ("additionalDirectories" in options && options.additionalDirectories?.length)
    throw new Error("Aider CLI supports one workspace per session")
  if (options.allowedTools !== undefined)
    throw new Error("Aider CLI cannot enforce a per-tool allowlist")
  if (options.permissionMode) permissionMode(options.permissionMode)
}

function permissionMode(mode?: AcpPermissionMode): "plan" | "bypassPermissions" {
  if (mode === "plan" || mode === "bypassPermissions") return mode
  if (mode === undefined) return "plan"
  throw new Error(`Aider CLI cannot enforce permission mode ${mode}`)
}

function workspaceFile(files: AgentFileHost, file: string, cwd: string): string {
  const absolute = file.startsWith("/") ? file : `${cwd}/${file}`
  if (file.includes("\0") || !files.isWithinRoot(absolute, cwd))
    throw new Error("Aider file is outside the session workspace")
  return absolute
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function preamble(options: SessionCreateOptions): string {
  const envelope = options.instructionEnvelope
  const pieces = [
    options.systemPrompt,
    envelope?.developerInstructions,
    envelope?.customInstructions,
    envelope?.projectContextSummary,
    envelope?.skillsSummary,
    options.briefMode ? "Answer concisely." : undefined,
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
  if (options.context) {
    const {
      workingDirectory: _workingDirectory,
      files: _files,
      custom,
      ...context
    } = options.context
    if (custom && typeof custom === "object" && !Array.isArray(custom)) {
      const semantic = Object.fromEntries(
        Object.entries(custom).filter(
          ([key]) =>
            ![
              "cwd",
              "workingDirectory",
              "additionalDirectories",
              "mcpServers",
              "traceId",
              "spanId",
              "parentSpanId",
              "sessionId",
              "turnId",
            ].includes(key)
        )
      )
      if (Object.keys(semantic).length) context.custom = semantic
    }
    if (Object.keys(context).length) pieces.push(`Task context: ${JSON.stringify(context)}`)
  }
  return pieces.join("\n\n")
}

function isSessionRecord(
  files: AgentFileHost,
  value: unknown,
  agentId: string,
  cwd: string,
  id: string
): value is SessionRecord {
  if (!value || typeof value !== "object") return false
  const record = value as SessionRecord
  return (
    record.version === 1 &&
    record.agentId === agentId &&
    record.cwd === cwd &&
    typeof record.preamble === "string" &&
    (record.contextFiles === undefined ||
      (Array.isArray(record.contextFiles) &&
        record.contextFiles.every(
          (file) => typeof file === "string" && files.isWithinRoot(file, cwd)
        ))) &&
    record.session?.id === id &&
    record.session.agentId === agentId &&
    Number.isFinite(Date.parse(String(record.session.createdAt))) &&
    Number.isFinite(Date.parse(String(record.session.lastActivityAt))) &&
    (record.model === undefined || typeof record.model === "string") &&
    (record.session.permissionMode === "plan" ||
      record.session.permissionMode === "bypassPermissions")
  )
}

function hasAssistantReply(history: string): boolean {
  return history.split("\n").some((line) => {
    const text = line.trim()
    return (
      Boolean(text) &&
      !text.startsWith("#### ") &&
      !text.startsWith("# aider chat started at ") &&
      !text.startsWith(">")
    )
  })
}
