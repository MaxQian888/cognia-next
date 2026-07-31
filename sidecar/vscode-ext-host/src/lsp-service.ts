/**
 * Sidecar LSP service.
 *
 * Holds a process-wide registry of `CogniaLspClient` instances keyed by
 * `${ownerId}:${serverId}`. Exposed to the renderer through the
 * existing JSON-RPC channel (`vscode://rpc/<channelId>`) as the
 * `lsp:*` method family. The renderer-side `TauriLspClientAdapter`
 * drives every call through `plugin_invoke_vscode_rpc`; this service
 * is the receiver.
 *
 * Lifecycle is intentionally decoupled from the VS Code extension
 * loader — a user-managed LSP (no `.vsix`) reaches this service through
 * the same RPC channel without first activating any extension.
 *
 * Beyond spawn/dispatch the service now owns the MATURITY layer:
 *
 *   - **Supervisor**: an unexpected `crashed` transition schedules a
 *     backoff restart (1s·2ⁿ capped at 30s). After `MAX_RESTARTS`
 *     consecutive failures the key lands in the `broken` set (manual
 *     `lsp:start` resets it). Open documents replay (`didOpen`) into the
 *     restarted client so diagnostics resume without caller involvement.
 *   - **Diagnostics buffer**: publishes are debounced (150 ms), deduped,
 *     and version-guarded (`lsp-diagnostics-buffer.ts`) before the
 *     `lsp:publishDiagnostics` notification fires.
 *   - **Ring-buffer logs**: server stderr + lifecycle lines, capped at
 *     `LOG_CAPACITY`, queryable via `logs()` (renderer `lsp:logs`).
 *   - **Detect/Install**: thin pass-throughs over `lsp-installer.ts` so
 *     the renderer can show binary status and run one-click installs
 *     (`lsp:detect` / `lsp:install` + `lsp:installProgress` pushes).
 *
 * Wire-up in `host.ts`:
 *
 *   1. Construct one `LspService` per RpcConnection instance.
 *   2. Register each `lsp:*` method on the connection.
 *   3. Pass `connection.sendNotification` so the service can push
 *      `lsp:publishDiagnostics`, `lsp:state` and `lsp:installProgress`
 *      frames back to the renderer.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lspClientModule = require("./lsp-client") as typeof import("./lsp-client")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const diagnosticsBufferModule =
  require("./lsp-diagnostics-buffer") as typeof import("./lsp-diagnostics-buffer")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const installerModule = require("./lsp-installer") as typeof import("./lsp-installer")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const jsonrpc = require("vscode-jsonrpc") as typeof import("vscode-jsonrpc")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require("node:crypto") as typeof import("node:crypto")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs/promises") as typeof import("node:fs/promises")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const url = require("node:url") as typeof import("node:url")

import type { CogniaLspClient, ClientState } from "./lsp-client"
import type { DiagnosticsBuffer } from "./lsp-diagnostics-buffer"
import type { LspInstallProgress, ResolveBinaryResult } from "./lsp-installer"

/** What the service emits back to the renderer. */
export type LspNotificationSink = (method: string, params: unknown) => void

/** Optional logger; defaults to silent in production. */
export interface LspServiceLogger {
  info?: (msg: string, ctx?: unknown) => void
  warn?: (msg: string, ctx?: unknown) => void
  error?: (msg: string, ctx?: unknown) => void
}

export interface LspStartParams {
  ownerId: string
  serverId: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  transport?: "stdio" | "socket"
  endpoint?: string
  workspaceFolders?: Array<{ uri: string; name: string }>
  initializationOptions?: unknown
  /** Per-server config for `workspace/configuration` + `didChangeConfiguration`. */
  settings?: Record<string, unknown>
  /** ms budget for the `initialize` handshake (default 10 000). */
  startupTimeout?: number
  memoryLimitMb?: number
}

export interface LspDocumentParams {
  ownerId: string
  serverId: string
  uri: string
  languageId?: string
  text?: string
}

export interface LspRequestParams {
  ownerId: string
  serverId: string
  method: string
  payload: unknown
  requestId?: string
}

