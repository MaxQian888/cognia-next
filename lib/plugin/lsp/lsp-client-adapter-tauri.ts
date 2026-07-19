/**
 * Production `LspClientAdapter` implementation.
 *
 * Drives the sidecar's `LspService` (in `sidecar/vscode-ext-host/src/
 * lsp-service.ts`) over the existing VS Code-extension RPC channel.
 * Sends every renderer→sidecar action via `invokeVscodeRpc` and
 * subscribes to `lsp:publishDiagnostics` notifications via the
 * standard rpc-dispatcher's `registerMethod`. The latter is shared
 * with the dispatcher's other `vscode://rpc/<channelId>` listeners —
 * one global handler with a routing table inside the adapter so
 * multiple servers (under different ownerId/serverId composites) can
 * coexist.
 *
 * Why we use the existing VS Code channel rather than a new
 * `lsp://`-prefixed one: the channel + plumbing already work end-to-
 * end with the Tauri `plugin_invoke_vscode_rpc` command and the
 * dispatcher. Introducing a new channel would force matching Rust
 * changes for no functional gain — the sidecar is one process, and
 * the JSON-RPC method names alone discriminate `lsp:*` vs
 * `extension:*`.
 */

import { invokeVscodeRpc, isVscodeHostAvailable } from "@/lib/plugin/core/vscode-loader"
import { transport } from "@/lib/tauri"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { registerMethod } from "@/lib/plugin/vscode-shim/rpc-dispatcher"
import { lspPublishDiagnosticsToBridgePayload } from "@/lib/plugin/vscode-shim/lsp-protocol-adapter"
import type { LspClientAdapter } from "./lsp-registry"
import { lspServerKey } from "./lsp-registry"

/**
 * Synthetic channel id used for non-extension-owned LSP traffic. The
 * sidecar's `LspService` is global, not per-extension, so the channel
 * the renderer drives it through is conceptually a single "system"
 * pseudo-extension. Plugin-contributed LSP servers also flow through
 * the same channel — the sidecar disambiguates via the `ownerId`
 * field on every payload.
 */
export const LSP_TAURI_CHANNEL_ID = "cognia.lsp-service"

type InvokeFn = (pluginId: string, method: string, payload: unknown) => Promise<unknown>

async function invokeActiveLspHost(
  pluginId: string,
  method: string,
  payload: unknown
): Promise<unknown> {
  if (!isRemoteHostActive()) return invokeVscodeRpc(pluginId, method, payload)
  if (pluginId !== LSP_TAURI_CHANNEL_ID) {
    throw new Error(`remote LSP facade rejects non-system channel ${pluginId}`)
  }
  const raw = await transport.call<string>("lsp_host_request", {
    method,
    payloadJson: JSON.stringify(payload ?? null),
  })
  return raw ? JSON.parse(raw) : null
}

type DiagnosticsForwarder = (
  uri: string,
  markers: ReturnType<typeof lspPublishDiagnosticsToBridgePayload>["markers"]
) => void

interface ConstructorDeps {
  /** Override the Tauri `invokeVscodeRpc` for tests. Defaults to the real one. */
  invoke?: InvokeFn
  /**
   * Optional override for the rpc-dispatcher `registerMethod`. Tests
   * substitute a no-op or capture the handler for direct firing.
   */
  registerHandler?: (method: string, handler: (params: unknown) => unknown) => () => void
  /** Override the host-availability check (testing in jsdom). */
  isHostAvailable?: () => boolean
  /** Channel id override. */
  channelId?: string
}

/**
 * Implementation of `LspClientAdapter` that talks to the sidecar.
 * Construct once per process; pass into `configureLspRegistry`.
 */
export class TauriLspClientAdapter implements LspClientAdapter {
  private invoke: InvokeFn
  private registerHandler: NonNullable<ConstructorDeps["registerHandler"]>
  private isHostAvailable: () => boolean
  private channelId: string
  private diagnosticsRoutes = new Map<string, DiagnosticsForwarder>()
  private unregisterPublishDiagnostics: (() => void) | null = null

  constructor(deps: ConstructorDeps = {}) {
    this.invoke = deps.invoke ?? invokeActiveLspHost
    this.registerHandler = deps.registerHandler ?? registerMethod
    this.isHostAvailable =
      deps.isHostAvailable ?? (() => isVscodeHostAvailable() || isRemoteHostActive())
    this.channelId = deps.channelId ?? LSP_TAURI_CHANNEL_ID
  }

