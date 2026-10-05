import {
  EPOCH_ENVELOPE_CT_BYTES,
  EPOCH_ENVELOPE_INFO,
  NAME_CIPHERTEXT_BYTES,
  checkEnvelopeSet,
  checkSealedNames,
  epochEnvelopeAad,
  expectedRecipients,
  fromBase64Url,
  keyCommitment,
  newEpochKey,
  parseEpochEnvelope,
  parseRecoveryKey,
  toBase64Url,
  type EpochEnvelope,
} from "@cognia/sync-protocol"
import { ChainBuilder, makeDevice, makeRecovery } from "@cognia/sync-protocol/testing/chain"

import { generateDeviceKeyMaterial, importDeviceKeys, type DeviceKeys } from "./device-keys"
import { AccountSyncCryptoError } from "./errors"
import {
  hpkeOpen,
  hpkeSeal,
  openEpochEnvelope,
  openRequestName,
  sealEpochEnvelope,
  sealEpochEnvelopes,
  sealRequestName,
} from "./hpke"
import { deriveRecoveryKeys } from "./recovery"

const SPACE = "s".repeat(43)

async function device(): Promise<DeviceKeys> {
  return importDeviceKeys(await generateDeviceKeyMaterial())
}

async function refusal(promise: Promise<unknown>): Promise<AccountSyncCryptoError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(AccountSyncCryptoError)
  return error as AccountSyncCryptoError
}

describe("hpkeSeal / hpkeOpen", () => {
  it("round-trips to a non-extractable recipient key pair", async () => {
    const recipient = await device()
    expect(recipient.enc.privateKey.extractable).toBe(false)
    const info = new Uint8Array([1])
    const aad = new Uint8Array([2])
    const sealed = await hpkeSeal(recipient.encPub, new Uint8Array([7, 8, 9]), info, aad)
    expect(fromBase64Url(sealed.enc)).toHaveLength(65)
    expect(await hpkeOpen(recipient.enc, sealed, info, aad)).toEqual(new Uint8Array([7, 8, 9]))
  })

  it("refuses another key, info, aad or a tampered ciphertext", async () => {
    const recipient = await device()
    const info = new Uint8Array([1])
    const aad = new Uint8Array([2])
    const sealed = await hpkeSeal(recipient.encPub, new Uint8Array(32), info, aad)
    expect((await refusal(hpkeOpen((await device()).enc, sealed, info, aad))).code).toBe(
      "bad_envelope"
    )
    await refusal(hpkeOpen(recipient.enc, sealed, new Uint8Array([9]), aad))
    await refusal(hpkeOpen(recipient.enc, sealed, info, new Uint8Array([9])))
    const ct = fromBase64Url(sealed.ct)
    ct[0] ^= 1
    await refusal(hpkeOpen(recipient.enc, { ...sealed, ct: toBase64Url(ct) }, info, aad))
  })
})