export interface LspServerResponseParams {
  ownerId: string
  serverId: string
  requestId: string
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export interface LspClientNotificationParams {
  ownerId: string
  serverId: string
  method: string
  payload: unknown
}

/** One entry of the `lsp:detect` request. */
export interface LspDetectEntry {
  serverId: string
  command: string
  npmPackage?: string
  version?: string
}

export interface LspDetectParams {
  servers: LspDetectEntry[]
  installDir?: string
  projectRoot?: string
}

export interface LspInstallParams {
  serverId: string
  command: string
  npmPackage: string
  version?: string
  installDir: string
}

/** Supervisor view of one tracked server. */
export interface LspServerStatusEntry {
  key: string
  ownerId: string
  serverId: string
  state: ClientState | "broken"
  restarts: number
  lastError?: string
  startedAt?: number
}

export interface LspLogEntry {
  ts: number
  level: "info" | "warn" | "error"
  key: string
  serverId: string
  message: string
}

/**
 * Test seam — injecting a constructor lets the lsp-service tests
 * substitute a fake CogniaLspClient that records every call without
 * spawning a real subprocess.
 */
export interface LspClientCtor {
  new (opts: ConstructorParameters<typeof CogniaLspClient>[0]): CogniaLspClient
}

/** Injectable timers so the restart supervisor is unit-testable. */
export interface LspServiceTimers {
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const MAX_RESTARTS = 4
const RESTART_BACKOFF_BASE_MS = 1_000
const RESTART_BACKOFF_CAP_MS = 30_000
const LOG_CAPACITY = 500

interface TrackedServer {
  client: CogniaLspClient
  params: LspStartParams
  restarts: number
  lastError?: string
  broken: boolean
  /** Client subscriptions to dispose on stop/restart. */
  disposers: Array<() => void>
  /** Last text per open uri — replayed into a restarted client. */
  docs: Map<string, { languageId: string; text: string }>
  restartTimer?: unknown
  startedAt?: number
  /** Set while an intentional stop is in flight — suppresses the supervisor. */
  stopping: boolean
  cancellations: Map<string, InstanceType<typeof jsonrpc.CancellationTokenSource>>
  serverRequests: Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (reason: unknown) => void
      timeout: unknown
    }
  >
}

const SERVER_REQUEST_TIMEOUT_MS = 30_000
const LSP_REQUEST_CANCELLED = -32800

export class LspService {
  private servers = new Map<string, TrackedServer>()
  private diagnosticsBuffer: DiagnosticsBuffer
  private logRing: LspLogEntry[] = []
  private readonly timers: LspServiceTimers

  constructor(
    private readonly notify: LspNotificationSink,
    private readonly logger: LspServiceLogger = {},
    private readonly clientCtor: LspClientCtor = lspClientModule.CogniaLspClient,
    timers?: LspServiceTimers
  ) {
    this.timers = timers ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
    }
    this.diagnosticsBuffer = new diagnosticsBufferModule.DiagnosticsBuffer(
      (key, params) => {
        const tracked = this.servers.get(key)
        if (!tracked) return
        try {
          this.notify("lsp:publishDiagnostics", {
            ownerId: tracked.params.ownerId,
            serverId: tracked.params.serverId,
            uri: params.uri,
            version: params.version,
            diagnostics: params.diagnostics,
          })
        } catch (err) {
          this.logger.warn?.("lsp-service: notify publishDiagnostics threw", { err, key })
        }
      },
      {
        setTimeout: this.timers.setTimeout,
        clearTimeout: this.timers.clearTimeout,
      }
    )
  }

  private key(ownerId: string, serverId: string): string {
    return `${ownerId}:${serverId}`
  }

  private pushLog(key: string, serverId: string, level: LspLogEntry["level"], message: string) {
    this.logRing.push({ ts: Date.now(), level, key, serverId, message })
    if (this.logRing.length > LOG_CAPACITY) {
      this.logRing.splice(0, this.logRing.length - LOG_CAPACITY)
    }
  }