  /**
   * Wire the global `lsp:publishDiagnostics` notification handler.
   * Idempotent — calling twice is a no-op. Returns a disposer for
   * tests; production code never tears this down.
   */
  install(): () => void {
    if (this.unregisterPublishDiagnostics) return this.unregisterPublishDiagnostics
    this.unregisterPublishDiagnostics = this.registerHandler(
      "lsp:publishDiagnostics",
      (params: unknown) => {
        const p = params as {
          ownerId: string
          serverId: string
          uri: string
          diagnostics: Parameters<typeof lspPublishDiagnosticsToBridgePayload>[0]["diagnostics"]
        }
        const forwarder = this.diagnosticsRoutes.get(lspServerKey(p.ownerId, p.serverId))
        if (!forwarder) return
        const { uri, markers } = lspPublishDiagnosticsToBridgePayload({
          uri: p.uri,
          diagnostics: p.diagnostics,
        })
        forwarder(uri, markers)
      }
    )
    return this.unregisterPublishDiagnostics
  }

  /**
   * Renderer→sidecar `lsp:start`. Resolves after the sidecar reports
   * the server is running. The diagnostic forwarder is registered
   * BEFORE the start RPC so an eager `publishDiagnostics` push from
   * the LSP (some servers send before resolving `initialize`) lands
   * on a wired route.
   */
  async start(input: Parameters<LspClientAdapter["start"]>[0]): Promise<void> {
    if (!this.isHostAvailable()) {
      throw new Error("TauriLspClientAdapter: VS Code host unavailable — sidecar cannot be reached")
    }
    this.install() // guarantee diagnostic handler is up
    this.diagnosticsRoutes.set(lspServerKey(input.ownerId, input.serverId), input.onDiagnostics)

    const payload = {
      ownerId: input.ownerId,
      serverId: input.serverId,
      command: input.config.command,
      args: input.config.args,
      env: input.config.env,
      transport: input.config.transport ?? "stdio",
      workspaceFolders: input.workspaceFolders,
      initializationOptions: input.config.initializationOptions,
      // Per-server settings drive workspace/configuration pulls + the
      // post-init didChangeConfiguration push; startupTimeout bounds the
      // initialize handshake (sidecar lsp-client).
      settings: input.config.settings,
      startupTimeout: input.config.startupTimeout,
    }
    try {
      await this.invoke(this.channelId, "lsp:start", payload)
    } catch (err) {
      // Route is dead — drop it so a future retry doesn't leak the
      // closure.
      this.diagnosticsRoutes.delete(lspServerKey(input.ownerId, input.serverId))
      throw err
    }
  }

  /**
   * Renderer→sidecar `lsp:stop`. Always drops the diagnostic route,
   * even if the sidecar throws — a stopped server should never
   * surface diagnostics.
   */
  async stop(ownerId: string, serverId: string): Promise<void> {
    const key = lspServerKey(ownerId, serverId)
    this.diagnosticsRoutes.delete(key)
    if (!this.isHostAvailable()) return
    try {
      await this.invoke(this.channelId, "lsp:stop", { ownerId, serverId })
    } catch {
      // Best-effort — the registry already considers this stopped.
    }
  }

  /**
   * Optional helpers for the registry / bootstrap to push document
   * lifecycle events to the LSP. The registry's bridge wires
   * `mountMonacoWorkbench` → these methods so every Skill / Canvas /
   * Artifact open/change/close lands at the sidecar.
   */
  async didOpen(input: {
    ownerId: string
    serverId: string
    uri: string
    languageId: string
    text: string
  }): Promise<void> {
    await this.invoke(this.channelId, "lsp:didOpen", input)
  }

  async didChange(input: {
    ownerId: string
    serverId: string
    uri: string
    text: string
  }): Promise<void> {
    await this.invoke(this.channelId, "lsp:didChange", input)
  }

  async didClose(input: { ownerId: string; serverId: string; uri: string }): Promise<void> {
    await this.invoke(this.channelId, "lsp:didClose", input)
  }

  /**
   * Generic provider request — used by the renderer when Monaco asks
   * for completion/hover/definition and we need to forward to the LSP
   * through the sidecar. The returned value is LSP-protocol-shaped
   * (the `lsp-protocol-adapter` translates).
   */
  async request(input: {
    ownerId: string
    serverId: string
    method: string
    payload: unknown
  }): Promise<unknown> {
    return this.invoke(this.channelId, "lsp:request", input)
  }

