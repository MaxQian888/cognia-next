/**
 * Plugin Workspace Backend API.
 *
 * Lets a plugin contribute an issue-loop / sandbox-runner backend to the
 * shared `workspace-backend-registry`. Plugins call
 * `ctx.workspace.registerBackend(...)` from `activate()`, or declare
 * `manifest.workspaceBackends[]` and let `workspace-backend-bridge.ts`
 * resolve the lazy factory on plugin enable.
 *
 * Backend ids are namespaced as `<pluginId>:<backendId>`. The legacy
 * `setE2BBackend()` shim still registers under the unprefixed id `"e2b"`
 * for back-compat — see `lib/github/workspace.ts:setE2BBackend` and
 * ADR-0026 §2 §D.
 *
 * Auto-cleanup on plugin disable is wired through
 * `clearWorkspaceBackendsForPlugin(pluginId)`.
 */

import { createPluginSystemLogger } from "../core/logger"
import type { E2BBackend } from "@/lib/github/workspace"
import {
  registerWorkspaceBackend,
  unregisterWorkspaceBackend,
  getWorkspaceBackend,
} from "@/lib/github/workspace-backend-registry"
import type { PluginWorkspaceBackendRegistration } from "@/types/plugin/plugin-workspace-backend"

const ownedByPlugin = new Map<string, Set<string>>()

export interface PluginWorkspaceAPI {
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
}

export function createWorkspaceAPI(pluginId: string): PluginWorkspaceAPI {
  const logger = createPluginSystemLogger(pluginId)
  return {
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
