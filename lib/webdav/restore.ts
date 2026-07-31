// Download + apply a snapshot from the WebDAV server. Reuses the exact import
// pipeline the file picker uses (`decryptBackupPackage` → `migrateEnvelope` →
// `applyBackupPackage`). Restore is always user-initiated and confirmed.

import { decryptBackupPackage } from "@/lib/data/crypto"
import { migrateEnvelope, isEncryptedEnvelope } from "@/lib/data/migrate"
import { applyBackupPackage } from "@/lib/data/apply-package"
import type { BackupManifestV3, ImportMergeStrategy, ImportSummary } from "@/lib/data/types"
import { makeWebDavClient } from "./config"
import { persistSyncPassphrase, setSyncPassphrase } from "./passphrase-cache"

const LATEST_POINTER = "latest.enc.cbk"
const SNAPSHOT_RE = /^cognia-backup-.*\.enc\.cbk$/

export interface RemoteSnapshot {
  name: string
  /** Full path including the collection prefix — pass to `restoreFromWebDav`. */
  path: string
  lastModified?: number
  size?: number
  isLatestPointer: boolean
}

/** List the backup snapshots present on the server, newest first. */
export async function listRemoteSnapshots(): Promise<RemoteSnapshot[]> {
  const made = await makeWebDavClient()
  if (!made) return []
  const { client, config } = made
  const entries = await client.propfindList(config.remoteDir)
  return entries
    .filter((e) => !e.isCollection && (e.name === LATEST_POINTER || SNAPSHOT_RE.test(e.name)))
    .map((e) => ({
      name: e.name,
      path: `${config.remoteDir}/${e.name}`,
      lastModified: e.lastModified,
      size: e.size,
      isLatestPointer: e.name === LATEST_POINTER,
    }))
    .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
}

export interface RestoreOptions {
  /** Defaults to the `latest.enc.cbk` pointer. */
  path?: string
  passphrase: string
  mergeStrategy: ImportMergeStrategy
  includeSessions?: boolean
  includeApiKey?: boolean
}

export interface RestoreFromWebDavResult {
  summary: ImportSummary
  /**
   * Producing-device provenance from the envelope manifest (cleartext, so
   * available even for pre-decryption display). Absent on pre-2026-06 files.
   */
  sourceDevice?: BackupManifestV3["device"]
}

/**
 * Fetch, decrypt, migrate, and apply a remote snapshot. Throws on a wrong
 * passphrase (WebCrypto `OperationError`) or a tampered file
 * (`IntegrityCheckFailedError`) — callers surface those to the user.
 */
export async function restoreFromWebDav(opts: RestoreOptions): Promise<RestoreFromWebDavResult> {
  const made = await makeWebDavClient()
  if (!made) throw new Error("WebDAV sync is not configured.")
  const { client, config } = made

  const path = opts.path ?? `${config.remoteDir}/${LATEST_POINTER}`
  const raw = await client.getFile(path)

  const parsed = JSON.parse(raw)
  if (!isEncryptedEnvelope(parsed)) {
    throw new Error("Remote snapshot is not an encrypted backup.")
  }
  const plaintext = await decryptBackupPackage(parsed, opts.passphrase)
  const pkg = await migrateEnvelope(JSON.parse(plaintext))

  const summary = await applyBackupPackage(pkg, {
    mergeStrategy: opts.mergeStrategy,
    includeSessions: opts.includeSessions ?? true,
    includeApiKey: opts.includeApiKey ?? false,
  })

  // The passphrase just proved itself — cache it so auto-uploads can fire this
  // session without a second prompt; persist to the keyring when opted in.
  setSyncPassphrase(opts.passphrase)
  await persistSyncPassphrase(opts.passphrase)
  const envelopeDevice = (parsed as { manifest?: { device?: BackupManifestV3["device"] } }).manifest
    ?.device
  return { summary, sourceDevice: envelopeDevice ?? pkg.manifest.device }
}
