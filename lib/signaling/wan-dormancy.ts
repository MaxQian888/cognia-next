/**
 * When a paired device stops earning a permanent WAN signaling connection.
 *
 * ADR-0021 gives the desktop **one permanent WSS connection per paired
 * device**. `SignalingHub::sync_devices` spawns a client task per entry the
 * renderer pushes, each with its own 20s ping/pong keepalive. They cannot be
 * multiplexed, because the hosted Cloudflare deployment routes the upgrade by
 * `?rid=` to a per-room Durable Object and
 * `policy::rendezvous_id_matches_upgrade_room` refuses any frame whose room id
 * differs from the URL's, so the socket count is exactly the eligible-device
 * count.
 *
 * Nothing prunes `pairedDevices`. `addPairedDevice` merges by `deviceId`, so
 * re-pairing the same phone is free, but every *new* `deviceId` (a reinstall, a
 * dev pairing, a browser companion) adds a row that lives forever. A real user
 * log showed 16 concurrent sockets. Most of those rows belong to devices that
 * have not spoken in months.
 *
 * So a device idle past {@link WAN_DORMANCY_WINDOW_MS} is **dormant** and gets
 * no automatic connection. This is purely about whether a client task is
 * spawned. The `pairedDevices` row, its pairing credentials, its grants and its
 * keyring identity are all untouched, and the owner can wake it on demand from
 * the device console (see `lib/signaling/wan-wake-overrides.ts`).
 *
 * Pure leaf: types and arithmetic only, no Dexie, no transport, no clock. Both
 * the decision side (`lib/signaling/desktop-controller.ts`) and the display
 * side (`lib/devices/build-device-rows.ts`) import it, which is the only way
 * the console can state the same rule the hub is actually applying.
 */

import type { PairedDeviceRow } from "@/types/mobile/paired-device"

/**
 * How long a device may stay silent before it loses its automatic connection.
 *
 * 30 days. Long enough that a phone left in a drawer over a holiday still
 * reconnects by itself, short enough that a reinstalled or retired device stops
 * costing a socket within a billing month.
 */
export const WAN_DORMANCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** The subset of a paired-device row the dormancy rule reads. */
export type WanEvidenceRow = Pick<PairedDeviceRow, "lastSeenAt" | "pairedAt">

/** The subset of a paired-device row {@link isWanBlocked} reads. */
export type WanBlockRow = Pick<PairedDeviceRow, "revokedAt" | "pausedAt">

/**
 * Whether the host would refuse this device's requests, so a signaling socket
 * could not serve one even if it existed.
 *
 * Lives here, next to the dormancy rule, because both sides of the decision
 * have to agree on it: `selectSignalingDevices` uses it to decide whether to
 * spawn a client, and `buildDeviceWan` uses it to decide what the console says.
 * It reads the mirror row's own fields rather than the host-preferred
 * `DeviceAdminState` the console derives, which is what keeps the two from
 * diverging on a row whose mirror and host disagree (`adminStateConflict`).
 * The hub only ever sees these two fields, so the console has to answer from
 * them too.
 *
 * `!== undefined`, matching `mirrorAdminState`, `roster.ts`, `mobile.ts` and
 * `capability-preflight.ts`. A falsy check would read an epoch timestamp as
 * "not paused".
 */
export function isWanBlocked(row: WanBlockRow): boolean {
  return row.revokedAt !== undefined || row.pausedAt !== undefined
}

/**
 * The most recent moment this device gave any evidence of existing.
 *
 * `lastSeenAt` is the primary signal, stamped by the JWT verifier on every
 * authenticated request. `pairedAt` is folded in because a device that paired
 * five minutes ago and has not yet made a request would otherwise read as
 * infinitely idle and be denied the very connection the pairing flow is waiting
 * on. (`addPairedDevice` does seed `lastSeenAt` at pair time, so this is a belt
 * for a row written by an older build rather than a live path.)
 *
 * Returns `0` when neither timestamp is usable, which callers read as "no
 * evidence at all". That state is dormant by this rule, and deliberately so:
 * absence of evidence is not evidence of activity, and the manual wake is the
 * recovery path.
 */
export function lastWanEvidenceAt(row: WanEvidenceRow): number {
  const seen = Number.isFinite(row.lastSeenAt) ? row.lastSeenAt : 0
  const paired = Number.isFinite(row.pairedAt) ? row.pairedAt : 0
  return Math.max(seen, paired, 0)
}

/**
 * How long this device has been silent, at `now`.
 *
 * Clamped at zero so a timestamp from the future (a phone with a skewed clock,
 * or a row written across a DST-confused host) reads as "active right now"
 * rather than as a negative duration. Note that with no evidence at all this is
 * `now` itself, i.e. the full age of the epoch, so read it together with
 * {@link lastWanEvidenceAt} before rendering a duration to a human.
 */
export function wanIdleForMs(row: WanEvidenceRow, now: number): number {
  return Math.max(0, now - lastWanEvidenceAt(row))
}

/**
 * Whether this device has gone quiet long enough to lose its automatic WAN
 * signaling connection.
 *
 * `windowMs` is a parameter rather than a constant read so a test can pin the
 * boundary without simulating 30 days, and so a future per-device or
 * per-settings override has somewhere to go.
 */
export function isWanDormant(
  row: WanEvidenceRow,
  now: number,
  windowMs: number = WAN_DORMANCY_WINDOW_MS
): boolean {
  // A row with no usable timestamp at all is dormant whatever the clock says.
  // Deriving this from the arithmetic instead would make it depend on `now`
  // being far enough past the epoch, which is true in production and quietly
  // false anywhere a test pins a small clock.
  if (lastWanEvidenceAt(row) === 0) return true
  return wanIdleForMs(row, now) > windowMs
}
