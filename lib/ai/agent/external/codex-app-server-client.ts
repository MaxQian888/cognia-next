/**
 * Codex `app-server` Protocol Client Adapter
 *
 * Drives OpenAI Codex through its **native** first-party `codex app-server`
 * JSON-RPC protocol (thread / turn / item primitives + server-side sandboxed
 * execution with client-side approvals), as opposed to the third-party
 * `@zed-industries/codex-acp` ACP shim used by {@link AcpClientAdapter}.
 *
 * @see https://developers.openai.com/codex/app-server
 *
 * Reuse notes (no re-implementation):
 * - stdio transport is the shared native bridge in `@/lib/native/external-agent`
 *   (`spawnExternalAgent` / `onExternalAgentStdout` / …) — the same Tauri
 *   commands the ACP path uses.
 * - JSON-RPC framing + request/response correlation is the shared
 *   {@link JsonRpcPeer}, here with `omitJsonRpcVersion: true` because the
 *   app-server omits the `"jsonrpc":"2.0"` field on the wire.
 * - credential env injection reuses `buildAgentEnv` (the codex overlay).
 * - permission-mode ordering reuses `MODE_RANK` from `permission-cascade`.
 *
 * Because Codex runs commands inside its OWN sandbox and only asks the client
 * for *approval*, this adapter does NOT implement client-side `fs/*` or
 * `terminal/*` handlers (a net simplification over ACP).
 */

import { isTauri } from "@/lib/utils"
import { loggers } from "@/lib/logging"
import {
  spawnExternalAgent,
  sendToExternalAgent,
  killExternalAgent,
  onExternalAgentStdout,
  onExternalAgentStderr,
  onExternalAgentExit,
} from "@/lib/native/external-agent"
import { BaseProtocolAdapter, type SessionCreateOptions } from "./protocol-adapter"
import { JsonRpcPeer } from "./json-rpc-peer"
import { buildAgentEnv } from "./env-builder"
import { MODE_RANK } from "./permission-cascade"
import type {
  ExternalAgentConfig,
  ExternalAgentSession,
  ExternalAgentMessage,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentContent,
  AcpPermissionMode,
  AcpPermissionResponse,
  AcpPermissionRequest,
  AcpPlanEntry,
  AcpStopReason,
  ExternalAgentTokenUsage,
  ExternalAgentSessionExtensionSupport,
} from "@/types/agent/external-agent"

const log = loggers.agent

/** Active health-probe timeout — mirrors the ACP adapter's 5s ping. */
const HEALTH_PROBE_TIMEOUT_MS = 5000

// ============================================================================
// Codex app-server wire types (local — kept out of the public type surface)
// ============================================================================

/** A user input item for `thread/start` / `turn/start`. */
type CodexUserInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }

/** Approval decision enums (camelCase on the wire). */
type CodexCommandDecision = "accept" | "acceptForSession" | "decline" | "cancel"
type CodexFileChangeDecision = "accept" | "acceptForSession" | "decline" | "cancel"

interface CodexThreadItem {
  id?: string
  type?: string
  // agentMessage / reasoning
  text?: string
  content?: unknown
  summary?: unknown
  phase?: string
  // commandExecution
  command?: string
  cwd?: string
  status?: string
  exitCode?: number
  aggregatedOutput?: string
  // fileChange
  changes?: unknown
  // mcpToolCall / dynamicToolCall
  server?: string
  tool?: string
  toolName?: string
  arguments?: unknown
  toolInput?: unknown
  result?: unknown
  error?: unknown
  // webSearch
  query?: string
}

interface CodexMcpServerStatus {
  name?: string
  status?: string
  authStatus?: string
  tools?: Array<{ name?: string }>
  [key: string]: unknown
}

interface CodexSkill {
  name?: string
  path?: string
  enabled?: boolean
  description?: string
  [key: string]: unknown
}

/** Status snapshot surfaced to the optional read-only UI panel (WS5). */
export interface CodexAppServerStatus {
  mcpServers: CodexMcpServerStatus[]
  skills: CodexSkill[]
}

interface PendingApproval {
  resolve: (decision: { decision: string }) => void
  request: AcpPermissionRequest
  kind: "command" | "fileChange"
}

// ============================================================================
// Adapter
// ============================================================================

export class CodexAppServerAdapter extends BaseProtocolAdapter {
  readonly protocol = "codex-app-server"

  private peer?: JsonRpcPeer
  private processId?: string
  private unsubscribers: Array<() => void> = []

  // Per-session streaming listeners (mirrors the ACP adapter's queue model).
  private sessionListeners = new Map<string, Set<(event: ExternalAgentEvent) => void>>()
  // Active turn id per session, for `turn/interrupt`.
  private activeTurns = new Map<string, string>()
  // Latest token usage per session, folded into the `done` event.
  private lastTokenUsage = new Map<string, ExternalAgentTokenUsage>()
  // agentMessage / reasoning item ids that already streamed deltas, so a
  // completed item doesn't double-emit the full text.
  private streamedItems = new Set<string>()
  // Sessions that have already had the system prompt prepended.
  private sentSystemPrompt = new Set<string>()
  // Pending approval requests awaiting a UI decision.
  private pendingApprovals = new Map<string, PendingApproval>()

