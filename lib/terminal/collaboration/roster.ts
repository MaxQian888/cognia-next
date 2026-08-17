/**
 * Terminal session sharing — renderer-side roster projection (ADR-0133).
 *
 * Sharing a terminal is NOT a new transport. A paired device that holds the
 * `terminal.open` grant attaches to the durable host through the existing
 * LAN/WAN adapters and takes part in the host's controller lease exactly like
 * the desktop does. What the renderer needs is a faithful, pure projection of
 * two facts the host and the pairing store already own:
 *
 *   * `SessionInfo.participants` — the host's roster for one session (who is
 *     attached, and who holds the lease), refreshed by the host whenever it
 *     changes;
 *   * the paired-device list + its terminal grants — who *could* attach.
 *
 * Everything here is synchronous and side-effect free so the share dialog and
 * the session chip can render straight from it. This replaces the earlier
 * `share-manager` model (invite tokens in URLs, an `editor` role, a private
 * data-channel protocol) which nothing produced or consumed and which the host
 * could not enforce; the enforceable roles are the host's two lease roles.
 */

import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import type { SessionInfo, TerminalParticipant, TerminalParticipantRole } from "../types"

/** Client id the desktop app attaches with (`ClientIdentity::local`). */
export const DESKTOP_CLIENT_ID = "desktop"
/** Prefix the companion adapters put on a paired device's client id. */
export const COMPANION_CLIENT_PREFIX = "companion:"

/** The host's roster for one session, as the UI reads it. */
export interface SessionRoster {
  sessionId: string
  /**
   * `true` when the host reported a roster at all. A pre-roster host (or a
   * listing that predates the attach) leaves this `false`; the UI must then
   * fall back to `attachedClients` and say "unknown", not "just me".
   */
  known: boolean
  participants: readonly TerminalParticipant[]
  /** Host client id currently holding the lease; `null` when nobody does. */
  controllerId: string | null
  /** Attached clients that are NOT the local desktop. */
  remote: readonly TerminalParticipant[]
  /** `true` when at least one remote client is attached. */
  shared: boolean
  /** Total attached clients — roster length, or the host's count for a pre-roster host. */
  attachedCount: number
}

/** Extract the paired device id from a companion client id, or `null`. */
export function deviceIdOfClient(clientId: string): string | null {
  return clientId.startsWith(COMPANION_CLIENT_PREFIX)
    ? clientId.slice(COMPANION_CLIENT_PREFIX.length) || null
    : null
}

/** Project a session's info block onto the roster the UI renders. Pure. */
export function projectRoster(
  info: Pick<SessionInfo, "id" | "participants" | "currentController" | "attachedClients">
): SessionRoster {
  const participants = info.participants
  if (!Array.isArray(participants)) {
    return {
      sessionId: info.id,
      known: false,
      participants: [],
      controllerId: info.currentController ?? null,
      remote: [],
      shared: false,
      attachedCount: info.attachedClients ?? 0,
    }
  }
  const remote = participants.filter((p) => !p.local)
  const controller = participants.find((p) => p.role === "controller")
  return {
    sessionId: info.id,
    known: true,
    participants,
    // The roster is authoritative when present; `currentController` is the
    // same fact serialised twice and the two must agree.
    controllerId: controller?.clientId ?? info.currentController ?? null,
    remote,
    shared: remote.length > 0,
    attachedCount: participants.length,
  }
}

/** A paired device as the share dialog lists it. */
export interface ShareableDevice {
  deviceId: string
  label: string
  platform: PairedDeviceRow["platform"]
  /** Whether the host currently lets this device open terminals. */
  terminalGranted: boolean
  /** Revoked or paused rows cannot be shared with until un-revoked / resumed. */
  blocked: boolean
  /** The device is attached to THIS session right now. */
  attached: boolean
  /** Its lease role when attached; `null` otherwise. */
  role: TerminalParticipantRole | null
}

/**
 * Join the paired-device list with the host's grant snapshot and one session's
 * roster. `grants` is the host's authoritative per-device grant map (may be
 * `undefined` on shells that cannot ask the host, in which case the Dexie
 * mirror's `allowRemoteTerminal` is used — same fallback as the paired-devices
 * card). Pure; ordering is preserved from `devices`.
 */
export function mergeDevicesWithRoster(
  devices: readonly PairedDeviceRow[],
  grants: ReadonlyMap<string, { terminal: boolean }> | undefined,
  roster: Pick<SessionRoster, "participants">
): ShareableDevice[] {
  const byDevice = new Map<string, TerminalParticipant>()
  for (const participant of roster.participants) {
    const deviceId = participant.deviceId ?? deviceIdOfClient(participant.clientId)
    if (deviceId) byDevice.set(deviceId, participant)
  }
  return devices.map((row) => {
    const attached = byDevice.get(row.deviceId)
    const grant = grants?.get(row.deviceId)
    return {
      deviceId: row.deviceId,
      label: row.label,
      platform: row.platform,
      terminalGranted: grant ? grant.terminal : row.allowRemoteTerminal === true,
      blocked: row.revokedAt !== undefined || row.pausedAt !== undefined,
      attached: attached !== undefined,
      role: attached?.role ?? null,
    }
  })
}

/**
 * Human label for a participant: the paired device's label when known, the
 * caller-supplied `localLabel` for the desktop, and the raw client id as the
 * last resort (a device revoked since it attached, or an unfamiliar client).
 */
export function participantLabel(
  participant: Pick<TerminalParticipant, "clientId" | "deviceId" | "local">,
  devices: ReadonlyArray<Pick<PairedDeviceRow, "deviceId" | "label">>,
  localLabel: string
): string {
  if (participant.local || participant.clientId === DESKTOP_CLIENT_ID) return localLabel
  const deviceId = participant.deviceId ?? deviceIdOfClient(participant.clientId)
  if (deviceId) {
    const device = devices.find((row) => row.deviceId === deviceId)
    if (device) return device.label
    return deviceId
  }
  return participant.clientId
}
