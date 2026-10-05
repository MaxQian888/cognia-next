/**
 * Sealed keys on the server (protocol §3.3, §5.2): epoch envelopes, one per
 * active device plus one for the recovery key, and the display names a new
 * device seals to each approver. The HPKE seal and open live in the client;
 * this module fixes their associated data and checks completeness, which the
 * Worker enforces.
 */

import { fromBase64UrlExact } from "./bytes"
import { canonicalJsonBytes } from "./jcs"
import { labelled } from "./labels"
import { NAME_CIPHERTEXT_BYTES } from "./registry/validate-append"
import { listActiveDevices } from "./registry/validate-append"
import { RECOVERY_SIGNER, type RegistryState } from "./registry/types"

/** HPKE `info` of an epoch envelope. */
export const EPOCH_ENVELOPE_INFO = labelled("epoch-envelope")
/** HPKE `info` of a display name sealed to an approver. */
export const REQUEST_NAME_INFO = labelled("request-name")

/** DHKEM(P-256) encapsulated key. */
export const HPKE_ENC_BYTES = 65
/** AES-256-GCM of a 32-byte epoch key. */
export const EPOCH_ENVELOPE_CT_BYTES = 32 + 16

export interface EpochEnvelope {
  epoch: number
  /** A deviceId, or `"recovery"`. */
  recipient: string
  recipientEncPub: string
  enc: string
  ct: string
}

export function epochEnvelopeAad(
  spaceId: string,
  epoch: number,
  recipient: string,
  recipientEncPub: string
): Uint8Array {
  return canonicalJsonBytes({ v: 1, spaceId, epoch, recipient, recipientEncPub })
}

export interface Recipient {
  recipient: string
  encPub: string
}

/** Who must hold the epoch key: every active device, and the recovery key. */
export function expectedRecipients(state: RegistryState): Recipient[] {
  return [
    ...listActiveDevices(state).map((device) => ({
      recipient: device.deviceId,
      encPub: device.encPub,
    })),
    { recipient: RECOVERY_SIGNER, encPub: state.recovery.encPub },
  ]
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EnvelopeError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseEpochEnvelope(value: unknown): EpochEnvelope {
  if (!isRecord(value)) throw new EnvelopeError("an envelope must be an object")
  for (const key of Object.keys(value)) {
    if (!["epoch", "recipient", "recipientEncPub", "enc", "ct"].includes(key)) {
      throw new EnvelopeError(`an envelope has an unknown field ${key}`)
    }
  }
  const { epoch, recipient, recipientEncPub, enc, ct } = value
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) {
    throw new EnvelopeError("envelope.epoch is invalid")
  }
  if (typeof recipient !== "string" || typeof recipientEncPub !== "string") {
    throw new EnvelopeError("envelope recipient is invalid")
  }
  try {
    fromBase64UrlExact(recipientEncPub, 65, "envelope.recipientEncPub")
    fromBase64UrlExact(enc, HPKE_ENC_BYTES, "envelope.enc")
    fromBase64UrlExact(ct, EPOCH_ENVELOPE_CT_BYTES, "envelope.ct")
  } catch (error) {
    throw new EnvelopeError(error instanceof Error ? error.message : "envelope is invalid")
  }
  return { epoch, recipient, recipientEncPub, enc: enc as string, ct: ct as string }
}

/**
 * Checks that `envelopes` seal `epoch` to exactly `recipients`, each to the
 * encryption key the registry holds for it. Returns them parsed.
 */
export function checkEnvelopeSet(
  values: readonly unknown[],
  epoch: number,
  recipients: readonly Recipient[]
): EpochEnvelope[] {
  const envelopes = values.map(parseEpochEnvelope)
  if (envelopes.length !== recipients.length) {
    throw new EnvelopeError(`expected ${recipients.length} envelopes, got ${envelopes.length}`)
  }
  const wanted = new Map(recipients.map((item) => [item.recipient, item.encPub]))
  const seen = new Set<string>()
  for (const envelope of envelopes) {
    if (envelope.epoch !== epoch)
      throw new EnvelopeError(`envelope for epoch ${envelope.epoch}, expected ${epoch}`)
    const encPub = wanted.get(envelope.recipient)
    if (encPub === undefined) throw new EnvelopeError(`${envelope.recipient} is not a recipient`)
    if (seen.has(envelope.recipient)) throw new EnvelopeError(`${envelope.recipient} appears twice`)
    if (envelope.recipientEncPub !== encPub) {
      throw new EnvelopeError(`envelope for ${envelope.recipient} is sealed to another key`)
    }
    seen.add(envelope.recipient)
  }
  return envelopes
}

/** A display name a new device sealed to one approver. */
export interface SealedName {
  recipient: string
  enc: string
  ct: string
}

export function requestNameAad(spaceId: string, deviceId: string, recipient: string): Uint8Array {
  return canonicalJsonBytes({ spaceId, deviceId, recipient })
}

/** One sealed name per active device, nothing else. */
export function checkSealedNames(values: unknown, state: RegistryState): SealedName[] {
  if (!Array.isArray(values)) throw new EnvelopeError("names must be an array")
  const active = new Set(listActiveDevices(state).map((device) => device.deviceId))
  const names = values.map((value): SealedName => {
    if (!isRecord(value)) throw new EnvelopeError("a sealed name must be an object")
    for (const key of Object.keys(value)) {
      if (!["recipient", "enc", "ct"].includes(key))
        throw new EnvelopeError(`a sealed name has an unknown field ${key}`)
    }
    if (typeof value.recipient !== "string")
      throw new EnvelopeError("sealed name recipient is invalid")
    try {
      fromBase64UrlExact(value.enc, HPKE_ENC_BYTES, "name.enc")
      fromBase64UrlExact(value.ct, NAME_CIPHERTEXT_BYTES, "name.ct")
    } catch (error) {
      throw new EnvelopeError(error instanceof Error ? error.message : "sealed name is invalid")
    }
    return { recipient: value.recipient, enc: value.enc as string, ct: value.ct as string }
  })
  const recipients = new Set(names.map((name) => name.recipient))
  if (
    recipients.size !== names.length ||
    names.length !== active.size ||
    [...recipients].some((r) => !active.has(r))
  ) {
    throw new EnvelopeError("names must be sealed to exactly the active devices")
  }
  return names
}
