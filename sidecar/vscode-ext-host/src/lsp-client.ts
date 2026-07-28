/**
 * Cognia-native LSP 3.17 client.
 *
 * Used by Phase B of the LSP reuse work: when a cognia plugin
 * contributes `manifest.lspServers[]` or a user adds a server via
 * Settings → Language Servers, the sidecar spawns the binary and wraps
 * its stdio stream in a `CogniaLspClient`. The client is a faithful
 * LSP 3.17 implementation — it does NOT pretend to be a VS Code
 * extension via the `vscode-languageclient` package; we own the
 * protocol so we can avoid that library's renderer-side assumptions.
 *
 * The transport rides on the already-installed `vscode-jsonrpc`
 * package, which gives us the Content-Length framing + correlated
 * request/response promises for free.
 *
 * Lifecycle:
 *
 *   1. `start()` — spawns the binary, opens the JSON-RPC connection,
 *      sends `initialize` with cognia's `ClientCapabilities`, awaits
 *      the server's `capabilities`, sends `initialized`.
 *   2. `registerTextDocument(...)` / `changeTextDocument(...)` /
 *      `closeTextDocument(...)` — document-sync notifications.
 *   3. Provider invocations — request methods returning protocol-shaped
 *      results (no Monaco translation here; the bridge handles that).
 *   4. `onPublishDiagnostics(cb)` — server-pushed diagnostics.
 *   5. `stop()` — sends `shutdown` + `exit`, kills the child.
 *
 * Every public method is `async` so callers can `await` initialise
 * completion. Calling a provider method before `start()` resolves
 * throws.
 *
 * Note on imports: the file uses `require()` for `vscode-jsonrpc` and
 * `node:child_process` so the compiled CJS output matches the rest of
 * the sidecar's module format. Top-level ESM imports would not survive
 * the `tsc -p` build (the sidecar emits CommonJS).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcess = require("node:child_process") as typeof import("node:child_process")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const jsonrpc = require("vscode-jsonrpc/node") as typeof import("vscode-jsonrpc/node")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require("node:net") as typeof import("node:net")

import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type { Socket } from "node:net"
import { monitorProcessResources } from "./process-resource-monitor"

/** Subset of LSP `ClientCapabilities` cognia advertises. */
const DEFAULT_CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false,
      didSave: true,
    },
    completion: {
      dynamicRegistration: false,
      completionItem: {
        snippetSupport: true,
        commitCharactersSupport: false,
        documentationFormat: ["markdown", "plaintext"],
        deprecatedSupport: true,
        preselectSupport: true,
        insertReplaceSupport: true,
      },
      contextSupport: true,
    },
    hover: {
      dynamicRegistration: false,
      contentFormat: ["markdown", "plaintext"],
    },
    signatureHelp: { dynamicRegistration: false },
    definition: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    documentHighlight: { dynamicRegistration: false },
    documentSymbol: { dynamicRegistration: false },
    formatting: { dynamicRegistration: false },
    rangeFormatting: { dynamicRegistration: false },
    onTypeFormatting: { dynamicRegistration: false },
    rename: { dynamicRegistration: false, prepareSupport: true },
    foldingRange: { dynamicRegistration: false, lineFoldingOnly: false },
    selectionRange: { dynamicRegistration: false },
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: false,
      tagSupport: { valueSet: [1, 2] }, // Unnecessary, Deprecated
    },
    codeAction: { dynamicRegistration: false },
    semanticTokens: {
      dynamicRegistration: false,
      requests: { full: { delta: false }, range: true },
      tokenTypes: [],
      tokenModifiers: [],
      formats: ["relative"],
    },
    inlayHint: { dynamicRegistration: false },
  },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    didChangeConfiguration: { dynamicRegistration: false },
    didChangeWatchedFiles: { dynamicRegistration: false },
  },
  general: { positionEncodings: ["utf-16"] },
} as const