  private emitState(key: string, tracked: TrackedServer): void {
    try {
      this.notify("lsp:state", {
        key,
        ownerId: tracked.params.ownerId,
        serverId: tracked.params.serverId,
        state: tracked.broken ? "broken" : tracked.client.getState(),
        restarts: tracked.restarts,
        lastError: tracked.lastError,
      })
    } catch (err) {
      this.logger.warn?.("lsp-service: notify state threw", { err, key })
    }
  }

  /** Create a client for `params` and wire diagnostics/log/state plumbing. */
  private createWiredClient(k: string, params: LspStartParams): TrackedServer {
    let tracked: TrackedServer
    const client = new this.clientCtor({
      serverId: params.serverId,
      command: params.command,
      args: params.args,
      env: params.env,
      cwd: params.cwd,
      transport: params.transport ?? "stdio",
      endpoint: params.endpoint,
      workspaceFolders: params.workspaceFolders,
      initializationOptions: params.initializationOptions,
      settings: params.settings,
      startupTimeout: params.startupTimeout,
      memoryLimitMb: params.memoryLimitMb,
      logger: this.logger,
      handleServerRequest: (method, payload) =>
        this.forwardServerRequest(k, tracked, method, payload),
      handleServerNotification: (method, payload) => {
        this.notify("lsp:serverNotification", {
          ownerId: params.ownerId,
          serverId: params.serverId,
          method,
          payload,
        })
      },
    })
    tracked = {
      client,
      params,
      restarts: 0,
      broken: false,
      disposers: [],
      docs: new Map(),
      stopping: false,
      cancellations: new Map(),
      serverRequests: new Map(),
    }

    tracked.disposers.push(
      client.onPublishDiagnostics((p) => {
        const getVersion = (
          client as { getDocumentVersion?: CogniaLspClient["getDocumentVersion"] }
        ).getDocumentVersion
        this.diagnosticsBuffer.ingest(
          k,
          p,
          typeof p.version === "number" && typeof getVersion === "function"
            ? getVersion.call(client, p.uri)
            : null
        )
      })
    )
    // onLog / onStateChange guards keep the service compatible with the
    // minimal fake clients older tests inject.
    const onLog = (client as { onLog?: CogniaLspClient["onLog"] }).onLog
    if (typeof onLog === "function") {
      tracked.disposers.push(
        onLog.call(client, (entry) => {
          this.pushLog(k, params.serverId, entry.level, entry.message)
        })
      )
    }
    const onStateChange = (client as { onStateChange?: CogniaLspClient["onStateChange"] })
      .onStateChange
    if (typeof onStateChange === "function") {
      tracked.disposers.push(
        onStateChange.call(client, (state) => {
          this.pushLog(
            k,
            params.serverId,
            state === "crashed" ? "error" : "info",
            `state: ${state}`
          )
          if (state === "crashed" && !tracked.stopping) {
            this.scheduleRestart(k, tracked)
          }
          this.emitState(k, tracked)
        })
      )
    }
    return tracked
  }

  private async forwardServerRequest(
    key: string,
    tracked: TrackedServer,
    method: string,
    payload: unknown
  ): Promise<unknown> {
    const requestId = crypto.randomUUID()
    const preconditions =
      method === "workspace/applyEdit"
        ? await this.workspaceEditPreconditions(tracked, payload)
        : undefined
    return new Promise((resolve, reject) => {
      const timeout = this.timers.setTimeout(() => {
        if (!tracked.serverRequests.delete(requestId)) return
        reject(
          new jsonrpc.ResponseError(LSP_REQUEST_CANCELLED, `LSP_CLIENT_REQUEST_TIMEOUT: ${method}`)
        )
      }, SERVER_REQUEST_TIMEOUT_MS)
      tracked.serverRequests.set(requestId, { resolve, reject, timeout })
      try {
        this.notify("lsp:serverRequest", {
          ownerId: tracked.params.ownerId,
          serverId: tracked.params.serverId,
          requestId,
          method,
          payload,
          preconditions,
        })
      } catch (err) {
        tracked.serverRequests.delete(requestId)
        this.timers.clearTimeout(timeout)
        reject(err)
      }
      this.pushLog(key, tracked.params.serverId, "info", `server request: ${method}`)
    })
  }

