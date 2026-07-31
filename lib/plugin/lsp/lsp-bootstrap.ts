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
import { useProjectStore } from "@/stores/project/project-store"
import { primaryRootOf } from "@/lib/workspace/roots"
import { resolveLspServers } from "@/lib/lsp/resolve-config"
import { readProjectLspFile } from "@/lib/lsp/project-file-reader"
import type { LspServerConfig } from "@/types/lsp/config"
import { configureLspRegistry, type LspBridgeAdapter, type LspClientAdapter } from "./lsp-registry"
import { editorEligibleServers, syncUserLspServers } from "./lsp-user-servers"
import { TauriLspClientAdapter } from "./lsp-client-adapter-tauri"

interface BootstrapDeps {
  /** Override the production adapter — used by tests. */
  client?: LspClientAdapter
  /** Override the bridge — used by tests. */
  bridge?: LspBridgeAdapter
  /**
   * Override the resolved editor-server list source — used by tests. Returns
   * the already-filtered list the editor should run (see
   * `editorEligibleServers`).
   */
  resolveEditorServers?: () => Promise<LspServerConfig[]>
  /**
   * Override the change subscription — used by tests. Fires the callback
   * whenever `settings.lsp` or the active project changes.
   */
  subscribeChanges?: (cb: () => void) => () => void
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

  // Unified LSP → editor sync. Resolve the layered server list (builtin ←
  // user ← project), keep the editor-eligible ones, and converge the
  // registry. Re-run whenever settings.lsp or the active project changes.
  const resolveEditorServers = deps.resolveEditorServers ?? defaultResolveEditorServers

  const applyEditorServers = () => {
    void resolveEditorServers()
      .then((servers) => syncUserLspServers(servers))
      .catch(() => {
        /* resolution / registration failures are non-fatal */
      })
  }

  applyEditorServers()

  const subscribeFn = deps.subscribeChanges ?? defaultSubscribeChanges
  const unsubscribe = subscribeFn(applyEditorServers)
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

/** Primary root dir of the active project, or undefined when none is active. */
function activeProjectRootDir(): string | undefined {
  const { projects, activeProjectId } = useProjectStore.getState()
  const proj = projects.find((p) => p.id === activeProjectId)
  return proj ? primaryRootOf(proj)?.path : undefined
}

/** Production resolver: layer builtin ← settings.lsp ← project `.cognia/lsp.json`. */
async function defaultResolveEditorServers(): Promise<LspServerConfig[]> {
  const settings = useSettingsStore.getState().settings
  const resolved = await resolveLspServers({
    rootDir: activeProjectRootDir(),
    userServers: settings?.lsp?.servers,
    readProjectFile: readProjectLspFile,
  })
  return editorEligibleServers(resolved)
}

/** Default subscription — fires the callback whenever `settings.lsp` or the
 *  active project changes. Reference equality tracks "did the user edit"
 *  because the settings store re-creates the object on every save. */
function defaultSubscribeChanges(cb: () => void): () => void {
  let prevLsp = useSettingsStore.getState().settings?.lsp
  let prevProject = useProjectStore.getState().activeProjectId
  const unsubSettings = useSettingsStore.subscribe((state) => {
    const nextLsp = state.settings?.lsp
    if (nextLsp !== prevLsp) {
      prevLsp = nextLsp
      cb()
    }
  })
  const unsubProject = useProjectStore.subscribe((state) => {
    if (state.activeProjectId !== prevProject) {
      prevProject = state.activeProjectId
      cb()
    }
  })
  return () => {
    unsubSettings()
    unsubProject()
  }
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
