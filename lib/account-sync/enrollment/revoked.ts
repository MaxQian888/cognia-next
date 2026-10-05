/**
 * Acting on being removed (protocol §5.5). A device deletes its keys only
 * when the VERIFIED list holds a validly signed revoke entry for its own id:
 * a bare `403 device_revoked` from the server proves nothing and deletes
 * nothing. It then keeps the pin and a record of when and by which device
 * it was removed. (Locking the profile and deleting synced secrets come with
 * phase 5.)
 */

import type { FoldedRegistry } from "@cognia/sync-protocol"

import type { DeviceKeys } from "../crypto"
import { verifyRegistry } from "../registry-sync"
import type { RemovalRecord } from "../vault-store"
import type { AccountSyncContext } from "./context"

/** The removal the verified list proves for `device`, or null. */
export function provenRemoval(
  registry: FoldedRegistry,
  device: Pick<DeviceKeys, "deviceId" | "signPub">
): RemovalRecord | null {
  const entry = registry.state.devices[device.deviceId]
  if (!entry || entry.status !== "revoked" || entry.signPub !== device.signPub) return null
  const revoke = registry.entries.find(
    (hashed) =>
      hashed.signed.entry.type === "revoke-device" && hashed.signed.entry.seq === entry.revokedSeq
  )
  if (
    !revoke ||
    revoke.signed.entry.type !== "revoke-device" ||
    revoke.signed.entry.deviceId !== device.deviceId
  ) {
    return null
  }
  return { at: revoke.signed.entry.at, seq: revoke.signed.entry.seq, by: entry.revokedBy! }
}

/** Forgets this device's keys if, and only if, the list proves it was removed. */
export async function applyRevocation(
  context: AccountSyncContext,
  registry: FoldedRegistry,
  device: DeviceKeys
): Promise<RemovalRecord | null> {
  const removal = provenRemoval(registry, device)
  if (removal) await context.vault.forgetDevice(removal)
  return removal
}

/** After a `403 device_revoked`: verify the list and act only on proof. */
export async function handleRevokedAnswer(
  context: AccountSyncContext,
  device: DeviceKeys
): Promise<RemovalRecord | null> {
  const registry = await verifyRegistry(context.api, context.vault)
  return registry ? applyRevocation(context, registry, device) : null
}
