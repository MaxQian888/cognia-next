/**
 * Epoch keys (protocol §3.3): subkeys of `SK_e`, the per-epoch key
 * commitment, the wrap of the previous epoch's key, and sealed device names.
 */

import { fromBase64Url, fromUtf8, randomBytes, toBase64Url, utf8 } from "./bytes"
import { aesGcmDecrypt, aesGcmEncrypt, hkdf, hmacSha256 } from "./crypto"
import { canonicalJsonBytes } from "./jcs"
import { labelled, type Label } from "./labels"
import { MAX_DEVICE_NAME_BYTES } from "./limits"
import type { NameCiphertext, PrevWrap } from "./registry/types"

export const EPOCH_KEY_BYTES = 32

export type EpochSubkey = Extract<Label, "commit" | "chain" | "name">

export function newEpochKey(): Uint8Array {
  return randomBytes(EPOCH_KEY_BYTES)
}

export async function epochSubkey(
  epochKey: Uint8Array,
  spaceId: string,
  purpose: EpochSubkey
): Promise<Uint8Array> {
  return hkdf(epochKey, utf8(spaceId), labelled(purpose), 32)
}

/** `keyCommit_e`, published in the signed entry that starts epoch `e`. */
export async function keyCommitment(
  epochKey: Uint8Array,
  spaceId: string,
  epoch: number
): Promise<string> {
  const commitKey = await epochSubkey(epochKey, spaceId, "commit")
  return toBase64Url(await hmacSha256(commitKey, canonicalJsonBytes({ spaceId, epoch })))
}

export async function matchesKeyCommitment(
  epochKey: Uint8Array,
  spaceId: string,
  epoch: number,
  keyCommit: string
): Promise<boolean> {
  return (await keyCommitment(epochKey, spaceId, epoch)) === keyCommit
}

function chainAad(spaceId: string, previousEpoch: number): Uint8Array {
  return labelled("chain", canonicalJsonBytes({ spaceId, epoch: previousEpoch }))
}

/** `prevWrap_e`: `SK_{e-1}` under the `chain` subkey of `SK_e`. */
export async function wrapPreviousKey(
  epochKey: Uint8Array,
  previousKey: Uint8Array,
  spaceId: string,
  epoch: number
): Promise<PrevWrap> {
  const chainKey = await epochSubkey(epochKey, spaceId, "chain")
  const nonce = randomBytes(12)
  const ct = await aesGcmEncrypt(chainKey, nonce, previousKey, chainAad(spaceId, epoch - 1))
  return { nonce: toBase64Url(nonce), ct: toBase64Url(ct) }
}

export async function unwrapPreviousKey(
  epochKey: Uint8Array,
  wrap: PrevWrap,
  spaceId: string,
  epoch: number
): Promise<Uint8Array> {
  const chainKey = await epochSubkey(epochKey, spaceId, "chain")
  return aesGcmDecrypt(
    chainKey,
    fromBase64Url(wrap.nonce),
    fromBase64Url(wrap.ct),
    chainAad(spaceId, epoch - 1)
  )
}

/** 1 length byte, the UTF-8 name, zero padding to 64 bytes: names do not leak their length. */
function padName(name: string): Uint8Array {
  const bytes = utf8(name.normalize("NFC"))
  if (bytes.length > MAX_DEVICE_NAME_BYTES - 1) throw new Error("device name is too long")
  const out = new Uint8Array(MAX_DEVICE_NAME_BYTES)
  out[0] = bytes.length
  out.set(bytes, 1)
  return out
}

function unpadName(padded: Uint8Array): string {
  const length = padded[0] ?? 0
  if (padded.length !== MAX_DEVICE_NAME_BYTES || length > MAX_DEVICE_NAME_BYTES - 1) {
    throw new Error("malformed device name")
  }
  return fromUtf8(padded.subarray(1, 1 + length))
}

/** Cuts a name to the longest prefix that fits, never splitting a character. */
export function fitDeviceName(name: string): string {
  let out = ""
  for (const char of name.normalize("NFC").trim()) {
    if (utf8(out + char).length > MAX_DEVICE_NAME_BYTES - 1) break
    out += char
  }
  return out
}

function nameAad(spaceId: string, deviceId: string, epoch: number): Uint8Array {
  return canonicalJsonBytes({ spaceId, deviceId, epoch })
}

export async function sealDeviceName(
  epochKey: Uint8Array,
  spaceId: string,
  deviceId: string,
  epoch: number,
  name: string
): Promise<NameCiphertext> {
  const nameKey = await epochSubkey(epochKey, spaceId, "name")
  const nonce = randomBytes(12)
  const ct = await aesGcmEncrypt(nameKey, nonce, padName(name), nameAad(spaceId, deviceId, epoch))
  return { epoch, nonce: toBase64Url(nonce), ct: toBase64Url(ct) }
}

export async function openDeviceName(
  epochKey: Uint8Array,
  spaceId: string,
  deviceId: string,
  sealed: NameCiphertext
): Promise<string> {
  const nameKey = await epochSubkey(epochKey, spaceId, "name")
  const padded = await aesGcmDecrypt(
    nameKey,
    fromBase64Url(sealed.nonce),
    fromBase64Url(sealed.ct),
    nameAad(spaceId, deviceId, sealed.epoch)
  )
  return unpadName(padded)
}

/** Exposed for the request-name seal, which pads the same way before HPKE. */
export const deviceNamePadding = { pad: padName, unpad: unpadName }
