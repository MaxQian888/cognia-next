/**
 * Host-neutral scheduled-backup runtime (ADR-0059 T-A6).
 *
 * React/Tauri and the Node brain share this implementation. Host filesystem
 * access and translated user-facing messages are injected at the boundary;
 * package construction, encryption, retention, history, WebDAV sync, and the
 * periodic remote-newer notification remain single-source.
 */

import { DEFAULT_BACKUP_AUTO_SCHEDULE } from "@cognia/agent-config-types"

import {
  buildBackupPackage,
  defaultExportFileName,
  serializePackage,
} from "@/lib/data/build-package"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { pruneScheduledBackups, shouldRunScheduledBackup } from "@/lib/data/scheduler"
import {
  encryptSnapshotBody,
  uploadSnapshotToWebDav,
  webdavSnapshotName,
} from "@/lib/data/destinations/webdav"
import { appendBackupHistory, getLatestSuccessful } from "@/lib/db/backup-history"
import { getSettings, saveSettings } from "@/lib/db/settings"
import {
  getSyncPassphrase,
  hasSyncPassphrase,
  loadPersistedSyncPassphrase,
} from "@/lib/webdav/passphrase-cache"
import { notifyIfRemoteNewer } from "@/lib/webdav/remote-newer-notify"
import type { BackupPackageV3, ExportOptions } from "@/lib/data/types"
import { attachPortableRetrievalKeys } from "@/lib/data/retrieval-key-backup"
import { buildBackupStream } from "./build-stream"

export const BACKUP_CHECK_INTERVAL_MS = 30 * 60 * 1000

export interface BackupFilesystem {
  /** Incremental, atomically committed file output on current desktop/headless hosts. */
  writeStream?(path: string, source: AsyncIterable<Uint8Array>): Promise<number>
  writeTextFile(path: string, contents: string): Promise<void>
  readDirNames(path: string): Promise<string[]>
  remove(path: string): Promise<void>
}

/** Shared local file path for both interval and cron schedulers. */
export async function writeEncryptedLocalBackup(
  filesystem: BackupFilesystem,
  target: string,
  options: ExportOptions,
  passphrase: string,
  signal?: AbortSignal
): Promise<{
  sizeBytes: number
  deviceId?: string
  deviceLabel?: string
  basePackage?: BackupPackageV3
}> {
  signal?.throwIfAborted()
  if (filesystem.writeStream) {
    let device: { id?: string; label?: string } | undefined
    async function* source() {
      let first = true
      for await (const chunk of buildBackupStream(options, { encryption: { passphrase } })) {
        signal?.throwIfAborted()
        if (first) {
          first = false
          // The producer emits its small cleartext manifest as the first record.
          device = JSON.parse(new TextDecoder().decode(chunk)).manifest?.device
        }
        yield chunk
      }
    }
    const sizeBytes = await filesystem.writeStream(target, source())
    return { sizeBytes, deviceId: device?.id, deviceLabel: device?.label }
  }
  // Compatibility for injected hosts that have not adopted the streaming seam.
  // The v3 builder enforces its serialization ceiling before reading source bytes.
  const basePackage = await buildBackupPackage(options)
  const pkg = await attachPortableRetrievalKeys(basePackage, passphrase)
  const body = await encryptSnapshotBody(serializePackage(pkg), pkg, passphrase)
  signal?.throwIfAborted()
  await filesystem.writeTextFile(target, body)
  return {
    sizeBytes: new TextEncoder().encode(body).byteLength,
    deviceId: pkg.manifest.device?.id,
    deviceLabel: pkg.manifest.device?.label,
    basePackage,
  }
}

export interface ScheduledBackupMessages {
  missingDestination: string
  autoKeyUnavailable: string
  syncPassphraseLocked: string
  newerTitle: string
  newerBody: string
}

export interface ScheduledBackupOptions {
  filesystem: BackupFilesystem | null
  messages: ScheduledBackupMessages
  now?: () => Date
}

