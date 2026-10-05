/**
 * The display names in the verified device list (protocol §4): each is
 * sealed under the epoch key of the epoch the device joined in, which an
 * enrolled device holds through its verified key chain. A name that does not
 * open is reported as null, never guessed.
 */

import { openDeviceName, type RegistryState } from "@cognia/sync-protocol"

import type { EpochKeyChain } from "./crypto"

export async function deviceNames(
  state: RegistryState,
  chain: EpochKeyChain
): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>()
  await Promise.all(
    Object.values(state.devices).map(async (device) => {
      const key = chain.get(device.nameCt.epoch)
      try {
        names.set(
          device.deviceId,
          key ? await openDeviceName(key, state.spaceId, device.deviceId, device.nameCt) : null
        )
      } catch {
        names.set(device.deviceId, null)
      }
    })
  )
  return names
}
