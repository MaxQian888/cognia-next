/**
 * Plugin Workspace Backend API.
 *
 * Lets a plugin contribute an issue-loop / sandbox-runner backend to the
 * shared `workspace-backend-registry`. Plugins call
 * `ctx.workspace.registerBackend(...)` from `activate()`, or declare
 * `manifest.workspaceBackends[]` and let `workspace-backend-bridge.ts`
 * resolve the lazy factory on plugin enable.
 *
 * Backend ids are namespaced as `<pluginId>:<backendId>`. The host dispatches
 * on the unprefixed *kind* via `resolveWorkspaceBackendByKind` (e.g.
 * `cloneToWorkspace({ backend: "e2b" })` finds `cognia-e2b-sandbox:e2b`), so
 * plugins never need to know how the host names backends. ADR-0026 §2 §D.
 *
 * Auto-cleanup on plugin disable is wired through
 * `clearWorkspaceBackendsForPlugin(pluginId)`.
 *
 * The API also has a *consumer* half (`acquire` / `walk` / `read` /
 * `changedSince`), added with ADR-0145. Registration alone left the contract
 * half-built: a plugin could contribute a backend and read back one it had
 * registered itself, and nothing anywhere let it obtain a checkout to work in.
 * See `lib/plugin/workspace/acquire.ts` for the containment rules.
 */

import { createPluginSystemLogger } from "../core/logger"
import type { E2BBackend } from "@/lib/github/workspace"
import {
  registerWorkspaceBackend,
  unregisterWorkspaceBackend,
  getWorkspaceBackend,
} from "@/lib/github/workspace-backend-registry"
import type { PluginWorkspaceBackendRegistration } from "@/types/plugin/plugin-workspace-backend"
import type { WorkspaceWalkOptions, WorkspaceWalkResult } from "@/lib/files/workspace-fs"
import { allRootPaths } from "@/lib/workspace/roots"
import { getActiveWorkspaceRoot } from "./workspace-root"
import {
  acquireWorkspace,
  changedSince,
  defaultAcquireDeps,
  readHandleFile,
  releaseWorkspace,
  walkHandle,
  type PluginWorkspaceHandle,
  type WorkspaceAcquireSpec,
} from "@/lib/plugin/workspace/acquire"

const ownedByPlugin = new Map<string, Set<string>>()

export interface PluginWorkspaceAPI {
  /** Absolute primary root of the active project, when one is open. */
  getActiveRoot(): string | undefined
  /**
   * Register a workspace backend. The given id is prefixed with the plugin
   * id to avoid collisions across plugins. Throws if the same plugin tries
   * to register two backends with the same unprefixed id.
   *
   * The optional `label` / `description` show up in the workspace picker
   * UI (when one ships — the registry already tracks these fields).
   */
  registerBackend(args: {
    id: string
    label: string
    description?: string
    backend: E2BBackend
  }): PluginWorkspaceBackendRegistration
  /**
   * Resolve a backend this plugin registered, by its unprefixed id. The
   * lookup auto-applies the `<pluginId>:` namespace, so a plugin that called
   * `registerBackend({ id: "sandbox" })` reads it back with
   * `getBackend("sandbox")`. Without this, plugin-contributed backends were
   * registered under the prefixed id but the host only ever resolved the
   * legacy unprefixed `"e2b"`, leaving them unreachable. Returns `undefined`
   * when the plugin never registered that id.
   */
  getBackend(id: string): E2BBackend | undefined
  /** Snapshot of backend ids this plugin has registered. */
  listRegistered(): string[]