/** One complete interval-scheduler iteration. */
export async function runScheduledBackupOnce(opts: ScheduledBackupOptions): Promise<boolean> {
  const settings = await getSettings()
  const config = settings.backupAutoSchedule
  if (!config?.enabled) return false

  const lastSuccessful = await getLatestSuccessful()
  const lastFromSchedule = lastSuccessful?.type === "scheduled" ? lastSuccessful : undefined
  if (
    !shouldRunScheduledBackup({
      config,
      lastSuccessAt: lastFromSchedule?.completedAt,
    })
  ) {
    return false
  }
  if (!opts.filesystem || !config.dirPath) {
    await appendBackupHistory({
      completedAt: Date.now(),
      type: "scheduled",
      success: false,
      encryption: "auto-key",
      errorMessage: opts.messages.missingDestination,
    })
    return false
  }

  try {
    const passphrase = await getDefaultBackupPassphrase()
    if (!passphrase) throw new Error(opts.messages.autoKeyUnavailable)
    const fileName = defaultExportFileName(opts.now?.() ?? new Date(), "encrypted")
    const sep = config.dirPath.includes("\\") ? "\\" : "/"
    const directory = config.dirPath.replace(/[/\\]+$/, "")
    const target = `${directory}${sep}${fileName}`

    const written = await writeEncryptedLocalBackup(
      opts.filesystem,
      target,
      { includeSessions: true, includeApiKey: false },
      passphrase
    )

    try {
      const names = await opts.filesystem.readDirNames(config.dirPath)
      const candidates = names
        .filter((name) => name.endsWith(".enc.cbk"))
        .map((name) => ({ name: `${directory}${sep}${name}`, completedAt: 0 }))
        .sort((a, b) => (a.name < b.name ? 1 : -1))
      const toRemove = pruneScheduledBackups(
        candidates.map((candidate, index) => ({ ...candidate, completedAt: -index })),
        config.retainCount
      )
      for (const candidate of toRemove) {
        try {
          await opts.filesystem.remove(candidate.name)
        } catch {
          // Retention is best-effort; the completed backup remains valid.
        }
      }
    } catch {
      // Directory enumeration/permissions failure is non-fatal.
    }

    await appendBackupHistory({
      completedAt: Date.now(),
      type: "scheduled",
      success: true,
      encryption: "auto-key",
      sizeBytes: written.sizeBytes,
      filename: fileName,
      deviceId: written.deviceId,
      deviceLabel: written.deviceLabel,
    })

    if (settings.webdavSync?.enabled === true) {
      try {
        const pkg =
          written.basePackage ??
          (await buildBackupPackage({ includeSessions: true, includeApiKey: false }))
        await maybeUploadToWebDav(true, pkg, "", opts.messages)
      } catch (error) {
        // A remote serialization limit must not invalidate the durable local stream.
        await appendBackupHistory({
          completedAt: Date.now(),
          type: "scheduled",
          success: false,
          encryption: "passphrase",
          errorMessage: error instanceof Error ? error.message : String(error),
        })
      }
    }

    try {
      await saveSettings({
        backupAutoSchedule: {
          ...(config ?? DEFAULT_BACKUP_AUTO_SCHEDULE),
          lastRunAt: new Date().toISOString(),
        },
      })
    } catch {
      // A metadata stamp must not invalidate an already-written backup.
    }
    return true
  } catch (error) {
    await appendBackupHistory({
      completedAt: Date.now(),
      type: "scheduled",
      success: false,
      encryption: "auto-key",
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

export async function maybeUploadToWebDav(
  enabled: boolean,
  pkg: BackupPackageV3,
  _plaintext: string,
  messages: Pick<ScheduledBackupMessages, "syncPassphraseLocked">
): Promise<void> {
  if (!enabled) return
  if (!hasSyncPassphrase()) {
    await appendBackupHistory({
      completedAt: Date.now(),
      type: "scheduled",
      success: false,
      encryption: "passphrase",
      errorMessage: messages.syncPassphraseLocked,
    })
    return
  }
  try {
    const syncPassphrase = getSyncPassphrase() as string
    const portablePackage = await attachPortableRetrievalKeys(pkg, syncPassphrase)
    const plaintext = serializePackage(portablePackage)
    const body = await encryptSnapshotBody(plaintext, portablePackage, syncPassphrase)
    const filename = webdavSnapshotName(portablePackage.manifest.exportedAt)
    const result = await uploadSnapshotToWebDav(body, {
      filename,
      exportedAt: portablePackage.manifest.exportedAt,
      sizeBytes: body.length,
    })
    await appendBackupHistory({
      completedAt: Date.now(),
      type: "scheduled",
      success: result.ok,
      encryption: "passphrase",
      sizeBytes: result.ok ? body.length : undefined,
      filename: result.ok ? filename : undefined,
      errorMessage: result.ok ? undefined : result.error,
      deviceId: portablePackage.manifest.device?.id,
      deviceLabel: portablePackage.manifest.device?.label,
    })
    if (result.ok) {
      const settings = await getSettings()
      await saveSettings({
        webdavSync: { ...(settings.webdavSync ?? {}), lastSyncAt: new Date().toISOString() },
      })
    }
  } catch (error) {
    await appendBackupHistory({
      completedAt: Date.now(),
      type: "scheduled",
      success: false,
      encryption: "passphrase",
      errorMessage: error instanceof Error ? error.message : String(error),
    })
  }
}

export interface BackupSchedulerLoopOptions extends ScheduledBackupOptions {
  intervalMs?: number
  log?: (level: "warn", message: string) => void
}

/** Start the initial + periodic backup/WebDAV check and return its teardown. */
export function startBackupScheduler(opts: BackupSchedulerLoopOptions): () => void {
  let stopped = false
  const tick = async (): Promise<void> => {
    try {
      await loadPersistedSyncPassphrase()
      await runScheduledBackupOnce(opts)
    } catch (error) {
      opts.log?.("warn", error instanceof Error ? error.message : String(error))
    }
    if (stopped) return
    await notifyIfRemoteNewer({ title: opts.messages.newerTitle, body: opts.messages.newerBody })
  }

  void tick()
  const handle = globalThis.setInterval(
    () => void tick(),
    opts.intervalMs ?? BACKUP_CHECK_INTERVAL_MS
  )
  return () => {
    stopped = true
    globalThis.clearInterval(handle)
  }
}
