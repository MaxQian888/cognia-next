import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type {
  AcpPermissionMode,
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentSession,
} from "@/types/agent/external-agent"
import { isPathUnderRoot } from "@/lib/sandbox/policy-bridge"
import { redactCredentialText } from "@/lib/security/redact-credentials"
import {
  agentDeleteTextFile,
  agentInvoke,
  agentListen,
  agentReadTextFile,
  agentWriteTextFile,
  supportsAgentFs,
  supportsExternalAgents,
} from "../../agent-transport"
import { BaseProtocolAdapter, type SessionCreateOptions } from "../../protocol-adapter"
import { hasNoLeakingExternalAgentPromptInput } from "../../policy/outbound-prompt-pii"

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

/**
 * Official one-shot CLI, with a separate Aider history per Cognia session.
 * Aider owns editing and model calls; Cognia owns process lifetime and history
 * identity. CLI output stays text: it is never fabricated into tool approvals.
 * No Node imports enter the renderer; every process and file goes through the
 * existing desktop/headless/CLI host boundary.
 */
export class AiderCliClientAdapter extends BaseProtocolAdapter {
  readonly protocol = "aider-cli"
  private readonly states = new Map<string, SessionState>()

  async connect(config: ExternalAgentConfig): Promise<void> {
    await this.disconnect()
    this._connectionStatus = "connecting"
    try {
      if (!supportsExternalAgents() || !supportsAgentFs())
        throw new Error("Aider requires a process host with workspace file access")
      if (config.transport !== "stdio" || !config.process?.command)
        throw new Error("Aider requires a configured CLI command over stdio")
      validateArgs(config.process.args ?? [])
      for (const key of Object.keys(config.process.env ?? {}))
        if (key.startsWith("AIDER_") && !MODEL_ENV.has(key))
          throw new Error(`Unsupported Aider environment option: ${key}`)
      const command = config.process.command.split(/[\\/]/).pop()!
      if (!(await agentInvoke<boolean>("check_command_exists", { command })))
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
      contextFiles: Array.isArray(options.context?.files)
        ? options.context.files.map((file) => workspaceFile(String(file), cwd))
        : [],
      model: textValue(options.metadata?.selectedModel),
    }
    if (!hasNoLeakingPiiDeep(record.preamble))
      throw new Error("Aider instructions blocked by the PII gate")
    const files = stateFiles(cwd, session.id)
    // Initialize with the host's symlink-aware writes before the CLI can open
    // these paths. Never use the repository's shared .aider.chat.history.md.
    try {
      await agentWriteTextFile(files.chat, "", [cwd])
      await agentWriteTextFile(files.input, "", [cwd])
      await agentWriteTextFile(files.prompt, "", [cwd])
      await this.persist(record)
    } catch (error) {
      await Promise.allSettled(Object.values(files).map((file) => agentDeleteTextFile(file, [cwd])))
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
      return known.record.session
    }
    const cwd = this.workspace(options.cwd)
    const files = stateFiles(cwd, sessionId)
    const raw: unknown = JSON.parse(await agentReadTextFile(files.manifest, [cwd]))
    if (!isSessionRecord(raw, this._config!.id, cwd, sessionId))
      throw new Error("Aider history does not belong to this agent and workspace")
    // Validate state paths and all restored provider-visible history before a
    // new process is allowed to load it.
    const history = await agentReadTextFile(files.chat, [cwd])
    await agentReadTextFile(files.input, [cwd])
    await agentReadTextFile(files.prompt, [cwd])
    if (!hasNoLeakingPiiDeep([history, raw.preamble]))
      throw new Error("Aider history blocked by the PII gate")
    raw.session.createdAt = new Date(raw.session.createdAt)
    raw.session.lastActivityAt = new Date(raw.session.lastActivityAt)
    raw.session.status = "active"
    if (options.permissionMode) raw.session.permissionMode = permissionMode(options.permissionMode)
    if (textValue(options.metadata?.selectedModel))
      raw.model = textValue(options.metadata?.selectedModel)
    this.states.set(sessionId, { record: raw })
    this._sessions.set(sessionId, raw.session)
    return raw.session
  }

