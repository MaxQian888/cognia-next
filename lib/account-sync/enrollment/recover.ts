/**
 * Joining with the sync recovery key when no other device is at hand
 * (protocol §5.3).
 *
 * The typed key must derive exactly the recovery keys of the verified list.
 * The recovery envelope's key must match the list's commitment. Then one
 * atomic batch goes up: the `add-device` signed by the recovery key and by
 * this device, and this device's `epoch-rotate`, so the recovery envelope
 * the server held stops opening anything new.
 */

import {
  RECOVERY_SIGNER,
  expectedRecipients,
  fitDeviceName,
  parseRecoveryKey,
  pinFor,
  sealDeviceName,
  validateAppend,
  type FoldedRegistry,
  type RegistryEntry,
} from "@cognia/sync-protocol"

import {
  assertRecoveryKeysMatch,
  deriveRecoveryKeys,
  generateDeviceKeyMaterial,
  importDeviceKeys,
  nextEpoch,
  openEpochEnvelope,
  sealEpochEnvelopes,
  signRegistryEntry,
  verifiedKeyChain,
} from "../crypto"
import { verifyRegistry } from "../registry-sync"
import type { AccountSyncContext } from "./context"
import { EnrollmentError } from "./errors"
import type { DeviceIdentityInput } from "./first-device"
import { withSpaceLock } from "./lock"

export function recoverWithKey(
  context: AccountSyncContext,
  recoveryKeyText: string,
  input: DeviceIdentityInput
): Promise<FoldedRegistry> {
  const { spaceId } = context.session
  return withSpaceLock(spaceId, async () => {
    context.vault.assertAvailable()
    const recoveryKey = parseRecoveryKey(recoveryKeyText)
    const registry = await verifyRegistry(context.api, context.vault)
    if (!registry) throw new EnrollmentError("space-empty", "this account has no sync devices yet")
    const { state } = registry
    const recovery = await deriveRecoveryKeys(recoveryKey, spaceId)
    recoveryKey.fill(0)
    assertRecoveryKeysMatch(recovery, state.recovery)

    const currentKey = await openEpochEnvelope(await context.api.recoveryEnvelope(), recovery.enc, {
      spaceId,
      epoch: state.epoch,
      recipient: RECOVERY_SIGNER,
      recipientEncPub: state.recovery.encPub,
      keyCommit: state.keyCommits[state.epoch]!,
    })
    const chain = await verifiedKeyChain(state, currentKey)

    const material = await generateDeviceKeyMaterial()
    const device = await importDeviceKeys(material)
    const add: RegistryEntry = {
      v: 1,
      spaceId,
      seq: state.head.seq + 1,
      prev: state.head.hash,
      type: "add-device",
      at: context.now(),
      via: "recovery",
      device: {
        deviceId: device.deviceId,
        platform: input.platform,
        signPub: device.signPub,
        encPub: device.encPub,
        nameCt: await sealDeviceName(
          currentKey,
          spaceId,
          device.deviceId,
          state.epoch,
          fitDeviceName(input.name)
        ),
      },
    }
    const signedAdd = await signRegistryEntry(add, [
      { kind: "recovery", keys: recovery },
      { kind: "device", keys: device },
    ])
    const afterAdd = (await validateAppend(state, signedAdd, spaceId)).state
    const { block, key } = await nextEpoch(afterAdd, chain)
    const rotate: RegistryEntry = {
      v: 1,
      spaceId,
      seq: afterAdd.head.seq + 1,
      prev: afterAdd.head.hash,
      type: "epoch-rotate",
      at: context.now(),
      epoch: block,
    }
    const signedRotate = await signRegistryEntry(rotate, [{ kind: "device", keys: device }])
    const rotated = await validateAppend(afterAdd, signedRotate, spaceId)
    const envelopes = await sealEpochEnvelopes(
      spaceId,
      rotated.state.epoch,
      key,
      expectedRecipients(rotated.state)
    )

    await context.api.append(device, [signedAdd, signedRotate], envelopes)
    await context.vault.saveDeviceKeys(material)
    await context.vault.saveKeyChain(await verifiedKeyChain(rotated.state, key))
    await context.vault.advancePin(pinFor(rotated.state))
    const entries = await Promise.all(
      [signedAdd, signedRotate].map(async (signed, index) => ({
        signed,
        hash: index === 0 ? afterAdd.head.hash : rotated.state.head.hash,
      }))
    )
    return { state: rotated.state, entries: [...registry.entries, ...entries] }
  })
}
