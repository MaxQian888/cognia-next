/**
 * Plugin Permission API Implementation
 *
 * Provides permission management capabilities to plugins.
 */

import type {
  PluginPermissionAPI,
  PluginAPIPermission,
  IntrospectablePluginPermission,
} from "@/types/plugin/plugin"
import type { PluginPermission } from "@/types/plugin"
import { createPluginSystemLogger } from "@/lib/plugin/core/logger"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { requestPluginPermission } from "@/lib/plugin/security/permission-requests"
import {
  grantPluginPermission as grantHostPermission,
  isPluginGatewayAvailable,
  listPluginPermissions as listHostPermissions,
  revokePluginPermission as revokeHostPermission,
} from "@/lib/plugin/core/transport"
import { recordSilentFailure } from "../contracts/diagnostics-store"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { pluginRuntimeAccountAvailable } from "@/lib/plugin/security/account-runtime-gate"

// Permission grants by plugin
const grantedPermissions = new Map<string, Set<PluginAPIPermission>>()

// Permission mapping from manifest permissions to API permissions
const permissionMapping: Record<string, PluginAPIPermission[]> = {
  "network:fetch": [],
  "filesystem:read": ["filesystem:read"],
  "filesystem:write": ["filesystem:write"],
  "fs:read": [],
  "fs:write": [],
  "clipboard:read": [],
  "clipboard:write": [],
  "shell:execute": [],
  "process:spawn": [],
  "database:read": [],
  "database:write": [],
  "secrets:read": [],
  "secrets:write": [],
  // API permissions
  "session:read": ["session:read"],
  "session:write": ["session:write"],
  "session:delete": ["session:delete"],
  "project:read": ["project:read"],
  "project:write": ["project:write"],
  "project:delete": ["project:delete"],
  "vector:read": ["vector:read"],
  "vector:write": ["vector:write"],
  "canvas:read": ["canvas:read"],
  "canvas:write": ["canvas:write"],
  "canvas:run": ["canvas:run"],
  "canvas:collaborate": ["canvas:collaborate"],
  "artifact:read": ["artifact:read"],
  "artifact:write": ["artifact:write"],
  "workflow:read": ["workflow:read"],
  "ai:chat": ["ai:chat"],
  "ai:embed": ["ai:embed"],
  "agent:control": ["agent:control"],
  "builtin-skills:invoke": ["builtin-skills:invoke"],
  "agent:dispatch-external": ["agent:dispatch-external"],
  // Subagent dispatch + shared-memory/twin introspection. Identity mappings —
  // without these the manifest declarations are silently dropped and
  // `ctx.agent.dispatchSubagent`/`runTeam` and
  // `ctx.agent.context.readSharedMemory`/`queryTwinMemory` (gated by
  // `pluginHasApiPermission` in `lib/plugin/core/context.ts`) always throw.
  "agent:dispatch": ["agent:dispatch"],
  "agent:shared-memory:read": ["agent:shared-memory:read"],
  "twin:read": ["twin:read"],
  "templates:read": ["templates:read"],
  "templates:contribute": ["templates:contribute"],
  "templates:instantiate": ["templates:instantiate"],
  "templates:library:write": ["templates:library:write"],
  "export:session": ["export:session"],
  "export:project": ["export:project"],
  "theme:read": ["theme:read"],
  "theme:write": ["theme:write"],
  "media:image:read": ["media:image:read"],
  "media:image:write": ["media:image:write"],
  "media:video:read": ["media:video:read"],
  "media:video:write": ["media:video:write"],
  "media:video:export": ["media:video:export"],
  "extension:ui": ["extension:ui"],
  "extension:workflow": ["extension:workflow"],
  "notification:show": ["notification:show"],
  // Inter-plugin IPC. Identity mappings — without these a plugin that
  // declares `ipc:call` / `ipc:expose` in its manifest never has the API
  // permission granted, so every `ctx.ipc.send/call/broadcast/expose` throws
  // (the gate in `lib/plugin/messaging/ipc.ts:createIPCAPI` checks exactly
  // these keys). Receiving (`on`) and introspection stay ungated.
  "ipc:call": ["ipc:call"],
  "ipc:expose": ["ipc:expose"],
  // Pub/sub event bus. Identity mappings — same reason as the IPC pair above:
  // without these a plugin that declares `events:publish` / `events:subscribe`
  // never has the API permission granted, so `ctx.events.bus.emit` / `.on`
  // throw (the gate lives in `lib/plugin/messaging/message-bus.ts:createEventAPI`).
  // Cleanup (`off`/`offAll`) stays ungated.
  "events:publish": ["events:publish"],
  "events:subscribe": ["events:subscribe"],
}

const legacyAliases: Record<string, string[]> = {
  storage: ["settings:read", "settings:write"],
  network: ["network:fetch"],
  filesystem: ["filesystem:read", "filesystem:write"],
  shell: ["shell:execute"],
  database: ["database:read", "database:write"],
  clipboard: ["clipboard:read", "clipboard:write"],
  notifications: ["notification"],
  // Legacy `secrets` must expand to the secrets permissions themselves, not
  // settings — mapping it to settings both under-granted (no secret access)
  // and over-granted (settings access the plugin never declared).
  secrets: ["secrets:read", "secrets:write"],
}

export function expandManifestPermission(permission: string): string[] {
  if (legacyAliases[permission]) {
    return legacyAliases[permission]
  }
  return [permission]
}

/**
 * Initialize permissions for a plugin based on its manifest
 */
