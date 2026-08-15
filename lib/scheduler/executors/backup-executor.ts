// Cron-driven backup executor. Reads the task payload (`BackupTaskPayload`),
// builds the v3 package, encrypts with the auto-key, writes to disk under
// `appDataDir()/backups/`, and records a `scheduled` row in `backupHistory`.
//
// Different from the interval-based `BackupSchedulerProvider`:
//
//   - That provider runs every 30 min and reads `appSettings.backupAutoSchedule`
//     for a single global schedule (interval days + retain count + dirPath).
//   - This executor handles arbitrary cron expressions created via the
//     `BackupScheduleDialog` and runs through the standard scheduler tab-lock
//     so only the leader tab fires it.
//
// Host gate: needs the host filesystem (`lib/scheduler/host-support.ts`), so it
// runs on the desktop and the headless brain and is refused with a structured
// reason elsewhere. Destinations: `local` writes the auto-key-encrypted package
// to disk; `webdav` uploads a sync-passphrase-encrypted snapshot; `all` does
// both. Other cloud targets (github/googledrive/convex) remain unsupported.

import type { ScheduledTask, TaskExecution, TaskExecutorResult } from "@/types/scheduler"
import type {
  BackupDestination,
  BackupSelectionOptions,
  BackupTaskPayload,
  BackupTaskType,
} from "@/types/scheduler"
import {
  buildBackupPackage,
  defaultExportFileName,
  serializePackage,
} from "@/lib/data/build-package"
import type { ExportOptions } from "@/lib/data/types"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { appendBackupHistory, type BackupHistoryEncryption } from "@/lib/db/backup-history"
import { DEFAULT_BACKUP_AUTO_SCHEDULE, type BackupAutoSchedule } from "@cognia/agent-config-types"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { assertTaskTypeSupportedOnHost } from "../host-support"
import { loggers } from "@cognia/logging"
import { dispatchBackupDestination } from "@/lib/data/destinations"
import { encryptSnapshotBody, webdavSnapshotName } from "@/lib/data/destinations/webdav"
import { getSyncPassphrase } from "@/lib/webdav/passphrase-cache"
import { attachPortableRetrievalKeys } from "@/lib/data/retrieval-key-backup"

const log = loggers.scheduler

type ExecutorResult = TaskExecutorResult

/**
 * Map the schedule's user-facing selection to an exact payload contract.
 */
function payloadToBuildOptions(
  type: BackupTaskType | undefined,
  options: BackupSelectionOptions | undefined
): ExportOptions {
  // The cron path always omits the API key — it's a long-lived encrypted-file
  // sitting on disk; baking the API key in would be a leak.
  const base = { includeApiKey: false } as const
  if (type === "sessions") {
    return {
      ...base,
      includeSessions: true,
      includeSettings: false,
      includeCoreData: false,
      includePlugins: false,
      includeLocalStorage: false,
    }
  }
  if (type === "settings") {
    return {
      ...base,
      includeSessions: false,
      includeSettings: true,
      includeCoreData: false,
      includePlugins: false,
      includeLocalStorage: true,
      includeArtifacts: false,
    }
  }
  if (type === "plugins") {
    return {
      ...base,
      includeSessions: false,
      includeSettings: false,
      includeCoreData: false,
      includePlugins: true,
      includeLocalStorage: false,
    }
  }
  if (type === "all") {
    return {
      ...base,
      includeSessions: true,
      includeSettings: true,
      includeCoreData: true,
      includePlugins: true,
      includeLocalStorage: true,
      includeArtifacts: true,
    }
  }
  return {
    ...base,
    includeSessions: options?.includeSessions ?? true,
    includeSettings: options?.includeSettings ?? true,
    includeCoreData: options?.includeIndexedDB ?? true,
    includePlugins: false,
    includeLocalStorage: true,
    includeArtifacts: options?.includeArtifacts ?? true,
  }
}

// Destinations the executor actually fires. `local`/`undefined` → disk;
// `webdav` → upload; `all` → both. A destination is supported iff it targets at
// least one wired backend — derived from the two `wants*` predicates so the
// enum literals live in exactly one place each.
function wantsLocal(destination: BackupDestination | undefined): boolean {
  return destination === undefined || destination === "local" || destination === "all"
}

function wantsWebdav(destination: BackupDestination | undefined): boolean {
  return destination === "webdav" || destination === "all"
}

function isSupportedDestination(destination: BackupDestination | undefined): boolean {
  return wantsLocal(destination) || wantsWebdav(destination)
}

async function resolveBackupPath(filename: string): Promise<string> {
  const { appDataDir, join } = await import("@tauri-apps/api/path")
  const { mkdir } = await import("@tauri-apps/plugin-fs")
  const root = await appDataDir()
  const dir = await join(root, "backups")
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    // Directory already exists or can't be created — `writeTextFile` will surface a
    // useful error if the path is genuinely unwritable.
  }
  return join(dir, filename)
}

