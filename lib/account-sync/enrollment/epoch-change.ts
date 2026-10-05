/**
 * Appending an entry that starts a new epoch (revoke, rotate, regenerate the
 * recovery key): a fresh key committed and chained to the current one, sealed
 * to every device that stays plus recovery. Built against the verified head,
 * checked with the same rules as the server, retried once if the head moved.
 */

import {
  expectedRecipients,
  pinFor,
  validateAppend,
  type EpochBlock,
  type RegistryEntry,
  type RegistryState,
} from "@cognia/sync-protocol"

import {
  nextEpoch,
  sealEpochEnvelopes,
  signRegistryEntry,
  verifiedKeyChain,
  type DeviceKeys,
  type EntrySigner,
} from "../crypto"
import { currentKeyChain, verifyRegistry } from "../registry-sync"
import { SyncApiError } from "../sync-api"
import type { AccountSyncContext } from "./context"
import { EnrollmentError } from "./errors"
import { withSpaceLock } from "./lock"

export interface EntryBase {
  v: 1
  spaceId: string
  seq: number
  prev: string
  at: number
}

export type EpochEntryBuilder = (
  base: EntryBase,
  block: EpochBlock,
  state: RegistryState
) => RegistryEntry

export function appendEpochChange(
  context: AccountSyncContext,
  device: DeviceKeys,
  build: EpochEntryBuilder,
  extraSigners: readonly EntrySigner[] = []
): Promise<RegistryState> {
  const { spaceId } = context.session
  return withSpaceLock(spaceId, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const registry = await verifyRegistry(context.api, context.vault)
      if (!registry || registry.state.devices[device.deviceId]?.status !== "active") {
        throw new EnrollmentError(
          "not-enrolled",
          "this device is not an active device of this account"
        )
      }
      const { state } = registry
      const chain = await currentKeyChain(context.api, context.vault, state, device)
      const { block, key } = await nextEpoch(state, chain)
      const entry = build(
        { v: 1, spaceId, seq: state.head.seq + 1, prev: state.head.hash, at: context.now() },
        block,
        state
      )
      const signed = await signRegistryEntry(entry, [
        { kind: "device", keys: device },
        ...extraSigners,
      ])
      const { state: next } = await validateAppend(state, signed, spaceId)
      const envelopes = await sealEpochEnvelopes(spaceId, next.epoch, key, expectedRecipients(next))
      try {
        await context.api.append(device, [signed], envelopes)
      } catch (error) {
        if (error instanceof SyncApiError && error.code === "head_moved") continue
        throw error
      }
      await context.vault.saveKeyChain(await verifiedKeyChain(next, key))
      await context.vault.advancePin(pinFor(next))
      return next
    }
    throw new EnrollmentError("busy", "the device list kept changing; try again")
  })
}
