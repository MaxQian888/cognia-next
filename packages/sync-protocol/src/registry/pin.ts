/**
 * The rollback pin (protocol §4.1): what a device remembers of the last chain
 * it verified, so a server that later shows an older or different chain is
 * caught. Kept in the device's vault; it only ever moves forward.
 */

import type { RegistryState } from "./types"

export interface RegistryPin {
  genesisHash: string
  seq: number
  hash: string
  epoch: number
}

export function pinFor(state: RegistryState): RegistryPin {
  return {
    genesisHash: state.genesisHash,
    seq: state.head.seq,
    hash: state.head.hash,
    epoch: state.epoch,
  }
}

/** The later of two pins of the same chain (a verified fold never goes back). */
export function laterPin(current: RegistryPin | null, next: RegistryPin): RegistryPin {
  if (!current || next.seq >= current.seq) return next
  return current
}
