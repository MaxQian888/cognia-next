/**
 * The admin lease a remote shell needs before it may read or write connector
 * credentials.
 *
 * ## Why a lease and not just a capability
 *
 * ADR-0152 put the four keyring arms on the device plane behind `host.admin`.
 * A capability check alone would have made the grant permanent and
 * device-wide; the lease is what supplies the two properties that make
 * "configure a bot from your phone" defensible — a time limit, and revocation
 * the moment the device disconnects (`admin_lease::revoke_device`). It is the
 * same mechanism `external_bridge_relay_enable` and the skills installer use,
 * so there is one consent story on the host rather than three.
 *
 * ## One lease, not one per call
 *
 * A Slack form reads five credentials and writes up to five more. Asking the
 * operator ten times would train them to approve without reading, so the lease
 * covers all four operations at once and is cached until it expires. That is
 * decision L12: one confirmation buys a bounded window, not a single call.
 *
 * ## Why a failure is sticky for a moment
 *
 * A denied or unreachable lease must not be retried on every render — a
 * dialog that re-mounts would otherwise queue a consent prompt per paint.
 * The failure is remembered for {@link DENIED_COOLDOWN_MS}; an explicit
 * operator retry calls {@link clearCredentialLease} and asks again
 * immediately, which is what the unlock affordance on a `stored` field does.
 */

import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import type { HostProfile } from "@/lib/platform/capabilities"
import {
  DEVICE_PLANE_CONNECTOR_COMMANDS,
  connectorCommandsNeedTransport,
  setConnectorDeviceLease,
} from "./device-plane"

/** Whether a device-plane credential call may proceed, and under what. */
export type CredentialLeaseState =
  /** This shell reaches the keyring locally; no lease exists or is needed. */
  | "not-required"
  /** A live lease is installed and will ride along with the next call. */
  | "held"
  /** The host declined, or could not be asked. The call will be refused. */
  | "unavailable"

/** Operations one credential lease covers. */
export const CREDENTIAL_LEASE_OPERATIONS: readonly string[] = DEVICE_PLANE_CONNECTOR_COMMANDS

/** Renew this far before expiry so a lease cannot lapse mid-form. */
const EXPIRY_SKEW_MS = 30_000

/** How long a refusal suppresses further consent prompts. */
export const DENIED_COOLDOWN_MS = 30_000

let expiresAt = 0
let deniedUntil = 0
let inFlight: Promise<CredentialLeaseState> | null = null

/**
 * True on the profiles whose keyring lives on a paired host.
 *
 * Deliberately the same predicate that decides whether a call is routed over
 * the device plane at all: "route it there" and "it needs a lease" must never
 * be able to disagree, or a call goes out that is guaranteed to be refused.
 */
export function credentialLeaseRequired(profile?: HostProfile): boolean {
  return connectorCommandsNeedTransport(profile)
}

/**
 * Make sure a lease is installed before a device-plane keyring call.
 *
 * Safe to call on every read and every save: it is a cache hit while the
 * current lease is live, and a no-op on hosts that do not need one.
 */
export async function ensureCredentialLease(): Promise<CredentialLeaseState> {
  if (!credentialLeaseRequired()) return "not-required"

  const now = Date.now()
  if (now < expiresAt - EXPIRY_SKEW_MS) return "held"
  if (now < deniedUntil) return "unavailable"
  if (inFlight) return inFlight

  inFlight = (async (): Promise<CredentialLeaseState> => {
    try {
      const lease = await issueHostAdminLease([...CREDENTIAL_LEASE_OPERATIONS])
      // A host that answers with an already-expired window is answering "no"
      // in a shape the cache would otherwise read as "yes, briefly".
      if (!lease?.token || lease.expiresAt <= Date.now()) {
        deniedUntil = Date.now() + DENIED_COOLDOWN_MS
        setConnectorDeviceLease(null)
        expiresAt = 0
        return "unavailable"
      }
      setConnectorDeviceLease(lease.token)
      expiresAt = lease.expiresAt
      deniedUntil = 0
      return "held"
    } catch {
      // Denied, unreachable, or not permitted on this device — all three mean
      // the same thing to a form, and the keyring call that follows produces
      // the message the operator actually sees.
      deniedUntil = Date.now() + DENIED_COOLDOWN_MS
      setConnectorDeviceLease(null)
      expiresAt = 0
      return "unavailable"
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

/**
 * Drop the cached lease and the refusal cooldown so the next
 * {@link ensureCredentialLease} asks the host again.
 *
 * Called by an explicit operator retry, and on sign-out/unpair paths that
 * invalidate the device's standing with the host.
 */
export function clearCredentialLease(): void {
  expiresAt = 0
  deniedUntil = 0
  inFlight = null
  setConnectorDeviceLease(null)
}

/** Test seam: reset module state without asserting on the transport. */
export function __resetCredentialLeaseForTests(): void {
  clearCredentialLease()
}
