/**
 * Data hooks barrel.
 *
 * Backup / restore / domain transfer / import / export plumbing,
 * plus the SSR-safe `useClientLiveQuery` Dexie wrapper used across
 * the desktop shell.
 */

export {
  useBackupHistory,
  useLatestSuccessfulBackup,
  appendBackupHistory,
  clearBackupHistory,
  deleteBackupHistory,
} from "./use-backup-history"
export { useBackupReminder } from "./use-backup-reminder"
export { useBatchExport, type BatchProgress, type BatchExportResult } from "./use-batch-export"
export { useChatImport, type ChatImportFlowState } from "./use-chat-import"
export { useClientLiveQuery } from "./use-client-live-query"
export { useFullBackup, type RunBackupArgs, type RunBackupResult } from "./use-full-backup"
export { useImportFlow, type ImportFlowState } from "./use-import-flow"
export { useSingleExport, type SingleExportResult } from "./use-single-export"
export { useStorageStats, type StorageStats } from "./use-storage-stats"