  /**
   * Obtain a checkout to read.
   *
   * A remote is cloned into this plugin's own data directory under guard rails
   * (https only, host allow-list, shallow, timed, size bounded). A local path
   * must be inside a workspace the user has already opened — a plugin naming
   * an arbitrary directory is the filesystem escape the rest of the plugin API
   * is built to prevent.
   */
  acquire(spec: WorkspaceAcquireSpec): Promise<PluginWorkspaceHandle>
  /**
   * Enumerate the checkout's files, honouring `.gitignore`.
   *
   * Check `truncated` before treating the result as complete, and
   * `skippedSensitive` to know the host withheld credential files.
   */
  walk(handle: PluginWorkspaceHandle, options?: WorkspaceWalkOptions): Promise<WorkspaceWalkResult>
  /** Read one file; pass `ref` to read it at a revision instead of on disk. */
  read(
    handle: PluginWorkspaceHandle,
    relPath: string,
    options?: { maxBytes?: number; ref?: string }
  ): Promise<string | null>
  /** Repo-relative paths that differ between `ref` and the current revision. */
  changedSince(handle: PluginWorkspaceHandle, ref: string): Promise<string[]>
  /**
   * Discard a handle. Deletes the checkout only when this plugin cloned it;
   * a handle onto the user's own project is left alone. Resolves `false` when
   * there was nothing to delete, so releasing twice is not an error.
   */
  release(handle: PluginWorkspaceHandle): Promise<boolean>
}

export function createWorkspaceAPI(pluginId: string): PluginWorkspaceAPI {
  const logger = createPluginSystemLogger(pluginId)
  return {
    getActiveRoot: getActiveWorkspaceRoot,
    registerBackend({ id, label, description, backend }) {
      const prefixed = `${pluginId}:${id}`
      const owned = ownedByPlugin.get(pluginId) ?? new Set<string>()
      if (owned.has(prefixed)) {
        throw new Error(
          `[workspace-api] plugin ${pluginId} already registered a backend with id "${id}"`
        )
      }
      registerWorkspaceBackend({
        backendId: prefixed,
        pluginId,
        label,
        description,
        backend,
      })
      owned.add(prefixed)
      ownedByPlugin.set(pluginId, owned)
      logger.info(`[workspace] registered backend "${prefixed}"`)
      return {
        backendId: prefixed,
        unregister: () => {
          if (!owned.has(prefixed)) return
          unregisterWorkspaceBackend(prefixed)
          owned.delete(prefixed)
          if (owned.size === 0) ownedByPlugin.delete(pluginId)
          logger.info(`[workspace] unregistered backend "${prefixed}"`)
        },
      }
    },
    getBackend(id) {
      return getWorkspaceBackend(`${pluginId}:${id}`)
    },
    listRegistered() {
      return Array.from(ownedByPlugin.get(pluginId) ?? [])
    },

    acquire(spec) {
      return acquireWorkspace(spec, defaultAcquireDeps(pluginId, openWorkspaceRoots))
    },
    walk(handle, options) {
      return walkHandle(handle, options)
    },
    read(handle, relPath, options) {
      return readHandleFile(handle, relPath, options)
    },
    changedSince(handle, ref) {
      return changedSince(handle, ref)
    },
    release(handle) {
      return releaseWorkspace(handle, defaultAcquireDeps(pluginId, openWorkspaceRoots))
    },
  }
}

/**
 * Every root the user currently has open, across projects.
 *
 * Imported lazily so the plugin API module does not pull the project store
 * (and Dexie behind it) into import graphs that never acquire a workspace.
 */
async function openWorkspaceRoots(): Promise<string[]> {
  try {
    const { useProjectStore } = await import("@/stores/project/project-store")
    const projects = useProjectStore.getState().projects ?? {}
    return Object.values(projects).flatMap((project) => allRootPaths(project))
  } catch {
    // No project store (headless, tests) — nothing is open, so every local
    // path is refused. Failing closed is the right direction here.
    return []
  }
}

/**
 * Drop every backend the plugin owns. Called by the plugin manager on
 * disable / unload. Safe to call multiple times.
 */
export function clearWorkspaceBackendsForPluginContext(pluginId: string): void {
  const owned = ownedByPlugin.get(pluginId)
  if (!owned) return
  for (const id of owned) {
    unregisterWorkspaceBackend(id)
  }
  ownedByPlugin.delete(pluginId)
}

/** Test-only. */
export function __resetWorkspaceApiForTesting(): void {
  ownedByPlugin.clear()
}
