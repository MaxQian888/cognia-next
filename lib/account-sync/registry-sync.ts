/**
 * Verifying the space from this device (protocol §4.1, §3.3).
 *
 * - `verifyRegistry` fetches the whole signed device list and folds it
 *   against this device's pin. A shorter or different list than the one this
 *   device last verified is an integrity failure: it deletes nothing and
 *   trusts nothing, and the pin stays where it was.
 * - `currentKeyChain` gets this device's epoch keys: from the vault when they
 *   already cover the current epoch, otherwise by opening this device's
 *   envelope, which counts only if the signed list commits to the key.
 */

import {
  RegistryError,
  foldRegistry,
  pinFor,
  type FoldedRegistry,
  type RegistryState,
} from "@cognia/sync-protocol"

import {
  matchesCurrentEpoch,
  openEpochEnvelope,
  verifiedKeyChain,
  type DeviceKeys,
  type EpochKeyChain,
} from "@/lib/account-sync/crypto"

import type { SyncApi } from "./sync-api"
import type { AccountSyncVault } from "./vault-store"

export class RegistryIntegrityError extends Error {
  constructor(
    readonly reason: RegistryError["code"],
    message: string
  ) {
    super(message)
    this.name = "RegistryIntegrityError"
  }
}

/** The verified list, or null for an empty space this device never pinned. */
export async function verifyRegistry(
  api: SyncApi,
  vault: AccountSyncVault
): Promise<FoldedRegistry | null> {
  const pin = await vault.loadPin()
  const elements = await api.registry()
  let folded: FoldedRegistry | null
  try {
    folded = await foldRegistry(elements, { spaceId: api.spaceId, pin })
  } catch (error) {
    if (error instanceof RegistryError) throw new RegistryIntegrityError(error.code, error.message)
    throw error
  }
  if (folded) await vault.advancePin(pinFor(folded.state))
  return folded
}

/** This device's verified key chain for the list's current epoch. */
export async function currentKeyChain(
  api: SyncApi,
  vault: AccountSyncVault,
  state: RegistryState,
  device: DeviceKeys
): Promise<EpochKeyChain> {
  const stored = await vault.loadKeyChain()
  if (stored && (await matchesCurrentEpoch(state, stored))) return stored
  const envelope = await api.selfEnvelope(device)
  const key = await openEpochEnvelope(envelope, device.enc, {
    spaceId: state.spaceId,
    epoch: state.epoch,
    recipient: device.deviceId,
    recipientEncPub: device.encPub,
    keyCommit: state.keyCommits[state.epoch]!,
  })
  const chain = await verifiedKeyChain(state, key)
  await vault.saveKeyChain(chain)
  return chain
}
