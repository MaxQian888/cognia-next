// Subscription-vault WebDAV cloud sync (ADR-0025 follow-up, 2026-06-07).
//
// A pipeline PARALLEL to the data-backup WebDAV sync — same server connection
// (Settings → Data → WebDAV), same client/keyring primitives, but its own
// envelope (`cogniabak-subscription-v1`), its own passphrase, its own enable
// toggle (`webdavSync.subscriptionSyncEnabled`) and its own server filenames:
//
//   cognia-subscription-<iso>.cogniabak.json  — immutable, timestamped
//   latest-subscription.cogniabak.json        — overwritten each run; O(1)
//                                               restore target
//
// Auto-upload trigger: every vault-mutating transport call marks the vault
// dirty (`markSubscriptionVaultChanged`), which debounces into
// `maybeAutoUploadSubscription`. Boot + mobile resume also poke it so a
// missed debounce never strands changes locally.

import { getDeviceMetadata } from "@/lib/device/device-identity"
import { appendBackupHistory, type BackupHistoryType } from "@/lib/db/backup-history"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { loggers } from "@cognia/logging"
import {
  buildSubscriptionPackage,
  decryptSubscriptionPackage,
  encryptSubscriptionPackage,
  type SubscriptionEncryptedEnvelope,
  type SubscriptionPackageBody,
} from "@/lib/subscription/core/encrypted-package"
import { applyVaults, snapshotVaults } from "@/lib/subscription/core/vault-snapshot"
import { makeWebDavClient } from "@/lib/webdav/config"

import { getLastVaultChangeAtMs } from "./change-tracker"
import {
  getSubscriptionSyncPassphrase,
  hasSubscriptionSyncPassphrase,
  loadPersistedSubscriptionSyncPassphrase,
  persistSubscriptionSyncPassphrase,
  setSubscriptionSyncPassphrase,
} from "./passphrase-cache"

const log = loggers.export

export const SUBSCRIPTION_LATEST_POINTER = "latest-subscription.cogniabak.json"
const SUBSCRIPTION_SNAPSHOT_RE = /^cognia-subscription-.*\.cogniabak\.json$/
const DEFAULT_RETAIN = 5

/** Hard floor between unattended uploads (matches the data pipeline). */
export const MIN_SUBSCRIPTION_AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000

/** Server filename for a timestamped subscription snapshot. */
export function subscriptionSnapshotName(createdAtIso: string): string {
  const stamp = createdAtIso.replace(/[:.]/g, "-")
  return `cognia-subscription-${stamp}.cogniabak.json`
}

// ---------------------------------------------------------------------------
// Sync now
// ---------------------------------------------------------------------------

export type SubscriptionSyncPhase = "building" | "encrypting" | "uploading" | "done"

export interface SubscriptionSyncNowOptions {
  /** History row type. Defaults to "manual" (the settings-card button). */
  historyType?: BackupHistoryType
  /** Coarse phase callback for progress UI. */
  onProgress?: (phase: SubscriptionSyncPhase) => void
}

export type SubscriptionSyncResult = { ok: true } | { ok: false; error: string }

/**
 * Snapshot all vaults, encrypt under `passphrase` (falling back to the
 * session cache), upload the timestamped snapshot + latest pointer, prune,
 * record history, and stamp `webdavSync.subscriptionLastSyncAt`.
 */
export async function runSubscriptionSyncNow(
  passphrase: string,
  opts: SubscriptionSyncNowOptions = {}
): Promise<SubscriptionSyncResult> {
  const historyType = opts.historyType ?? "manual"
  const onProgress = opts.onProgress ?? (() => undefined)

  const pass = passphrase || getSubscriptionSyncPassphrase() || ""
  if (!pass) return { ok: false, error: "A sync passphrase is required." }

  // requireEnabled false: the subscription toggle is independent of the
  // data-backup toggle; only the connection fields gate here.
  const made = await makeWebDavClient({ requireEnabled: false })
  if (!made) return { ok: false, error: "WebDAV connection is not configured." }
  const { client, config } = made

  let ok = false
  let error: string | undefined
  let sizeBytes: number | undefined
  let filename: string | undefined
  let device: Awaited<ReturnType<typeof getDeviceMetadata>> = null
  try {
    onProgress("building")
    const vaults = await snapshotVaults()
    device = await getDeviceMetadata()
    const body = buildSubscriptionPackage(vaults, Date.now(), device ?? undefined)
    onProgress("encrypting")
    const envelope = await encryptSubscriptionPackage(body, pass)
    const json = JSON.stringify(envelope)
    filename = subscriptionSnapshotName(body.manifest.createdAtIso)

    onProgress("uploading")
    await client.ensureCollection(config.remoteDir)
    await client.putFile(`${config.remoteDir}/${filename}`, json)
    await client.putFile(`${config.remoteDir}/${SUBSCRIPTION_LATEST_POINTER}`, json)
    await pruneSubscriptionSnapshots(client, config.remoteDir)
    sizeBytes = json.length
    ok = true
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    log.error("subscription_webdav_upload_failed", undefined, { error })
  }

  await appendBackupHistory({
    completedAt: Date.now(),
    type: historyType,
    success: ok,
    encryption: "passphrase",
    payloadKind: "subscription",
    sizeBytes: ok ? sizeBytes : undefined,
    filename: ok ? filename : undefined,
    errorMessage: ok ? undefined : error,
    deviceId: device?.id,
    deviceLabel: device?.label,
  })

  if (!ok) return { ok: false, error: error ?? "upload failed" }

  setSubscriptionSyncPassphrase(pass)
  // Opt-in keyring persistence — the upload just proved the passphrase.
  await persistSubscriptionSyncPassphrase(pass)
  try {
    const settings = await getSettings()
    await saveSettings({
      webdavSync: {
        ...(settings.webdavSync ?? {}),
        subscriptionLastSyncAt: new Date().toISOString(),
      },
    })
  } catch {
    // Non-fatal — the upload itself succeeded.
  }
  onProgress("done")
  return { ok: true }
}

