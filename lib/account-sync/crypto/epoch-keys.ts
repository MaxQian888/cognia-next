/**
 * The local epoch key chain (protocol §3.3, §4.1). A device trusts an epoch
 * key only through the verified registry: the current key must match the
 * signed `keyCommit`, and every older key is unwrapped from the signed
 * `prevWrap` chain and checked against its own commitment.
 */

import {
  EPOCH_KEY_BYTES,
  fromBase64Url,
  keyCommitment,
  matchesKeyCommitment,
  newEpochKey,
  toBase64Url,
  unwrapPreviousKey,
  wrapPreviousKey,
  type EpochBlock,
  type RegistryState,
} from "@cognia/sync-protocol"

import { AccountSyncCryptoError } from "./errors"

/** Epoch number → 32-byte key, for every epoch from 1 to the chain's current one. */
export type EpochKeyChain = ReadonlyMap<number, Uint8Array>

/**
 * Builds the whole chain from the current epoch's key. Throws
 * `key_commitment` if any key disagrees with the signed registry.
 */
export async function verifiedKeyChain(
  state: RegistryState,
  currentKey: Uint8Array
): Promise<EpochKeyChain> {
  const chain = new Map<number, Uint8Array>()
  let key = currentKey
  for (let epoch = state.epoch; epoch >= 1; epoch--) {
    const commit = state.keyCommits[epoch]
    if (
      !commit ||
      key.length !== EPOCH_KEY_BYTES ||
      !(await matchesKeyCommitment(key, state.spaceId, epoch, commit))
    ) {
      throw new AccountSyncCryptoError(
        "key_commitment",
        `the key of epoch ${epoch} is not the committed one`
      )
    }
    chain.set(epoch, key)
    if (epoch === 1) break
    const wrap = state.prevWraps[epoch]
    if (!wrap)
      throw new AccountSyncCryptoError(
        "key_commitment",
        `epoch ${epoch} does not wrap the previous key`
      )
    try {
      key = await unwrapPreviousKey(key, wrap, state.spaceId, epoch)
    } catch (cause) {
      throw new AccountSyncCryptoError("key_commitment", `epoch ${epoch} wraps an unreadable key`, {
        cause,
      })
    }
  }
  return chain
}

/** Whether a stored chain holds the list's current epoch key, as the list commits to it. */
export async function matchesCurrentEpoch(
  state: RegistryState,
  chain: EpochKeyChain
): Promise<boolean> {
  const key = chain.get(state.epoch)
  const commit = state.keyCommits[state.epoch]
  return !!key && !!commit && (await matchesKeyCommitment(key, state.spaceId, state.epoch, commit))
}

/** The next epoch's block for an entry this device appends, and its new key. */
export async function nextEpoch(
  state: RegistryState,
  chain: EpochKeyChain
): Promise<{ block: EpochBlock; key: Uint8Array }> {
  const current = chain.get(state.epoch)
  if (!current)
    throw new AccountSyncCryptoError(
      "key_commitment",
      "this device does not hold the current epoch key"
    )
  const epoch = state.epoch + 1
  const key = newEpochKey()
  return {
    key,
    block: {
      epoch,
      keyCommit: await keyCommitment(key, state.spaceId, epoch),
      prevWrap: await wrapPreviousKey(key, current, state.spaceId, epoch),
    },
  }
}

/** The genesis epoch: a fresh key and its commitment. */
export async function firstEpoch(spaceId: string): Promise<{ block: EpochBlock; key: Uint8Array }> {
  const key = newEpochKey()
  return { key, block: { epoch: 1, keyCommit: await keyCommitment(key, spaceId, 1) } }
}

/** Vault form of a chain: `{"1": "<b64url>", ...}`. */
export function serializeKeyChain(chain: EpochKeyChain): string {
  return JSON.stringify(
    Object.fromEntries([...chain].map(([epoch, key]) => [String(epoch), toBase64Url(key)]))
  )
}

export function parseKeyChain(text: string): EpochKeyChain {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new AccountSyncCryptoError("bad_key_material", "the stored key chain is not readable", {
      cause,
    })
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AccountSyncCryptoError("bad_key_material", "the stored key chain is not readable")
  }
  const chain = new Map<number, Uint8Array>()
  for (const [epoch, encoded] of Object.entries(value)) {
    const number = Number(epoch)
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      String(number) !== epoch ||
      typeof encoded !== "string"
    ) {
      throw new AccountSyncCryptoError("bad_key_material", "the stored key chain is not readable")
    }
    let key: Uint8Array
    try {
      key = fromBase64Url(encoded)
    } catch (cause) {
      throw new AccountSyncCryptoError("bad_key_material", "the stored key chain is not readable", {
        cause,
      })
    }
    if (key.length !== EPOCH_KEY_BYTES) {
      throw new AccountSyncCryptoError("bad_key_material", "the stored key chain is not readable")
    }
    chain.set(number, key)
  }
  return chain
}
