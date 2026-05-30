// Manual "Sync now": build the full package, encrypt with the sync passphrase,
// upload to WebDAV, record history, and cache the passphrase for the session.
// Shared by the settings card and any future trigger.

import { buildBackupPackage, serializePackage } from "@/lib/data/build-package"
import {
  encryptSnapshotBody,
  uploadSnapshotToWebDav,
  webdavSnapshotName,
} from "@/lib/data/destinations/webdav"
import { appendBackupHistory } from "@/lib/db/backup-history"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { getSyncPassphrase, setSyncPassphrase } from "./passphrase-cache"

export async function runWebDavSyncNow(
  passphrase: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Fall back to the cached session passphrase: an already-unlocked user can
  // sync without re-typing it (the settings card clears the input on unlock).
  const pass = passphrase || getSyncPassphrase() || ""
  if (!pass) return { ok: false, error: "A sync passphrase is required." }

  const pkg = await buildBackupPackage({ includeSessions: true, includeApiKey: false })
  const plaintext = serializePackage(pkg)
  const body = await encryptSnapshotBody(plaintext, pkg, pass)
  const filename = webdavSnapshotName(pkg.manifest.exportedAt)

  const result = await uploadSnapshotToWebDav(body, {
    filename,
    exportedAt: pkg.manifest.exportedAt,
    sizeBytes: body.length,
  })

  await appendBackupHistory({
    completedAt: Date.now(),
    type: "manual",
    success: result.ok,
    encryption: "passphrase",
    sizeBytes: result.ok ? body.length : undefined,
    filename: result.ok ? filename : undefined,
    errorMessage: result.ok ? undefined : result.error,
  })

  if (!result.ok) return { ok: false, error: result.error }

  setSyncPassphrase(pass)
  try {
    const settings = await getSettings()
    await saveSettings({
      webdavSync: { ...(settings.webdavSync ?? {}), lastSyncAt: new Date().toISOString() },
    })
  } catch {
    // Non-fatal — the upload itself succeeded.
  }
  return { ok: true }
}
