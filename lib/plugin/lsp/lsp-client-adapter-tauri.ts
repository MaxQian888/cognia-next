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
    this.invoke = deps.invoke ?? invokeVscodeRpc
    this.registerHandler = deps.registerHandler ?? registerMethod
    this.isHostAvailable = deps.isHostAvailable ?? isVscodeHostAvailable
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
}