  private async workspaceEditPreconditions(
    tracked: TrackedServer,
    payload: unknown
  ): Promise<Record<string, { exists: boolean; version?: number; contentHash?: string }>> {
    const uris = workspaceEditUris(payload)
    const preconditions: Record<
      string,
      { exists: boolean; version?: number; contentHash?: string }
    > = {}
    for (const uri of uris) {
      const doc = tracked.docs.get(uri)
      const version = tracked.client.getDocumentVersion(uri)
      if (doc) {
        preconditions[uri] = {
          exists: true,
          ...(version == null ? {} : { version }),
          contentHash: crypto.createHash("sha256").update(doc.text, "utf8").digest("hex"),
        }
        continue
      }
      let path: string
      try {
        path = url.fileURLToPath(uri)
      } catch {
        throw new jsonrpc.ResponseError(-32602, `LSP_WORKSPACE_EDIT_URI_INVALID: ${uri}`)
      }
      try {
        const contents = await fs.readFile(path)
        preconditions[uri] = {
          exists: true,
          contentHash: crypto.createHash("sha256").update(contents).digest("hex"),
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
        preconditions[uri] = { exists: false }
      }
    }
    return preconditions
  }

  private rejectServerRequests(tracked: TrackedServer, message: string): void {
    for (const pending of tracked.serverRequests.values()) {
      this.timers.clearTimeout(pending.timeout)
      pending.reject(new jsonrpc.ResponseError(LSP_REQUEST_CANCELLED, message))
    }
    tracked.serverRequests.clear()
  }

  /** Backoff restart after an unexpected crash; `broken` after MAX_RESTARTS. */
  private scheduleRestart(k: string, tracked: TrackedServer): void {
    if (tracked.broken || tracked.restartTimer) return
    if (tracked.restarts >= MAX_RESTARTS) {
      tracked.broken = true
      this.pushLog(
        k,
        tracked.params.serverId,
        "error",
        `marked broken after ${tracked.restarts} restart attempts`
      )
      this.emitState(k, tracked)
      return
    }
    const delay = Math.min(RESTART_BACKOFF_CAP_MS, RESTART_BACKOFF_BASE_MS * 2 ** tracked.restarts)
    tracked.restarts += 1
    this.pushLog(
      k,
      tracked.params.serverId,
      "warn",
      `restart #${tracked.restarts} scheduled in ${delay}ms`
    )
    tracked.restartTimer = this.timers.setTimeout(() => {
      tracked.restartTimer = undefined
      void this.restart(k, tracked)
    }, delay)
  }

  private async restart(k: string, prev: TrackedServer): Promise<void> {
    if (this.servers.get(k) !== prev || prev.stopping) return
    this.rejectServerRequests(prev, "LSP_CLIENT_DISCONNECTED")
    // Tear down the dead client's subscriptions; build a fresh one.
    for (const dispose of prev.disposers) {
      try {
        dispose()
      } catch {
        /* swallow */
      }
    }
    const next = this.createWiredClient(k, prev.params)
    next.restarts = prev.restarts
    next.docs = prev.docs
    this.servers.set(k, next)
    try {
      await next.client.start()
      next.startedAt = Date.now()
      this.pushLog(k, prev.params.serverId, "info", "restarted")
      // Replay open documents so diagnostics resume without caller help.
      for (const [uri, doc] of next.docs) {
        try {
          next.client.registerTextDocument(uri, doc.languageId, doc.text)
        } catch (err) {
          this.logger.warn?.("lsp-service: didOpen replay failed", { err, key: k, uri })
        }
      }
      this.emitState(k, next)
    } catch (err) {
      next.lastError = err instanceof Error ? err.message : String(err)
      // start() failure flips the client to "crashed" before the supervisor
      // listener exists on the OLD client — drive the backoff explicitly so
      // attempts continue until MAX_RESTARTS → broken.
      this.scheduleRestart(k, next)
      this.emitState(k, next)
    }
  }

  /**
   * Spawn an LSP server. Idempotent: if a server with the same key is
   * already running, returns its current state without restarting it. A
   * `broken` server is reset and given a fresh start (manual recovery).
   */
  async start(params: LspStartParams): Promise<{
    state: "running" | "starting"
    key: string
    capabilities: unknown
  }> {
    const k = this.key(params.ownerId, params.serverId)
    const existing = this.servers.get(k)
    if (existing && !existing.broken) {
      return {
        state: existing.client.getState() === "running" ? "running" : "starting",
        key: k,
        capabilities: existing.client.getServerCapabilities(),
      }
    }
    if (existing) {
      // Manual recovery of a broken server: drop the old tracking entirely.
      await this.stop(params.ownerId, params.serverId)
    }

    const tracked = this.createWiredClient(k, params)
    this.servers.set(k, tracked)

    try {
      await tracked.client.start()
      tracked.startedAt = Date.now()
      this.pushLog(k, params.serverId, "info", `started: ${params.command}`)
      this.emitState(k, tracked)
      return {
        state: "running",
        key: k,
        capabilities: tracked.client.getServerCapabilities(),
      }
    } catch (err) {
      // Tear down the half-started entry so a retry can re-spawn.
      for (const dispose of tracked.disposers) {
        try {
          dispose()
        } catch {
          /* swallow */
        }
      }
      if (tracked.restartTimer) this.timers.clearTimeout(tracked.restartTimer)
      this.servers.delete(k)
      const message = err instanceof Error ? err.message : String(err)
      this.pushLog(k, params.serverId, "error", `start failed: ${message}`)
      this.logger.warn?.("lsp-service: start failed", { key: k, err: message })
      throw err
    }
  }

  /** Stop a server. Idempotent on a missing/stopped server. */
  async stop(ownerId: string, serverId: string): Promise<{ removed: boolean }> {
    const k = this.key(ownerId, serverId)
    const tracked = this.servers.get(k)
    if (!tracked) return { removed: false }
    tracked.stopping = true
    if (tracked.restartTimer) {
      this.timers.clearTimeout(tracked.restartTimer)
      tracked.restartTimer = undefined
    }
    this.diagnosticsBuffer.cancelKey(k)
    for (const source of tracked.cancellations.values()) {
      source.cancel()
      source.dispose()
    }
    tracked.cancellations.clear()
    this.rejectServerRequests(tracked, "LSP_CLIENT_STOPPED")
    try {
      await tracked.client.stop()
    } catch (err) {
      this.logger.warn?.("lsp-service: stop threw", {
        key: k,
        err: err instanceof Error ? err.message : String(err),
      })
    }
    for (const dispose of tracked.disposers) {
      try {
        dispose()
      } catch {
        /* swallow */
      }
    }
    this.servers.delete(k)
    this.pushLog(k, serverId, "info", "stopped")
    return { removed: true }
  }

  /** Stop every running server — called from sidecar SIGTERM. */
  async stopAll(): Promise<void> {
    const keys = [...this.servers.keys()]
    for (const k of keys) {
      const [ownerId, serverId] = k.split(":", 2) as [string, string]
      await this.stop(ownerId, serverId)
    }
    this.diagnosticsBuffer.dispose()
  }

  /** `textDocument/didOpen`. */
  didOpen(params: LspDocumentParams): void {
    const tracked = this.requireServer(params.ownerId, params.serverId)
    if (params.text == null) throw new Error("lsp:didOpen requires `text`")
    const languageId = params.languageId ?? "plaintext"
    tracked.docs.set(params.uri, { languageId, text: params.text })
    tracked.client.registerTextDocument(params.uri, languageId, params.text)
  }

  /** `textDocument/didChange`. */
  didChange(params: LspDocumentParams): void {
    const tracked = this.requireServer(params.ownerId, params.serverId)
    if (params.text == null) throw new Error("lsp:didChange requires `text`")
    const doc = tracked.docs.get(params.uri)
    tracked.docs.set(params.uri, {
      languageId: doc?.languageId ?? params.languageId ?? "plaintext",
      text: params.text,
    })
    tracked.client.changeTextDocument(params.uri, params.text)
  }

  /** `textDocument/didClose`. */
  didClose(params: Omit<LspDocumentParams, "text" | "languageId">): void {
    const tracked = this.requireServer(params.ownerId, params.serverId)
    tracked.docs.delete(params.uri)
    tracked.client.closeTextDocument(params.uri)
  }

  /**
   * Generic request dispatch — `method` is one of the LSP provider
   * names (`completion`, `hover`, `definition`, ...). Payload shape
   * matches the corresponding `CogniaLspClient` method signature.
   */
  async request(params: LspRequestParams): Promise<unknown> {
    const tracked = this.requireServer(params.ownerId, params.serverId)
    const client = tracked.client
    const p = params.payload as Record<string, unknown>
    if (params.method.includes("/")) {
      if (!params.requestId) return client.requestRaw(params.method, params.payload)
      if (tracked.cancellations.has(params.requestId)) {
        throw new Error(`LSP_DUPLICATE_REQUEST_ID: ${params.requestId}`)
      }
      const source = new jsonrpc.CancellationTokenSource()
      tracked.cancellations.set(params.requestId, source)
      try {
        return await client.requestRaw(params.method, params.payload, source.token)
      } finally {
        tracked.cancellations.delete(params.requestId)
        source.dispose()
      }
    }
    switch (params.method) {
      case "completion":
        return client.completion(p.uri as string, p.position as { line: number; character: number })
      case "hover":
        return client.hover(p.uri as string, p.position as { line: number; character: number })
      case "definition":
        return client.definition(p.uri as string, p.position as { line: number; character: number })
      case "references":
        return client.references(p.uri as string, p.position as { line: number; character: number })
      case "formatting":
        return client.formatting(p.uri as string)
      case "rangeFormatting":
        return client.rangeFormatting(
          p.uri as string,
          p.range as Parameters<CogniaLspClient["rangeFormatting"]>[1]
        )
      case "codeActions":
        return client.codeActions(
          p.uri as string,
          p.range as Parameters<CogniaLspClient["codeActions"]>[1],
          (p.diagnostics as unknown[]) ?? []
        )
      case "signatureHelp":
        return client.signatureHelp(
          p.uri as string,
          p.position as { line: number; character: number }
        )
      case "documentSymbol":
        return client.documentSymbol(p.uri as string)
      case "rename":
        return client.rename(
          p.uri as string,
          p.position as { line: number; character: number },
          p.newName as string
        )
      case "foldingRange":
        return client.foldingRange(p.uri as string)
      case "semanticTokens":
        return client.semanticTokens(p.uri as string)
      default:
        throw new Error(`lsp:request — unknown method '${params.method}'`)
    }
  }

  cancel(ownerId: string, serverId: string, requestId: string): boolean {
    const source = this.servers.get(this.key(ownerId, serverId))?.cancellations.get(requestId)
    if (!source) return false
    source.cancel()
    return true
  }

  serverResponse(params: LspServerResponseParams): { accepted: boolean } {
    const tracked = this.servers.get(this.key(params.ownerId, params.serverId))
    const pending = tracked?.serverRequests.get(params.requestId)
    if (!tracked || !pending) return { accepted: false }
    tracked.serverRequests.delete(params.requestId)
    this.timers.clearTimeout(pending.timeout)
    if (params.error) {
      pending.reject(
        new jsonrpc.ResponseError(params.error.code, params.error.message, params.error.data)
      )
    } else {
      pending.resolve(params.result ?? null)
    }
    return { accepted: true }
  }

  clientNotification(params: LspClientNotificationParams): { accepted: boolean } {
    const tracked = this.servers.get(this.key(params.ownerId, params.serverId))
    if (!tracked) return { accepted: false }
    tracked.client.notifyRaw(params.method, params.payload)
    return { accepted: true }
  }

  /** Snapshot of currently-tracked servers — useful for telemetry. */
  list(): Array<{ key: string; state: string }> {
    return [...this.servers.entries()].map(([key, tracked]) => ({
      key,
      state: tracked.broken ? "broken" : tracked.client.getState(),
    }))
  }

  /** Rich per-server status for the renderer's status store (`lsp:status`). */
  status(): LspServerStatusEntry[] {
    return [...this.servers.entries()].map(([key, tracked]) => ({
      key,
      ownerId: tracked.params.ownerId,
      serverId: tracked.params.serverId,
      state: tracked.broken ? "broken" : tracked.client.getState(),
      restarts: tracked.restarts,
      lastError: tracked.lastError,
      startedAt: tracked.startedAt,
    }))
  }

  /** Ring-buffer log query (`lsp:logs`). Newest entries last. */
  logs(params: { serverId?: string; limit?: number } = {}): LspLogEntry[] {
    let entries = this.logRing
    if (params.serverId) entries = entries.filter((e) => e.serverId === params.serverId)
    const limit = params.limit ?? 200
    return entries.slice(-limit)
  }

  /** Binary detection for a server list (`lsp:detect`). Never installs. */
  async detect(
    params: LspDetectParams
  ): Promise<Array<{ serverId: string } & ResolveBinaryResult>> {
    const installer = installerModule.createLspInstaller()
    const out: Array<{ serverId: string } & ResolveBinaryResult> = []
    for (const entry of params.servers ?? []) {
      const result = await installer.resolveBinary({
        command: entry.command,
        npmPackage: entry.npmPackage,
        version: entry.version,
        projectRoot: params.projectRoot,
        installDir: params.installDir,
        allowInstall: false,
      })
      out.push({ serverId: entry.serverId, ...result })
    }
    return out
  }

  /**
   * One-click install (`lsp:install`). Emits `lsp:installProgress`
   * notifications and resolves with the post-install detection result.
   */
  async install(params: LspInstallParams): Promise<{ serverId: string } & ResolveBinaryResult> {
    const installer = installerModule.createLspInstaller()
    const onProgress = (progress: LspInstallProgress) => {
      try {
        this.notify("lsp:installProgress", { serverId: params.serverId, ...progress })
      } catch {
        /* swallow */
      }
    }
    const result = await installer.resolveBinary({
      command: params.command,
      npmPackage: params.npmPackage,
      version: params.version,
      installDir: params.installDir,
      allowInstall: true,
      onProgress,
    })
    this.pushLog(
      this.key("ui", params.serverId),
      params.serverId,
      result.status === "missing" ? "error" : "info",
      result.status === "missing"
        ? `install failed: ${result.error ?? "binary not produced"}`
        : `installed: ${result.resolvedPath}`
    )
    return { serverId: params.serverId, ...result }
  }

  private requireServer(ownerId: string, serverId: string): TrackedServer {
    const k = this.key(ownerId, serverId)
    const tracked = this.servers.get(k)
    if (!tracked) {
      throw new Error(`lsp-service: no client registered for ${k} — call lsp:start first`)
    }
    return tracked
  }
}

function workspaceEditUris(payload: unknown): Set<string> {
  const uris = new Set<string>()
  if (!payload || typeof payload !== "object") return uris
  const edit = (payload as { edit?: unknown }).edit
  if (!edit || typeof edit !== "object") return uris
  const changes = (edit as { changes?: unknown }).changes
  if (changes && typeof changes === "object" && !Array.isArray(changes)) {
    for (const uri of Object.keys(changes)) uris.add(uri)
  }
  const documentChanges = (edit as { documentChanges?: unknown }).documentChanges
  if (Array.isArray(documentChanges)) {
    for (const change of documentChanges) {
      if (!change || typeof change !== "object") continue
      const value = change as {
        textDocument?: { uri?: unknown }
        uri?: unknown
        oldUri?: unknown
        newUri?: unknown
      }
      for (const uri of [value.textDocument?.uri, value.uri, value.oldUri, value.newUri]) {
        if (typeof uri === "string") uris.add(uri)
      }
    }
  }
  return uris
}
