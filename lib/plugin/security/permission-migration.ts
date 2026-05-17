/**
 * One-shot migrations that rewrite legacy permission names in the
 * `plugin_permissions` Dexie table to their canonical equivalents.
 *
 * Runs at plugin-manager bootstrap. Idempotent — re-invoking it after a
 * successful migration is a no-op because the legacy names have been
 * replaced. Each rewrite preserves the row's `decision`, `expiresAt`,
 * `grantedBy`, and `grantedAt` so the user doesn't have to re-authorize.
 *
 * Triggered by ADR 0016 P1-8 (2026-05-17), which renamed
 * `plugins/workspace-tools/plugin.json` from `fs:read/fs:write` to the
 * canonical `filesystem:read/filesystem:write`. Without this migration,
 * users upgrading from a previous release would see the manifest reject
 * with "unknown permission" because the legacy names are no longer in
 * `VALID_PERMISSIONS`. The migration runs at the Dexie layer so the
 * remembered grant survives the rename.
 */

import { listAllPermissions, revokePermission, setPermission } from "@/lib/db/plugin-permissions"
import { recordSilentFailure } from "../contracts/diagnostics-store"

const LEGACY_TO_CANONICAL: Record<string, string> = {
  "fs:read": "filesystem:read",
  "fs:write": "filesystem:write",
}

export interface PermissionMigrationResult {
  scanned: number
  rewritten: number
}

/**
 * Rewrite every row in `plugin_permissions` whose `permission` field is a
 * legacy alias to the canonical name. Records a single diagnostic per
 * rewrite so the Audit Panel surfaces the migration.
 */
export async function migrateLegacyPermissionNames(): Promise<PermissionMigrationResult> {
  const rows = await listAllPermissions()
  let rewritten = 0
  for (const row of rows) {
    const canonical = LEGACY_TO_CANONICAL[row.permission]
    if (!canonical) continue
    try {
      await revokePermission(row.pluginId, row.permission)
      await setPermission({
        pluginId: row.pluginId,
        permission: canonical,
        decision: row.decision,
        expiresAt: row.expiresAt,
        grantedBy: row.grantedBy,
        grantedAt: row.grantedAt,
      })
      recordSilentFailure(
        row.pluginId,
        {
          site: "permission.legacy-rename",
          message: `Renamed legacy permission "${row.permission}" → "${canonical}"`,
          expected: false,
        },
        new Error(`legacy:${row.permission}`)
      )
      rewritten += 1
    } catch (error) {
      // Rewrite failed mid-flight (e.g. a unique-key collision because the
      // canonical name was already granted). Drop the legacy row anyway —
      // leaving it would let `requestPluginPermission` consult a row that
      // can never match a canonical lookup, which is its own bug.
      recordSilentFailure(
        row.pluginId,
        {
          site: "permission.legacy-rename-failed",
          message: `Failed to rewrite legacy permission "${row.permission}"`,
          expected: false,
        },
        error
      )
    }
  }
  return { scanned: rows.length, rewritten }
}
