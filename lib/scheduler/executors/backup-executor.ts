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
// reason elsewhere. The local leg writes through `lib/data/backup-host-filesystem`
// (Tauri plugin-fs on the desktop, the injected Node adapter on the brain).
// Destinations: `local` writes the auto-key-encrypted package to disk;
// `webdav` / `github` / `googledrive` upload a sync-passphrase-encrypted
// snapshot through `lib/data/destinations`; `all` does local + every remote.
// `convex` is deprecated.

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
import { dispatchBackupDestination, remoteLegsFor } from "@/lib/data/destinations"
import { isDeprecatedBackupDestination } from "@/lib/data/destinations/config"
import { encryptSnapshotBody, webdavSnapshotName } from "@/lib/data/destinations/webdav"
import { resolveBackupHostFilesystem } from "@/lib/data/backup-host-filesystem"
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

// Destinations the executor fires. `local`/`undefined` → host filesystem;
// `webdav` / `github` / `googledrive` → the matching remote uploader; `all` →
// local + every remote. A destination is supported iff it targets at least one
// wired backend — `convex` is deprecated (see `lib/data/destinations/config.ts`).
function wantsLocal(destination: BackupDestination | undefined): boolean {
  return destination === undefined || destination === "local" || destination === "all"
}

/** @deprecated kept for `__TESTING__` compatibility; use `remoteLegsFor`. */
function wantsWebdav(destination: BackupDestination | undefined): boolean {
  return remoteLegsFor(destination).includes("webdav")
}

function isSupportedDestination(destination: BackupDestination | undefined): boolean {
  if (isDeprecatedBackupDestination(destination)) return false
  return wantsLocal(destination) || remoteLegsFor(destination).length > 0
}

/** Human-readable name of a remote leg for messages/history rows. */
const REMOTE_LEG_LABEL: Record<"webdav" | "github" | "googledrive", string> = {
  webdav: "WebDAV",
  github: "GitHub",
  googledrive: "Google Drive",
}

export async function executeBackupTask(
  task: ScheduledTask,
  execution: TaskExecution,
  _signal: AbortSignal
): Promise<ExecutorResult> {
  const payload = (task.payload ?? {}) as Partial<BackupTaskPayload>
  const destination = payload.destination

  if (!isSupportedDestination(destination)) {
    const error = isDeprecatedBackupDestination(destination)
      ? `Backup destination "${destination}" is deprecated and no longer supported; edit the task to pick local / webdav / github / googledrive.`
      : `Backup destination "${destination}" is not supported in cognia-next; only "local"/"webdav"/"github"/"googledrive"/"all" are wired up.`
    await safelyAppendFailure(error, "auto-key", destination)
    return { success: false, error }
  }

  const refused = assertTaskTypeSupportedOnHost(task.type)
  if (refused) {
    await safelyAppendFailure(refused.error, "auto-key", destination)
    return refused
  }

  try {
    const buildOpts = payloadToBuildOptions(payload.backupType, payload.options)
    const basePackage = await buildBackupPackage(buildOpts)
    const output: Record<string, unknown> = {}
    const remoteLegs = remoteLegsFor(destination)
    const localOnly = destination === undefined || destination === "local"

    if (wantsLocal(destination)) {
      const host = await resolveBackupHostFilesystem()
      const dir = host ? await host.resolveBackupDir() : null
      if (!host || !dir) {
        const error = host
          ? "Local backup skipped — no backup directory is configured on this host (Settings → Data → Auto backup directory)."
          : "Local backup skipped — this host has no filesystem for backups."
        await safelyAppendFailure(error, "auto-key", "local")
        // Local-only tasks fail hard; `all` keeps going and reports the leg.
        if (localOnly) return { success: false, error }
        output.local = { skipped: true, error }
      } else {
        const passphrase = await getDefaultBackupPassphrase()
        if (!passphrase) throw new Error("Auto-key not available on this runtime.")
        const pkg = await attachPortableRetrievalKeys(basePackage, passphrase)
        const plaintext = serializePackage(pkg)
        const body = await encryptSnapshotBody(plaintext, pkg, passphrase)
        const filename = defaultExportFileName(new Date(), "encrypted")
        const target = host.join(dir, filename)
        await host.filesystem.writeTextFile(target, body)
        await appendBackupHistory({
          completedAt: Date.now(),
          type: "scheduled",
          success: true,
          encryption: "auto-key",
          sizeBytes: body.length,
          filename,
          destination: "local",
        })
        output.local = { target, sizeBytes: body.length, filename }
      }
    }

    if (remoteLegs.length > 0) {
      const syncPass = getSyncPassphrase()
      if (!syncPass) {
        const error =
          "Remote upload skipped — unlock the sync passphrase this session to enable it."
        await safelyAppendFailure(error, "passphrase", destination)
        // For a remote-only task this is a hard failure; for `all` the local
        // backup already succeeded, so keep going and report partial success —
        // but surface the skipped legs in `output` so they aren't silent at the
        // result level (and the next scheduled tick retries the upload).
        if (!wantsLocal(destination)) return { success: false, error }
        for (const leg of remoteLegs) output[leg] = { skipped: true, error }
      } else {
        const pkg = await attachPortableRetrievalKeys(basePackage, syncPass)
        const plaintext = serializePackage(pkg)
        const body = await encryptSnapshotBody(plaintext, pkg, syncPass)
        const filename = webdavSnapshotName(pkg.manifest.exportedAt)
        const meta = { filename, exportedAt: pkg.manifest.exportedAt, sizeBytes: body.length }
        let anyRemoteSucceeded = false
        for (const leg of remoteLegs) {
          const result = await dispatchBackupDestination(leg, body, meta)
          if (result.ok) {
            anyRemoteSucceeded = true
            await appendBackupHistory({
              completedAt: Date.now(),
              type: "scheduled",
              success: true,
              encryption: "passphrase",
              sizeBytes: body.length,
              filename,
              destination: leg,
            })
            output[leg] = { target: result.target, sizeBytes: body.length, filename }
            if (leg === "webdav") await stampWebdavLastSync()
          } else {
            const error =
              result.error ??
              `${REMOTE_LEG_LABEL[leg as keyof typeof REMOTE_LEG_LABEL] ?? leg} upload failed.`
            await safelyAppendFailure(error, "passphrase", leg)
            output[leg] = { failed: true, error }
          }
        }
        // A single-remote task fails when its one leg failed; `all` (or a
        // remote-only fan-out) fails only when every remote leg failed and
        // there was no local success to report.
        const remoteFailures = remoteLegs.filter(
          (leg) => (output[leg] as { failed?: boolean } | undefined)?.failed
        )
        if (remoteFailures.length > 0 && !wantsLocal(destination) && !anyRemoteSucceeded) {
          const first = output[remoteFailures[0]] as { error?: string }
          return { success: false, output, error: first.error ?? "Remote upload failed." }
        }
        if (
          remoteFailures.length === remoteLegs.length &&
          remoteLegs.length === 1 &&
          !wantsLocal(destination)
        ) {
          const first = output[remoteFailures[0]] as { error?: string }
          return { success: false, output, error: first.error ?? "Remote upload failed." }
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
    await safelyAppendFailure(error, "auto-key", destination)
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
  encryption: BackupHistoryEncryption = "auto-key",
  destination?: BackupDestination
): Promise<void> {
  try {
    await appendBackupHistory({
      completedAt: Date.now(),
      type: "scheduled",
      success: false,
      encryption,
      errorMessage,
      destination,
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
