/**
 * Plugin Backup API (`ctx.backup`) — build / inspect / restore the app's
 * encrypted backup packages (ADR-0001) from a plugin (scheduled-backup,
 * migration, disaster-recovery plugins).
 *
 * Wraps `lib/data/{export,import}.ts` + the `lib/db/backup-history.ts`
 * ledger.
 *
 * SECURITY: a plugin must never be able to exfiltrate or overwrite the
 * user's raw API key, so `includeApiKey` is FORCED to `false` on both
 * `create` and `restore` regardless of what the plugin passes — the
 * plugin-facing option types don't even expose it.
 *
 * PERMISSIONS: `create`/`serialize`/`validate`/`listHistory` are read-shaped
 * → `backup:read`. `restore` overwrites the local database → `backup:write`
 * (a `DANGEROUS` permission requiring consent).
 */

import { buildExportEnvelope, serializePackage } from "@/lib/data/export"
import { validateEnvelope, importEnvelope } from "@/lib/data/import"
import { listBackupHistory, getLatestSuccessful } from "@/lib/db/backup-history"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type { PluginBackupAPI } from "@cognia/plugin-contract/lib/plugin/api/backup-api"
export type {
  PluginBackupAPI,
  PluginBackupCreateOptions,
  PluginBackupRestoreOptions,
} from "@cognia/plugin-contract/lib/plugin/api/backup-api"

/**
 * Create the Backup API for a plugin. Reads need `backup:read`; `restore`
 * needs `backup:write`.
 */
export function createBackupAPI(pluginId: string): PluginBackupAPI {
  const api: PluginBackupAPI = {
    create: (opts) =>
      buildExportEnvelope({
        includeSessions: opts?.includeSessions ?? true,
        includeBuiltIns: opts?.includeBuiltIns,
        // backup:read is not memory:read. Plugins cannot exfiltrate learned memory.
        includeMemories: false,
        // Hard-forced: a plugin never gets the raw API key in a backup.
        includeApiKey: false,
      }),
    serialize: (pkg) => serializePackage(pkg),
    validate: (input) => validateEnvelope(input),
    restore: (envelope, opts) =>
      importEnvelope(envelope, {
        mergeStrategy: opts.mergeStrategy,
        includeSessions: opts.includeSessions ?? false,
        // Hard-forced: a plugin never overwrites the user's API key.
        includeApiKey: false,
      }),
    listHistory: (filter) => listBackupHistory(filter),
    getLatestSuccessful: async () => (await getLatestSuccessful()) ?? null,
  }

  return createGuardedAPI(pluginId, api, {
    create: "backup:read",
    serialize: "backup:read",
    validate: "backup:read",
    listHistory: "backup:read",
    getLatestSuccessful: "backup:read",
    restore: "backup:write",
  })
}
