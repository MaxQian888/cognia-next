/**
 * Plugin Lifecycle - Version management exports
 */

export {
  PluginUpdater,
  getPluginUpdater,
  resetPluginUpdater,
  type UpdateInfo,
  type UpdateResult,
  type UpdateProgress,
  type AutoUpdateConfig,
} from "./updater"

export {
  PluginBackupManager,
  getPluginBackupManager,
  resetPluginBackupManager,
  type PluginBackup,
  type BackupReason,
  type BackupResult,
  type RestoreResult,
} from "./backup"

export {
  PluginRollbackManager,
  getPluginRollbackManager,
  resetPluginRollbackManager,
  type RollbackInfo,
  type RollbackResult,
  type RollbackPlan,
  type MigrationScript,
} from "./rollback"
