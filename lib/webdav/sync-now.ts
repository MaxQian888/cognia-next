// Manual "Sync now": build the full package, encrypt with the sync passphrase,
// upload to WebDAV, record history, and cache the passphrase for the session.
// Shared by the settings card, the mobile auto-upload trigger (historyType
// "auto"), and any future caller.

import { buildBackupPackage, serializePackage } from "@/lib/data/build-package"
import {
  encryptSnapshotBody,
  uploadSnapshotToWebDav,
  webdavSnapshotName,
} from "@/lib/data/destinations/webdav"
import { appendBackupHistory, type BackupHistoryType } from "@/lib/db/backup-history"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { getSyncPassphrase, persistSyncPassphrase, setSyncPassphrase } from "./passphrase-cache"

/** Coarse progress phases — the transport isn't byte-streaming, so the UI
 * shows a phase label rather than a percentage. */
export type WebDavSyncPhase = "building" | "encrypting" | "uploading" | "done"

export interface WebDavSyncNowOptions {
  /** History row type. Defaults to "manual" (the settings-card button). */
  historyType?: BackupHistoryType
  /** Coarse phase callback for progress UI. */
  onProgress?: (phase: WebDavSyncPhase) => void
}

export async function runWebDavSyncNow(
  passphrase: string,
  opts: WebDavSyncNowOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const historyType = opts.historyType ?? "manual"
  const onProgress = opts.onProgress ?? (() => undefined)

  // Fall back to the cached session passphrase: an already-unlocked user can
  // sync without re-typing it (the settings card clears the input on unlock).
  const pass = passphrase || getSyncPassphrase() || ""
  if (!pass) return { ok: false, error: "A sync passphrase is required." }

  onProgress("building")
  const pkg = await buildBackupPackage({ includeSessions: true, includeApiKey: false })
  const plaintext = serializePackage(pkg)
  onProgress("encrypting")
  const body = await encryptSnapshotBody(plaintext, pkg, pass)
  const filename = webdavSnapshotName(pkg.manifest.exportedAt)

  onProgress("uploading")
  const result = await uploadSnapshotToWebDav(body, {
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
  })

  if (!result.ok) return { ok: false, error: result.error }

  setSyncPassphrase(pass)
  // Opt-in keyring persistence — the upload just proved the passphrase.
  await persistSyncPassphrase(pass)
  try {
    const settings = await getSettings()
    await saveSettings({
      webdavSync: { ...(settings.webdavSync ?? {}), lastSyncAt: new Date().toISOString() },
    })
  } catch {
    // Non-fatal — the upload itself succeeded.
  }
  onProgress("done")
  return { ok: true }
}
