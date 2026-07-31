// Upload an encrypted backup snapshot to a WebDAV server.
//
// Layout on the server (under the configured collection):
//   cognia-backup-<iso>.enc.cbk   — immutable, timestamped history
//   latest.enc.cbk                — overwritten each run; O(1) restore + the
//                                   target the startup "remote is newer" check
//                                   PROPFINDs.
//
// Retention prunes the timestamped copies down to the user's `retainCount`
// (shared with the local auto-backup schedule); `latest.enc.cbk` is never
// pruned.

import { getSettings } from "@/lib/db/settings"
import { makeWebDavClient } from "@/lib/webdav/config"
import { encryptBackupPackage } from "@/lib/data/crypto"
import { loggers } from "@cognia/logging"
import type { BackupPackageV3 } from "@/lib/data/types"

const log = loggers.export
const LATEST_POINTER = "latest.enc.cbk"
const SNAPSHOT_RE = /^cognia-backup-.*\.enc\.cbk$/
const DEFAULT_RETAIN = 5

export interface SnapshotMeta {
  /** Local filename hint (unused on the server, kept for history rows). */
  filename: string
  /** ISO timestamp from the package manifest — drives the server filename. */
  exportedAt: string
  sizeBytes: number
}

export type WebDavUploadResult = { ok: true; remotePath: string } | { ok: false; error: string }

/** Server filename for a timestamped snapshot, derived from the manifest time. */
export function webdavSnapshotName(exportedAt: string): string {
  // `2026-05-30T12:30:00.000Z` → `cognia-backup-2026-05-30T12-30-00-000Z.enc.cbk`
  const stamp = exportedAt.replace(/[:.]/g, "-")
  return `cognia-backup-${stamp}.enc.cbk`
}

/**
 * Encrypt a serialized package under `passphrase` and return the JSON envelope
 * body ready to write/upload. Single source of truth for the encrypted-envelope
 * manifest shape — shared by every snapshot writer (the cron executor, the
 * interval scheduler, and manual "Sync now") so the envelope format can't drift
 * across paths.
 */
export async function encryptSnapshotBody(
  plaintext: string,
  pkg: BackupPackageV3,
  passphrase: string
): Promise<string> {
  const env = await encryptBackupPackage(plaintext, passphrase, {
    version: pkg.manifest.version,
    schemaVersion: pkg.manifest.schemaVersion,
    traceId: pkg.manifest.traceId,
    exportedAt: pkg.manifest.exportedAt,
    appVersion: pkg.manifest.appVersion,
    backend: pkg.manifest.backend,
    encryption: { enabled: true, format: "encrypted-envelope-v1" },
    // Optional device provenance (generic label, never the raw user agent) —
    // rides cleartext in the envelope so the restore dialog can show it
    // without decrypting.
    ...(pkg.manifest.device ? { device: pkg.manifest.device } : {}),
  })
  return JSON.stringify(env)
}

async function resolveRetainCount(): Promise<number> {
  try {
    const settings = await getSettings()
    const n = settings.backupAutoSchedule?.retainCount
    return typeof n === "number" && n > 0 ? n : DEFAULT_RETAIN
  } catch {
    return DEFAULT_RETAIN
  }
}

export async function uploadSnapshotToWebDav(
  envelopeJson: string,
  meta: SnapshotMeta
): Promise<WebDavUploadResult> {
  const made = await makeWebDavClient()
  if (!made) return { ok: false, error: "WebDAV sync is not configured." }
  const { client, config } = made

  try {
    await client.ensureCollection(config.remoteDir)

    const snapshotName = webdavSnapshotName(meta.exportedAt)
    const snapshotPath = `${config.remoteDir}/${snapshotName}`
    await client.putFile(snapshotPath, envelopeJson)
    await client.putFile(`${config.remoteDir}/${LATEST_POINTER}`, envelopeJson)

    await pruneSnapshots(client, config.remoteDir)

    return { ok: true, remotePath: snapshotPath }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.error("webdav_upload_failed", undefined, { error })
    return { ok: false, error }
  }
}

async function pruneSnapshots(
  client: NonNullable<Awaited<ReturnType<typeof makeWebDavClient>>>["client"],
  remoteDir: string
): Promise<void> {
  const retain = await resolveRetainCount()
  try {
    const entries = await client.propfindList(remoteDir)
    const snapshots = entries
      .filter((e) => !e.isCollection && e.name !== LATEST_POINTER && SNAPSHOT_RE.test(e.name))
      // Newest first: prefer mtime, fall back to the lexicographic name (the
      // ISO stamp sorts chronologically).
      .sort((a, b) => {
        const am = a.lastModified ?? 0
        const bm = b.lastModified ?? 0
        if (am !== bm) return bm - am
        return a.name < b.name ? 1 : -1
      })

    for (const stale of snapshots.slice(retain)) {
      try {
        await client.deleteFile(`${remoteDir}/${stale.name}`)
      } catch {
        // Best-effort; a failed prune doesn't fail the upload.
      }
    }
  } catch {
    // Listing failed — non-fatal, the snapshot is already uploaded.
  }
}
