/**
 * The first device of a space (protocol §5.1).
 *
 * `prepareFirstDevice` makes everything locally: device keys, the sync
 * recovery key, epoch 1, the genesis entry signed by both, and the two
 * envelopes. Nothing leaves the device until the person has passed the
 * recovery-key confirmation; then `commitFirstDevice` uploads it.
 * Only once the server confirms does the device store its keys.
 */

import {
  canonicalJsonBytes,
  expectedRecipients,
  fitDeviceName,
  formatRecoveryKey,
  pinFor,
  sealDeviceName,
  toBase64Url,
  validateAppend,
  type DevicePlatform,
  type EpochEnvelope,
  type FoldedRegistry,
  type RegistryState,
  type SignedEntry,
} from "@cognia/sync-protocol"

import {
  deriveRecoveryKeys,
  firstEpoch,
  generateDeviceKeyMaterial,
  importDeviceKeys,
  newRecoveryKey,
  sealEpochEnvelopes,
  signRegistryEntry,
  type DeviceKeyMaterial,
} from "../crypto"
import { SyncApiError } from "../sync-api"
import type { AccountSyncContext } from "./context"
import { withSpaceLock } from "./lock"

export interface PreparedFirstDevice {
  /** Shown to the person once, never uploaded. */
  recoveryKey: Uint8Array
  /** `XXXX-XXXX-…-XX`. */
  recoveryKeyText: string
  material: DeviceKeyMaterial
  signed: SignedEntry
  envelopes: EpochEnvelope[]
  epochKey: Uint8Array
  state: RegistryState
}

export interface DeviceIdentityInput {
  name: string
  platform: DevicePlatform
}

export async function prepareFirstDevice(
  context: AccountSyncContext,
  input: DeviceIdentityInput
): Promise<PreparedFirstDevice> {
  context.vault.assertAvailable()
  const { spaceId } = context.session
  const material = await generateDeviceKeyMaterial()
  const device = await importDeviceKeys(material)
  const recoveryKey = newRecoveryKey()
  const recovery = await deriveRecoveryKeys(recoveryKey, spaceId)
  const epoch = await firstEpoch(spaceId)
  const signed = await signRegistryEntry(
    {
      v: 1,
      spaceId,
      seq: 0,
      prev: null,
      type: "genesis",
      at: context.now(),
      device: {
        deviceId: device.deviceId,
        platform: input.platform,
        signPub: device.signPub,
        encPub: device.encPub,
        nameCt: await sealDeviceName(
          epoch.key,
          spaceId,
          device.deviceId,
          1,
          fitDeviceName(input.name)
        ),
      },
      recovery: { signPub: recovery.signPub, encPub: recovery.encPub },
      epoch: epoch.block,
    },
    [
      { kind: "device", keys: device },
      { kind: "recovery", keys: recovery },
    ]
  )
  // The same rules the server applies; a bug here never reaches it.
  const { state } = await validateAppend(null, signed, spaceId)
  return {
    recoveryKey,
    recoveryKeyText: formatRecoveryKey(recoveryKey),
    material,
    signed,
    envelopes: await sealEpochEnvelopes(spaceId, 1, epoch.key, expectedRecipients(state)),
    epochKey: epoch.key,
    state,
  }
}

export type FirstDeviceResult =
  { kind: "created"; registry: FoldedRegistry } | { kind: "space-exists" }

/** Did our genesis land although its answer was lost? */
async function genesisLanded(
  context: AccountSyncContext,
  prepared: PreparedFirstDevice
): Promise<boolean> {
  try {
    const [first] = await context.api.registry()
    const canonical = (value: unknown) => toBase64Url(canonicalJsonBytes(value))
    return first !== undefined && canonical(first) === canonical(prepared.signed)
  } catch {
    return false
  }
}

export function commitFirstDevice(
  context: AccountSyncContext,
  prepared: PreparedFirstDevice
): Promise<FirstDeviceResult> {
  return withSpaceLock(context.session.spaceId, async () => {
    context.vault.assertAvailable()
    try {
      await context.api.genesis(prepared.signed, prepared.envelopes)
    } catch (error) {
      if (error instanceof SyncApiError && error.code === "space_exists") {
        if (!(await genesisLanded(context, prepared))) return { kind: "space-exists" as const }
      } else if (!(
        error instanceof SyncApiError &&
        error.code === "network" &&
        (await genesisLanded(context, prepared))
      )) {
        throw error
      }
    }
    await context.vault.saveDeviceKeys(prepared.material)
    await context.vault.saveKeyChain(new Map([[1, prepared.epochKey]]))
    await context.vault.advancePin(pinFor(prepared.state))
    prepared.recoveryKey.fill(0)
    return {
      kind: "created" as const,
      registry: {
        state: prepared.state,
        entries: [{ signed: prepared.signed, hash: prepared.state.genesisHash }],
      },
    }
  })
}
