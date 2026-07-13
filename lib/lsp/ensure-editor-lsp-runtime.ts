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

import { isTauri } from "@/lib/tauri"
import { loggers } from "@cognia/logging"
import { LSP_TAURI_CHANNEL_ID } from "@/lib/plugin/lsp/lsp-client-adapter-tauri"

const log = loggers.plugin.child("editor-lsp-runtime")

/** Module-level once-guard; reset on failure so the next trigger retries. */
let started = false

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
}

/**
 * Ensure the editor LSP runtime is up. Idempotent: after the first successful
 * run subsequent calls no-op. No-ops entirely off the Tauri desktop runtime.
 * Never throws — a failure is logged and the guard is reset so a later trigger
 * (e.g. reopening Settings → Language Servers) can retry.
 */
export async function ensureEditorLspRuntime(deps: EditorLspRuntimeDeps = {}): Promise<void> {
  if (started) return
  const hostAvailable = deps.hostAvailable ?? isTauri
  if (!hostAvailable()) return
  started = true
  try {
    const invoke = deps.invoke ?? (await import("@tauri-apps/api/core")).invoke
    const ensureDispatcher =
      deps.ensureDispatcher ??
      (await import("@/lib/plugin/core/vscode-loader")).ensureDispatcherConfigured
    const subscribe =
      deps.subscribe ??
      (await import("@/lib/plugin/vscode-shim/rpc-dispatcher")).subscribeToVscodeEvents

    // 1. Spawn the headless host FIRST so any subsequent `lsp:start` (emitted
    //    by the registry bootstrap in step 2) lands on a live sidecar instead
    //    of `not_loaded`.
    await invoke("ensure_system_lsp_host")
    // 2. Configure the RPC dispatcher transport + monaco-bridge, then bootstrap
    //    the LSP registry (constructs the adapter, registers the global
    //    `lsp:publishDiagnostics` handler) and run the settings migration.
    await ensureDispatcher()
    // 3. Route sidecar→renderer pushes for the system channel. MUST run after
    //    step 2 — `subscribeToVscodeEvents` needs the dispatcher transport
    //    configured by `ensureDispatcher()` or it throws.
    await subscribe(LSP_TAURI_CHANNEL_ID)
  } catch (err) {
    // Sub-steps are individually idempotent, so a partial failure is safe to
    // retry on the next trigger.
    started = false
    log.warn("editor LSP runtime bootstrap failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Test-only: clear the once-guard between cases. */
export function __resetEditorLspRuntimeForTesting(): void {
  started = false
}