  // Status surfaced to the read-only UI panel.
  private status: CodexAppServerStatus = { mcpServers: [], skills: [] }
  private statusListeners = new Set<(status: CodexAppServerStatus) => void>()

  private serverInfo?: { userAgent?: string; codexHome?: string; platformOs?: string }

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  async connect(config: ExternalAgentConfig): Promise<void> {
    if (this._connectionStatus === "connected") return
    if (!isTauri()) {
      throw new Error("Codex app-server requires the Tauri desktop environment")
    }
    if (config.transport !== "stdio") {
      throw new Error(`Codex app-server only supports stdio transport, got: ${config.transport}`)
    }
    if (!config.process) {
      throw new Error("Process configuration required for the Codex app-server")
    }

    this._config = config
    this._connectionStatus = "connecting"

    try {
      this.peer = new JsonRpcPeer({
        omitJsonRpcVersion: true,
        writeRaw: (message) => this.writeToProcess(message),
        onNotification: (method, params) => this.handleNotification(method, params),
        onServerRequest: (method, params) => this.handleServerRequest(method, params),
      })

      const env = await buildAgentEnv(config, config.process.env || {})
      this.processId = await spawnExternalAgent({
        id: config.id,
        command: config.process.command,
        args: config.process.args ?? [],
        env,
        cwd: config.process.cwd,
      })

      this.registerProcessListeners()

      // Handshake: initialize → store info → `initialized` notification.
      const result = await this.peer.sendRequest<{
        userAgent?: string
        codexHome?: string
        platformOs?: string
      }>("initialize", {
        clientInfo: { name: "cognia", title: "Cognia", version: "1.0.0" },
      })
      this.serverInfo = {
        userAgent: result?.userAgent,
        codexHome: result?.codexHome,
        platformOs: result?.platformOs,
      }
      this.peer.sendNotification("initialized")

      this._capabilities = {
        streaming: true,
        toolExecution: true,
        fileOperations: true,
        mcpTools: true,
        multiTurn: true,
      }
      this._tools = []
      this._connectionStatus = "connected"
      log.info("Connected to Codex app-server", { name: config.name, info: this.serverInfo })
    } catch (error) {
      this.cleanupListeners()
      this._connectionStatus = "error"
      log.error("Codex app-server connection failed", { error })
      throw error
    }
  }

  async disconnect(): Promise<void> {
    if (this._connectionStatus === "disconnected") return

    this.cleanupListeners()
    this.peer?.rejectAll("Disconnected from Codex app-server")

    if (this.processId && isTauri()) {
      try {
        await killExternalAgent(this.processId)
      } catch (error) {
        log.warn("Error killing Codex app-server process", { error })
      }
    }

    for (const [, pending] of this.pendingApprovals) {
      pending.resolve({ decision: "cancel" })
    }
    this.pendingApprovals.clear()
    this.processId = undefined
    this.peer = undefined
    this._sessions.clear()
    this.activeTurns.clear()
    this.lastTokenUsage.clear()
    this.streamedItems.clear()
    this.sentSystemPrompt.clear()
    this._connectionStatus = "disconnected"
    log.info("Disconnected from Codex app-server")
  }

  /**
   * Active liveness probe. The base adapter only reports the cached connection
   * flag, which stays `"connected"` if the server process hangs without
   * exiting — so the manager's health timer never reconnects a wedged Codex.
   * Round-trip a cheap, side-effect-free `model/list`: any reply (even a
   * JSON-RPC *error* response) proves the server is still processing messages;
   * only a request timeout or a torn-down transport is unhealthy.
   */
  override async healthCheck(): Promise<boolean> {
    if (!this.isConnected() || !this.peer) return false
    try {
      await this.peer.sendRequest("model/list", { includeHidden: false }, HEALTH_PROBE_TIMEOUT_MS)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // JsonRpcPeer formats a JSON-RPC error response as "<code>: <message>"
      // (server answered → alive); a timeout rejects with "Request timeout: …".
      return /^-?\d+: /.test(message)
    }
  }

  private registerProcessListeners(): void {
    void onExternalAgentStdout((event) => {
      if (event.agentId === this.processId) this.peer?.ingest(event.data)
    }).then((un) => this.unsubscribers.push(un))

    void onExternalAgentStderr((event) => {
      if (event.agentId === this.processId)
        log.warn("Codex app-server stderr", { data: event.data })
    }).then((un) => this.unsubscribers.push(un))

    void onExternalAgentExit((event) => {
      if (event.agentId === this.processId) {
        log.info("Codex app-server process exited", { code: event.code })
        this.peer?.rejectAll("Codex app-server process exited")
        this._connectionStatus = "disconnected"
      }
    }).then((un) => this.unsubscribers.push(un))
  }

