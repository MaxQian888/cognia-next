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
 * Wire-up in `host.ts`:
 *
 *   1. Construct one `LspService` per RpcConnection instance.
 *   2. Register each `lsp:*` method on the connection.
 *   3. Pass `connection.sendNotification` so the service can push
 *      `lsp:publishDiagnostics` and `lsp:state` frames back to the
 *      renderer.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lspClientModule = require("./lsp-client") as typeof import("./lsp-client")

import type { CogniaLspClient } from "./lsp-client"

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
  transport?: "stdio"
  workspaceFolders?: Array<{ uri: string; name: string }>
  initializationOptions?: unknown
  /** Per-server config for `workspace/configuration` + `didChangeConfiguration`. */
  settings?: Record<string, unknown>
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
}

/**
 * Test seam — injecting a constructor lets the lsp-service tests
 * substitute a fake CogniaLspClient that records every call without
 * spawning a real subprocess.
 */
export interface LspClientCtor {
  new (opts: ConstructorParameters<typeof CogniaLspClient>[0]): CogniaLspClient
}

export class LspService {
  private clients = new Map<string, CogniaLspClient>()
  /** Diagnostics-subscription disposers keyed by the same composite key. */
  private diagnosticsDisposers = new Map<string, () => void>()

  constructor(
    private readonly notify: LspNotificationSink,
    private readonly logger: LspServiceLogger = {},
    private readonly clientCtor: LspClientCtor = lspClientModule.CogniaLspClient
  ) {}

  private key(ownerId: string, serverId: string): string {
    return `${ownerId}:${serverId}`
  }

  /**
   * Spawn an LSP server. Idempotent: if a server with the same key is
   * already running, returns its current state without restarting it.
   */
  async start(params: LspStartParams): Promise<{ state: "running" | "starting"; key: string }> {
    const k = this.key(params.ownerId, params.serverId)
    const existing = this.clients.get(k)
    if (existing) {
      return { state: existing.getState() === "running" ? "running" : "starting", key: k }
    }
    const client = new this.clientCtor({
      serverId: params.serverId,
      command: params.command,
      args: params.args,
      env: params.env,
      cwd: params.cwd,
      transport: params.transport ?? "stdio",
      workspaceFolders: params.workspaceFolders,
      initializationOptions: params.initializationOptions,
      settings: params.settings,
      logger: this.logger,
    })
    this.clients.set(k, client)

    // Subscribe to publishDiagnostics; forward through the RPC channel
    // as a `lsp:publishDiagnostics` notification keyed by the
    // composite id so the renderer can route to the right registry
    // record.
    const dispose = client.onPublishDiagnostics((p) => {
      try {
        this.notify("lsp:publishDiagnostics", {
          ownerId: params.ownerId,
          serverId: params.serverId,
          uri: p.uri,
          version: p.version,
          diagnostics: p.diagnostics,
        })
      } catch (err) {
        this.logger.warn?.("lsp-service: notify publishDiagnostics threw", { err, key: k })
      }
    })
    this.diagnosticsDisposers.set(k, dispose)

    try {
      await client.start()
      return { state: "running", key: k }
    } catch (err) {
      // Tear down the half-started entry so a retry can re-spawn.
      try {
        dispose()
      } catch {
        /* swallow */
      }
      this.diagnosticsDisposers.delete(k)
      this.clients.delete(k)
      this.logger.warn?.("lsp-service: start failed", {
        key: k,
        err: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  /** Stop a server. Idempotent on a missing/stopped server. */
  async stop(ownerId: string, serverId: string): Promise<{ removed: boolean }> {
    const k = this.key(ownerId, serverId)
    const client = this.clients.get(k)
    if (!client) return { removed: false }
    try {
      await client.stop()
    } catch (err) {
      this.logger.warn?.("lsp-service: stop threw", {
        key: k,
        err: err instanceof Error ? err.message : String(err),
      })
    }
    try {
      this.diagnosticsDisposers.get(k)?.()
    } catch {
      /* swallow */
    }
    this.diagnosticsDisposers.delete(k)
    this.clients.delete(k)
    return { removed: true }
  }

  /** Stop every running server — called from sidecar SIGTERM. */
  async stopAll(): Promise<void> {
    const keys = [...this.clients.keys()]
    for (const k of keys) {
      const [ownerId, serverId] = k.split(":", 2) as [string, string]
      await this.stop(ownerId, serverId)
    }
  }

  /** `textDocument/didOpen`. */
  didOpen(params: LspDocumentParams): void {
    const client = this.requireClient(params.ownerId, params.serverId)
    if (!params.text) throw new Error("lsp:didOpen requires `text`")
    client.registerTextDocument(params.uri, params.languageId ?? "plaintext", params.text)
  }

  /** `textDocument/didChange`. */
  didChange(params: LspDocumentParams): void {
    const client = this.requireClient(params.ownerId, params.serverId)
    if (params.text == null) throw new Error("lsp:didChange requires `text`")
    client.changeTextDocument(params.uri, params.text)
  }

  /** `textDocument/didClose`. */
  didClose(params: Omit<LspDocumentParams, "text" | "languageId">): void {
    const client = this.requireClient(params.ownerId, params.serverId)
    client.closeTextDocument(params.uri)
  }

  /**
   * Generic request dispatch — `method` is one of the LSP provider
   * names (`completion`, `hover`, `definition`, ...). Payload shape
   * matches the corresponding `CogniaLspClient` method signature.
   */
  async request(params: LspRequestParams): Promise<unknown> {
    const client = this.requireClient(params.ownerId, params.serverId)
    const p = params.payload as Record<string, unknown>
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

  /** Snapshot of currently-tracked servers — useful for telemetry. */
  list(): Array<{ key: string; state: string }> {
    return [...this.clients.entries()].map(([key, client]) => ({
      key,
      state: client.getState(),
    }))
  }

  private requireClient(ownerId: string, serverId: string): CogniaLspClient {
    const k = this.key(ownerId, serverId)
    const client = this.clients.get(k)
    if (!client) {
      throw new Error(`lsp-service: no client registered for ${k} — call lsp:start first`)
    }
    return client
  }
}
