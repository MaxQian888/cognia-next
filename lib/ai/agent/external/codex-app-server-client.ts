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
import { loggers } from "@cognia/logging"
import { truncateForLog } from "@cognia/logging/truncate"
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
import { spawnReclaimingOrphan } from "./spawn-reclaim"
import { MODE_RANK } from "./permission-cascade"
import {
  createExternalAgentUnsupportedSessionExtensionError,
  isExternalAgentMethodNotFoundError,
} from "./session-extension-errors"
import type {
  ExternalAgentConfig,
  ExternalAgentSession,
  ExternalAgentMessage,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentContent,
  AcpConfigOption,
  AcpPermissionMode,
  AcpPermissionResponse,
  AcpPermissionRequest,
  AcpPlanEntry,
  AcpSessionModelState,
  AcpStopReason,
  ExternalAgentTokenUsage,
  ExternalAgentSessionExtensionMethod,
  ExternalAgentSessionExtensionSupport,
  ExternalAgentExtensionSupportStatus,
} from "@/types/agent/external-agent"

const log = loggers.agent

/** Active health-probe timeout — mirrors the ACP adapter's 5s ping. */
const HEALTH_PROBE_TIMEOUT_MS = 5000

// ============================================================================
// Codex app-server wire types (local — kept out of the public type surface)
// ============================================================================

// Wire-format ground truth: verified against `codex app-server generate-json-schema`
// (codex-cli 0.141.0). Key invariants encoded below:
// - `approvalPolicy` (AskForApproval) is kebab-case: "untrusted" | "on-failure" |
//   "on-request" | "never".
// - `sandboxPolicy` is a `type`-tagged camelCase union (see CodexSandboxPolicy).
// - `effort` is a free-form model-advertised string; `summary` is
//   "auto" | "concise" | "detailed" | "none".
// - `thread/start` accepts `developerInstructions` (system-prompt channel) and
//   `sandbox` (same SandboxPolicy union as turn/start's `sandboxPolicy`).

/** A user input item for `thread/start` / `turn/start`. */
type CodexUserInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }

/** Approval decision enums (camelCase on the wire). */
type CodexCommandDecision = "accept" | "acceptForSession" | "decline" | "cancel"
type CodexFileChangeDecision = "accept" | "acceptForSession" | "decline" | "cancel"

/** Sandbox modes the client exposes (externalSandbox is server-managed only). */
export type CodexSandboxMode = "readOnly" | "workspaceWrite" | "dangerFullAccess"

/** `SandboxPolicy` tagged union as serialized on the wire. */
export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess?: boolean }
  | {
      type: "workspaceWrite"
      writableRoots?: string[]
      networkAccess?: boolean
      excludeSlashTmp?: boolean
      excludeTmpdirEnvVar?: boolean
    }

/** Per-session Codex option overrides carried via session metadata. */
export interface CodexSessionOptions {
  sandboxMode?: CodexSandboxMode
  networkAccess?: boolean
  writableRoots?: string[]
  defaultReasoningEffort?: string
  reasoningSummary?: string
}

/** `model/list` entry (v2 `Model`). */
export interface CodexModelInfo {
  id: string
  model?: string
  displayName?: string
  description?: string
  hidden?: boolean
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description?: string }>
  supportsPersonality?: boolean
}

/** `account/read` result (v2 `Account` union, flattened for the status card). */
export interface CodexAccountInfo {
  type?: string
  email?: string
  planType?: string
}

/** One `RateLimitWindow` from a `RateLimitSnapshot`. */
export interface CodexRateLimitWindow {
  usedPercent: number
  windowDurationMins?: number
  /** Unix timestamp in seconds. */
  resetsAt?: number
}

/** Flattened `account/rateLimits/read` snapshot for the status card. */
export interface CodexRateLimitsInfo {
  planType?: string
  primary?: CodexRateLimitWindow
  secondary?: CodexRateLimitWindow
  rateLimitReachedType?: string
}

/** A `thread/list` entry (v2 `Thread`, subset the session UI needs). */
interface CodexThreadSummary {
  id?: string
  name?: string | null
  preview?: string | null
  /** Unix timestamp in seconds. */
  createdAt?: number
  updatedAt?: number
}

/** One `item/tool/requestUserInput` question (EXPERIMENTAL wire shape). */
export interface CodexUserInputQuestion {
  id: string
  header?: string
  question: string
  options?: Array<{ label: string; description?: string }> | null
  isOther?: boolean
  isSecret?: boolean
}

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
  // imageView
  path?: string
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
  /** `account/read` — null means signed out; undefined means not yet fetched. */
  account?: CodexAccountInfo | null
  requiresOpenaiAuth?: boolean
  /** `account/rateLimits/read` / `account/rateLimits/updated` snapshot. */
  rateLimits?: CodexRateLimitsInfo | null
  /**
   * `true` when the connected Codex CLI lacks the `skills/extraRoots/set`
   * method, so configured extra skill folders cannot be registered. Left
   * `undefined` until the roots are applied (or when there are none).
   */
  extraSkillRootsUnsupported?: boolean
}

/**
 * Trim, drop blanks, and de-duplicate a list of extra skill folder paths before
 * sending them over the wire. Order is preserved (first occurrence wins).
 */
function normalizeSkillRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of roots) {
    const path = raw.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

interface PendingApproval {
  resolve: (decision: { decision: string }) => void
  request: AcpPermissionRequest
  kind: "command" | "fileChange"
  sessionId?: string
}

interface PendingUserInput {
  resolve: (response: { answers: Record<string, { answers: string[] }> }) => void
  sessionId?: string
  questions: CodexUserInputQuestion[]
  timer?: ReturnType<typeof setTimeout>
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
  // Pending `item/tool/requestUserInput` requests awaiting a UI answer.
  private pendingUserInputs = new Map<string, PendingUserInput>()
  // `agentMessage` itemId → MessagePhase ("commentary" | "final_answer") from
  // item/started, so deltas (which carry no phase) can route to thinking.
  private itemPhases = new Map<string, string>()
  // Full model catalog cached from `model/list` (drives effort options).
  private modelCache: CodexModelInfo[] = []
  // Per-method support cache for graceful degradation on older codex CLIs.
  private unsupportedMethods = new Set<string>()
  private _sessionExtensionSupport: ExternalAgentSessionExtensionSupport =
    createDefaultCodexSessionExtensionSupport()

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
        // Approvals / requestUserInput stay pending on user interaction while
        // the server keeps streaming (and may resolve them via
        // serverRequest/resolved) — never block the inbound pipeline on them.
        concurrentServerRequests: true,
        writeRaw: (message) => this.writeToProcess(message),
        onNotification: (method, params) => this.handleNotification(method, params),
        onServerRequest: (method, params) => this.handleServerRequest(method, params),
      })

      const env = await buildAgentEnv(config, config.process.env || {})
      this.processId = await this.spawnProcess(config, env)

      this.registerProcessListeners()

      // Handshake: initialize → store info → `initialized` notification.
      const result = await this.peer.sendRequest<{
        userAgent?: string
        codexHome?: string
        platformOs?: string
      }>("initialize", {
        clientInfo: { name: "cognia", title: "Cognia", version: "1.0.0" },
        // `experimentalApi` opts into experimental methods/fields — required for
        // `item/tool/requestUserInput` (marked EXPERIMENTAL in the 0.141 schema).
        // Unknown experimental notifications fall through the default branch.
        capabilities: { experimentalApi: true },
      })
      this.serverInfo = {
        userAgent: result?.userAgent,
        codexHome: result?.codexHome,
        platformOs: result?.platformOs,
      }
      this.peer.sendNotification("initialized")
      this.clearSessionExtensionSupportCache()
      // Best-effort account + rate-limit snapshot for the status card; older
      // CLIs without the account surface degrade silently via callOptional.
      void this.refreshAccount()
      // Re-register configured extra skill folders — the app-server never
      // persists them across restarts, so every connect must re-apply.
      void this.applyConfiguredExtraSkillRoots()

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
      // Never leave the child registered behind a failed connect: the process
      // manager keys it by config id, so an orphan makes every later connect
      // fail with "already running" until the whole app restarts.
      if (this.processId) {
        try {
          await killExternalAgent(this.processId)
        } catch (killError) {
          log.warn("Failed to kill Codex app-server process after a failed connect", { killError })
        }
        this.processId = undefined
      }
      this.peer = undefined
      this._connectionStatus = "error"
      log.error("Codex app-server connection failed", { error })
      throw error
    }
  }

  /** Spawn the app-server, reclaiming the agent id from an orphaned process. */
  private async spawnProcess(
    config: ExternalAgentConfig,
    env: Record<string, string>
  ): Promise<string> {
    const spawnConfig = {
      id: config.id,
      command: config.process!.command,
      args: config.process!.args ?? [],
      env,
      cwd: config.process!.cwd,
    }
    return spawnReclaimingOrphan({
      id: config.id,
      spawn: () => spawnExternalAgent(spawnConfig),
      kill: (id) => killExternalAgent(id),
      onReclaim: (id) => log.warn("Reclaiming an orphaned Codex app-server process", { id }),
    })
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
    for (const [, pending] of this.pendingUserInputs) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve({ answers: emptyAnswersFor(pending.questions) })
    }
    this.pendingUserInputs.clear()
    this.processId = undefined
    this.peer = undefined
    this._sessions.clear()
    this.activeTurns.clear()
    this.lastTokenUsage.clear()
    this.streamedItems.clear()
    this.sentSystemPrompt.clear()
    this.itemPhases.clear()
    this.modelCache = []
    this.clearSessionExtensionSupportCache()
    this._connectionStatus = "disconnected"
    log.info("Disconnected from Codex app-server")
  }

  /**
   * Call a method that may not exist on older codex CLIs. A JSON-RPC
   * method-not-found (`-32601`) marks the method unsupported (cached until the
   * next connect) and returns `undefined`; any other failure propagates.
   */
  private async callOptional<T>(
    method: string,
    params?: Record<string, unknown>,
    timeout?: number
  ): Promise<T | undefined> {
    if (!this.peer || this.unsupportedMethods.has(method)) return undefined
    try {
      return await this.peer.sendRequest<T>(method, params, timeout)
    } catch (error) {
      if (isExternalAgentMethodNotFoundError(error)) {
        this.unsupportedMethods.add(method)
        log.info("Codex app-server method unsupported", { method })
        return undefined
      }
      throw error
    }
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
      // Routine subprocess stderr, per-chunk on a chatty stream: keep it at
      // `debug` (below the Next dev server's forwarded warn+ threshold, so it
      // can't flood the forwarded-console buffer) and bound each chunk's size.
      if (event.agentId === this.processId)
        log.debug("Codex app-server stderr", { data: truncateForLog(event.data) })
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

    const metadata = this.buildSessionMetadata(options)
    const params: Record<string, unknown> = {
      approvalPolicy: this.approvalPolicyFor(
        (options?.permissionMode || "default") as AcpPermissionMode
      ),
    }
    const cwd = readString(metadata.cwd) || this._config?.process?.cwd
    if (cwd) params.cwd = cwd
    const model = readString(metadata.selectedModel)
    if (model) params.model = model
    const sandbox = this.sandboxPolicyFrom(metadata)
    if (sandbox) params.sandbox = sandbox
    // `developerInstructions` is the native system-prompt channel (verified in
    // the 0.141 schema) — carrying it here supersedes the first-turn text
    // prepend, which stays as the fallback for resumed/forked threads only.
    const systemPrompt = resolveSystemPromptText(metadata)
    if (systemPrompt) params.developerInstructions = systemPrompt

    const result = await this.peer.sendRequest<{ thread?: { id?: string } }>("thread/start", params)
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
      metadata,
    }
    this._sessions.set(session.id, session)
    // The system prompt already rode in via developerInstructions.
    if (systemPrompt) this.sentSystemPrompt.add(threadId)
    log.info("Created Codex thread", { threadId })
    return session
  }

  /** Session metadata assembled from create options + per-agent codexOptions. */
  private buildSessionMetadata(options?: SessionCreateOptions): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      ...(options?.metadata ?? {}),
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options?.briefMode ? { briefMode: true } : {}),
    }
    // Per-agent defaults plumbed by the manager as metadata.codexOptions;
    // resolve into flat runtime keys the turn builder + config options read.
    const defaults = readObject(metadata.codexOptions) as CodexSessionOptions | undefined
    if (defaults?.sandboxMode && metadata.sandboxMode === undefined) {
      metadata.sandboxMode = defaults.sandboxMode
    }
    if (defaults?.networkAccess !== undefined && metadata.networkAccess === undefined) {
      metadata.networkAccess = defaults.networkAccess
    }
    if (defaults?.writableRoots && metadata.writableRoots === undefined) {
      metadata.writableRoots = defaults.writableRoots
    }
    if (defaults?.defaultReasoningEffort && metadata.reasoningEffort === undefined) {
      metadata.reasoningEffort = defaults.defaultReasoningEffort
    }
    if (defaults?.reasoningSummary && metadata.reasoningSummary === undefined) {
      metadata.reasoningSummary = defaults.reasoningSummary
    }
    return metadata
  }

  /** Build the wire `SandboxPolicy` from resolved session metadata, if any. */
  private sandboxPolicyFrom(
    metadata: Record<string, unknown> | undefined
  ): CodexSandboxPolicy | undefined {
    const mode = readString(metadata?.sandboxMode)
    if (mode === "dangerFullAccess") return { type: "dangerFullAccess" }
    if (mode === "readOnly") {
      const policy: CodexSandboxPolicy = { type: "readOnly" }
      if (typeof metadata?.networkAccess === "boolean")
        policy.networkAccess = metadata.networkAccess
      return policy
    }
    if (mode === "workspaceWrite") {
      const policy: CodexSandboxPolicy = { type: "workspaceWrite" }
      if (typeof metadata?.networkAccess === "boolean")
        policy.networkAccess = metadata.networkAccess
      if (Array.isArray(metadata?.writableRoots) && metadata.writableRoots.length > 0) {
        policy.writableRoots = metadata.writableRoots.filter(
          (root): root is string => typeof root === "string"
        )
      }
      return policy
    }
    return undefined
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

  // --------------------------------------------------------------------------
  // Session extension (thread/list, thread/resume, thread/fork, thread/delete)
  //
  // The app-server implements the full thread-persistence surface (verified in
  // the 0.141 schema). Support is probed per method and cached like the ACP
  // adapter: a `-32601` marks the method unsupported for this connection and
  // throws the shared typed error so manager gating behaves identically.
  // --------------------------------------------------------------------------

  getSessionExtensionSupport(): ExternalAgentSessionExtensionSupport {
    return { ...this._sessionExtensionSupport }
  }

  clearSessionExtensionSupportCache(): void {
    this._sessionExtensionSupport = createDefaultCodexSessionExtensionSupport()
    this.unsupportedMethods.clear()
  }

  private setExtensionSupport(
    method: ExternalAgentSessionExtensionMethod,
    state: ExternalAgentExtensionSupportStatus["state"],
    reason?: string
  ): void {
    this._sessionExtensionSupport = {
      ...this._sessionExtensionSupport,
      [method]: {
        state,
        reasonCode: state === "supported" ? ("ok" as const) : ("extension_unsupported" as const),
        reason,
        lastCheckedAt: new Date(),
      },
    }
  }

  /** Wrap a thread/* call in the probe-cache + typed unsupported error dance. */
  private async callSessionExtension<T>(
    extension: ExternalAgentSessionExtensionMethod,
    wireMethod: string,
    params: Record<string, unknown>
  ): Promise<T> {
    if (!this.peer) throw new Error("Not connected to Codex app-server")
    if (this.unsupportedMethods.has(wireMethod)) {
      this.setExtensionSupport(extension, "unsupported", `${wireMethod} is not supported`)
      throw createExternalAgentUnsupportedSessionExtensionError(extension)
    }
    try {
      const result = await this.peer.sendRequest<T>(wireMethod, params)
      this.setExtensionSupport(extension, "supported")
      return result
    } catch (error) {
      if (isExternalAgentMethodNotFoundError(error)) {
        this.unsupportedMethods.add(wireMethod)
        this.setExtensionSupport(extension, "unsupported", `${wireMethod} is not supported`)
        throw createExternalAgentUnsupportedSessionExtensionError(extension)
      }
      throw error
    }
  }

  async listSessions(): Promise<
    Array<{ sessionId: string; title?: string; createdAt?: string; updatedAt?: string }>
  > {
    const result = await this.callSessionExtension<{ data?: CodexThreadSummary[] }>(
      "session/list",
      "thread/list",
      { limit: 50, sortKey: "updated_at", sortDirection: "desc" }
    )
    return (result?.data ?? [])
      .filter((thread): thread is CodexThreadSummary & { id: string } => !!readString(thread.id))
      .map((thread) => ({
        sessionId: thread.id,
        title: readString(thread.name) ?? readString(thread.preview),
        createdAt: unixSecondsToIso(thread.createdAt),
        updatedAt: unixSecondsToIso(thread.updatedAt),
      }))
  }

  async resumeSession(
    sessionId: string,
    options?: SessionCreateOptions
  ): Promise<ExternalAgentSession> {
    const metadata = this.buildSessionMetadata(options)
    const params: Record<string, unknown> = { threadId: sessionId }
    const model = readString(metadata.selectedModel)
    if (model) params.model = model
    const sandbox = this.sandboxPolicyFrom(metadata)
    if (sandbox) params.sandbox = sandbox

    const result = await this.callSessionExtension<{
      thread?: { id?: string }
      model?: string
      reasoningEffort?: string
      initialTurnsPage?: { data?: Array<{ items?: CodexThreadItem[] }> }
    }>("session/resume", "thread/resume", params)

    const threadId = readString(result?.thread?.id) ?? sessionId
    if (result?.model && metadata.selectedModel === undefined) {
      metadata.selectedModel = result.model
    }
    if (result?.reasoningEffort && metadata.reasoningEffort === undefined) {
      metadata.reasoningEffort = result.reasoningEffort
    }
    const messages = hydrateMessagesFromTurns(result?.initialTurnsPage?.data)
    const session: ExternalAgentSession = {
      id: threadId,
      agentId: this._config!.id,
      status: "active",
      permissionMode: (options?.permissionMode || "default") as AcpPermissionMode,
      capabilities: this._capabilities,
      tools: this._tools ?? [],
      messages,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata,
    }
    this._sessions.set(session.id, session)
    // A resumed thread already carries its history; never re-prepend the prompt.
    this.sentSystemPrompt.add(session.id)
    log.info("Resumed Codex thread", { threadId, messages: messages.length })
    return session
  }

  async forkSession(sessionId: string): Promise<ExternalAgentSession> {
    const source = this._sessions.get(sessionId)
    const result = await this.callSessionExtension<{ thread?: { id?: string } }>(
      "session/fork",
      "thread/fork",
      { threadId: sessionId }
    )
    const threadId = readString(result?.thread?.id)
    if (!threadId) throw new Error("Codex app-server did not return a forked thread id")
    const session: ExternalAgentSession = {
      id: threadId,
      agentId: this._config!.id,
      status: "active",
      permissionMode: source?.permissionMode ?? "default",
      capabilities: this._capabilities,
      tools: this._tools ?? [],
      messages: [...(source?.messages ?? [])],
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: { ...(source?.metadata ?? {}), forkedFrom: sessionId },
    }
    this._sessions.set(session.id, session)
    this.sentSystemPrompt.add(session.id)
    log.info("Forked Codex thread", { from: sessionId, threadId })
    return session
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.callOptional("thread/delete", { threadId: sessionId })
    this._sessions.delete(sessionId)
    this.activeTurns.delete(sessionId)
  }

  // Codex-specific thread housekeeping, reached via getCodexAppServerAdapter().

  /** Trigger server-side context compaction for a thread. */
  async compactSession(sessionId: string): Promise<void> {
    if (!this.peer) throw new Error("Not connected to Codex app-server")
    await this.peer.sendRequest("thread/compact/start", { threadId: sessionId })
  }

  /** Remove the last `numTurns` turns from the thread's context. */
  async rollbackSession(sessionId: string, numTurns: number): Promise<void> {
    if (!this.peer) throw new Error("Not connected to Codex app-server")
    await this.peer.sendRequest("thread/rollback", { threadId: sessionId, numTurns })
  }

  /** Set the user-facing thread name (mirrored back via thread/name/updated). */
  async setThreadName(sessionId: string, name: string): Promise<void> {
    await this.callOptional("thread/name/set", { threadId: sessionId, name })
  }

  async archiveThread(sessionId: string): Promise<void> {
    await this.callOptional("thread/archive", { threadId: sessionId })
  }

  async unarchiveThread(sessionId: string): Promise<void> {
    await this.callOptional("thread/unarchive", { threadId: sessionId })
  }

  /** Whether this adapter supports server-side context compaction. */
  supportsCompaction(): boolean {
    return this.isConnected() && !this.unsupportedMethods.has("thread/compact/start")
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
    const effort = readString(session?.metadata?.reasoningEffort)
    if (effort) params.effort = effort
    const summary = readString(session?.metadata?.reasoningSummary)
    if (summary) params.summary = summary
    const sandboxPolicy = this.sandboxPolicyFrom(session?.metadata)
    if (sandboxPolicy) params.sandboxPolicy = sandboxPolicy

    const result = await this.peer.sendRequest<{ turn?: { id?: string } }>("turn/start", params)
    const turnId = result?.turn?.id
    if (turnId) this.activeTurns.set(sessionId, turnId)
  }

  /**
   * Append input to the session's in-flight turn (`turn/steer`). Throws when no
   * turn is active or the server predates the method; callers fall back to
   * their queue-and-replay path in that case.
   */
  async steerTurn(sessionId: string, text: string): Promise<void> {
    if (!this.peer) throw new Error("Not connected to Codex app-server")
    const expectedTurnId = this.activeTurns.get(sessionId)
    if (!expectedTurnId) throw new Error("No active turn to steer")
    if (this.unsupportedMethods.has("turn/steer")) {
      throw new Error("turn/steer is not supported by this Codex version")
    }
    try {
      const result = await this.peer.sendRequest<{ turnId?: string }>("turn/steer", {
        threadId: sessionId,
        expectedTurnId,
        input: [{ type: "text", text }],
      })
      if (result?.turnId) this.activeTurns.set(sessionId, result.turnId)
    } catch (error) {
      if (isExternalAgentMethodNotFoundError(error)) {
        this.unsupportedMethods.add("turn/steer")
        throw new Error("turn/steer is not supported by this Codex version")
      }
      throw error
    }
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
    return resolveSystemPromptText(this._sessions.get(sessionId)?.metadata)
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
    if (method === "mcpServer/oauthLogin/completed") {
      void this.refreshMcpServers()
      return
    }
    if (method === "account/updated" || method === "account/login/completed") {
      void this.refreshAccount()
      return
    }
    if (method === "account/rateLimits/updated") {
      const rateLimits = mapRateLimits(readObject(p.rateLimits))
      if (rateLimits) {
        this.status = { ...this.status, rateLimits }
        this.notifyStatus()
      }
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
        // An `interrupted` turn is a user cancellation, NOT a failure: it ends
        // with `done{success:false, stopReason:"cancelled"}` and no error event.
        if (status === "failed") {
          const turnError = readObject(turn?.error)
          const failureMessage =
            readString(turnError?.message) ?? readString(turn?.error) ?? "Codex turn failed"
          this.emit(sessionId, {
            type: "error",
            sessionId,
            timestamp: new Date(),
            error: failureMessage,
            code: mapCodexErrorCode(turnError?.codexErrorInfo),
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
          // Commentary-phase assistant text (mid-turn narration) streams as
          // thinking so the final answer stays clean. The delta carries no
          // phase; it was registered from the item/started payload.
          if (this.itemPhases.get(itemId) === "commentary") {
            this.emit(sessionId, {
              type: "thinking",
              sessionId,
              timestamp: new Date(),
              thinking: delta,
            })
            return
          }
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
      case "item/reasoning/summaryPartAdded": {
        // Boundary between reasoning summary sections — keep them readable.
        this.emit(sessionId, {
          type: "thinking",
          sessionId,
          timestamp: new Date(),
          thinking: "\n\n",
        })
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
      case "thread/name/updated": {
        const name = readString(p.threadName) ?? readString(p.name)
        const s = this._sessions.get(sessionId)
        if (s && name !== undefined) s.metadata = { ...s.metadata, title: name }
        return
      }
      case "thread/status/changed": {
        // Mirror the server-side thread status onto the local session so a
        // wedged/errored thread is visible without waiting on turn events.
        const statusType = readString(readObject(p.status)?.type)
        const s = this._sessions.get(sessionId)
        if (!s) return
        if (statusType === "active") this.updateSession(sessionId, { status: "executing" })
        else if (statusType === "idle") this.updateSession(sessionId, { status: "idle" })
        else if (statusType === "systemError") this.updateSession(sessionId, { status: "error" })
        return
      }
      case "thread/closed": {
        if (this._sessions.has(sessionId)) {
          this.emit(sessionId, {
            type: "session_end",
            sessionId,
            timestamp: new Date(),
            reason: "completed",
          })
          this.activeTurns.delete(sessionId)
          this._sessions.delete(sessionId)
        }
        return
      }
      case "thread/deleted": {
        this._sessions.delete(sessionId)
        this.activeTurns.delete(sessionId)
        return
      }
      case "thread/started":
      case "thread/archived":
      case "thread/unarchived":
        // Bookkeeping-only notifications; session state already tracks these.
        return
      case "serverRequest/resolved": {
        // The server resolved an outstanding request (approval / user input)
        // elsewhere — unblock any pending resolver for this thread; the late
        // JSON-RPC response is ignored server-side.
        this.resolvePendingForThread(sessionId, "resolved_elsewhere")
        return
      }
      default:
        return
    }
  }

  /** Resolve all pending approvals + user-input requests for a thread. */
  private resolvePendingForThread(sessionId: string, reason: string): void {
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.sessionId !== sessionId) continue
      this.pendingApprovals.delete(id)
      pending.resolve({ decision: "decline" })
      this.emit(sessionId, {
        type: "permission_response",
        sessionId,
        timestamp: new Date(),
        response: { requestId: id, granted: false, reason },
      })
    }
    for (const [id, pending] of this.pendingUserInputs) {
      if (pending.sessionId !== sessionId) continue
      this.pendingUserInputs.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve({ answers: emptyAnswersFor(pending.questions) })
      this.emit(sessionId, {
        type: "permission_response",
        sessionId,
        timestamp: new Date(),
        response: { requestId: id, granted: false, reason },
      })
    }
  }

  private handleItemStarted(sessionId: string, item?: CodexThreadItem): void {
    if (!item?.id) return
    const id = item.id
    switch (item.type) {
      case "agentMessage":
        // Register the message phase so deltas (phase-less) can route
        // commentary to thinking. Commentary items emit no message_start.
        if (typeof item.phase === "string") this.itemPhases.set(id, item.phase)
        if (item.phase === "commentary") return
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
      case "collabAgentToolCall":
        // Multi-agent collaboration tool call (agent-to-agent messaging).
        this.emit(sessionId, {
          type: "tool_use_start",
          sessionId,
          timestamp: new Date(),
          toolUseId: id,
          toolName: item.tool || item.toolName || "collab_agent",
          kind: "other",
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
      case "enteredReviewMode":
        this.emit(sessionId, {
          type: "mode_update",
          sessionId,
          timestamp: new Date(),
          modeId: "review",
        })
        return
      case "contextCompaction": {
        // Server-side history compaction in progress; surface as progress and
        // flag the session so the UI can annotate the context reset.
        const s = this._sessions.get(sessionId)
        if (s) s.metadata = { ...s.metadata, contextCompacted: true }
        this.emit(sessionId, {
          type: "progress",
          sessionId,
          timestamp: new Date(),
          progress: 0,
          message: "context_compaction",
        })
        return
      }
      default:
        return
    }
  }

  private handleItemCompleted(sessionId: string, item?: CodexThreadItem): void {
    if (!item?.id) return
    const id = item.id
    switch (item.type) {
      case "agentMessage": {
        const phase = readString(item.phase) ?? this.itemPhases.get(id)
        const text = readString(item.text) ?? extractText(item.content)
        // Commentary text is mid-turn narration: emit as thinking (when not
        // already streamed) and skip the message_start/end envelope.
        if (phase === "commentary") {
          if (text && !this.streamedItems.has(id)) {
            this.emit(sessionId, {
              type: "thinking",
              sessionId,
              timestamp: new Date(),
              thinking: text,
            })
          }
          this.itemPhases.delete(id)
          return
        }
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
        this.itemPhases.delete(id)
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
      case "dynamicToolCall":
      case "collabAgentToolCall": {
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
      case "imageView": {
        // The agent surfaced an image (path/url) — report as a tool result so
        // the transcript records it.
        this.emit(sessionId, {
          type: "tool_result",
          sessionId,
          timestamp: new Date(),
          toolUseId: id,
          result: { path: readString(item.path) ?? "" },
          isError: false,
        })
        return
      }
      case "exitedReviewMode": {
        this.emit(sessionId, {
          type: "mode_update",
          sessionId,
          timestamp: new Date(),
          modeId: "default",
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
   * Codex mid-turn `item/tool/requestUserInput` — the agent asks the user
   * questions ({@link CodexUserInputQuestion}). Surface them as a
   * `permission_request` (rendered by the existing tool-approval dialog in
   * question mode via `metadata.codexUserInput`) and await
   * {@link respondToPermission}, whose `answers` map is forwarded verbatim as
   * `{ answers: { [id]: { answers: [...] } } }`. When `autoResolutionMs` is set
   * the request self-resolves with empty answers (server-side auto-resolution)
   * once the window elapses.
   */
  private handleRequestUserInput(
    params: Record<string, unknown>
  ): Promise<{ answers: Record<string, { answers: string[] }> }> {
    const sessionId = this.resolveSessionId(params)
    const questions = parseUserInputQuestions(params.questions)
    const requestId = readString(params.itemId) ?? `user_input_${Date.now()}`
    if (!sessionId || questions.length === 0) {
      return Promise.resolve({ answers: emptyAnswersFor(questions) })
    }

    const autoResolutionMs = readNumber(params.autoResolutionMs)
    const first = questions[0]
    const request: AcpPermissionRequest = {
      id: requestId,
      requestId,
      sessionId,
      title: first.header || first.question,
      kind: "other",
      toolInfo: { id: requestId, name: "request_user_input", category: "other" },
      // Single-question single-select renders directly from ACP options; the
      // full multi-question payload rides in metadata for the question-mode UI.
      options: (first.options ?? []).map((option, index) => ({
        optionId: `${first.id}:${option.label}`,
        name: option.label,
        description: option.description,
        kind: "allow_once" as const,
        isDefault: index === 0,
      })),
      autoApproveTimeout: autoResolutionMs,
      metadata: {
        codexUserInput: {
          requestId,
          questions,
          ...(autoResolutionMs !== undefined ? { autoResolutionMs } : {}),
        },
      },
    }

    return new Promise((resolve) => {
      const pending: PendingUserInput = { resolve, sessionId, questions }
      if (autoResolutionMs && autoResolutionMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.pendingUserInputs.has(requestId)) return
          this.pendingUserInputs.delete(requestId)
          resolve({ answers: emptyAnswersFor(questions) })
          this.emit(sessionId, {
            type: "permission_response",
            sessionId,
            timestamp: new Date(),
            response: { requestId, granted: false, reason: "auto_resolved" },
          })
        }, autoResolutionMs)
      }
      this.pendingUserInputs.set(requestId, pending)
      this.emit(sessionId, {
        type: "permission_request",
        sessionId,
        timestamp: new Date(),
        request,
      })
    })
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

    // Forward protocol context the approval dialog can use (ordered decision
    // list, parsed command actions, network approval context).
    const availableDecisions = Array.isArray(params.availableDecisions)
      ? params.availableDecisions.filter((d): d is string => typeof d === "string")
      : undefined
    if (availableDecisions || params.commandActions || params.networkApprovalContext) {
      request.metadata = {
        ...(availableDecisions ? { availableDecisions } : {}),
        ...(params.commandActions ? { commandActions: params.commandActions } : {}),
        ...(params.networkApprovalContext
          ? { networkApprovalContext: params.networkApprovalContext }
          : {}),
      }
    }

    const mode = session?.permissionMode ?? "default"
    const auto = this.autoDecision(mode, kind)
    if (auto) return { decision: auto }

    // Surface to the UI and await `respondToPermission`.
    return new Promise<{ decision: string }>((resolve) => {
      this.pendingApprovals.set(itemId, { resolve, request, kind, sessionId })
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
    // requestUserInput answers take precedence: same dialog surface, distinct
    // wire reply ({answers} instead of {decision}).
    const userInput = this.pendingUserInputs.get(response.requestId)
    if (userInput) {
      this.pendingUserInputs.delete(response.requestId)
      if (userInput.timer) clearTimeout(userInput.timer)
      userInput.resolve({ answers: this.buildUserInputAnswers(userInput.questions, response) })
      const sessionId = userInput.sessionId || _sessionId
      this.emit(sessionId, {
        type: "permission_response",
        sessionId,
        timestamp: new Date(),
        response,
      })
      return
    }

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

  /** Map a UI permission response onto the Codex requestUserInput answer map. */
  private buildUserInputAnswers(
    questions: CodexUserInputQuestion[],
    response: AcpPermissionResponse
  ): Record<string, { answers: string[] }> {
    const answers = emptyAnswersFor(questions)
    if (!response.granted) return answers
    // Preferred channel: the question-mode dialog supplies per-question answers.
    if (response.answers) {
      for (const [questionId, values] of Object.entries(response.answers)) {
        answers[questionId] = { answers: values.filter((v) => typeof v === "string") }
      }
      return answers
    }
    // Fallback: a plain option pick from the standard approval dialog
    // (`optionId` is `<questionId>:<label>`).
    if (response.optionId) {
      const splitAt = response.optionId.indexOf(":")
      if (splitAt > 0) {
        const questionId = response.optionId.slice(0, splitAt)
        const label = response.optionId.slice(splitAt + 1)
        if (answers[questionId]) answers[questionId] = { answers: [label] }
      }
    }
    return answers
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
      this.modelCache = (result?.data ?? result?.models ?? []).map((m) => mapModelInfo(m))
      return this.modelCache.map((m) => ({ id: m.id, name: m.displayName }))
    } catch (error) {
      log.warn("model/list failed", { error })
      return []
    }
  }

  /** Full cached model catalog (rich `model/list` fields). */
  getModelCatalog(): CodexModelInfo[] {
    return [...this.modelCache]
  }

  getSessionModels(sessionId: string): AcpSessionModelState | undefined {
    const session = this._sessions.get(sessionId)
    if (!session || this.modelCache.length === 0) return undefined
    const selected = readString(session.metadata?.selectedModel)
    const current = selected ?? this.modelCache.find((m) => m.isDefault)?.id
    return {
      availableModels: this.modelCache.map((m) => ({
        modelId: m.id,
        name: m.displayName ?? m.id,
        description: m.description,
      })),
      currentModelId: current ?? this.modelCache[0].id,
    }
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const session = this._sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    // Switching models invalidates the effort choice — each model advertises
    // its own supported efforts; reset to the new model's default.
    const model = this.modelCache.find((m) => m.id === modelId)
    const metadata: Record<string, unknown> = { ...session.metadata, selectedModel: modelId }
    if (model?.defaultReasoningEffort) {
      metadata.reasoningEffort = model.defaultReasoningEffort
    }
    this.updateSession(sessionId, { metadata })
    this.emitConfigOptions(sessionId)
    log.info("Codex session model set", { sessionId, modelId })
  }

  async setSessionMode(sessionId: string, modeId: AcpPermissionMode): Promise<void> {
    if (!this._sessions.has(sessionId)) throw new Error(`Session not found: ${sessionId}`)
    this.updateSession(sessionId, { permissionMode: modeId })
  }

  // --------------------------------------------------------------------------
  // Session config options (synthesized — effort + sandbox)
  //
  // Codex has no native config-option surface; we synthesize ACP-shaped options
  // so the existing session-panel control renders effort/sandbox pickers with
  // zero new chat UI. Values write into session metadata consumed by turn/start.
  // --------------------------------------------------------------------------

  getConfigOptions(sessionId: string): AcpConfigOption[] | undefined {
    const session = this._sessions.get(sessionId)
    if (!session) return undefined
    const options: AcpConfigOption[] = []

    const selectedModel = readString(session.metadata?.selectedModel)
    const model =
      this.modelCache.find((m) => m.id === selectedModel) ??
      this.modelCache.find((m) => m.isDefault)
    const efforts =
      model && model.supportedReasoningEfforts.length > 0
        ? model.supportedReasoningEfforts
        : DEFAULT_REASONING_EFFORTS
    const currentEffort =
      readString(session.metadata?.reasoningEffort) ?? model?.defaultReasoningEffort
    options.push({
      id: "reasoningEffort",
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: currentEffort ?? efforts[Math.floor(efforts.length / 2)].reasoningEffort,
      options: efforts.map((e) => ({
        value: e.reasoningEffort,
        name: e.reasoningEffort,
        description: e.description,
      })),
    })

    options.push({
      id: "sandboxMode",
      name: "Sandbox",
      category: "mode",
      type: "select",
      currentValue: readString(session.metadata?.sandboxMode) ?? "workspaceWrite",
      options: [
        { value: "readOnly", name: "Read only" },
        { value: "workspaceWrite", name: "Workspace write" },
        { value: "dangerFullAccess", name: "Full access" },
      ],
    })
    return options
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<AcpConfigOption[]> {
    const session = this._sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    if (configId === "reasoningEffort") {
      this.updateSession(sessionId, {
        metadata: { ...session.metadata, reasoningEffort: value },
      })
    } else if (configId === "sandboxMode") {
      this.updateSession(sessionId, {
        metadata: { ...session.metadata, sandboxMode: value },
      })
    } else {
      throw new Error(`Unknown config option: ${configId}`)
    }
    this.emitConfigOptions(sessionId)
    return this.getConfigOptions(sessionId) ?? []
  }

  private emitConfigOptions(sessionId: string): void {
    const configOptions = this.getConfigOptions(sessionId)
    if (!configOptions) return
    this.emit(sessionId, {
      type: "config_options_update",
      sessionId,
      timestamp: new Date(),
      configOptions,
    })
  }

  // --------------------------------------------------------------------------
  // Account + rate limits (status card)
  // --------------------------------------------------------------------------

  /**
   * Fetch account + rate-limit snapshots (best-effort; degrades on old CLIs).
   *
   * The two reads are independent: a login that has an account but no rate
   * limits (see {@link isCodexChatgptAuthRequiredError}) must still surface its
   * account, and the status listeners are always notified so the UI reflects
   * whatever we did learn.
   */
  async refreshAccount(): Promise<void> {
    try {
      const account = await this.callOptional<{
        account?: Record<string, unknown> | null
        requiresOpenaiAuth?: boolean
      }>("account/read", { refreshToken: false })
      if (account !== undefined) {
        this.status = {
          ...this.status,
          account: account.account ? mapAccountInfo(account.account) : null,
          requiresOpenaiAuth: account.requiresOpenaiAuth === true,
        }
      }
    } catch (error) {
      log.warn("Codex account read failed", { error })
    }

    try {
      // `account/rateLimits/read` takes no params (serde unit) — omit them.
      const limits = await this.callOptional<{ rateLimits?: Record<string, unknown> }>(
        "account/rateLimits/read"
      )
      if (limits !== undefined) {
        this.status = { ...this.status, rateLimits: mapRateLimits(readObject(limits.rateLimits)) }
      }
    } catch (error) {
      if (isCodexChatgptAuthRequiredError(error)) {
        // Expected for this auth mode, not a failure: record "no rate limits"
        // (null) rather than "unknown" (undefined) so the UI can stop asking.
        this.status = { ...this.status, rateLimits: null }
        log.debug("Codex rate limits unavailable without ChatGPT auth", {
          accountType: this.status.account?.type,
        })
      } else {
        log.warn("Codex rate-limit read failed", { error })
      }
    }

    this.notifyStatus()
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

  /**
   * Register absolute folder paths as extra Codex skill roots for this
   * app-server process (`skills/extraRoots/set`). Codex then discovers every
   * `SKILL.md` under them, on top of the default `.agents/skills` locations.
   * The roots are not persisted by the server, so callers re-apply on connect.
   * Older CLIs without the method degrade silently (the status snapshot flags
   * `extraSkillRootsUnsupported`). Returns `true` when the method was accepted.
   */
  async setExtraSkillRoots(roots: string[]): Promise<boolean> {
    if (!this.peer) return false
    const extraRoots = normalizeSkillRoots(roots)
    await this.callOptional("skills/extraRoots/set", { extraRoots })
    const supported = !this.unsupportedMethods.has("skills/extraRoots/set")
    this.status = { ...this.status, extraSkillRootsUnsupported: !supported }
    this.notifyStatus()
    if (supported) await this.refreshSkills()
    return supported
  }

  /**
   * Best-effort connect-time application of the configured extra skill roots.
   * No-ops when none are configured so an untouched process makes no RPC.
   */
  private async applyConfiguredExtraSkillRoots(): Promise<void> {
    const roots = this._config?.codexOptions?.extraSkillRoots
    if (!roots || roots.length === 0) return
    try {
      await this.setExtraSkillRoots(roots)
    } catch (error) {
      log.warn("Failed to apply Codex extra skill roots", { error })
    }
  }

  getStatus(): CodexAppServerStatus {
    return {
      ...this.status,
      mcpServers: [...this.status.mcpServers],
      skills: [...this.status.skills],
    }
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

/** Fallback effort list when the model catalog has not been fetched yet. */
const DEFAULT_REASONING_EFFORTS: Array<{ reasoningEffort: string; description?: string }> = [
  { reasoningEffort: "low" },
  { reasoningEffort: "medium" },
  { reasoningEffort: "high" },
]

function createDefaultCodexSessionExtensionSupport(): ExternalAgentSessionExtensionSupport {
  const unknown: ExternalAgentExtensionSupportStatus = { state: "unknown" }
  return {
    "session/list": { ...unknown },
    "session/fork": { ...unknown },
    "session/resume": { ...unknown },
  }
}

/** Resolve the (brief-aware) system prompt from session-creation metadata. */
function resolveSystemPromptText(
  metadata: Record<string, unknown> | undefined
): string | undefined {
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

function unixSecondsToIso(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return new Date(value * 1000).toISOString()
}

function parseUserInputQuestions(raw: unknown): CodexUserInputQuestion[] {
  if (!Array.isArray(raw)) return []
  const questions: CodexUserInputQuestion[] = []
  for (const entry of raw) {
    const q = readObject(entry)
    const id = readString(q?.id)
    const question = readString(q?.question)
    if (!q || !id || !question) continue
    let options: Array<{ label: string; description?: string }> | null = null
    if (Array.isArray(q.options)) {
      options = []
      for (const o of q.options) {
        const opt = readObject(o)
        const label = readString(opt?.label)
        if (!label) continue
        const description = readString(opt?.description)
        options.push(description !== undefined ? { label, description } : { label })
      }
    }
    questions.push({
      id,
      question,
      header: readString(q.header),
      options,
      isOther: q.isOther === true,
      isSecret: q.isSecret === true,
    })
  }
  return questions
}

function emptyAnswersFor(
  questions: CodexUserInputQuestion[]
): Record<string, { answers: string[] }> {
  const answers: Record<string, { answers: string[] }> = {}
  for (const q of questions) answers[q.id] = { answers: [] }
  return answers
}

function mapModelInfo(raw: Record<string, unknown>): CodexModelInfo {
  const efforts: Array<{ reasoningEffort: string; description?: string }> = []
  if (Array.isArray(raw.supportedReasoningEfforts)) {
    for (const e of raw.supportedReasoningEfforts) {
      const obj = readObject(e)
      const effort = readString(obj?.reasoningEffort) ?? readString(e)
      if (!effort) continue
      const description = readString(obj?.description)
      efforts.push(
        description !== undefined
          ? { reasoningEffort: effort, description }
          : { reasoningEffort: effort }
      )
    }
  }
  return {
    id: readString(raw.id) ?? readString(raw.model) ?? "",
    model: readString(raw.model),
    displayName: readString(raw.displayName) ?? readString(raw.name),
    description: readString(raw.description),
    hidden: raw.hidden === true,
    isDefault: raw.isDefault === true,
    defaultReasoningEffort: readString(raw.defaultReasoningEffort),
    supportedReasoningEfforts: efforts,
    supportsPersonality: raw.supportsPersonality === true,
  }
}

/**
 * True for the app-server's "you are not signed in with ChatGPT" refusal
 * (`-32600 chatgpt authentication required to read rate limits`).
 *
 * This is the *correct* answer for a perfectly healthy login that simply isn't
 * a ChatGPT subscription — an API key in `~/.codex/auth.json`, including a
 * third-party provider configured via `model_provider` + `model_providers.<n>.
 * base_url` in `~/.codex/config.toml`. Rate limits are a subscription concept,
 * so those accounts have none to report. Treating it as an error made the
 * client log a scary warning and skip notifying the status listeners, so a
 * working third-party login never reached the UI.
 *
 * Matched on the message because `-32600` is the generic "invalid request"
 * code, which we must NOT blanket-swallow.
 */
function isCodexChatgptAuthRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /chatgpt authentication required/i.test(message)
}

function mapAccountInfo(raw: Record<string, unknown>): CodexAccountInfo {
  return {
    type: readString(raw.type),
    email: readString(raw.email),
    planType: readString(raw.planType),
  }
}

function mapRateLimitWindow(
  raw: Record<string, unknown> | undefined
): CodexRateLimitWindow | undefined {
  const usedPercent = readNumber(raw?.usedPercent)
  if (raw === undefined || usedPercent === undefined) return undefined
  return {
    usedPercent,
    windowDurationMins: readNumber(raw.windowDurationMins),
    resetsAt: readNumber(raw.resetsAt),
  }
}

function mapRateLimits(raw: Record<string, unknown> | undefined): CodexRateLimitsInfo | null {
  if (!raw) return null
  return {
    planType: readString(raw.planType),
    primary: mapRateLimitWindow(readObject(raw.primary)),
    secondary: mapRateLimitWindow(readObject(raw.secondary)),
    rateLimitReachedType: readString(raw.rateLimitReachedType),
  }
}

/**
 * Map a `codexErrorInfo` union onto a stable snake_case error code
 * ("contextWindowExceeded" → "context_window_exceeded"; object variants use
 * their tag, e.g. `{httpConnectionFailed: {...}}` → "http_connection_failed").
 */
function mapCodexErrorCode(raw: unknown): string | undefined {
  const variant =
    readString(raw) ??
    (() => {
      const obj = readObject(raw)
      return obj ? Object.keys(obj)[0] : undefined
    })()
  if (!variant) return undefined
  return variant.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
}

/** Rebuild session history from a `thread/resume` initialTurnsPage payload. */
function hydrateMessagesFromTurns(
  turns: Array<{ items?: CodexThreadItem[] }> | undefined
): ExternalAgentMessage[] {
  if (!Array.isArray(turns)) return []
  const messages: ExternalAgentMessage[] = []
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (!item || typeof item !== "object") continue
      if (item.type === "userMessage") {
        const text = readString(item.text) ?? extractText(item.content)
        if (text) {
          messages.push({
            id: item.id ?? `user_${messages.length}`,
            role: "user",
            content: [{ type: "text", text }],
            timestamp: new Date(),
          })
        }
      } else if (item.type === "agentMessage" && item.phase !== "commentary") {
        const text = readString(item.text) ?? extractText(item.content)
        if (text) {
          messages.push({
            id: item.id ?? `assistant_${messages.length}`,
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: new Date(),
          })
        }
      }
    }
  }
  return messages
}