export interface LspClientOptions {
  /** Stable identifier for diagnostics + log routing (e.g. `eslint`, `pyright`). */
  serverId: string
  /** Executable path. */
  command: string
  /** Arguments. */
  args?: string[]
  /** Environment overrides. */
  env?: Record<string, string>
  /** Working directory for the child process. */
  cwd?: string
  /** Process stdio or a loopback TCP endpoint owned by the spawned server. */
  transport?: "stdio" | "socket"
  /** Required for `socket`; credentials are forbidden in the URL. */
  endpoint?: string
  /** Workspace folder URIs to advertise via `initialize`. */
  workspaceFolders?: Array<{ uri: string; name: string }>
  /** Initialization options forwarded verbatim. */
  initializationOptions?: unknown
  /**
   * Server-specific configuration. Returned for `workspace/configuration`
   * pull requests (resolved by `section`) and pushed once via
   * `workspace/didChangeConfiguration` right after `initialized`. Drives
   * settings like `{ "rust-analyzer": { cargo: { features: "all" } } }`.
   */
  settings?: Record<string, unknown>
  /**
   * Milliseconds to wait for the server's `initialize` response before the
   * spawn is treated as failed (child killed, `start()` rejects). Guards
   * against hung binaries blocking callers forever. Default 10 000.
   */
  startupTimeout?: number
  /** Maximum aggregate RSS for the detached language-server process tree. */
  memoryLimitMb?: number
  /** Optional logger for protocol-level events. */
  logger?: {
    info?: (msg: string, ctx?: unknown) => void
    warn?: (msg: string, ctx?: unknown) => void
    error?: (msg: string, ctx?: unknown) => void
  }
  /**
   * Project a stable LSP server→client request into the active IDE
   * consumer. The promise result is returned to the language server.
   */
  handleServerRequest?: (method: string, params: unknown) => Promise<unknown>
  /** Project stable server→client notifications such as `$/progress`. */
  handleServerNotification?: (method: string, params: unknown) => void
}

export interface PublishDiagnosticsParams {
  uri: string
  version?: number
  diagnostics: Array<{
    range: { start: { line: number; character: number }; end: { line: number; character: number } }
    severity?: 1 | 2 | 3 | 4
    code?: string | number
    source?: string
    message: string
    tags?: number[]
    relatedInformation?: unknown
  }>
}

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

/** Minimal Connection shape we depend on — sourced from vscode-jsonrpc. */
interface LspConnection {
  sendRequest<T>(method: string, params: unknown, token?: unknown): Promise<T>
  sendNotification(method: string, params: unknown): void
  onNotification(method: string, cb: (params: unknown) => void): void
  /** Server→client request handler (e.g. `workspace/configuration`). */
  onRequest(method: string, cb: (params: unknown) => unknown): void
  onError(cb: (err: [Error, unknown, number | undefined]) => void): void
  onClose(cb: () => void): void
  listen(): void
  dispose(): void
}

const STABLE_SERVER_REQUESTS = new Set([
  "textDocument/completion",
  "completionItem/resolve",
  "textDocument/hover",
  "textDocument/signatureHelp",
  "textDocument/declaration",
  "textDocument/definition",
  "textDocument/typeDefinition",
  "textDocument/implementation",
  "textDocument/references",
  "textDocument/documentHighlight",
  "textDocument/documentSymbol",
  "textDocument/codeAction",
  "codeAction/resolve",
  "textDocument/codeLens",
  "codeLens/resolve",
  "textDocument/documentLink",
  "documentLink/resolve",
  "textDocument/documentColor",
  "textDocument/colorPresentation",
  "textDocument/formatting",
  "textDocument/rangeFormatting",
  "textDocument/onTypeFormatting",
  "textDocument/rename",
  "textDocument/prepareRename",
  "textDocument/foldingRange",
  "textDocument/selectionRange",
  "textDocument/prepareCallHierarchy",
  "callHierarchy/incomingCalls",
  "callHierarchy/outgoingCalls",
  "textDocument/prepareTypeHierarchy",
  "typeHierarchy/supertypes",
  "typeHierarchy/subtypes",
  "textDocument/semanticTokens/full",
  "textDocument/semanticTokens/full/delta",
  "textDocument/semanticTokens/range",
  "textDocument/linkedEditingRange",
  "textDocument/moniker",
  "textDocument/inlayHint",
  "inlayHint/resolve",
  "textDocument/inlineValue",
  "textDocument/diagnostic",
  "workspace/symbol",
  "workspaceSymbol/resolve",
  "workspace/diagnostic",
  "workspace/executeCommand",
  "workspace/willCreateFiles",
  "workspace/willRenameFiles",
  "workspace/willDeleteFiles",
])

