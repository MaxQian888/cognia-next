"use client"

/**
 * App-startup bootstrap for the standalone-LSP pathway (Phase B of
 * the VS Code LSP reuse work — see
 * `~/.claude/plans/vscode-lsp-mighty-robin.md`).
 *
 * Wiring sequence:
 *
 *   1. Construct the production `LspClientAdapter` (Tauri) + a thin
 *      `LspBridgeAdapter` over the existing `monaco-bridge.setDiagnostics`.
 *   2. Call `configureLspRegistry({ client, bridge, ... })`.
 *   3. Subscribe to the settings store so any change to
 *      `developer.userLspServers` triggers `syncUserLspServers`.
 *   4. Apply the initial settings snapshot once on bootstrap.
 *
 * The bootstrap is idempotent — repeated calls return the same
 * disposer. Production code calls it once during app init; tests
 * exercise individual layers in isolation.
 *
 * Why we depend on `monaco-bridge` indirectly (via `setDiagnostics`):
 * the bridge is already configured during the VS Code loader's
 * `ensureDispatcherConfigured` step (see `lib/plugin/core/vscode-loader.ts`).
 * The LSP registry hands diagnostics directly to that exported
 * function — no second `configureMonacoBridge` call.
 */

import { setDiagnostics } from "@/lib/plugin/vscode-shim/monaco-bridge"
import { listWorkspaceFolders } from "@/lib/plugin/vscode-shim/lsp-workspace-manager"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { UserLspServerEntry } from "@/lib/claude/types"
import { configureLspRegistry, type LspBridgeAdapter, type LspClientAdapter } from "./lsp-registry"
import { syncUserLspServers } from "./lsp-user-servers"
import { TauriLspClientAdapter } from "./lsp-client-adapter-tauri"

interface BootstrapDeps {
  /** Override the production adapter — used by tests. */
  client?: LspClientAdapter
  /** Override the bridge — used by tests. */
  bridge?: LspBridgeAdapter
  /** Override the user-server settings list source — used by tests. */
  getUserLspServers?: () => UserLspServerEntry[] | undefined
  /** Override the change subscription — used by tests. */
  subscribeUserLspServers?: (cb: (entries: UserLspServerEntry[] | undefined) => void) => () => void
  /** Override the workspace-folder resolver — used by tests. */
  resolveWorkspaceFolders?: () => Array<{ uri: string; name: string }>
  /** Override `Date.now()` — used by tests. */
  now?: () => number
}

let installed = false
let disposers: Array<() => void> = []

/**
 * Wire the LSP pipeline. Returns a disposer that tears down every
 * registration; production never tears it down (one-shot at boot).
 *
 * Calling twice without disposing first is a no-op — the previous
 * disposer is returned.
 */
export function bootstrapLspRegistry(deps: BootstrapDeps = {}): () => void {
  if (installed) {
    return () => {
      for (const d of disposers) {
        try {
          d()
        } catch {
          /* swallow */
        }
      }
      disposers = []
      installed = false
    }
  }

  const client =
    deps.client ??
    (() => {
      const a = new TauriLspClientAdapter()
      a.install()
      return a
    })()

  const bridge: LspBridgeAdapter = deps.bridge ?? {
    setDiagnostics: (input) => {
      setDiagnostics({
        extensionId: input.extensionId,
        uri: input.uri,
        markers: input.markers,
      })
    },
  }

  const resolveWorkspaceFolders =
    deps.resolveWorkspaceFolders ??
    (() => listWorkspaceFolders().map((f) => ({ uri: f.uri, name: f.name })))

  const registryDispose = configureLspRegistry({
    client,
    bridge,
    resolveWorkspaceFolders,
    now: deps.now ?? Date.now,
  })
  disposers.push(() => {
    void registryDispose()
  })

  // Settings → user LSP sync. We apply the initial snapshot once and
  // subscribe to subsequent changes.
  const getUserLspServers =
    deps.getUserLspServers ??
    (() => useSettingsStore.getState().settings?.developer?.userLspServers)

  void syncUserLspServers(getUserLspServers())

  const subscribeFn = deps.subscribeUserLspServers ?? defaultSubscribeUserLspServers

  const unsubscribe = subscribeFn((next) => {
    void syncUserLspServers(next)
  })
  disposers.push(unsubscribe)

  installed = true
  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* swallow */
      }
    }
    disposers = []
    installed = false
  }
}

/** Default settings-store subscription — fires the callback whenever
 *  `settings.developer.userLspServers` changes. Equality is checked
 *  by reference because the settings store re-creates the array on
 *  every save, so reference identity tracks "did the user edit". */
function defaultSubscribeUserLspServers(
  cb: (entries: UserLspServerEntry[] | undefined) => void
): () => void {
  let prev = useSettingsStore.getState().settings?.developer?.userLspServers
  return useSettingsStore.subscribe((state) => {
    const next = state.settings?.developer?.userLspServers
    if (next !== prev) {
      prev = next
      cb(next)
    }
  })
}

/** Test helper — clears `installed`. Production never resets. */
export function __resetLspBootstrapForTesting(): void {
  for (const d of disposers) {
    try {
      d()
    } catch {
      /* swallow */
    }
  }
  disposers = []
  installed = false
}
