/**
 * Where this device stands in its person's space, as one value the UI
 * switches on (ADR-0215 phase 2).
 *
 * - `locked`: the profile's secret store is locked; nothing can be read.
 * - `not-enrolled`: this device holds no keys. `space` says whether the
 *   person has a space yet (first device) or not (join or recover).
 * - `enrolled`: this device is an active device of the verified list.
 * - `removed`: another device revoked this one; its keys are gone.
 * - `integrity`: the server showed a list this device cannot accept (older
 *   than, or different from, what it verified before). Nothing was deleted.
 */

import type { FoldedRegistry, RegistryState } from "@cognia/sync-protocol"

import type { DeviceKeys } from "../crypto"
import { RegistryIntegrityError, verifyRegistry } from "../registry-sync"
import { AccountSyncVaultLockedError, type RemovalRecord } from "../vault-store"
import type { AccountSyncContext } from "./context"
import { applyRevocation } from "./revoked"

export type EnrollmentStatus =
  | { kind: "locked" }
  | { kind: "not-enrolled"; space: "empty" | "ready"; registry: FoldedRegistry | null }
  | { kind: "enrolled"; device: DeviceKeys; registry: FoldedRegistry }
  | { kind: "removed"; removal: RemovalRecord }
  | { kind: "integrity"; reason: string }

export async function readEnrollmentStatus(context: AccountSyncContext): Promise<EnrollmentStatus> {
  try {
    const removal = await context.vault.loadRemoval()
    const device = await context.vault.loadDeviceKeys()
    const registry = await verifyRegistry(context.api, context.vault)
    if (!device) {
      if (removal) return { kind: "removed", removal }
      return { kind: "not-enrolled", space: registry ? "ready" : "empty", registry }
    }
    const entry = registry?.state.devices[device.deviceId]
    if (!registry || !entry || entry.signPub !== device.signPub) {
      // Keys for a space that does not list them: a genesis that never landed,
      // or a purged space. They cannot sign anything here.
      return { kind: "not-enrolled", space: registry ? "ready" : "empty", registry }
    }
    if (entry.status === "revoked") {
      const proven = await applyRevocation(context, registry, device)
      // A revoked status always comes from a signed revoke entry in the fold.
      return proven ? { kind: "removed", removal: proven } : { kind: "integrity", reason: "rule" }
    }
    return { kind: "enrolled", device, registry }
  } catch (error) {
    if (error instanceof AccountSyncVaultLockedError) return { kind: "locked" }
    if (error instanceof RegistryIntegrityError) return { kind: "integrity", reason: error.reason }
    throw error
  }
}

/** Whether `deviceId` is still active in `state`. */
export function isActiveDevice(state: RegistryState, deviceId: string): boolean {
  return state.devices[deviceId]?.status === "active"
}
