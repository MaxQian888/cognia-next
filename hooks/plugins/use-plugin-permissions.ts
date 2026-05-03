"use client"

// Wraps lib/plugin/security/permission-guard.ts so UI components don't reach
// past the singleton accessor. All grant/revoke calls go through the guard;
// the audit log is read straight from the in-memory ring buffer.
//
// Audit-log identity strategy: the guard returns a fresh array on every
// `getAuditLog()` call. Re-deriving inside `useSyncExternalStore` would
// produce a new snapshot each render and trigger React's "snapshot should
// be cached" infinite loop. We instead key a `useMemo` on a revision counter
// that's bumped whenever the wrapper performs a grant/revoke/request.

import { useCallback, useMemo, useState } from "react"
import {
  getPermissionGuard,
  PERMISSION_GROUPS,
  DANGEROUS_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  type PermissionAuditEntry,
} from "@/lib/plugin/security/permission-guard"
import type { PluginPermission } from "@/types/plugin"

export interface UsePluginPermissions {
  /** All declared groups (filesystem / network / clipboard / …). */
  groups: typeof PERMISSION_GROUPS
  /** Permissions tagged dangerous — UI surfaces them with a warning style. */
  dangerous: typeof DANGEROUS_PERMISSIONS
  /** Static description map keyed by permission id. */
  descriptions: typeof PERMISSION_DESCRIPTIONS
  /** Permissions currently granted to a given plugin. */
  getGranted: (pluginId: string) => PluginPermission[]
  /** All plugin ids that hold a given permission. */
  getHolders: (permission: PluginPermission) => string[]
  /** Latest audit log entries (ring-buffered at 1000 by default). */
  auditLog: PermissionAuditEntry[]
  grant: (
    pluginId: string,
    permission: PluginPermission,
    options?: { grantedBy?: "manifest" | "user" | "system"; expiresIn?: number }
  ) => void
  revoke: (pluginId: string, permission: PluginPermission) => void
  revokeAll: (pluginId: string) => void
  request: (pluginId: string, permission: PluginPermission, reason?: string) => Promise<boolean>
  isDangerous: (permission: PluginPermission) => boolean
}

export function usePluginPermissions(): UsePluginPermissions {
  const guard = getPermissionGuard()
  const [revision, setRevision] = useState(0)
  const bump = useCallback(() => setRevision((r) => r + 1), [])

  // Memoized snapshot keyed on revision — the array identity stays stable
  // until a grant / revoke / request bumps the counter.
  const auditLog = useMemo<PermissionAuditEntry[]>(
    () => guard.getAuditLog({ limit: 200 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [guard, revision]
  )

  const getGranted = useCallback(
    (pluginId: string) => guard.getPluginPermissions(pluginId),
    [guard]
  )
  const getHolders = useCallback(
    (permission: PluginPermission) => guard.getAllPluginsWithPermission(permission),
    [guard]
  )
  const grant = useCallback(
    (
      pluginId: string,
      permission: PluginPermission,
      options?: {
        grantedBy?: "manifest" | "user" | "system"
        expiresIn?: number
      }
    ) => {
      guard.grant(pluginId, permission, options)
      bump()
    },
    [guard, bump]
  )
  const revoke = useCallback(
    (pluginId: string, permission: PluginPermission) => {
      guard.revoke(pluginId, permission)
      bump()
    },
    [guard, bump]
  )
  const revokeAll = useCallback(
    (pluginId: string) => {
      guard.revokeAll(pluginId)
      bump()
    },
    [guard, bump]
  )
  const request = useCallback(
    async (pluginId: string, permission: PluginPermission, reason?: string) => {
      const result = await guard.request(pluginId, permission, reason)
      bump()
      return result
    },
    [guard, bump]
  )
  const isDangerous = useCallback(
    (permission: PluginPermission) => guard.isDangerousPermission(permission),
    [guard]
  )

  return useMemo(
    () => ({
      groups: PERMISSION_GROUPS,
      dangerous: DANGEROUS_PERMISSIONS,
      descriptions: PERMISSION_DESCRIPTIONS,
      getGranted,
      getHolders,
      auditLog,
      grant,
      revoke,
      revokeAll,
      request,
      isDangerous,
    }),
    [auditLog, getGranted, getHolders, grant, revoke, revokeAll, request, isDangerous]
  )
}
