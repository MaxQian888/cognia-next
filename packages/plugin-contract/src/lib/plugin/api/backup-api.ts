/**
 * The plugin contract's share of `lib/plugin/api/backup-api.ts`, which re-exports these.
 */
import type { BackupHistoryRow, BackupHistoryType } from "../../db/backup-history"
import type { BackupPackageV3, ImportMergeStrategy, ImportSummary } from "@/lib/data/types"

/** Plugin-facing create options — `includeApiKey` is intentionally absent. */
export interface PluginBackupCreateOptions {
  /** Include sessions + messages + sessionState. Default true. */
  includeSessions?: boolean
  /** Include built-in characters/skills/teams. Default false. */
  includeBuiltIns?: boolean
}

/** Plugin-facing restore options — `includeApiKey` is intentionally absent. */
export interface PluginBackupRestoreOptions {
  mergeStrategy: ImportMergeStrategy
  /** Apply the sessions/messages slice. Default false. */
  includeSessions?: boolean
}

export interface PluginBackupAPI {
  /** Build an encrypted backup package (never carries the API key). */
  create(opts?: PluginBackupCreateOptions): Promise<BackupPackageV3>
  /** Serialize a package to its on-disk JSON string. */
  serialize(pkg: BackupPackageV3): string
  /** Validate + migrate an arbitrary envelope into a current package. */
  validate(input: unknown): Promise<BackupPackageV3>
  /** Restore a backup (overwrites local data; never restores the API key). */
  restore(envelope: unknown, opts: PluginBackupRestoreOptions): Promise<ImportSummary>
  /** Newest-first backup/restore history rows. */
  listHistory(filter?: {
    type?: BackupHistoryType
    successOnly?: boolean
    limit?: number
  }): Promise<BackupHistoryRow[]>
  /** Most-recent successful backup row, or `null`. */
  getLatestSuccessful(): Promise<BackupHistoryRow | null>
}