  private cleanupListeners(): void {
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe()
      } catch {
        // ignore cleanup errors
      }
    }
    this.unsubscribers = []
  }

  private async writeToProcess(message: string): Promise<void> {
    if (!this.processId || !isTauri()) {
      throw new Error("No active Codex app-server connection")
    }
    await sendToExternalAgent(this.processId, message)
  }

  // --------------------------------------------------------------------------
  // Sessions (threads)
  // --------------------------------------------------------------------------

  async createSession(options?: SessionCreateOptions): Promise<ExternalAgentSession> {
    if (!this.isConnected() || !this.peer) throw new Error("Not connected to Codex app-server")

    const result = await this.peer.sendRequest<{ thread?: { id?: string } }>("thread/start", {})
    const threadId = result?.thread?.id
    if (!threadId) throw new Error("Codex app-server did not return a thread id")

    const session: ExternalAgentSession = {
      id: threadId,
      agentId: this._config!.id,
      status: "active",
      permissionMode: (options?.permissionMode || "default") as AcpPermissionMode,
      capabilities: this._capabilities,
      tools: this._tools ?? [],
      messages: [],
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {
        ...(options?.metadata ?? {}),
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        ...(options?.briefMode ? { briefMode: true } : {}),
      },
    }
    this._sessions.set(session.id, session)
    log.info("Created Codex thread", { threadId })
    return session
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this._sessions.has(sessionId)) return
    // Best-effort unsubscribe so the server can release the thread.
    try {
      await this.peer?.sendRequest("thread/unsubscribe", { threadId: sessionId }, 5000)
    } catch {
      // The server may not be subscribed; local cleanup is what matters.
    }
    this.activeTurns.delete(sessionId)
    this.lastTokenUsage.delete(sessionId)
    this.sentSystemPrompt.delete(sessionId)
    this._sessions.delete(sessionId)
  }

  /**
   * The Codex app-server protocol exposes only `thread/start` + `thread/unsubscribe`
   * — there is no `session/list`, `session/fork`, or `session/resume` equivalent.
   * Report these as deterministically `unsupported` (rather than leaving the
   * manager at `unknown`) so session-extension gating short-circuits with a clear
   * reason instead of attempting an optimistic dispatch that would always fail.
   */
  getSessionExtensionSupport(): ExternalAgentSessionExtensionSupport {
    const unsupported = {
      state: "unsupported" as const,
      lastCheckedAt: new Date(),
      reason: "Codex app-server does not implement session list/fork/resume.",
    }
    return {
      "session/list": unsupported,
      "session/fork": unsupported,
      "session/resume": unsupported,
    }
  }

  // --------------------------------------------------------------------------
  // Prompt / turn lifecycle
  // --------------------------------------------------------------------------

  async *prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    const session = this._sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    this.updateSession(sessionId, { status: "executing" })
    ;(session.messages ?? (session.messages = [])).push(message)

    const queue: ExternalAgentEvent[] = []
    let resolveNext: (() => void) | null = null
    let isDone = false
    let sawDone = false
    let error: Error | null = null

    const listener = (event: ExternalAgentEvent) => {
      if (event.sessionId !== sessionId) return
      queue.push(event)
      resolveNext?.()
      resolveNext = null
      if (event.type === "done") {
        isDone = true
        sawDone = true
      } else if (event.type === "error") {
        isDone = true
        error = new Error(event.error)
      }
    }
    this.addSessionListener(sessionId, listener)

    const input = this.buildTurnInput(sessionId, message, options)

    try {
      // turn/start is a request that resolves once the turn is created; the
      // actual streaming arrives via turn/* + item/* notifications. We fire it
      // and let the notification stream drive completion.
      void this.startTurn(sessionId, input).catch((err) => {
        listener({
          type: "error",
          sessionId,
          timestamp: new Date(),
          error: err instanceof Error ? err.message : String(err),
          recoverable: false,
        })
      })

      while (!isDone) {
        if (queue.length > 0) {
          yield queue.shift()!
        } else {
          await new Promise<void>((resolve) => {
            resolveNext = resolve
            setTimeout(resolve, 100)
          })
        }
        if (options?.signal?.aborted) {
          await this.cancel(sessionId)
          break
        }
      }

      while (queue.length > 0) yield queue.shift()!
      // A turn-failure emits an `error` event for consumer parity AND a terminal
      // `done{success:false}`; that is a graceful end, so we do not rethrow. We
      // only throw for a hard error with no `done` (e.g. turn/start rejected or a
      // transport break), preserving the original failure-propagation contract.
      if (error && !sawDone) throw error
    } finally {
      this.removeSessionListener(sessionId, listener)
      this.updateSession(sessionId, { status: "idle" })
    }
  }

  private async startTurn(sessionId: string, input: CodexUserInput[]): Promise<void> {
    if (!this.peer) throw new Error("Not connected to Codex app-server")
    const session = this._sessions.get(sessionId)
    const params: Record<string, unknown> = {
      threadId: sessionId,
      input,
      approvalPolicy: this.approvalPolicyFor(session?.permissionMode),
    }
    const cwd =
      (typeof session?.metadata?.cwd === "string" ? session.metadata.cwd : undefined) ||
      this._config?.process?.cwd
    if (cwd) params.cwd = cwd
    const model = session?.metadata?.selectedModel
    if (typeof model === "string") params.model = model

    const result = await this.peer.sendRequest<{ turn?: { id?: string } }>("turn/start", params)
    const turnId = result?.turn?.id
    if (turnId) this.activeTurns.set(sessionId, turnId)
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this._sessions.get(sessionId)
    if (!session || session.status !== "executing") return
    const turnId = this.activeTurns.get(sessionId)
    if (turnId && this.peer) {
      try {
        await this.peer.sendRequest("turn/interrupt", { threadId: sessionId, turnId }, 5000)
      } catch (error) {
        log.warn("turn/interrupt failed", { error })
      }
    }
    this.updateSession(sessionId, { status: "idle" })
  }

  /**
   * Codex auto-asks (`approvalPolicy: on-request`) for every mode except
   * `bypassPermissions`, which runs unattended (`never`). The per-mode
   * auto-accept / auto-decline logic is then applied client-side in
   * {@link handleApproval}, so the request actually reaches Codex.
   */
  private approvalPolicyFor(mode: AcpPermissionMode | undefined): string {
    return mode === "bypassPermissions" ? "never" : "on-request"
  }

  // --------------------------------------------------------------------------
  // Input mapping
  // --------------------------------------------------------------------------

  private buildTurnInput(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): CodexUserInput[] {
    const input: CodexUserInput[] = []

    // Prepend the (brief-aware) system prompt once per thread as a leading text
    // item — app-server threads have no dedicated systemPrompt field, so the
    // instructions captured at createSession ride in as the first user input.
    if (!this.sentSystemPrompt.has(sessionId)) {
      const sys = this.resolveSystemPrompt(sessionId)
      if (sys) input.push({ type: "text", text: sys })
      this.sentSystemPrompt.add(sessionId)
    }

    for (const content of message.content) {
      const mapped = this.mapContent(content)
      if (mapped) input.push(mapped)
    }
    for (const file of options?.files ?? []) {
      input.push({ type: "text", text: `Attached file: ${file.path}` })
    }
    if (input.length === 0) input.push({ type: "text", text: "" })
    return input
  }

  /**
   * Resolve the leading system-prompt text for a thread from the metadata
   * captured at {@link createSession} (Codex app-server has no systemPrompt
   * field). Brief mode prepends a concise-output instruction, mirroring the ACP
   * adapter's brief snippet.
   */
  private resolveSystemPrompt(sessionId: string): string | undefined {
    const metadata = this._sessions.get(sessionId)?.metadata
    const systemPrompt =
      typeof metadata?.systemPrompt === "string" ? metadata.systemPrompt : undefined
    const briefMode = metadata?.briefMode === true
    if (!systemPrompt && !briefMode) return undefined
    const briefSnippet =
      "Respond concisely. Skip preamble, headers, and bullet-list filler. Direct answers only — match length to the question."
    if (briefMode) {
      return systemPrompt ? `${briefSnippet}\n\n${systemPrompt}` : briefSnippet
    }
    return systemPrompt
  }

  private mapContent(content: ExternalAgentContent): CodexUserInput | null {
    switch (content.type) {
      case "text":
        return { type: "text", text: content.text }
      case "image":
        if (content.source.type === "url" && content.source.url) {
          return { type: "image", url: content.source.url }
        }
        // Codex input has no inline-base64 form; surface a note rather than drop silently.
        return {
          type: "text",
          text: "[image attachment omitted: base64 not supported by Codex input]",
        }
      case "file": {
        if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(content.path)) {
          return { type: "localImage", path: content.path }
        }
        return { type: "text", text: `File: ${content.path}` }
      }
      default:
        return null
    }
  }

  // --------------------------------------------------------------------------
  // Inbound notifications → events
  // --------------------------------------------------------------------------

  private handleNotification(method: string, params: Record<string, unknown> | undefined): void {
    const p = params ?? {}
    // Status notifications (not part of a prompt stream).
    if (method === "mcpServer/startupStatus/updated" || method === "mcpServerStatus/list/updated") {
      this.applyMcpStatus(p)
      return
    }
    if (method === "skills/changed") {
      void this.refreshSkills()
      return
    }

    const sessionId = this.resolveSessionId(p)
    if (!sessionId) return

    switch (method) {
      case "turn/started": {
        const turnId = readString(readObject(p.turn)?.id)
        if (turnId) this.activeTurns.set(sessionId, turnId)
        return
      }
      case "turn/completed": {
        const turn = readObject(p.turn)
        const status = readString(turn?.status) ?? "completed"
        // Align failure signaling with the OpenCode/A2A adapters: a failed turn
        // emits a dedicated `error` event (not only `done{success:false}`), so
        // downstream consumers that branch on `error` surface Codex failures the
        // same way. The terminal `done` still follows for turn bookkeeping.
        if (status === "failed") {
          const failureMessage =
            readString(readObject(turn?.error)?.message) ??
            readString(turn?.error) ??
            "Codex turn failed"
          this.emit(sessionId, {
            type: "error",
            sessionId,
            timestamp: new Date(),
            error: failureMessage,
            recoverable: false,
          })
        }
        this.emit(sessionId, {
          type: "done",
          sessionId,
          timestamp: new Date(),
          success: status === "completed",
          stopReason: this.mapStopReason(status),
          tokenUsage: this.lastTokenUsage.get(sessionId),
        })
        this.activeTurns.delete(sessionId)
        return
      }
      case "turn/plan/updated": {
        const entries = this.mapPlan(p.plan)
        const total = entries.length || 1
        const done = entries.filter((e) => e.status === "completed").length
        this.emit(sessionId, {
          type: "plan_update",
          sessionId,
          timestamp: new Date(),
          entries,
          progress: done / total,
          step: done,
          totalSteps: total,
        })
        return
      }
      case "thread/tokenUsage/updated": {
        const usage = this.mapTokenUsage(p)
        if (usage) this.lastTokenUsage.set(sessionId, usage)
        return
      }
      case "item/started":
        this.handleItemStarted(sessionId, readObject(p.item))
        return
      case "item/completed":
        this.handleItemCompleted(sessionId, readObject(p.item))
        return
      case "item/agentMessage/delta": {
        const itemId = readString(p.itemId) ?? "agent"
        const delta = readString(p.delta) ?? readString(readObject(p.delta)?.text) ?? ""
        if (delta) {
          this.streamedItems.add(itemId)
          this.emit(sessionId, {
            type: "message_delta",
            sessionId,
            timestamp: new Date(),
            messageId: itemId,
            delta: { type: "text", text: delta },
          })
        }
        return
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const itemId = readString(p.itemId) ?? "reasoning"
        const text = readString(p.delta) ?? readString(p.text) ?? ""
        if (text) {
          this.streamedItems.add(itemId)
          this.emit(sessionId, {
            type: "thinking",
            sessionId,
            timestamp: new Date(),
            thinking: text,
          })
        }
        return
      }
      case "item/commandExecution/outputDelta": {
        // Per the protocol `CommandExecutionOutputDeltaNotification.delta` is a
        // plain (UTF-8) string — there is no base64 field. We read `delta`
        // directly and only fall back to decoding a legacy `deltaBase64` if a
        // forked build still sends it. The previous `deltaBase64`-only read
        // dropped every live command-output chunk.
        const itemId = readString(p.itemId)
        const deltaPlain = readString(p.delta)
        const deltaB64 = readString(p.deltaBase64)
        const delta = deltaPlain ?? (deltaB64 ? decodeBase64(deltaB64) : undefined)
        if (itemId && delta) {
          this.emit(sessionId, {
            type: "tool_use_delta",
            sessionId,
            timestamp: new Date(),
            toolUseId: itemId,
            delta,
          })
        }
        return
      }
      case "item/plan/delta": {
        // Streamed plan text for a `plan` item. Surface as a thinking chunk so
        // the proposed plan renders incrementally rather than being dropped.
        const itemId = readString(p.itemId) ?? "plan"
        const text =
          readString(p.delta) ?? readString(readObject(p.delta)?.text) ?? readString(p.text) ?? ""
        if (text) {
          this.streamedItems.add(itemId)
          this.emit(sessionId, {
            type: "thinking",
            sessionId,
            timestamp: new Date(),
            thinking: text,
          })
        }
        return
      }
      case "turn/diff/updated": {
        // Aggregated unified diff across the turn's file changes. Stored on the
        // session so the UI can render a turn-level diff without re-deriving it.
        const diff = readString(p.diff) ?? readString(readObject(p.unifiedDiff)?.text)
        if (diff !== undefined) {
          const s = this._sessions.get(sessionId)
          if (s) s.metadata = { ...s.metadata, turnDiff: diff }
        }
        return
      }
      default:
        return
    }
  }

  private handleItemStarted(sessionId: string, item?: CodexThreadItem): void {
    if (!item?.id) return
    const id = item.id
    switch (item.type) {
      case "agentMessage":
        this.emit(sessionId, {
          type: "message_start",
          sessionId,
          timestamp: new Date(),
          messageId: id,
          role: "assistant",
        })
        return
      case "commandExecution":
        this.emit(sessionId, {
          type: "tool_use_start",
          sessionId,
          timestamp: new Date(),
          toolUseId: id,
          toolName: "shell",
          kind: "execute",
          rawInput: { command: item.command, cwd: item.cwd },
        })
        return
      case "fileChange":
        this.emit(sessionId, {
          type: "tool_use_start",
          sessionId,
          timestamp: new Date(),
          toolUseId: id,
          toolName: "edit",
          kind: "file_write",
          rawInput: { changes: item.changes },
        })
        return
      case "mcpToolCall":
      case "dynamicToolCall":
        this.emit(sessionId, {
          type: "tool_use_start",
          sessionId,
          timestamp: new Date(),
          toolUseId: id,
          toolName: item.tool || item.toolName || "mcp_tool",
          kind: "mcp",
          rawInput: asRecord(item.arguments ?? item.toolInput),
        })
        return
      case "webSearch":
        this.emit(sessionId, {
          type: "tool_use_start",
          sessionId,
          timestamp: new Date(),
          toolUseId: id,
          toolName: "web_search",
          kind: "other",
          rawInput: { query: item.query },
        })
        return
      default:
        return
    }
  }

  private handleItemCompleted(sessionId: string, item?: CodexThreadItem): void {
    if (!item?.id) return
    const id = item.id
    switch (item.type) {
      case "agentMessage": {
        const text = readString(item.text) ?? extractText(item.content)
        if (text && !this.streamedItems.has(id)) {
          this.emit(sessionId, {
            type: "message_delta",
            sessionId,
            timestamp: new Date(),
            messageId: id,
            delta: { type: "text", text },
          })
        }
        this.emit(sessionId, {
          type: "message_end",
          sessionId,
          timestamp: new Date(),
          messageId: id,
        })
        return
      }
      case "reasoning": {
        if (!this.streamedItems.has(id)) {
          const text =
            readString(item.content) ?? extractText(item.summary) ?? extractText(item.content)
          if (text)
            this.emit(sessionId, {
              type: "thinking",
              sessionId,
              timestamp: new Date(),
              thinking: text,
            })
        }
        return
      }
      case "commandExecution": {
        this.emit(sessionId, {
          type: "tool_use_end",
          sessionId,
          timestamp: new Date(),
          toolUseId: id,
          input: { command: item.command, cwd: item.cwd },
        })
        this.emit(sessionId, {
          type: "tool_result",
          sessionId,
          timestamp: new Date(),
          toolUseId: id,
          result: item.aggregatedOutput ?? "",
          isError: typeof item.exitCode === "number" && item.exitCode !== 0,
        })
        return
      }
      case "fileChange": {
        this.emit(sessionId, {
          type: "tool_use_end",
          sessionId,
          timestamp: new Date(),
          toolUseId: id,
          input: { changes: item.changes },
        })
        this.emit(sessionId, {
          type: "tool_result",
          sessionId,
          timestamp: new Date(),
          toolUseId: id,
          result: asRecord(item.changes) ?? {},
          isError: item.status === "failed",
        })
        return
      }
      case "mcpToolCall":
      case "dynamicToolCall": {
        this.emit(sessionId, {
          type: "tool_use_end",
          sessionId,
          timestamp: new Date(),
          toolUseId: id,
          input: asRecord(item.arguments ?? item.toolInput) ?? {},
        })
        this.emit(sessionId, {
          type: "tool_result",
          sessionId,
          timestamp: new Date(),
          toolUseId: id,
          result: (item.result as string | Record<string, unknown>) ?? "",
          isError: item.error != null,
        })
        return
      }
      case "webSearch": {
        this.emit(sessionId, {
          type: "tool_use_end",
          sessionId,
          timestamp: new Date(),
          toolUseId: id,
          input: { query: item.query },
        })
        return
      }
      case "plan": {
        // A proposed-plan item. Surface its text as a thinking chunk unless it
        // was already streamed via `item/plan/delta`.
        if (!this.streamedItems.has(id)) {
          const text = readString(item.text) ?? extractText(item.content)
          if (text)
            this.emit(sessionId, {
              type: "thinking",
              sessionId,
              timestamp: new Date(),
              thinking: text,
            })
        }
        return
      }
      default:
        return
    }
  }

  // --------------------------------------------------------------------------
  // Approvals (server → client requests)
  // --------------------------------------------------------------------------

  private async handleServerRequest(
    method: string,
    params: Record<string, unknown> | undefined
  ): Promise<unknown> {
    const p = params ?? {}
    if (method === "item/commandExecution/requestApproval") {
      return this.handleApproval(p, "command")
    }
    if (method === "item/fileChange/requestApproval") {
      return this.handleApproval(p, "fileChange")
    }
    if (method === "item/tool/requestUserInput") {
      return this.handleRequestUserInput(p)
    }
    // Unknown client method → JSON-RPC method-not-found via the peer.
    throw new Error(`Method not found: ${method}`)
  }

  /**
   * Codex mid-turn `item/tool/requestUserInput` — the agent asks the user 1–3
   * questions. Without a dedicated question UI we surface the question text into
   * the stream so it is not silently dropped, then respond with the contract's
   * empty-answers shape so Codex can fall back to its own auto-resolution
   * (`autoResolutionMs` / `isOther`) instead of the turn erroring on a
   * method-not-found. Response shape: `{ answers: { [id]: { answers: [] } } }`.
   */
  private handleRequestUserInput(params: Record<string, unknown>): {
    answers: Record<string, { answers: string[] }>
  } {
    const sessionId = this.resolveSessionId(params)
    const questions = Array.isArray(params.questions) ? params.questions : []
    const answers: Record<string, { answers: string[] }> = {}
    const lines: string[] = []
    for (const raw of questions) {
      const q = readObject(raw)
      if (!q) continue
      const id = readString(q.id)
      const text = readString(q.question) ?? readString(q.header)
      if (text) lines.push(`❓ ${text}`)
      if (id) answers[id] = { answers: [] }
    }
    if (sessionId && lines.length > 0) {
      this.emit(sessionId, {
        type: "message_delta",
        sessionId,
        timestamp: new Date(),
        messageId: readString(params.itemId) ?? "request_user_input",
        delta: { type: "text", text: `\n${lines.join("\n")}\n` },
      })
    }
    return { answers }
  }

  private async handleApproval(
    params: Record<string, unknown>,
    kind: "command" | "fileChange"
  ): Promise<{ decision: string }> {
    const sessionId = this.resolveSessionId(params)
    const session = sessionId ? this._sessions.get(sessionId) : undefined
    const itemId = readString(params.itemId) ?? `approval_${Date.now()}`
    const command = readString(params.command)
    const request: AcpPermissionRequest = {
      id: itemId,
      requestId: itemId,
      sessionId,
      toolCallId: itemId,
      title: kind === "command" ? command || "Run command" : "Apply file changes",
      kind: kind === "command" ? "execute" : "file_write",
      toolInfo: {
        id: itemId,
        name: kind === "command" ? command || "shell" : "edit",
        category: kind === "command" ? "execute" : "edit",
      },
      rawInput: kind === "command" ? { command, cwd: readString(params.cwd) } : {},
      reason: readString(params.reason),
    }

    const mode = session?.permissionMode ?? "default"
    const auto = this.autoDecision(mode, kind)
    if (auto) return { decision: auto }

    // Surface to the UI and await `respondToPermission`.
    return new Promise<{ decision: string }>((resolve) => {
      this.pendingApprovals.set(itemId, { resolve, request, kind })
      if (sessionId) {
        this.emit(sessionId, {
          type: "permission_request",
          sessionId,
          timestamp: new Date(),
          request,
        })
      }
    })
  }

  /**
   * Apply the permission mode without UI. Returns the decision string, or
   * `undefined` when the request must be surfaced to the user.
   * - `bypassPermissions` → accept everything (Codex won't even ask, but guard anyway)
   * - `acceptEdits` → accept file changes; commands still prompt
   * - `plan` / `dontAsk` → decline side effects (no pre-approval registry)
   * - `default` → prompt
   */
  private autoDecision(
    mode: AcpPermissionMode,
    kind: "command" | "fileChange"
  ): CodexCommandDecision | CodexFileChangeDecision | undefined {
    if (mode === "bypassPermissions") return "accept"
    if (mode === "acceptEdits" && kind === "fileChange") return "accept"
    // Reuse the shared ordering: anything at or below `dontAsk` auto-declines.
    if (MODE_RANK[mode] <= MODE_RANK.dontAsk) return "decline"
    return undefined
  }

  async respondToPermission(_sessionId: string, response: AcpPermissionResponse): Promise<void> {
    const pending = this.pendingApprovals.get(response.requestId)
    if (!pending) return
    this.pendingApprovals.delete(response.requestId)
    const decision = response.granted
      ? response.scope === "session" || response.rememberChoice
        ? "acceptForSession"
        : "accept"
      : "decline"
    pending.resolve({ decision })
    this.emit(pending.request.sessionId || _sessionId, {
      type: "permission_response",
      sessionId: pending.request.sessionId || _sessionId,
      timestamp: new Date(),
      response,
    })
  }

  // --------------------------------------------------------------------------
  // Models
  // --------------------------------------------------------------------------

  async listModels(): Promise<Array<{ id: string; name?: string }>> {
    if (!this.peer) return []
    try {
      // Per the Codex app-server v2 protocol the result is
      // `ModelListResponse { data: Model[], nextCursor }`, and each `Model` is
      // `{ id, model, displayName, ... }`. We read `data` (with a `models`
      // fallback for any legacy/forked build) so the model picker is populated;
      // the previous `result.models` read always yielded an empty list.
      const result = await this.peer.sendRequest<{
        data?: Array<Record<string, unknown>>
        models?: Array<Record<string, unknown>>
      }>("model/list", { includeHidden: false })
      return (result?.data ?? result?.models ?? []).map((m) => ({
        id: readString(m.id) ?? readString(m.model) ?? "",
        name: readString(m.displayName) ?? readString(m.name),
      }))
    } catch (error) {
      log.warn("model/list failed", { error })
      return []
    }
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const session = this._sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    this.updateSession(sessionId, { metadata: { ...session.metadata, selectedModel: modelId } })
    log.info("Codex session model set", { sessionId, modelId })
  }

  async setSessionMode(sessionId: string, modeId: AcpPermissionMode): Promise<void> {
    if (!this._sessions.has(sessionId)) throw new Error(`Session not found: ${sessionId}`)
    this.updateSession(sessionId, { permissionMode: modeId })
  }

  // --------------------------------------------------------------------------
  // Native MCP + skills (WS3)
  // --------------------------------------------------------------------------

  async refreshMcpServers(): Promise<CodexMcpServerStatus[]> {
    if (!this.peer) return []
    try {
      const result = await this.peer.sendRequest<{ servers?: CodexMcpServerStatus[] }>(
        "mcpServerStatus/list",
        {}
      )
      this.status = { ...this.status, mcpServers: result?.servers ?? [] }
      this.notifyStatus()
      return this.status.mcpServers
    } catch (error) {
      log.warn("mcpServerStatus/list failed", { error })
      return this.status.mcpServers
    }
  }

  async reloadMcpConfig(): Promise<void> {
    await this.peer?.sendRequest("config/mcpServer/reload", {})
    await this.refreshMcpServers()
  }

  async startMcpOAuthLogin(server: string): Promise<{ authUrl?: string }> {
    if (!this.peer) return {}
    const result = await this.peer.sendRequest<{ authUrl?: string; url?: string }>(
      "mcpServer/oauth/login",
      { server }
    )
    return { authUrl: result?.authUrl ?? result?.url }
  }

  async refreshSkills(cwds?: string[]): Promise<CodexSkill[]> {
    if (!this.peer) return []
    try {
      const roots = cwds ?? (this._config?.process?.cwd ? [this._config.process.cwd] : [])
      const result = await this.peer.sendRequest<{ skills?: CodexSkill[] }>("skills/list", {
        cwds: roots,
      })
      this.status = { ...this.status, skills: result?.skills ?? [] }
      this.notifyStatus()
      return this.status.skills
    } catch (error) {
      log.warn("skills/list failed", { error })
      return this.status.skills
    }
  }

  async setSkillEnabled(path: string, enabled: boolean): Promise<void> {
    await this.peer?.sendRequest("skills/config/write", { path, enabled })
    await this.refreshSkills()
  }

  getStatus(): CodexAppServerStatus {
    return { mcpServers: [...this.status.mcpServers], skills: [...this.status.skills] }
  }

  onStatusUpdate(listener: (status: CodexAppServerStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  getServerInfo(): { userAgent?: string; codexHome?: string; platformOs?: string } | undefined {
    return this.serverInfo
  }

  private applyMcpStatus(params: Record<string, unknown>): void {
    const servers = Array.isArray(params.servers)
      ? (params.servers as CodexMcpServerStatus[])
      : undefined
    if (servers) {
      this.status = { ...this.status, mcpServers: servers }
      this.notifyStatus()
    } else {
      void this.refreshMcpServers()
    }
  }

  private notifyStatus(): void {
    const snapshot = this.getStatus()
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot)
      } catch {
        // ignore listener errors
      }
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private addSessionListener(sessionId: string, fn: (event: ExternalAgentEvent) => void): void {
    let set = this.sessionListeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.sessionListeners.set(sessionId, set)
    }
    set.add(fn)
  }

  private removeSessionListener(sessionId: string, fn: (event: ExternalAgentEvent) => void): void {
    this.sessionListeners.get(sessionId)?.delete(fn)
  }

  private emit(sessionId: string, event: ExternalAgentEvent): void {
    const set = this.sessionListeners.get(sessionId)
    if (!set) return
    for (const fn of set) fn(event)
  }

  private resolveSessionId(params: Record<string, unknown>): string | undefined {
    const direct = readString(params.threadId)
    if (direct) return direct
    const fromThread = readString(readObject(params.thread)?.id)
    if (fromThread) return fromThread
    const fromTurn = readString(readObject(params.turn)?.threadId)
    if (fromTurn) return fromTurn
    // Single-session fallback.
    return this._sessions.size === 1 ? [...this._sessions.keys()][0] : undefined
  }

  private mapStopReason(status: string): AcpStopReason {
    switch (status) {
      case "interrupted":
        return "cancelled"
      case "failed":
        return "refusal"
      default:
        return "end_turn"
    }
  }

  private mapPlan(raw: unknown): AcpPlanEntry[] {
    if (!Array.isArray(raw)) return []
    return raw.map((entry) => {
      const obj = readObject(entry) ?? {}
      const status = readString(obj.status)
      return {
        content: readString(obj.step) ?? readString(obj.content) ?? "",
        priority: "medium",
        status:
          status === "completed" || status === "in_progress" || status === "pending"
            ? status
            : "pending",
      }
    })
  }

  private mapTokenUsage(params: Record<string, unknown>): ExternalAgentTokenUsage | undefined {
    const usage = readObject(params.usage) ?? readObject(params.tokenUsage) ?? params
    const prompt = readNumber(usage.inputTokens) ?? readNumber(usage.promptTokens)
    const completion = readNumber(usage.outputTokens) ?? readNumber(usage.completionTokens)
    if (prompt === undefined && completion === undefined) return undefined
    const promptTokens = prompt ?? 0
    const completionTokens = completion ?? 0
    return {
      promptTokens,
      completionTokens,
      totalTokens: readNumber(usage.totalTokens) ?? promptTokens + completionTokens,
      cacheReadTokens: readNumber(usage.cachedInputTokens) ?? readNumber(usage.cacheReadTokens),
    }
  }
}

// ============================================================================
// Pure parsing helpers
// ============================================================================

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return readObject(value)
}

/** Extract plain text from an agentMessage/reasoning `content` array or string. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const obj = readObject(part)
        return readString(obj?.text) ?? (typeof part === "string" ? part : "")
      })
      .join("")
  }
  return ""
}

function decodeBase64(value: string): string {
  try {
    if (typeof atob === "function") {
      const binary = atob(value)
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    }
    return Buffer.from(value, "base64").toString("utf-8")
  } catch {
    return value
  }
}
