/**
 * Manual "Sync now" for the remote backup destinations other than WebDAV
 * (GitHub / Google Drive) — the same pipeline `lib/webdav/sync-now.ts` runs:
 * build the full package, encrypt with the sync passphrase, upload through
 * the destination dispatcher, record a history row (with `destination`), and
 * cache the passphrase for the session. Shared by the settings cards and any
 * future caller (mobile trigger, agent tool).
 */

import { buildBackupPackage, serializePackage } from "@/lib/data/build-package"
import { attachPortableRetrievalKeys } from "@/lib/data/retrieval-key-backup"
import { appendBackupHistory, type BackupHistoryType } from "@/lib/db/backup-history"
import {
  getSyncPassphrase,
  persistSyncPassphrase,
  setSyncPassphrase,
} from "@/lib/webdav/passphrase-cache"
import type { BackupDestination } from "@/types/scheduler"
import { dispatchBackupDestination } from "./index"
import { encryptSnapshotBody, webdavSnapshotName } from "./webdav"

export type RemoteBackupSyncPhase = "building" | "encrypting" | "uploading" | "done"

export type RemoteBackupSyncDestination = Extract<
  BackupDestination,
  "github" | "googledrive" | "webdav"
>

export interface RemoteBackupSyncNowOptions {
  historyType?: BackupHistoryType
  onProgress?: (phase: RemoteBackupSyncPhase) => void
  /** Test seam. */
  dispatch?: typeof dispatchBackupDestination
}

export async function runRemoteBackupSyncNow(
  destination: RemoteBackupSyncDestination,
  passphrase: string,
  opts: RemoteBackupSyncNowOptions = {}
): Promise<{ ok: true; target?: string } | { ok: false; error: string }> {
  const historyType = opts.historyType ?? "manual"
  const onProgress = opts.onProgress ?? (() => undefined)
  const dispatch = opts.dispatch ?? dispatchBackupDestination

  const pass = passphrase || getSyncPassphrase() || ""
  if (!pass) return { ok: false, error: "A sync passphrase is required." }

  onProgress("building")
  const basePackage = await buildBackupPackage({ includeSessions: true, includeApiKey: false })
  const pkg = await attachPortableRetrievalKeys(basePackage, pass)
  const plaintext = serializePackage(pkg)
  onProgress("encrypting")
  const body = await encryptSnapshotBody(plaintext, pkg, pass)
  const filename = webdavSnapshotName(pkg.manifest.exportedAt)

  onProgress("uploading")
  const result = await dispatch(destination, body, {
    filename,
    exportedAt: pkg.manifest.exportedAt,
    sizeBytes: body.length,
  })

  await appendBackupHistory({
    completedAt: Date.now(),
    type: historyType,
    success: result.ok,
    encryption: "passphrase",
    sizeBytes: result.ok ? body.length : undefined,
    filename: result.ok ? filename : undefined,
    errorMessage: result.ok ? undefined : result.error,
    deviceId: pkg.manifest.device?.id,
    deviceLabel: pkg.manifest.device?.label,
    destination,
  })

  if (!result.ok) return { ok: false, error: result.error ?? "Upload failed." }

  setSyncPassphrase(pass)
  await persistSyncPassphrase(pass)
  onProgress("done")
  return { ok: true, target: result.target }
}
