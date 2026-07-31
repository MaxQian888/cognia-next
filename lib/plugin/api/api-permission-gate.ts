/**
 * Permission gate for context APIs whose permissions live in the
 * PluginAPIPermission space (`ai:chat`, `vector:read`, `project:delete`, …).
 *
 * Mirrors `createGuardedAPI` (lib/plugin/security/permission-guard.ts) —
 * same Proxy shape, same fail-closed rule for unlisted function properties —
 * but checks the API-permission store (`pluginHasApiPermission`, which holds
 * manifest-mapped grants plus the default grants like `theme:read`) and
 * falls back to the PermissionGuard so a guard-side grant of the same string
 * also passes. `createGuardedAPI` alone cannot gate these APIs: the guard is
 * seeded raw from the manifest and never receives the default API grants.
 */

import type { PluginAPIPermission } from "@/types/plugin/plugin"
import type { PluginPermission } from "@/types/plugin"
import { getPermissionGuard, PermissionError } from "@/lib/plugin/security/permission-guard"
import { pluginHasApiPermission } from "./permission-api"

export interface ApiGuardOptions<T> {
  /**
   * Method names intentionally NOT permission-gated — pure helpers,
   * introspection, or contribution-registration methods. Listing them is
   * REQUIRED: a function property that is neither in the permission map nor
   * here fails closed (throws on call), so a method added to the API without
   * updating the map can't drift into being unprotected.
   */
  unguarded?: ReadonlyArray<keyof T>
}

export function hasApiOrGuardPermission(
  pluginId: string,
  permission: PluginAPIPermission
): boolean {
  return (
    pluginHasApiPermission(pluginId, permission) ||
    getPermissionGuard().check(pluginId, permission as unknown as PluginPermission, "api-gate")
  )
}

export function createApiGuardedAPI<T extends object>(
  pluginId: string,
  api: T,
  permissionMap: Partial<Record<keyof T, PluginAPIPermission>>,
  options: ApiGuardOptions<T> = {}
): T {
  const unguarded = new Set<keyof T>(options.unguarded ?? [])

  return new Proxy(api, {
    get(target, prop: string | symbol) {
      const value = target[prop as keyof T]

      if (typeof value !== "function") {
        return value
      }

      if (unguarded.has(prop as keyof T)) {
        return value
      }

      const required = permissionMap[prop as keyof T]
      if (!required) {
        // Fail closed: an unmapped method is a drift bug, not a free pass.
        return () => {
          throw new PermissionError(
            `Method "${String(prop)}" is not permission-mapped for plugin "${pluginId}" — ` +
              `add it to the permission map or the unguarded list`,
            pluginId,
            "unmapped" as PluginPermission
          )
        }
      }

      return (...args: unknown[]) => {
        if (!hasApiOrGuardPermission(pluginId, required)) {
          throw new PermissionError(
            `Plugin "${pluginId}" lacks the "${required}" permission required by "${String(prop)}"`,
            pluginId,
            required as unknown as PluginPermission
          )
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}
