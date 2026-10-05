/**
 * `foldRegistry` (protocol §4.1): verifies a whole chain and derives its
 * state. Every public key a client seals to or trusts must come out of this,
 * never from another server response.
 */

import { RegistryError } from "../errors"
import type { RegistryPin } from "./pin"
import type { HashedEntry, RegistryState } from "./types"
import { validateAppend } from "./validate-append"

export interface FoldedRegistry {
  state: RegistryState
  entries: HashedEntry[]
}

export interface FoldOptions {
  spaceId: string
  /** The device's pin; absent for a device that has not verified this space before. */
  pin?: RegistryPin | null
}

export async function foldRegistry(
  elements: readonly unknown[],
  options: FoldOptions
): Promise<FoldedRegistry | null> {
  const { spaceId, pin } = options
  if (elements.length === 0) {
    if (pin) throw new RegistryError("rollback", "the server returned an empty device list")
    return null
  }
  let state: RegistryState | null = null
  const entries: HashedEntry[] = []
  for (const element of elements) {
    const result: Awaited<ReturnType<typeof validateAppend>> = await validateAppend(
      state,
      element,
      spaceId
    )
    state = result.state
    entries.push({ signed: result.signed, hash: result.hash })
  }
  const folded = state!
  if (folded.pendingRecoveryRotate !== null) {
    throw new RegistryError("incomplete_batch", "the chain ends inside a recovery batch")
  }
  if (pin) {
    if (folded.genesisHash !== pin.genesisHash) {
      throw new RegistryError("fork", "the device list starts from a different genesis")
    }
    if (entries.length <= pin.seq) {
      throw new RegistryError("rollback", "the server returned an older device list")
    }
    if (entries[pin.seq]!.hash !== pin.hash) {
      throw new RegistryError("fork", "the device list differs from the one this device verified")
    }
  }
  return { state: folded, entries }
}
