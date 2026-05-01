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
// Tauri-only: web-mode runs return a clear error rather than silently writing
// to nowhere. Cloud destinations are intentionally unsupported here — the
// type still allows them for forward compat, but only `local` actually fires.

import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
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
import { encryptBackupPackage } from "@/lib/data/crypto"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { appendBackupHistory } from "@/lib/db/backup-history"
import { DEFAULT_BACKUP_AUTO_SCHEDULE, type BackupAutoSchedule } from "@/lib/claude/types"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@/lib/logger"

const log = loggers.scheduler

interface ExecutorResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

/**
 * Map a high-level `BackupTaskType` to the package-build options. cognia-next
 * doesn't support every Cognia backup-type variant — `plugins` has no
 * backing system, so we fall through to `full` for safety.
 */
function payloadToBuildOptions(
  type: BackupTaskType | undefined,
  options: BackupSelectionOptions | undefined
): { includeSessions: boolean; includeApiKey: boolean } {
  // Default: include everything.
  const includeSessions = options?.includeSessions ?? true
  // The cron path always omits the API key — it's a long-lived encrypted-file
  // sitting on disk; baking the API key in would be a leak.
  const includeApiKey = false
  if (!type || type === "full") {
    return { includeSessions, includeApiKey }
  }
  if (type === "sessions") return { includeSessions: true, includeApiKey: false }
  if (type === "settings") return { includeSessions: false, includeApiKey: false }
  if (type === "all") return { includeSessions: true, includeApiKey: false }
  // `plugins` not supported here — fall through.
  return { includeSessions, includeApiKey }
}

function isLocalDestination(destination: BackupDestination | undefined): boolean {
  return destination === undefined || destination === "local"
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
  execution: TaskExecution
): Promise<ExecutorResult> {
  const payload = (task.payload ?? {}) as Partial<BackupTaskPayload>
  const destination = payload.destination

  if (!isLocalDestination(destination)) {
    const error = `Backup destination "${destination}" is not supported in cognia-next; only "local" is wired up.`
    await safelyAppendFailure(error)
    return { success: false, error }
  }

  if (!isTauri()) {
    const error = "Scheduled backups require the Tauri runtime — open the desktop app to enable."
    await safelyAppendFailure(error)
    return { success: false, error }
  }

  try {
    const buildOpts = payloadToBuildOptions(payload.backupType, payload.options)
    const pkg = await buildBackupPackage(buildOpts)
    const plaintext = serializePackage(pkg)

    const passphrase = await getDefaultBackupPassphrase()
    if (!passphrase) {
      throw new Error("Auto-key not available on this runtime.")
    }

    const env = await encryptBackupPackage(plaintext, passphrase, {
      version: pkg.manifest.version,
      schemaVersion: pkg.manifest.schemaVersion,
      traceId: pkg.manifest.traceId,
      exportedAt: pkg.manifest.exportedAt,
      appVersion: pkg.manifest.appVersion,
      backend: pkg.manifest.backend,
      encryption: { enabled: true, format: "encrypted-envelope-v1" },
    })

    const body = JSON.stringify(env)
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

    // Stamp settings.backupAutoSchedule.lastRunAt so cross-device sync (and
    // the in-app "next run at" indicator) can derive recency without
    // walking `backupHistory`. Best-effort; a failure here doesn't undo the
    // backup itself.
    try {
      const settings = await getSettings()
      const current: BackupAutoSchedule =
        settings.backupAutoSchedule ?? DEFAULT_BACKUP_AUTO_SCHEDULE
      await saveSettings({
        backupAutoSchedule: {
          ...current,
          lastRunAt: new Date().toISOString(),
        },
      })
    } catch (err) {
      log.warn("Failed to stamp backupAutoSchedule.lastRunAt", {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    log.info("Scheduler backup task complete", {
      taskId: task.id,
      executionId: execution.id,
      target,
      sizeBytes: body.length,
    })

    return {
      success: true,
      output: { target, sizeBytes: body.length, filename },
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await safelyAppendFailure(error)
    log.error("Scheduler backup task failed", { taskId: task.id, error })
    return { success: false, error }
  }
}

async function safelyAppendFailure(errorMessage: string): Promise<void> {
  try {
    await appendBackupHistory({
      completedAt: Date.now(),
      type: "scheduled",
      success: false,
      encryption: "auto-key",
      errorMessage,
    })
  } catch {
    // Don't let history failures mask the real error in the result.
  }
}

export const __TESTING__ = {
  payloadToBuildOptions,
  isLocalDestination,
}