  // ──────────────────────────────────────────────────────────────────────
  // Maturity surface — binary detection, one-click install, runtime
  // health and the sidecar log ring. All degrade to inert values when
  // the host is unavailable (web / mobile).
  // ──────────────────────────────────────────────────────────────────────

  /** `lsp:detect` — ladder resolution without installing. */
  async detect(input: {
    servers: Array<{ serverId: string; command: string; npmPackage?: string; version?: string }>
    installDir?: string
    projectRoot?: string
  }): Promise<LspDetectResultEntry[]> {
    if (!this.isHostAvailable()) return []
    return (await this.invoke(this.channelId, "lsp:detect", input)) as LspDetectResultEntry[]
  }

  /** `lsp:install` — npm-first install; progress arrives via onInstallProgress. */
  async installServer(input: {
    serverId: string
    command: string
    npmPackage: string
    version?: string
    installDir: string
  }): Promise<LspDetectResultEntry> {
    if (!this.isHostAvailable()) {
      return { serverId: input.serverId, status: "missing", source: null, resolvedPath: null }
    }
    return (await this.invoke(this.channelId, "lsp:install", input)) as LspDetectResultEntry
  }

  /** `lsp:status` — supervisor snapshot of every tracked server. */
  async status(): Promise<LspRuntimeStatusEntry[]> {
    if (!this.isHostAvailable()) return []
    return (await this.invoke(this.channelId, "lsp:status", {})) as LspRuntimeStatusEntry[]
  }

  /** `lsp:logs` — sidecar ring-buffer query (newest last). */
  async logs(input: { serverId?: string; limit?: number } = {}): Promise<LspSidecarLogEntry[]> {
    if (!this.isHostAvailable()) return []
    return (await this.invoke(this.channelId, "lsp:logs", input)) as LspSidecarLogEntry[]
  }

  private installProgressListeners = new Set<(p: LspInstallProgressEvent) => void>()
  private stateListeners = new Set<(p: LspStatePushEvent) => void>()
  private unregisterInstallProgress: (() => void) | null = null
  private unregisterState: (() => void) | null = null

  /** Subscribe to `lsp:installProgress` pushes. */
  onInstallProgress(cb: (p: LspInstallProgressEvent) => void): () => void {
    if (!this.unregisterInstallProgress) {
      this.unregisterInstallProgress = this.registerHandler("lsp:installProgress", (params) => {
        for (const listener of this.installProgressListeners) {
          try {
            listener(params as LspInstallProgressEvent)
          } catch {
            /* swallow */
          }
        }
      })
    }
    this.installProgressListeners.add(cb)
    return () => {
      this.installProgressListeners.delete(cb)
    }
  }

  /** Subscribe to `lsp:state` health-transition pushes. */
  onStatePush(cb: (p: LspStatePushEvent) => void): () => void {
    if (!this.unregisterState) {
      this.unregisterState = this.registerHandler("lsp:state", (params) => {
        for (const listener of this.stateListeners) {
          try {
            listener(params as LspStatePushEvent)
          } catch {
            /* swallow */
          }
        }
      })
    }
    this.stateListeners.add(cb)
    return () => {
      this.stateListeners.delete(cb)
    }
  }
}

/** `lsp:detect` / `lsp:install` result entry (sidecar lsp-installer). */
export interface LspDetectResultEntry {
  serverId: string
  status: "installed" | "managed" | "missing"
  source: "explicit" | "project" | "managed" | "path" | null
  resolvedPath: string | null
  error?: string
}

/** `lsp:status` entry (sidecar supervisor snapshot). */
export interface LspRuntimeStatusEntry {
  key: string
  ownerId: string
  serverId: string
  state: "stopped" | "starting" | "running" | "crashed" | "broken"
  restarts: number
  lastError?: string
  startedAt?: number
}

/** `lsp:logs` entry. */
export interface LspSidecarLogEntry {
  ts: number
  level: "info" | "warn" | "error"
  key: string
  serverId: string
  message: string
}

/** `lsp:installProgress` push. */
export interface LspInstallProgressEvent {
  serverId: string
  phase: "resolving" | "installing" | "done" | "error"
  message?: string
}

/** `lsp:state` push. */
export interface LspStatePushEvent {
  key: string
  ownerId: string
  serverId: string
  state: LspRuntimeStatusEntry["state"]
  restarts: number
  lastError?: string
}