const STABLE_CLIENT_REQUESTS = [
  "workspace/applyEdit",
  "workspace/workspaceFolders",
  "workspace/semanticTokens/refresh",
  "workspace/codeLens/refresh",
  "workspace/inlayHint/refresh",
  "workspace/inlineValue/refresh",
  "workspace/diagnostic/refresh",
  "workspace/foldingRange/refresh",
  "window/showMessageRequest",
  "window/showDocument",
  "window/workDoneProgress/create",
  "client/registerCapability",
  "client/unregisterCapability",
] as const

const STABLE_CLIENT_NOTIFICATIONS = [
  "$/progress",
  "$/logTrace",
  "telemetry/event",
  "window/logMessage",
  "window/showMessage",
] as const

const STABLE_SERVER_NOTIFICATIONS = new Set([
  "window/workDoneProgress/cancel",
  "workspace/didChangeWorkspaceFolders",
  "workspace/didChangeWatchedFiles",
  "workspace/didChangeConfiguration",
])

/**
 * Resolve a dotted `workspace/configuration` section (e.g.
 * `"rust-analyzer.cargo"`) against a settings object. Returns `null` when
 * the path is missing — LSP allows a null entry per item. A request with no
 * section returns the whole settings object.
 */
export function selectConfigurationSection(
  settings: Record<string, unknown> | undefined,
  section: string | undefined
): unknown {
  if (!settings) return null
  if (!section) return settings
  let cursor: unknown = settings
  for (const key of section.split(".")) {
    if (cursor && typeof cursor === "object" && !Array.isArray(cursor) && key in cursor) {
      cursor = (cursor as Record<string, unknown>)[key]
    } else {
      return null
    }
  }
  return cursor
}

type DiagnosticsListener = (params: PublishDiagnosticsParams) => void

/**
 * State machine for the client: created → starting → running → stopped.
 * Calls outside the running state either queue (when starting) or throw.
 */
export type ClientState = "stopped" | "starting" | "running" | "crashed"

export interface LspClientLogEntry {
  level: "info" | "warn" | "error"
  message: string
}

/** Default budget for the `initialize` handshake. */
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000