describe("epoch envelopes", () => {
  it("seals in the protocol's envelope shape", async () => {
    const recipient = await device()
    const envelope = await sealEpochEnvelope(SPACE, 2, newEpochKey(), {
      recipient: recipient.deviceId,
      encPub: recipient.encPub,
    })
    expect(parseEpochEnvelope(envelope)).toEqual(envelope)
    expect(fromBase64Url(envelope.ct)).toHaveLength(EPOCH_ENVELOPE_CT_BYTES)
  })

  it("seals a complete set the server accepts", async () => {
    const first = await makeDevice()
    const recovery = await makeRecovery()
    const chain = await ChainBuilder.genesis(SPACE, first, recovery)
    await chain.addByApproval(first, await makeDevice())
    const recipients = expectedRecipients(chain.state)
    const envelopes = await sealEpochEnvelopes(SPACE, 1, chain.currentKey(), recipients)
    expect(checkEnvelopeSet(envelopes, 1, recipients)).toHaveLength(3)
  })

  it("opens a key only if the registry commits to it", async () => {
    const me = await device()
    const key = newEpochKey()
    const keyCommit = await keyCommitment(key, SPACE, 4)
    const envelope = await sealEpochEnvelope(SPACE, 4, key, {
      recipient: me.deviceId,
      encPub: me.encPub,
    })
    const expected = {
      spaceId: SPACE,
      epoch: 4,
      recipient: me.deviceId,
      recipientEncPub: me.encPub,
      keyCommit,
    }
    expect(await openEpochEnvelope(envelope, me.enc, expected)).toEqual(key)

    // The server seals its own key to this device: HPKE opens, the commitment refuses.
    const injected = await sealEpochEnvelope(SPACE, 4, newEpochKey(), {
      recipient: me.deviceId,
      encPub: me.encPub,
    })
    expect((await refusal(openEpochEnvelope(injected, me.enc, expected))).code).toBe(
      "key_commitment"
    )
  })

  it("refuses an envelope for another epoch, recipient or key", async () => {
    const me = await device()
    const key = newEpochKey()
    const envelope = await sealEpochEnvelope(SPACE, 4, key, {
      recipient: me.deviceId,
      encPub: me.encPub,
    })
    const expected = {
      spaceId: SPACE,
      epoch: 4,
      recipient: me.deviceId,
      recipientEncPub: me.encPub,
      keyCommit: await keyCommitment(key, SPACE, 4),
    }
    await refusal(openEpochEnvelope({ ...envelope, epoch: 3 }, me.enc, expected))
    await refusal(openEpochEnvelope(envelope, me.enc, { ...expected, epoch: 3 }))
    await refusal(openEpochEnvelope({ ...envelope, recipient: "recovery" }, me.enc, expected))
    // Re-labelled for another space: the AAD no longer matches.
    await refusal(openEpochEnvelope(envelope, me.enc, { ...expected, spaceId: "t".repeat(43) }))
  })

  it("refuses a sealed value that is not a 32-byte key", async () => {
    const me = await device()
    const short = await hpkeSeal(
      me.encPub,
      new Uint8Array(16),
      EPOCH_ENVELOPE_INFO,
      epochEnvelopeAad(SPACE, 1, me.deviceId, me.encPub)
    )
    const envelope: EpochEnvelope = {
      epoch: 1,
      recipient: me.deviceId,
      recipientEncPub: me.encPub,
      ...short,
    }
    const error = await refusal(
      openEpochEnvelope(envelope, me.enc, {
        spaceId: SPACE,
        epoch: 1,
        recipient: me.deviceId,
        recipientEncPub: me.encPub,
        keyCommit: await keyCommitment(newEpochKey(), SPACE, 1),
      })
    )
    expect(error.message).toMatch(/length/)
  })

  it("opens the frozen v1 envelope (suite, info and AAD never change)", async () => {
    const recovery = await deriveRecoveryKeys(
      parseRecoveryKey("0123-4567-89AB-CDEF-GHJK-MNPQ-RW"),
      SPACE
    )
    const envelope: EpochEnvelope = {
      epoch: 3,
      recipient: "recovery",
      recipientEncPub:
        "BHCpq8p7uRlDKwmjPaW8viAkGnwxkqv5Njvjuaz41Z-Wof_xptkB7V8Xkq9spJvKAOqnRJkFj47ZlIbJil8WOVc",
      enc: "BJCagav2zhN8Fr8Dj006fK2MezSa8XoXdFguD8Xq52oCy_Q3hLVYD_E699Yy9ht5m2gVUpP3sYjgB9Qo5m82EYQ",
      ct: "897XpMDqMYSXvmdCJQtyj8Xv1-talxbIa_7kOwV6xmZkjoN5MLYQ1g5ipA-VT0aS",
    }
    const key = await openEpochEnvelope(envelope, recovery.enc, {
      spaceId: SPACE,
      epoch: 3,
      recipient: "recovery",
      recipientEncPub: recovery.encPub,
      keyCommit: "oa2H8Wli7x3-ZLZckekt4-rOqrtYe7X3XiuqBJl9ffw",
    })
    expect(key).toEqual(Uint8Array.from({ length: 32 }, (_, i) => i + 1))
  })
})

describe("request names", () => {
  it("seals a fixed-size name each approver can open", async () => {
    const approver = await device()
    const sealed = await sealRequestName("Pixel 9 · 工作", SPACE, "dev_R", {
      recipient: approver.deviceId,
      encPub: approver.encPub,
    })
    expect(fromBase64Url(sealed.ct)).toHaveLength(NAME_CIPHERTEXT_BYTES)
    expect(await openRequestName(sealed, approver.enc, SPACE, "dev_R", approver.deviceId)).toBe(
      "Pixel 9 · 工作"
    )
    await refusal(openRequestName(sealed, approver.enc, SPACE, "dev_X", approver.deviceId))
    await refusal(openRequestName(sealed, approver.enc, SPACE, "dev_R", "dev_other"))
  })

  it("produces names the server's completeness check accepts", async () => {
    const first = await device()
    const chainFirst = await makeDevice()
    const chain = await ChainBuilder.genesis(SPACE, chainFirst, await makeRecovery())
    const sealed = await sealRequestName("New", SPACE, first.deviceId, {
      recipient: chainFirst.deviceId,
      encPub: chainFirst.encPub,
    })
    expect(checkSealedNames([sealed], chain.state)).toHaveLength(1)
  })
})