  async listSessions(options?: { cwd?: string }) {
    return [...this.states.values()]
      .filter(({ record }) => !options?.cwd || options.cwd === record.cwd)
      .map(({ record }) => ({
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
    await agentDeleteTextFile(files.manifest, [state.record.cwd])
    for (const file of [files.chat, files.input, files.prompt])
      await agentDeleteTextFile(file, [state.record.cwd])
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
    if (turn.spawned && !turn.ended) await agentInvoke("kill_external_agent", { agentId: turn.id })
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
    let timeout: ReturnType<typeof setTimeout> | undefined
    let success = false
    let error: string | undefined
    let errorReported = false
    let timedOut = false
    const secrets = Object.entries(this._config?.process?.env ?? {})
      .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value)
      .map(([, value]) => value)
    const redact = (value: string) =>
      redactCredentialText(
        secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value)
      )
    try {
      if (turn.cancelled) return
      const texts: string[] = []
      const filenames: string[] = [...(record.contextFiles ?? [])]
      for (const block of message.content) {
        if (block.type === "text") texts.push(block.text)
        else if (block.type === "file") {
          filenames.push(workspaceFile(block.path, record.cwd))
          if (block.content !== undefined) {
            if (block.encoding === "base64")
              throw new Error("Aider CLI does not accept base64 file attachments")
            texts.push(`File context (${block.path}):\n${block.content}`)
          }
        } else throw new Error(`Aider CLI does not support ${block.type} prompt content`)
      }
      for (const file of options.files ?? []) {
        filenames.push(workspaceFile(file.path, record.cwd))
        if (file.content !== undefined) texts.push(`File context (${file.path}):\n${file.content}`)
      }
      for (const file of options.context?.files ?? [])
        filenames.push(workspaceFile(file, record.cwd))
      const instructions = preamble({
        ...options,
        context: options.context as Record<string, unknown> | undefined,
      })
      const payload = [record.preamble, instructions, ...texts].filter(Boolean).join("\n\n")
      if (!payload.trim()) throw new Error("Aider prompt must contain text")
      const existingFiles = await Promise.all(
        [...new Set(filenames)].map((file) => agentReadTextFile(file, [record.cwd]))
      )
      const history = await agentReadTextFile(files.chat, [record.cwd])
      if (
        !hasNoLeakingExternalAgentPromptInput(message) ||
        !hasNoLeakingPiiDeep([payload, filenames, existingFiles, history])
      )
        throw new Error("Aider prompt, file context, or history blocked by the PII gate")
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
      await agentWriteTextFile(files.prompt, `Task request:\n\n${payload}`, [record.cwd])
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
        await agentListen<{ agentId: string; data: string }>(
          "external-agent://stdout-raw",
          (event) => {
            if (event.agentId !== turn.id) return
            try {
              const bytes = Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0))
              receivedBytes += bytes.length
              if (receivedBytes > 16 * 1024 * 1024)
                throw new Error("Aider output exceeded the 16 MiB turn limit")
              stream(decoder.decode(bytes, { stream: true }))
            } catch (failure) {
              rejectExit(failure instanceof Error ? failure : new Error(String(failure)))
            }
          }
        )
      )
      unlisten.push(
        await agentListen<{ agentId: string; data: string }>("external-agent://stderr", (event) => {
          if (event.agentId === turn.id) stderr = redact(stderr + event.data).slice(-8192)
        })
      )
      unlisten.push(
        await agentListen<{ agentId: string; code: number }>("external-agent://exit", (event) => {
          if (event.agentId === turn.id) {
            turn.exited = true
            turn.spawned = false
            resolveExit(event.code)
          }
        })
      )
      // Install a rejection handler immediately, even if the spawn RPC is
      // still pending while an output-limit failure arrives.
      void exited.catch(() => {})
      await agentInvoke("spawn_external_agent", {
        config: {
          id: turn.id,
          command: this._config!.process!.command,
          args,
          cwd: record.cwd,
          env: this._config!.process!.env ?? {},
          framing: "raw",
        },
      })
      turn.spawned = !turn.exited
      turn.settleSpawn()
      if (turn.cancelled && turn.spawned)
        await agentInvoke("kill_external_agent", { agentId: turn.id })
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
        const updatedHistory = await agentReadTextFile(files.chat, [record.cwd])
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
          await agentInvoke("kill_external_agent", { agentId: turn.id })
        } catch (failure) {
          success = false
          error ??= redact(String(failure))
        }
      }
      for (const off of unlisten) off()
      try {
        await agentWriteTextFile(files.prompt, "", [record.cwd])
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
    return agentWriteTextFile(
      stateFiles(record.cwd, record.session.id).manifest,
      JSON.stringify(record),
      [record.cwd]
    )
  }
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

function workspaceFile(file: string, cwd: string): string {
  const absolute = file.startsWith("/") ? file : `${cwd}/${file}`
  if (file.includes("\0") || !isPathUnderRoot(absolute, cwd))
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
          (file) => typeof file === "string" && isPathUnderRoot(file, cwd)
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
