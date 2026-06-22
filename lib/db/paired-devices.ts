/**
 * CRUD helpers for the `pairedDevices` Dexie table (schema v23).
 *
 * The pair endpoint (M2.3) calls `addPairedDevice` after a successful pair
 * JWT exchange. The verifier middleware (M2.4) calls `touchPairedDevice` on
 * every authenticated request to keep `lastSeenAt` fresh. The owner-facing
 * settings UI (M2.8) calls `listPairedDevices` to render the table and
 * `revokePairedDevice` to soft-delete a device.
 */

import type { DevicePlatform, PairedDeviceRow } from "@/types/mobile/paired-device"
import { getDb } from "./schema"

export interface AddPairedDeviceInput {
  deviceId: string
  accountId?: string
  label: string
  platform: DevicePlatform
  pubkey: string
  appVersion: string
  /**
   * SHA-256 fingerprint of the server's TLS SubjectPublicKeyInfo at pair
   * time. Optional — rows paired before Wave 1.4 lacked TLS so the field
   * stays absent.
   */
  serverFingerprint?: string
  /**
   * ADR-0021 — public room id used by the WebRTC signaling service. UUIDv4
   * minted by the desktop pair handler. Absent for rows paired before
   * WebRTC support landed.
   */
  rendezvousId?: string
  /**
   * ADR-0021 — 32-byte HMAC key (URL-safe base64, unpadded) shared with the
   * paired device, used to authenticate signaling envelopes. Absent for
   * legacy rows.
   */
  rendezvousSecret?: string
  /** Defaults to `Date.now()` — pass an explicit value in tests. */
  nowMs?: number
}

export async function addPairedDevice(input: AddPairedDeviceInput): Promise<void> {
  const now = input.nowMs ?? Date.now()
  const row: PairedDeviceRow = {
    deviceId: input.deviceId,
    label: input.label,
    platform: input.platform,
    pubkey: input.pubkey,
    appVersion: input.appVersion,
    pairedAt: now,
    lastSeenAt: now,
  }
  if (input.accountId) {
    row.accountId = input.accountId
  }
  if (input.serverFingerprint) {
    row.serverFingerprint = input.serverFingerprint
  }
  if (input.rendezvousId) {
    row.rendezvousId = input.rendezvousId
  }
  if (input.rendezvousSecret) {
    row.rendezvousSecret = input.rendezvousSecret
  }
  await getDb().pairedDevices.put(row)
}

/**
 * Update the stored TLS fingerprint for a device. Used when the desktop
 * server rotates its self-signed cert and the user re-pairs to refresh the
 * pin without losing other state (push token, etc.).
 */
export async function setServerFingerprint(
  deviceId: string,
  fingerprint: string
): Promise<boolean> {
  const updated = await getDb().pairedDevices.update(deviceId, {
    serverFingerprint: fingerprint,
  })
  return updated > 0
}

/**
 * Soft-delete the device by stamping `revokedAt`. The JWT verifier deny-list
 * cache (M2.4) reads from rows where `revokedAt` is set; the row stays so
 * the owner can audit revocations.
 *
 * @returns true if a row was found and updated; false if the deviceId is unknown.
 */
export async function revokePairedDevice(
  deviceId: string,
  nowMs: number = Date.now()
): Promise<boolean> {
  const updated = await getDb().pairedDevices.update(deviceId, { revokedAt: nowMs })
  return updated > 0
}

/**
 * Temporarily block a paired device. Sets `pausedAt`; the Rust deny-list
 * mirror (driven from `companion_revoke_device` by the caller) is what
 * actually refuses the device's JWT — this Dexie write only records the
 * pause-vs-revoke distinction so the Settings UI can render the right
 * Resume action.
 *
 * @returns true if a row was found and updated; false if the deviceId is unknown.
 */
export async function pausePairedDevice(
  deviceId: string,
  nowMs: number = Date.now()
): Promise<boolean> {
  const updated = await getDb().pairedDevices.update(deviceId, { pausedAt: nowMs })
  return updated > 0
}

/**
 * Clear a previously-set `pausedAt`. Pairs with the Rust `companion_unrevoke_device`
 * call by the caller; together they return the device to the active set.
 *
 * @returns true if a row was found and updated; false if the deviceId is unknown.
 */
export async function resumePairedDevice(deviceId: string): Promise<boolean> {
  // Dexie's `update` cannot set a column to `undefined` (silently ignored),
  // so use `modify` to delete the property when we want it gone — that's
  // what other consumers reading `row.pausedAt === undefined` will see.
  let cleared = 0
  await getDb()
    .pairedDevices.where("deviceId")
    .equals(deviceId)
    .modify((row) => {
      delete (row as Partial<PairedDeviceRow>).pausedAt
      cleared++
    })
  return cleared > 0
}

/**
 * Update `lastSeenAt` for the device. Best-effort: failures (missing row,
 * Dexie closed during shutdown) are swallowed so they don't block the
 * authenticated request.
 */
export async function touchPairedDevice(
  deviceId: string,
  nowMs: number = Date.now()
): Promise<void> {
  try {
    await getDb().pairedDevices.update(deviceId, { lastSeenAt: nowMs })
  } catch {
    // Best-effort — see jsdoc.
  }
}

/**
 * Return all paired devices, newest-first by `lastSeenAt`. Includes revoked
 * rows so the settings UI can show "Revoked 3d ago" tombstones.
 */
export async function listPairedDevices(): Promise<PairedDeviceRow[]> {
  return getDb().pairedDevices.orderBy("lastSeenAt").reverse().toArray()
}

/**
 * Return a single paired device row, or `undefined` if not found. Used by
 * the JWT verifier to look up `pubkey` and check `revokedAt`.
 */
export async function getPairedDevice(deviceId: string): Promise<PairedDeviceRow | undefined> {
  return getDb().pairedDevices.get(deviceId)
}

/**
 * Set / clear the APNs/FCM push token for a device. Called when the phone
 * registers (or de-registers) after pairing. M4.6 wires the phone-side
 * registration flow.
 */
export async function setPushToken(
  deviceId: string,
  pushToken: string | undefined
): Promise<boolean> {
  const updated = await getDb().pairedDevices.update(deviceId, { pushToken })
  return updated > 0
}

/**
 * Grant or revoke the Remote Session Control capability for a device. When
 * `true`, the device may issue control RPCs (drive / steer / approve live
 * agent sessions); when `false` it is limited to read-only sync + observe.
 *
 * Pairs with the Rust `companion_set_remote_control` command (called by the
 * caller — the paired-devices card — behind the biometric guard) which
 * mirrors the bit into the `ControlAllowList` the per-command gate in
 * `rpc.rs` consults. This Dexie write is the persisted source of truth that
 * re-seeds the Rust mirror on the next desktop boot.
 *
 * Stored as an explicit boolean (never deleted) so a disabled device reads
 * back `false` rather than `undefined` — the gate treats both as "deny", but
 * an explicit `false` records that the owner made a deliberate choice.
 *
 * @returns true if a row was found and updated; false if the deviceId is unknown.
 */
export async function setRemoteControlAllowed(
  deviceId: string,
  allowed: boolean
): Promise<boolean> {
  const updated = await getDb().pairedDevices.update(deviceId, {
    allowRemoteControl: allowed,
  })
  return updated > 0
}
