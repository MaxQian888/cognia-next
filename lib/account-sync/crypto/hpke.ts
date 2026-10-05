/**
 * HPKE (RFC 9180, base mode, DHKEM(P-256, HKDF-SHA256) / HKDF-SHA256 /
 * AES-256-GCM, via `@hpke/core`) for the two things a device seals to another
 * key (protocol §3.3, §5.2): epoch-key envelopes and the display name a new
 * device seals to each approver.
 *
 * Base mode does not authenticate the sealer, so an opened epoch key is only
 * returned after it matches the signed registry's `keyCommit`.
 */

import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core"

import {
  EPOCH_ENVELOPE_INFO,
  EPOCH_KEY_BYTES,
  REQUEST_NAME_INFO,
  buffer,
  deviceNamePadding,
  epochEnvelopeAad,
  fromBase64Url,
  matchesKeyCommitment,
  requestNameAad,
  toBase64Url,
  type EpochEnvelope,
  type Recipient,
  type SealedName,
} from "@cognia/sync-protocol"

import { AccountSyncCryptoError } from "./errors"

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
})

export interface Sealed {
  enc: string
  ct: string
}

export async function hpkeSeal(
  recipientEncPub: string,
  plaintext: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array
): Promise<Sealed> {
  const recipientPublicKey = await suite.kem.importKey(
    "raw",
    buffer(fromBase64Url(recipientEncPub)),
    true
  )
  const { ct, enc } = await suite.seal(
    { recipientPublicKey, info: buffer(info) },
    buffer(plaintext),
    buffer(aad)
  )
  return { enc: toBase64Url(new Uint8Array(enc)), ct: toBase64Url(new Uint8Array(ct)) }
}

/** `recipient` must be the full key pair (see `p256-keys.ts`). */
export async function hpkeOpen(
  recipient: CryptoKeyPair,
  sealed: Sealed,
  info: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  try {
    const plaintext = await suite.open(
      { recipientKey: recipient, enc: buffer(fromBase64Url(sealed.enc)), info: buffer(info) },
      buffer(fromBase64Url(sealed.ct)),
      buffer(aad)
    )
    return new Uint8Array(plaintext)
  } catch (cause) {
    throw new AccountSyncCryptoError("bad_envelope", "the sealed key does not open", { cause })
  }
}

export async function sealEpochEnvelope(
  spaceId: string,
  epoch: number,
  epochKey: Uint8Array,
  recipient: Recipient
): Promise<EpochEnvelope> {
  const aad = epochEnvelopeAad(spaceId, epoch, recipient.recipient, recipient.encPub)
  const { enc, ct } = await hpkeSeal(recipient.encPub, epochKey, EPOCH_ENVELOPE_INFO, aad)
  return { epoch, recipient: recipient.recipient, recipientEncPub: recipient.encPub, enc, ct }
}

/** One envelope per recipient (from `expectedRecipients` of the state after the entry). */
export function sealEpochEnvelopes(
  spaceId: string,
  epoch: number,
  epochKey: Uint8Array,
  recipients: readonly Recipient[]
): Promise<EpochEnvelope[]> {
  return Promise.all(
    recipients.map((recipient) => sealEpochEnvelope(spaceId, epoch, epochKey, recipient))
  )
}

export interface EnvelopeExpectation {
  spaceId: string
  epoch: number
  /** This device's id, or `"recovery"`. */
  recipient: string
  /** The registry's encryption key for `recipient`. */
  recipientEncPub: string
  /** The registry's `keyCommits[epoch]`. */
  keyCommit: string
}

/** Opens an epoch envelope and returns the key only if the signed registry commits to it. */
export async function openEpochEnvelope(
  envelope: EpochEnvelope,
  keys: CryptoKeyPair,
  expected: EnvelopeExpectation
): Promise<Uint8Array> {
  if (
    envelope.epoch !== expected.epoch ||
    envelope.recipient !== expected.recipient ||
    envelope.recipientEncPub !== expected.recipientEncPub
  ) {
    throw new AccountSyncCryptoError(
      "bad_envelope",
      "the envelope is addressed to another key or epoch"
    )
  }
  const aad = epochEnvelopeAad(
    expected.spaceId,
    expected.epoch,
    expected.recipient,
    expected.recipientEncPub
  )
  const key = await hpkeOpen(keys, envelope, EPOCH_ENVELOPE_INFO, aad)
  if (key.length !== EPOCH_KEY_BYTES) {
    throw new AccountSyncCryptoError("bad_envelope", "the sealed epoch key has the wrong length")
  }
  if (!(await matchesKeyCommitment(key, expected.spaceId, expected.epoch, expected.keyCommit))) {
    throw new AccountSyncCryptoError(
      "key_commitment",
      "the sealed key is not the one the device list commits to"
    )
  }
  return key
}

/** The pending device's display name, padded to 64 bytes, sealed to one approver. */
export async function sealRequestName(
  name: string,
  spaceId: string,
  deviceId: string,
  recipient: Recipient
): Promise<SealedName> {
  const aad = requestNameAad(spaceId, deviceId, recipient.recipient)
  const { enc, ct } = await hpkeSeal(
    recipient.encPub,
    deviceNamePadding.pad(name),
    REQUEST_NAME_INFO,
    aad
  )
  return { recipient: recipient.recipient, enc, ct }
}

export async function openRequestName(
  sealed: SealedName,
  keys: CryptoKeyPair,
  spaceId: string,
  deviceId: string,
  recipient: string
): Promise<string> {
  if (sealed.recipient !== recipient) {
    throw new AccountSyncCryptoError("bad_envelope", "the name is sealed to another device")
  }
  const padded = await hpkeOpen(
    keys,
    sealed,
    REQUEST_NAME_INFO,
    requestNameAad(spaceId, deviceId, recipient)
  )
  try {
    return deviceNamePadding.unpad(padded)
  } catch (cause) {
    throw new AccountSyncCryptoError("bad_envelope", "the sealed name is malformed", { cause })
  }
}
