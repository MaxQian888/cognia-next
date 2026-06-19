/**
 * Plugin Permission API Implementation
 *
 * Provides permission management capabilities to plugins.
 */

import type { PluginPermissionAPI, PluginAPIPermission } from "@/types/plugin/plugin-extended"
import { createPluginSystemLogger } from "@/lib/plugin/core/logger"
import { requestPluginPermission } from "@/lib/plugin/security/permission-requests"
import {
  grantPluginPermission as grantHostPermission,
  listPluginPermissions as listHostPermissions,
  revokePluginPermission as revokeHostPermission,
} from "@/lib/plugin/core/transport"
import { recordSilentFailure } from "../contracts/diagnostics-store"

// Permission grants by plugin
const grantedPermissions = new Map<string, Set<PluginAPIPermission>>()

// Permission mapping from manifest permissions to API permissions
const permissionMapping: Record<string, PluginAPIPermission[]> = {
  "network:fetch": [],
  "filesystem:read": [],
  "filesystem:write": [],
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
  "artifact:read": ["artifact:read"],
  "artifact:write": ["artifact:write"],
  "ai:chat": ["ai:chat"],
  "ai:embed": ["ai:embed"],
  "agent:control": ["agent:control"],
  "agent:dispatch-external": ["agent:dispatch-external"],
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
  secrets: ["settings:read", "settings:write"],
}

function expandManifestPermission(permission: string): string[] {
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

  // Prime host-side grants list (best effort).
  void listHostPermissions(pluginId).catch((error) =>
    recordSilentFailure(
      pluginId,
      {
        site: "permission.listHost",
        message: "Failed to prime host-side permission grants",
        expected: false,
      },
      error
    )
  )

  const getPermissions = () => grantedPermissions.get(pluginId) || new Set()

  return {
    hasPermission: (permission: PluginAPIPermission): boolean => {
      return getPermissions().has(permission)
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
        void grantHostPermission(pluginId, permission).catch((error) =>
          recordSilentFailure(
            pluginId,
            {
              site: "permission.grantHost",
              message: `Failed to persist grant for ${permission}`,
              expected: false,
            },
            error
          )
        )
        logger.info(`Granted permission: ${permission}`)
      } else {
        logger.info(`Denied permission: ${permission}`)
      }
      return granted
    },

    getGrantedPermissions: (): PluginAPIPermission[] => {
      return Array.from(getPermissions())
    },

    hasAllPermissions: (permissions: PluginAPIPermission[]): boolean => {
      const granted = getPermissions()
      return permissions.every((p) => granted.has(p))
    },

    hasAnyPermission: (permissions: PluginAPIPermission[]): boolean => {
      const granted = getPermissions()
      return permissions.some((p) => granted.has(p))
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
  return grantedPermissions.get(pluginId)?.has(permission) ?? false
}

/**
 * Revoke all permissions for a plugin
 */
export function revokePluginPermissions(pluginId: string) {
  grantedPermissions.delete(pluginId)
}

/**
 * Grant a specific permission to a plugin
 */
export function grantPermission(pluginId: string, permission: PluginAPIPermission) {
  const permissions = grantedPermissions.get(pluginId) || new Set()
  permissions.add(permission)
  grantedPermissions.set(pluginId, permissions)
  void grantHostPermission(pluginId, permission).catch((error) =>
    recordSilentFailure(
      pluginId,
      {
        site: "permission.grantHost",
        message: `Failed to persist grant for ${permission}`,
        expected: false,
      },
      error
    )
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
  void revokeHostPermission(pluginId, permission).catch((error) =>
    recordSilentFailure(
      pluginId,
      {
        site: "permission.revokeHost",
        message: `Failed to persist revocation for ${permission}`,
        expected: false,
      },
      error
    )
  )
}
