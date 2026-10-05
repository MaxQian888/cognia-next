/**
 * What an enrolled device can change (protocol §5.5): remove another device,
 * rotate the keys, and replace the sync recovery key. Each starts a new
 * epoch the removed device (or old recovery key) never receives.
 */

import { formatRecoveryKey, type RegistryState } from "@cognia/sync-protocol"

import {
  deriveRecoveryKeys,
  newRecoveryKey,
  type DeviceKeys,
  type RecoveryKeyPairs,
} from "../crypto"
import type { AccountSyncContext } from "./context"
import { appendEpochChange } from "./epoch-change"

export function revokeDevice(
  context: AccountSyncContext,
  device: DeviceKeys,
  targetDeviceId: string
): Promise<RegistryState> {
  return appendEpochChange(context, device, (base, block) => ({
    ...base,
    type: "revoke-device",
    deviceId: targetDeviceId,
    epoch: block,
  }))
}

export function rotateKeys(
  context: AccountSyncContext,
  device: DeviceKeys
): Promise<RegistryState> {
  return appendEpochChange(context, device, (base, block) => ({
    ...base,
    type: "epoch-rotate",
    epoch: block,
  }))
}

export interface PreparedRecoveryKey {
  recoveryKey: Uint8Array
  recoveryKeyText: string
  keys: RecoveryKeyPairs
}

/** A new recovery key, held locally until the person confirmed they stored it. */
export async function prepareRecoveryKey(
  context: AccountSyncContext
): Promise<PreparedRecoveryKey> {
  const recoveryKey = newRecoveryKey()
  return {
    recoveryKey,
    recoveryKeyText: formatRecoveryKey(recoveryKey),
    keys: await deriveRecoveryKeys(recoveryKey, context.session.spaceId),
  }
}

/** Installs the new recovery key; the old one stops working from the new epoch on. */
export async function commitRecoveryKey(
  context: AccountSyncContext,
  device: DeviceKeys,
  prepared: PreparedRecoveryKey
): Promise<RegistryState> {
  const state = await appendEpochChange(
    context,
    device,
    (base, block) => ({
      ...base,
      type: "recovery-rotate",
      recovery: { signPub: prepared.keys.signPub, encPub: prepared.keys.encPub },
      epoch: block,
    }),
    [{ kind: "recovery", keys: prepared.keys }]
  )
  prepared.recoveryKey.fill(0)
  return state
}
