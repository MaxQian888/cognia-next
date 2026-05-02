// Plugin-permissions table CRUD (Dexie v15 — §A-Schema).
//
// One row per (pluginId, permission) pair. Stores remembered grant/deny
// decisions so the runtime doesn't re-prompt on every invocation. The
// composite primary key `[pluginId+permission]` makes single-decision
// lookups O(1) without scanning.

import type { PluginPermissionRow } from "./plugin-types"
import { getDb } from "./schema"

export async function getPermission(
  pluginId: string,
  permission: string
): Promise<PluginPermissionRow | undefined> {
  return getDb().pluginPermissions.get([pluginId, permission])
}

export async function listPermissionsForPlugin(pluginId: string): Promise<PluginPermissionRow[]> {
  return getDb().pluginPermissions.where("pluginId").equals(pluginId).toArray()
}

export async function listAllPermissions(): Promise<PluginPermissionRow[]> {
  return getDb().pluginPermissions.toArray()
}

/**
 * Idempotent upsert. The runtime calls this after the user grants / denies a
 * permission via the prompt; later calls just refresh `grantedAt`.
 */
export async function setPermission(
  row: Omit<PluginPermissionRow, "grantedAt"> & { grantedAt?: number }
): Promise<PluginPermissionRow> {
  const stored: PluginPermissionRow = {
    ...row,
    grantedAt: row.grantedAt ?? Date.now(),
  }
  await getDb().pluginPermissions.put(stored)
  return stored
}

export async function revokePermission(pluginId: string, permission: string): Promise<void> {
  await getDb().pluginPermissions.delete([pluginId, permission])
}

/**
 * Drop every remembered decision for a plugin. Called when the plugin is
 * uninstalled so a future re-install starts fresh and the user re-authorizes.
 */
export async function revokeAllPermissionsForPlugin(pluginId: string): Promise<number> {
  const rows = await listPermissionsForPlugin(pluginId)
  await Promise.all(rows.map((r) => revokePermission(r.pluginId, r.permission)))
  return rows.length
}

/** Sweep TTL-expired decisions. Returns the number of rows removed. */
export async function purgeExpiredPermissions(now: number = Date.now()): Promise<number> {
  // `expiresAt` is indexed but null/undefined keys aren't usable in a range
  // query, so we scan and let Dexie filter. Volumes here are small (one row
  // per plugin per permission) so the linear scan is fine.
  const expired = await getDb()
    .pluginPermissions.filter((row) => typeof row.expiresAt === "number" && row.expiresAt <= now)
    .toArray()
  await Promise.all(expired.map((r) => revokePermission(r.pluginId, r.permission)))
  return expired.length
}
