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
import {
  registerWorkspaceBackend,
  unregisterWorkspaceBackend,
  getWorkspaceBackend,
} from "@/lib/github/workspace-backend-registry"
import { allRootPaths } from "@/lib/workspace/roots"
import { getActiveWorkspaceRoot } from "./workspace-root"
import { pluginHasApiPermission } from "./permission-api"
import { getPermissionGuard } from "../security/permission-guard"
import { getPluginConsentBroker } from "../security/consent-broker"
import {
  validateWorkspaceCloneHosts,
  DEFAULT_WORKSPACE_CLONE_HOSTS,
} from "../workspace/clone-hosts"
import type { PluginPermission, PluginAPIPermission, PluginManifest } from "@/types/plugin/plugin"
import {
  acquireBotWorkspace,
  assertOwnedBotWorkspace,
  captureBotWorkspace,
  publishBotWorkspace,
} from "../workspace/bot-run"
import {
  acquireWorkspace,
  changedSince,
  defaultAcquireDeps,
  readHandleFile,
  releaseWorkspace,
  walkHandle,
} from "@/lib/plugin/workspace/acquire"
import type { PluginWorkspaceAPI } from "@cognia/plugin-contract/lib/plugin/api/workspace-api"
export type { PluginWorkspaceAPI } from "@cognia/plugin-contract/lib/plugin/api/workspace-api"

const ownedByPlugin = new Map<string, Set<string>>()

export function createWorkspaceAPI(
  pluginId: string,
  manifest: Pick<PluginManifest, "permissions" | "workspaceCloneHosts"> = {}
): PluginWorkspaceAPI {
  const logger = createPluginSystemLogger(pluginId)
  const declaredPermissions = new Set(manifest.permissions ?? [])
  const allowedCloneHosts = Object.freeze(validateWorkspaceCloneHosts(manifest.workspaceCloneHosts))
  const requirePermissions = (...permissions: PluginPermission[]) => {
    for (const permission of permissions)
      if (
        !pluginHasApiPermission(pluginId, permission as PluginAPIPermission) &&
        !getPermissionGuard().check(pluginId, permission, "workspace-api")
      )
        throw new Error(`workspace API requires ${permission}`)
  }
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
      if (spec.kind === "bot-run") {
        requirePermissions("filesystem:write", "git:write", "integrations:read")
        return acquireBotWorkspace(pluginId, spec, defaultAcquireDeps(pluginId, openWorkspaceRoots))
      }
      return acquireWorkspace(spec, {
        ...defaultAcquireDeps(pluginId, openWorkspaceRoots),
        allowedCloneHosts,
        authorizeRemote: async (remote) => {
          if (!declaredPermissions.has("git:write"))
            throw new Error("workspace clone requires the manifest to declare git:write")
          requirePermissions("git:write")
          const credentials = DEFAULT_WORKSPACE_CLONE_HOSTS.includes(remote.host)
            ? "This may use your saved Git credentials for this host."
            : "Your saved Git credentials will not be used for this host."
          const allowed = await getPluginConsentBroker().request({
            pluginId,
            permission: "git:write",
            scope: `workspace-clone:${remote.host}`,
            reason: `Clone or refresh ${remote.url}. ${credentials}`,
          })
          if (!allowed) throw new Error("Workspace clone consent denied")
          // The consent overlay can stay open while a grant is revoked,
          // forbidden, or the active profile is locked.
          requirePermissions("git:write")
        },
      })
    },
    snapshot: (handle) => {
      requirePermissions("filesystem:read", "git:read")
      return captureBotWorkspace(pluginId, handle)
    },
    publish: (handle, input) => {
      requirePermissions("filesystem:write", "git:write", "integrations:execute")
      return publishBotWorkspace(pluginId, handle, input)
    },
    async walk(handle, options) {
      if (handle.origin === "bot-run") await assertOwnedBotWorkspace(pluginId, handle)
      return walkHandle(handle, options)
    },
    async read(handle, relPath, options) {
      if (handle.origin === "bot-run") await assertOwnedBotWorkspace(pluginId, handle)
      return readHandleFile(handle, relPath, options)
    },
    async changedSince(handle, ref) {
      if (handle.origin === "bot-run") await assertOwnedBotWorkspace(pluginId, handle)
      return changedSince(handle, ref)
    },
    async release(handle) {
      if (handle.origin === "bot-run") {
        await assertOwnedBotWorkspace(pluginId, handle)
        throw new Error("Bot workspaces are retained with their run for approval and recovery")
      }
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