export async function executeBackupTask(
  task: ScheduledTask,
  execution: TaskExecution,
  _signal: AbortSignal
): Promise<ExecutorResult> {
  const payload = (task.payload ?? {}) as Partial<BackupTaskPayload>
  const destination = payload.destination

  if (!isSupportedDestination(destination)) {
    const error = `Backup destination "${destination}" is not supported in cognia-next; only "local"/"webdav"/"all" are wired up.`
    await safelyAppendFailure(error)
    return { success: false, error }
  }

  const refused = assertTaskTypeSupportedOnHost(task.type)
  if (refused) {
    await safelyAppendFailure(refused.error)
    return refused
  }

  try {
    const buildOpts = payloadToBuildOptions(payload.backupType, payload.options)
    const basePackage = await buildBackupPackage(buildOpts)
    const output: Record<string, unknown> = {}

    if (wantsLocal(destination)) {
      const passphrase = await getDefaultBackupPassphrase()
      if (!passphrase) throw new Error("Auto-key not available on this runtime.")
      const pkg = await attachPortableRetrievalKeys(basePackage, passphrase)
      const plaintext = serializePackage(pkg)
      const body = await encryptSnapshotBody(plaintext, pkg, passphrase)
      const filename = defaultExportFileName(new Date(), "encrypted")
      const target = await resolveBackupPath(filename)
      const { writeTextFile } = await import("@tauri-apps/plugin-fs")
      await writeTextFile(target, body)
      await appendBackupHistory({
        completedAt: Date.now(),
        type: "scheduled",
        success: true,
        encryption: "auto-key",
        sizeBytes: body.length,
        filename,
      })
      output.local = { target, sizeBytes: body.length, filename }
    }

    if (wantsWebdav(destination)) {
      const syncPass = getSyncPassphrase()
      if (!syncPass) {
        const error =
          "WebDAV upload skipped — unlock the sync passphrase this session to enable it."
        await safelyAppendFailure(error, "passphrase")
        // For a webdav-only task this is a hard failure; for `all` the local
        // backup already succeeded, so keep going and report partial success —
        // but surface the skipped leg in `output` so it isn't silent at the
        // result level (and the next scheduled tick retries the upload).
        if (destination === "webdav") return { success: false, error }
        output.webdav = { skipped: true, error }
      } else {
        const pkg = await attachPortableRetrievalKeys(basePackage, syncPass)
        const plaintext = serializePackage(pkg)
        const body = await encryptSnapshotBody(plaintext, pkg, syncPass)
        const filename = webdavSnapshotName(pkg.manifest.exportedAt)
        const result = await dispatchBackupDestination("webdav", body, {
          filename,
          exportedAt: pkg.manifest.exportedAt,
          sizeBytes: body.length,
        })
        if (result.ok) {
          await appendBackupHistory({
            completedAt: Date.now(),
            type: "scheduled",
            success: true,
            encryption: "passphrase",
            sizeBytes: body.length,
            filename,
          })
          output.webdav = { target: result.target, sizeBytes: body.length, filename }
          await stampWebdavLastSync()
        } else {
          const error = result.error ?? "WebDAV upload failed."
          await safelyAppendFailure(error, "passphrase")
          if (destination === "webdav") return { success: false, error }
          output.webdav = { failed: true, error }
        }
      }
    }

    await stampBackupScheduleLastRun(task.id)

    log.info("Scheduler backup task complete", {
      taskId: task.id,
      executionId: execution.id,
      destination: destination ?? "local",
      output,
    })

    return { success: true, output }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await safelyAppendFailure(error)
    log.error("Scheduler backup task failed", { taskId: task.id, error })
    return { success: false, error }
  }
}

/**
 * Stamp `backupAutoSchedule.lastRunAt` so cross-device sync (and the in-app
 * "next run at" indicator) can derive recency without walking `backupHistory`.
 * Best-effort; a failure here doesn't undo the backup itself.
 */
async function stampBackupScheduleLastRun(taskId: string): Promise<void> {
  try {
    const settings = await getSettings()
    const current: BackupAutoSchedule = settings.backupAutoSchedule ?? DEFAULT_BACKUP_AUTO_SCHEDULE
    await saveSettings({
      backupAutoSchedule: { ...current, lastRunAt: new Date().toISOString() },
    })
  } catch (err) {
    log.warn("Failed to stamp backupAutoSchedule.lastRunAt", {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Stamp `webdavSync.lastSyncAt` after a successful upload. Best-effort. */
async function stampWebdavLastSync(): Promise<void> {
  try {
    const settings = await getSettings()
    const current = settings.webdavSync ?? {}
    await saveSettings({ webdavSync: { ...current, lastSyncAt: new Date().toISOString() } })
  } catch {
    // Non-fatal.
  }
}

async function safelyAppendFailure(
  errorMessage: string,
  encryption: BackupHistoryEncryption = "auto-key"
): Promise<void> {
  try {
    await appendBackupHistory({
      completedAt: Date.now(),
      type: "scheduled",
      success: false,
      encryption,
      errorMessage,
    })
  } catch {
    // Don't let history failures mask the real error in the result.
  }
}

export const __TESTING__ = {
  payloadToBuildOptions,
  isSupportedDestination,
  wantsLocal,
  wantsWebdav,
}