export class CogniaLspClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private socket: Socket | null = null
  private connection: LspConnection | null = null
  private state: ClientState = "stopped"
  private serverCapabilities: unknown = null
  private diagnosticsListeners = new Set<DiagnosticsListener>()
  private startedAt = 0
  private openDocuments = new Map<string, { version: number; languageId: string }>()
  private startPromise: Promise<void> | null = null
  /** Live server-specific settings — seeded from opts, mutable via updateConfiguration. */
  private currentSettings: Record<string, unknown> | undefined
  private stateListeners = new Set<(state: ClientState) => void>()
  private logListeners = new Set<(entry: LspClientLogEntry) => void>()
  private disposeResourceMonitor: (() => void) | null = null

  constructor(
    private readonly opts: LspClientOptions,
    /**
     * Optional connection factory — used by tests to inject an
     * in-memory transport (no real subprocess). When omitted, the
     * client spawns the `opts.command` child and wraps its stdio
     * streams in `vscode-jsonrpc`'s `StreamMessageReader`/`Writer`.
     */
    private readonly connectionFactory?: (
      opts: LspClientOptions
    ) => Promise<{ connection: LspConnection; dispose: () => void }>
  ) {
    this.currentSettings = opts.settings
  }

  /** Current lifecycle state. Read-only. */
  getState(): ClientState {
    return this.state
  }

  /** Server-advertised capabilities — null until `start()` resolves. */
  getServerCapabilities(): unknown {
    return this.serverCapabilities
  }

  /**
   * Subscribe to lifecycle transitions (starting/running/stopped/crashed).
   * The `LspService` supervisor uses this to drive backoff restarts.
   */
  onStateChange(cb: (state: ClientState) => void): () => void {
    this.stateListeners.add(cb)
    return () => {
      this.stateListeners.delete(cb)
    }
  }

  /** Subscribe to server stderr + lifecycle log lines (ring-buffer feed). */
  onLog(cb: (entry: LspClientLogEntry) => void): () => void {
    this.logListeners.add(cb)
    return () => {
      this.logListeners.delete(cb)
    }
  }

  /** Last `didOpen`/`didChange` version for an open document, or null. */
  getDocumentVersion(uri: string): number | null {
    return this.openDocuments.get(uri)?.version ?? null
  }

  private setState(next: ClientState): void {
    if (this.state === next) return
    this.state = next
    for (const listener of this.stateListeners) {
      try {
        listener(next)
      } catch {
        /* listener errors must not break the client */
      }
    }
  }

  private emitLog(level: LspClientLogEntry["level"], message: string): void {
    for (const listener of this.logListeners) {
      try {
        listener({ level, message })
      } catch {
        /* swallow */
      }
    }
  }

  /**
   * Spawn the LSP binary and run the `initialize` handshake. Idempotent —
   * repeated calls return the same in-flight promise. Throws if the
   * spawn fails or the server returns an error response to `initialize`.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (this.state === "running") return Promise.resolve()
    this.setState("starting")
    this.startPromise = this.doStart().catch((err) => {
      this.cleanup()
      this.setState("crashed")
      this.startPromise = null
      this.emitLog("error", `start failed: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    })
    return this.startPromise
  }

  private testDispose: (() => void) | null = null

  private async doStart(): Promise<void> {
    if (
      this.opts.memoryLimitMb !== undefined &&
      (!Number.isInteger(this.opts.memoryLimitMb) ||
        this.opts.memoryLimitMb < 16 ||
        this.opts.memoryLimitMb > 32_768)
    ) {
      throw new Error("IDE_PROTOCOL_MEMORY_LIMIT_INVALID")
    }
    if (this.connectionFactory) {
      // Test seam — bypass child_process entirely.
      const made = await this.connectionFactory(this.opts)
      this.connection = made.connection
      this.testDispose = made.dispose
    } else {
      const proc = childProcess.spawn(this.opts.command, this.opts.args ?? [], {
        cwd: this.opts.cwd,
        env: { ...process.env, ...(this.opts.env ?? {}) },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      })
      this.process = proc
      if (proc.pid) {
        this.disposeResourceMonitor = monitorProcessResources({
          pid: proc.pid,
          memoryLimitMb: this.opts.memoryLimitMb,
          onLimitExceeded: (error) => {
            this.emitLog("error", error.message)
            this.cleanup()
            this.setState("crashed")
            this.startPromise = null
          },
        })
      }

      proc.stderr.on("data", (buf: Buffer) => {
        const chunk = buf.toString("utf-8").slice(0, 4096)
        this.opts.logger?.warn?.(`[lsp:${this.opts.serverId}] stderr`, { chunk })
        this.emitLog("warn", chunk)
      })
      proc.on("exit", (code, signal) => {
        this.opts.logger?.info?.(`[lsp:${this.opts.serverId}] child exited`, { code, signal })
        this.emitLog(
          code === 0 || code === null ? "info" : "error",
          `child exited (code ${code ?? "null"}, signal ${signal ?? "null"})`
        )
        this.setState(code === 0 || code === null ? "stopped" : "crashed")
        this.startPromise = null
      })

      const stream =
        this.opts.transport === "socket"
          ? await connectLoopbackSocket(
              this.opts.endpoint,
              this.opts.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT_MS
            )
          : null
      this.socket = stream
      const reader = new jsonrpc.StreamMessageReader(stream ?? proc.stdout)
      const writer = new jsonrpc.StreamMessageWriter(stream ?? proc.stdin)
      this.connection = jsonrpc.createMessageConnection(reader, writer) as unknown as LspConnection
    }

    // Wire publishDiagnostics + protocol-level error handling before we
    // start listening, so no event is dropped.
    this.connection.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
      const p = params as PublishDiagnosticsParams
      for (const listener of this.diagnosticsListeners) {
        try {
          listener(p)
        } catch (err) {
          this.opts.logger?.warn?.(`[lsp:${this.opts.serverId}] diagnostic listener threw`, { err })
        }
      }
    })
    // Server→client `workspace/configuration` pull: answer each requested
    // section from the per-server settings (null when the path is absent).
    this.connection.onRequest("workspace/configuration", (params: unknown) => {
      const items =
        params && typeof params === "object" && Array.isArray((params as { items?: unknown }).items)
          ? ((params as { items: Array<{ section?: string }> }).items ?? [])
          : []
      return items.map((item) => selectConfigurationSection(this.currentSettings, item?.section))
    })
    for (const method of STABLE_CLIENT_REQUESTS) {
      this.connection.onRequest(method, async (params: unknown) => {
        if (!this.opts.handleServerRequest) {
          throw new jsonrpc.ResponseError(
            jsonrpc.ErrorCodes.MethodNotFound,
            `LSP_CLIENT_METHOD_UNAVAILABLE: ${method}`
          )
        }
        return this.opts.handleServerRequest(method, params)
      })
    }
    for (const method of STABLE_CLIENT_NOTIFICATIONS) {
      this.connection.onNotification(method, (params: unknown) => {
        try {
          this.opts.handleServerNotification?.(method, params)
        } catch (err) {
          this.opts.logger?.warn?.(`[lsp:${this.opts.serverId}] client notification failed`, {
            method,
            err,
          })
        }
      })
    }
    this.connection.onError((err) => {
      this.opts.logger?.error?.(`[lsp:${this.opts.serverId}] connection error`, { err })
    })
    this.connection.onClose(() => {
      this.opts.logger?.info?.(`[lsp:${this.opts.serverId}] connection closed`)
      this.emitLog("info", "connection closed")
      if (this.state === "running") {
        this.setState("stopped")
        this.startPromise = null
      }
    })

    this.connection.listen()

    const initializeParams = {
      processId: process.pid,
      clientInfo: { name: "cognia", version: "0.1.0" },
      locale: "en",
      rootUri: this.opts.workspaceFolders?.[0]?.uri ?? null,
      workspaceFolders: this.opts.workspaceFolders ?? null,
      capabilities: DEFAULT_CLIENT_CAPABILITIES,
      initializationOptions: this.opts.initializationOptions,
    }
    // Race `initialize` against the startup budget — a hung binary must not
    // block its caller forever (Claude Code ships the same guard as
    // `startupTimeout`).
    const startupTimeout = this.opts.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT_MS
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        this.connection.sendRequest<{ capabilities: unknown }>("initialize", initializeParams),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`initialize timed out after ${startupTimeout}ms`)),
            startupTimeout
          )
        }),
      ])
      this.serverCapabilities = result.capabilities
    } catch (err) {
      // Kill the (possibly hung) child so it doesn't linger.
      this.cleanup()
      throw err
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
    this.connection.sendNotification("initialized", {})
    this.setState("running")
    this.emitLog("info", "initialized")
    this.startedAt = Date.now()
    // Proactively push the initial configuration so servers that rely on a
    // didChangeConfiguration (rather than the pull model) pick up settings.
    if (this.currentSettings !== undefined) {
      this.connection.sendNotification("workspace/didChangeConfiguration", {
        settings: this.currentSettings,
      })
    }
  }

  /**
   * Update the server-specific settings at runtime. Stores the new value
   * (so subsequent `workspace/configuration` pulls see it) and, when the
   * client is running, pushes a `workspace/didChangeConfiguration`.
   */
  updateConfiguration(settings: Record<string, unknown> | undefined): void {
    this.currentSettings = settings
    if (this.state === "running" && this.connection) {
      this.connection.sendNotification("workspace/didChangeConfiguration", {
        settings: settings ?? {},
      })
    }
  }

  /**
   * Send `textDocument/didOpen` for a new document. Versioning starts at
   * 1; subsequent calls to `changeTextDocument` increment.
   */
  registerTextDocument(uri: string, languageId: string, text: string): void {
    this.assertRunning()
    this.openDocuments.set(uri, { version: 1, languageId })
    this.connection!.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    })
  }

  changeTextDocument(uri: string, text: string): void {
    this.assertRunning()
    const entry = this.openDocuments.get(uri)
    if (!entry) {
      // The client lost track of the open document. Re-open with the
      // new text — the server treats this as a fresh didOpen which is
      // safer than a versioned didChange against an unknown document.
      this.registerTextDocument(uri, "plaintext", text)
      return
    }
    entry.version += 1
    this.connection!.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: entry.version },
      contentChanges: [{ text }],
    })
  }

  closeTextDocument(uri: string): void {
    this.assertRunning()
    if (!this.openDocuments.has(uri)) return
    this.openDocuments.delete(uri)
    this.connection!.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    })
  }

  /**
   * Subscribe to server-pushed diagnostics. The bridge consumer wraps
   * these in `lspPublishDiagnosticsToBridgePayload` and forwards to
   * `monaco-bridge.setDiagnostics`.
   */
  onPublishDiagnostics(cb: DiagnosticsListener): () => void {
    this.diagnosticsListeners.add(cb)
    return () => {
      this.diagnosticsListeners.delete(cb)
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Provider methods — minimal but complete LSP request set.
  // The return types stay as LSP-protocol-shape (0-based, integer
  // enums); the renderer side translates via lsp-protocol-adapter.
  // ────────────────────────────────────────────────────────────────────

  async completion(uri: string, position: LspPosition): Promise<unknown> {
    this.assertRunning()
    return this.connection!.sendRequest("textDocument/completion", {
      textDocument: { uri },
      position,
    })
  }

  async hover(uri: string, position: LspPosition): Promise<unknown> {
    this.assertRunning()
    return this.connection!.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position,
    })
  }

  async definition(uri: string, position: LspPosition): Promise<unknown> {
    this.assertRunning()
    return this.connection!.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position,
    })
  }

  async references(uri: string, position: LspPosition): Promise<unknown> {
    this.assertRunning()
    return this.connection!.sendRequest("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    })
  }

  async formatting(uri: string): Promise<unknown> {
    this.assertRunning()
    return this.connection!.sendRequest("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    })
  }

  async rangeFormatting(uri: string, range: LspRange): Promise<unknown> {
    this.assertRunning()
    return this.connection!.sendRequest("textDocument/rangeFormatting", {
      textDocument: { uri },
      range,
      options: { tabSize: 2, insertSpaces: true },
    })
  }

  async codeActions(uri: string, range: LspRange, diagnostics: unknown[] = []): Promise<unknown> {
    this.assertRunning()
    return this.connection!.sendRequest("textDocument/codeAction", {
      textDocument: { uri },
      range,
      context: { diagnostics },
    })
  }

  async signatureHelp(uri: string, position: LspPosition): Promise<unknown> {
    this.assertRunning()
    return this.connection!.sendRequest("textDocument/signatureHelp", {
      textDocument: { uri },
      position,
    })
  }

  async documentSymbol(uri: string): Promise<unknown> {
    this.assertRunning()
    return this.connection!.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    })
  }

  async rename(uri: string, position: LspPosition, newName: string): Promise<unknown> {
    this.assertRunning()
    return this.connection!.sendRequest("textDocument/rename", {
      textDocument: { uri },
      position,
      newName,
    })
  }

  async foldingRange(uri: string): Promise<unknown> {
    this.assertRunning()
    return this.connection!.sendRequest("textDocument/foldingRange", {
      textDocument: { uri },
    })
  }

  async semanticTokens(uri: string): Promise<unknown> {
    this.assertRunning()
    return this.connection!.sendRequest("textDocument/semanticTokens/full", {
      textDocument: { uri },
    })
  }

  /**
   * Send an arbitrary stable LSP 3.17 server request. Keeping the allowlist
   * here prevents the managed IDE bridge from becoming an escape hatch to
   * proposed or server-to-client methods.
   */
  async requestRaw(method: string, params: unknown, cancellationToken?: unknown): Promise<unknown> {
    if (!STABLE_SERVER_REQUESTS.has(method)) {
      throw new Error(`LSP_METHOD_UNSUPPORTED: ${method}`)
    }
    this.assertRunning()
    return this.connection!.sendRequest(method, params, cancellationToken)
  }

  notifyRaw(method: string, params: unknown): void {
    if (!STABLE_SERVER_NOTIFICATIONS.has(method)) {
      throw new Error(`LSP_NOTIFICATION_UNSUPPORTED: ${method}`)
    }
    this.assertRunning()
    this.connection!.sendNotification(method, params)
  }

  /**
   * Tear down the connection. Sends `shutdown` + `exit` per spec; if
   * the server fails to acknowledge within 5s we SIGKILL the child.
   */
  async stop(): Promise<void> {
    if (this.state === "stopped" || this.state === "crashed") {
      this.cleanup()
      return
    }
    try {
      if (this.connection) {
        await Promise.race([
          this.connection.sendRequest<null>("shutdown", null),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("shutdown timeout")), 5_000)
          ),
        ])
        this.connection.sendNotification("exit", null)
        if (this.socket) {
          // StreamMessageWriter schedules socket writes. Give the final `exit`
          // notification one event-loop turn before disposing the transport.
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
    } catch (err) {
      this.opts.logger?.warn?.(`[lsp:${this.opts.serverId}] shutdown failed`, { err })
    } finally {
      this.cleanup()
    }
  }

  private cleanup(): void {
    this.disposeResourceMonitor?.()
    this.disposeResourceMonitor = null
    try {
      this.connection?.dispose()
    } catch {
      /* swallow */
    }
    this.connection = null
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    if (this.testDispose) {
      try {
        this.testDispose()
      } catch {
        /* swallow */
      }
      this.testDispose = null
    }
    if (this.process && !this.process.killed) {
      try {
        if (process.platform !== "win32" && this.process.pid) {
          process.kill(-this.process.pid, "SIGKILL")
        } else {
          this.process.kill("SIGKILL")
        }
      } catch {
        try {
          this.process.kill("SIGKILL")
        } catch {
          /* swallow */
        }
      }
    }
    this.process = null
    this.openDocuments.clear()
    this.diagnosticsListeners.clear()
    // Direct assignment, not setState: cleanup runs inside failure paths
    // whose callers set the FINAL state ("crashed") right after — emitting a
    // transient "stopped" would confuse the supervisor.
    this.state = "stopped"
    this.startPromise = null
  }

  private assertRunning(): void {
    if (this.state !== "running") {
      throw new Error(
        `CogniaLspClient(${this.opts.serverId}): cannot run RPC in state '${this.state}' — call start() first`
      )
    }
  }
}

async function connectLoopbackSocket(
  endpoint: string | undefined,
  timeoutMs: number
): Promise<Socket> {
  let url: URL
  try {
    url = new URL(endpoint ?? "")
  } catch {
    throw new Error("LSP_SOCKET_ENDPOINT_INVALID")
  }
  if (
    url.protocol !== "tcp:" ||
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password
  ) {
    throw new Error("LSP_SOCKET_ENDPOINT_INVALID")
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const socket = await new Promise<Socket | null>((resolve) => {
      const candidate = net.createConnection({
        host: url.hostname,
        port: Number(url.port),
      })
      candidate.once("connect", () => resolve(candidate))
      candidate.once("error", () => {
        candidate.destroy()
        resolve(null)
      })
    })
    if (socket) return socket
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`LSP_SOCKET_ENDPOINT_TIMEOUT: ${url.origin}`)
}
