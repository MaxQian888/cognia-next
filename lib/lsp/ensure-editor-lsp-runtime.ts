/**
 * Desktop startup wiring for the editor/renderer LSP data plane.
 *
 * The editor-side `TauriLspClientAdapter` sends every `lsp:*` RPC over the
 * fixed channel `cognia.lsp-service` (`LSP_TAURI_CHANNEL_ID`). Two things must
 * be alive for that plane to work, and neither happens on a default install:
 *
 *   1. A sidecar registered under `cognia.lsp-service` in the Rust
 *      `VscodeExtensionState` — spawned by the `ensure_system_lsp_host`
 *      command (the headless `vscode-ext-host` process). Without it every
 *      `lsp:*` RPC returns `not_loaded`.
 *   2. The renderer dispatcher + monaco-bridge + LSP registry, wired by
 *      `ensureDispatcherConfigured()` — which otherwise runs ONLY when a real
 *      `.vsix` VS Code extension loads.
 *
 * This module brings both up once, in the correct order, on desktop. It is
 * mounted via `EditorLspRuntimeInitializer` inside `DesktopOnlyInitializers`.
 * The agent-runtime LSP (the model's `lsp_*` tools) is a separate in-process
 * path in the sidecar and is unaffected by this wiring.
 */

import { isTauri, transport } from "@/lib/tauri"
import { isHeadlessHost } from "@/lib/platform/detect"
import { getActiveRemoteTransport, isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { loggers } from "@cognia/logging"
import { LSP_TAURI_CHANNEL_ID } from "@/lib/plugin/lsp/lsp-client-adapter-tauri"

const log = loggers.plugin.child("editor-lsp-runtime")

const LOCAL_HOST = Symbol("local-lsp-host")
let startedHost: unknown | null = null
let startup: { host: unknown; promise: Promise<void> } | null = null

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

export interface EditorLspRuntimeDeps {
  /** Tauri command invoker — injected for tests. */
  invoke?: InvokeFn
  /** Renderer dispatcher/monaco/registry bootstrap — injected for tests. */
  ensureDispatcher?: () => Promise<void>
  /** Subscribe to a sidecar→renderer push channel — injected for tests. */
  subscribe?: (channelId: string) => Promise<() => void>
  /** Runtime host gate — injected for tests. */
  hostAvailable?: () => boolean
  /** Active execution-host identity — injected to verify remote route switches. */
  hostIdentity?: () => unknown
  /** Whether the active execution host is the remote Companion route. */
  remoteHostActive?: () => boolean
}

/**
 * Ensure the editor LSP runtime is up. Idempotent: after the first successful
 * run subsequent calls no-op. No-ops entirely off the Tauri desktop runtime.
 * Never throws — a failure is logged and the guard is reset so a later trigger
 * (e.g. reopening Settings → Language Servers) can retry.
 */
export async function ensureEditorLspRuntime(deps: EditorLspRuntimeDeps = {}): Promise<void> {
  const hostAvailable =
    deps.hostAvailable ?? (() => isTauri() || isHeadlessHost() || isRemoteHostActive())
  if (!hostAvailable()) return
  const host = (deps.hostIdentity ?? (() => getActiveRemoteTransport() ?? LOCAL_HOST))()
  if (startedHost === host) return
  const pendingStartup = startup
  if (pendingStartup && pendingStartup.host === host) return pendingStartup.promise

  const promise = (async () => {
    try {
      const invoke = deps.invoke ?? ((cmd, args) => transport.call(cmd, args))
      const ensureDispatcher =
        deps.ensureDispatcher ??
        (await import("@/lib/plugin/core/vscode-loader")).ensureDispatcherConfigured
      const subscribe =
        deps.subscribe ??
        (await import("@/lib/plugin/vscode-shim/rpc-dispatcher")).subscribeToVscodeEvents
      const remoteHostActive = deps.remoteHostActive ?? isRemoteHostActive

      // Spawn on the currently-routed host before the registry emits lsp:start.
      await invoke(remoteHostActive() ? "lsp_host_ensure" : "ensure_system_lsp_host")
      await ensureDispatcher()
      // RoutingTransport owns live subscription rebinding across host changes.
      await subscribe(LSP_TAURI_CHANNEL_ID)
      startedHost = host
    } catch (err) {
      log.warn("editor LSP runtime bootstrap failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (startup?.host === host) startup = null
    }
  })()
  startup = { host, promise }
  return promise
}

/** Test-only: clear the once-guard between cases. */
export function __resetEditorLspRuntimeForTesting(): void {
  startedHost = null
  startup = null
}