export function initializePluginPermissions(pluginId: string, manifestPermissions: string[]) {
  const permissions = new Set<PluginAPIPermission>()

  // Map manifest permissions to API permissions
  for (const perm of manifestPermissions) {
    const expanded = expandManifestPermission(perm)
    for (const item of expanded) {
      const mapped = permissionMapping[item]
      if (mapped) {
        for (const p of mapped) {
          permissions.add(p)
        }
      }
    }
  }

  // Grant some default permissions
  permissions.add("notification:show")
  permissions.add("theme:read")

  grantedPermissions.set(pluginId, permissions)
}

/**
 * Mirror an API-permission change to the native/remote host, but only when that
 * gateway exists — browser / Capacitor-local plugins use the in-memory set, and
 * issuing a Tauri-only command there would warn and persist nothing. Failures
 * are recorded silently: the in-memory grant already succeeded, so the host
 * mirror is best-effort.
 */
function persistToHost(
  pluginId: string,
  fn: () => Promise<unknown>,
  site: string,
  message: string
): void {
  if (!isPluginGatewayAvailable()) return
  void fn().catch((error) =>
    recordSilentFailure(pluginId, { site, message, expected: false }, error)
  )
}

/**
 * Create the Permission API for a plugin
 */
export function createPermissionAPI(
  pluginId: string,
  manifestPermissions: string[]
): PluginPermissionAPI {
  const logger = createPluginSystemLogger(pluginId)
  // Initialize permissions if not already done
  if (!grantedPermissions.has(pluginId)) {
    initializePluginPermissions(pluginId, manifestPermissions)
  }

  // Prime native/remote host grants (a no-op without the host gateway).
  persistToHost(
    pluginId,
    () => listHostPermissions(pluginId),
    "permission.listHost",
    "Failed to prime host-side permission grants"
  )

  const getPermissions = () => grantedPermissions.get(pluginId) || new Set()

  // Introspection must agree with enforcement: `ctx.git.commit()` is gated by
  // the PermissionGuard (manifest-level perms like `git:write`), which the
  // API-permission set knows nothing about. Consult both stores.
  const checkEither = (permission: IntrospectablePluginPermission): boolean =>
    getPermissions().has(permission as PluginAPIPermission) ||
    getPermissionGuard().check(pluginId, permission as PluginPermission, "permission-api")

  return {
    hasPermission: (permission: IntrospectablePluginPermission): boolean => {
      return checkEither(permission)
    },

    requestPermission: async (
      permission: PluginAPIPermission,
      reason?: string
    ): Promise<boolean> => {
      const existing = getPermissions()
      if (existing.has(permission)) {
        return true
      }

      const granted = await requestPluginPermission({
        pluginId,
        permission,
        reason,
        kind: "api",
      })

      if (granted) {
        existing.add(permission)
        contextPanelRegistry.refresh()
        persistToHost(
          pluginId,
          () => grantHostPermission(pluginId, permission),
          "permission.grantHost",
          `Failed to persist grant for ${permission}`
        )
        logger.info(`Granted permission: ${permission}`)
      } else {
        logger.info(`Denied permission: ${permission}`)
      }
      return granted
    },

    getGrantedPermissions: (): IntrospectablePluginPermission[] => {
      return Array.from(
        new Set<IntrospectablePluginPermission>([
          ...getPermissions(),
          ...getPermissionGuard().getPluginPermissions(pluginId),
        ])
      )
    },

    hasAllPermissions: (permissions: IntrospectablePluginPermission[]): boolean => {
      return permissions.every(checkEither)
    },

    hasAnyPermission: (permissions: IntrospectablePluginPermission[]): boolean => {
      return permissions.some(checkEither)
    },
  }
}

/**
 * Synchronous host-side check: does `pluginId` hold `permission` in its
 * granted API-permission set? Used by imperative context APIs (e.g. the
 * tool-enabled `agent.executeAgent` / `agent.runExternalAgent` branches) to
 * gate behind the plugin's declared manifest permissions before reaching the
 * sidecar. Returns `false` when the plugin has no initialised permission set.
 */
export function pluginHasApiPermission(pluginId: string, permission: PluginAPIPermission): boolean {
  if (!pluginRuntimeAccountAvailable()) return false
  return grantedPermissions.get(pluginId)?.has(permission) ?? false
}

/** Clear process-wide API grants when a LocalProfile locks or changes. */
export function clearAllPluginApiPermissions(): void {
  grantedPermissions.clear()
  contextPanelRegistry.refresh()
}

/**
 * Revoke all permissions for a plugin
 */
export function revokePluginPermissions(pluginId: string) {
  grantedPermissions.delete(pluginId)
  contextPanelRegistry.refresh()
}

/**
 * Grant a specific permission to a plugin
 */
export function grantPermission(pluginId: string, permission: PluginAPIPermission) {
  const permissions = grantedPermissions.get(pluginId) || new Set()
  permissions.add(permission)
  grantedPermissions.set(pluginId, permissions)
  contextPanelRegistry.refresh()
  persistToHost(
    pluginId,
    () => grantHostPermission(pluginId, permission),
    "permission.grantHost",
    `Failed to persist grant for ${permission}`
  )
}

/**
 * Revoke a specific permission from a plugin
 */
export function revokePermission(pluginId: string, permission: PluginAPIPermission) {
  const permissions = grantedPermissions.get(pluginId)
  if (permissions) {
    permissions.delete(permission)
  }
  contextPanelRegistry.refresh()
  persistToHost(
    pluginId,
    () => revokeHostPermission(pluginId, permission),
    "permission.revokeHost",
    `Failed to persist revocation for ${permission}`
  )
}