async function pruneSubscriptionSnapshots(
  client: NonNullable<Awaited<ReturnType<typeof makeWebDavClient>>>["client"],
  remoteDir: string
): Promise<void> {
  let retain = DEFAULT_RETAIN
  try {
    const settings = await getSettings()
    const n = settings.backupAutoSchedule?.retainCount
    if (typeof n === "number" && n > 0) retain = n
  } catch {
    // Keep the default.
  }
  try {
    const entries = await client.propfindList(remoteDir)
    const snapshots = entries
      .filter(
        (e) =>
          !e.isCollection &&
          e.name !== SUBSCRIPTION_LATEST_POINTER &&
          SUBSCRIPTION_SNAPSHOT_RE.test(e.name)
      )
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

// ---------------------------------------------------------------------------
// Unattended auto-upload
// ---------------------------------------------------------------------------

export type SubscriptionAutoUploadOutcome =
  | { ran: false; reason: "disabled" | "locked" | "fresh" }
  | { ran: true; ok: boolean; error?: string }

/**
 * Upload unattended when: the subscription toggle is on, a passphrase is
 * available (hydrating the opt-in keyring copy first), the minimum interval
 * elapsed, and either nothing was ever uploaded or the vault changed since
 * the last upload. Never throws.
 */
export async function maybeAutoUploadSubscription(
  nowMs: number = Date.now()
): Promise<SubscriptionAutoUploadOutcome> {
  try {
    const settings = await getSettings()
    const wd = settings.webdavSync
    if (wd?.subscriptionSyncEnabled !== true) return { ran: false, reason: "disabled" }

    if (!hasSubscriptionSyncPassphrase()) await loadPersistedSubscriptionSyncPassphrase()
    if (!hasSubscriptionSyncPassphrase()) return { ran: false, reason: "locked" }

    const parsed = wd.subscriptionLastSyncAt ? Date.parse(wd.subscriptionLastSyncAt) : NaN
    const lastSyncAtMs = Number.isNaN(parsed) ? null : parsed

    if (lastSyncAtMs !== null) {
      if (nowMs - lastSyncAtMs < MIN_SUBSCRIPTION_AUTO_SYNC_INTERVAL_MS) {
        return { ran: false, reason: "fresh" }
      }
      // Only re-upload when a mutation happened since the last upload. The
      // marker is in-memory: after a cold start we conservatively treat the
      // vault as clean (the next mutation re-marks it).
      const changedAt = getLastVaultChangeAtMs()
      if (changedAt === null || changedAt <= lastSyncAtMs) {
        return { ran: false, reason: "fresh" }
      }
    }

    const result = await runSubscriptionSyncNow(getSubscriptionSyncPassphrase() ?? "", {
      historyType: "auto",
    })
    return result.ok ? { ran: true, ok: true } : { ran: true, ok: false, error: result.error }
  } catch (err) {
    return { ran: true, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface SubscriptionRestorePreview {
  body: SubscriptionPackageBody
}

/**
 * Download + decrypt the latest subscription snapshot for PREVIEW — the
 * caller shows counts/provenance and only then commits via
 * {@link applySubscriptionRestore}. Throws on missing config/file or a wrong
 * passphrase (`SubscriptionPassphraseError` bubbles up for the UI to map).
 */
export async function restoreSubscriptionFromWebDav(
  passphrase: string
): Promise<SubscriptionRestorePreview> {
  if (!passphrase) throw new Error("A sync passphrase is required.")
  const made = await makeWebDavClient({ requireEnabled: false })
  if (!made) throw new Error("WebDAV connection is not configured.")
  const { client, config } = made
  const json = await client.getFile(`${config.remoteDir}/${SUBSCRIPTION_LATEST_POINTER}`)
  const envelope = JSON.parse(json) as SubscriptionEncryptedEnvelope
  const body = await decryptSubscriptionPackage(envelope, passphrase)
  // Decryption proved the passphrase — cache + optionally persist it.
  setSubscriptionSyncPassphrase(passphrase)
  await persistSubscriptionSyncPassphrase(passphrase)
  return { body }
}

/** Commit a previewed restore into the keyring. */
export async function applySubscriptionRestore(
  preview: SubscriptionRestorePreview
): Promise<{ accountCount: number }> {
  return applyVaults(preview.body.vaults)
}
