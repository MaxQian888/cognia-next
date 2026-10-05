import { toBase64Url, fromUtf8 } from "./bytes"
import {
  EPOCH_ENVELOPE_CT_BYTES,
  EPOCH_ENVELOPE_INFO,
  EnvelopeError,
  HPKE_ENC_BYTES,
  REQUEST_NAME_INFO,
  checkEnvelopeSet,
  checkSealedNames,
  epochEnvelopeAad,
  expectedRecipients,
  parseEpochEnvelope,
  requestNameAad,
} from "./envelopes"
import { NAME_CIPHERTEXT_BYTES } from "./registry/validate-append"
import { ChainBuilder, makeDevice, makeRecovery } from "./testing/chain"

const SPACE = "s".repeat(43)
const b64 = (length: number, fill = 1) => toBase64Url(new Uint8Array(length).fill(fill))

async function twoDevices() {
  const first = await makeDevice("First")
  const recovery = await makeRecovery()
  const chain = await ChainBuilder.genesis(SPACE, first, recovery)
  const second = await makeDevice("Second")
  await chain.addByApproval(first, second)
  return { chain, first, second, recovery }
}

function envelope(epoch: number, recipient: string, recipientEncPub: string) {
  return {
    epoch,
    recipient,
    recipientEncPub,
    enc: b64(HPKE_ENC_BYTES),
    ct: b64(EPOCH_ENVELOPE_CT_BYTES),
  }
}

describe("envelope labels and associated data", () => {
  it("labels the HPKE info strings", () => {
    expect(fromUtf8(EPOCH_ENVELOPE_INFO)).toBe("cognia-sync/v1/epoch-envelope\u0000")
    expect(fromUtf8(REQUEST_NAME_INFO)).toBe("cognia-sync/v1/request-name\u0000")
  })

  it("binds an envelope to space, epoch, recipient and its key", () => {
    expect(fromUtf8(epochEnvelopeAad(SPACE, 3, "recovery", "K"))).toBe(
      `{"epoch":3,"recipient":"recovery","recipientEncPub":"K","spaceId":"${SPACE}","v":1}`
    )
    expect(fromUtf8(requestNameAad(SPACE, "dev_R", "dev_A"))).toBe(
      `{"deviceId":"dev_R","recipient":"dev_A","spaceId":"${SPACE}"}`
    )
  })
})

describe("expectedRecipients", () => {
  it("lists the active devices then the recovery key", async () => {
    const { chain, first, second, recovery } = await twoDevices()
    expect(expectedRecipients(chain.state)).toEqual([
      { recipient: first.deviceId, encPub: first.encPub },
      { recipient: second.deviceId, encPub: second.encPub },
      { recipient: "recovery", encPub: recovery.encPub },
    ])
    await chain.revoke(first, second.deviceId)
    expect(expectedRecipients(chain.state).map((item) => item.recipient)).toEqual([
      first.deviceId,
      "recovery",
    ])
  })
})

describe("parseEpochEnvelope", () => {
  it("accepts a well-formed envelope", () => {
    const value = envelope(2, "recovery", b64(65))
    expect(parseEpochEnvelope(value)).toEqual(value)
  })

  it.each([
    ["an unknown field", { ...envelope(1, "recovery", b64(65)), alg: "x" }],
    ["epoch 0", envelope(0, "recovery", b64(65))],
    ["a short enc", { ...envelope(1, "recovery", b64(65)), enc: b64(64) }],
    ["a long ct", { ...envelope(1, "recovery", b64(65)), ct: b64(EPOCH_ENVELOPE_CT_BYTES + 1) }],
    ["a short recipient key", envelope(1, "recovery", b64(33))],
    ["a numeric recipient", { ...envelope(1, "recovery", b64(65)), recipient: 1 }],
    ["an array", []],
  ])("refuses %s", (_label, value) => {
    expect(() => parseEpochEnvelope(value)).toThrow(EnvelopeError)
  })
})

describe("checkEnvelopeSet", () => {
  it("accepts exactly one envelope per recipient, in any order", async () => {
    const { chain } = await twoDevices()
    const recipients = expectedRecipients(chain.state)
    const values = recipients.map((item) => envelope(1, item.recipient, item.encPub)).reverse()
    expect(checkEnvelopeSet(values, 1, recipients)).toHaveLength(3)
  })

  it("refuses a missing, extra, duplicated, stale or misaddressed envelope", async () => {
    const { chain } = await twoDevices()
    const recipients = expectedRecipients(chain.state)
    const values = recipients.map((item) => envelope(1, item.recipient, item.encPub))
    const stranger = await makeDevice()

    expect(() => checkEnvelopeSet(values.slice(1), 1, recipients)).toThrow(/expected 3/)
    expect(() =>
      checkEnvelopeSet([...values, envelope(1, stranger.deviceId, stranger.encPub)], 1, recipients)
    ).toThrow(/expected 3/)
    expect(() => checkEnvelopeSet([values[0], values[0], values[2]], 1, recipients)).toThrow(
      /twice/
    )
    expect(() => checkEnvelopeSet(values, 2, recipients)).toThrow(/epoch/)
    expect(() =>
      checkEnvelopeSet(
        [values[0], values[1], envelope(1, stranger.deviceId, stranger.encPub)],
        1,
        recipients
      )
    ).toThrow(/not a recipient/)
    // The server swaps in its own key for a real recipient.
    expect(() =>
      checkEnvelopeSet(
        [values[0], values[1], { ...values[2]!, recipientEncPub: stranger.encPub }],
        1,
        recipients
      )
    ).toThrow(/another key/)
  })
})

describe("checkSealedNames", () => {
  const name = (recipient: string) => ({
    recipient,
    enc: b64(HPKE_ENC_BYTES),
    ct: b64(NAME_CIPHERTEXT_BYTES),
  })

  it("needs one sealed name per active device", async () => {
    const { chain, first, second } = await twoDevices()
    expect(
      checkSealedNames([name(second.deviceId), name(first.deviceId)], chain.state)
    ).toHaveLength(2)
    expect(() => checkSealedNames([name(first.deviceId)], chain.state)).toThrow(
      /exactly the active devices/
    )
    expect(() =>
      checkSealedNames([name(first.deviceId), name(first.deviceId)], chain.state)
    ).toThrow(/exactly the active devices/)
    expect(() => checkSealedNames([name(first.deviceId), name("recovery")], chain.state)).toThrow(
      /exactly the active devices/
    )
  })

  it("does not seal names to revoked devices", async () => {
    const { chain, first, second } = await twoDevices()
    await chain.revoke(first, second.deviceId)
    expect(() =>
      checkSealedNames([name(first.deviceId), name(second.deviceId)], chain.state)
    ).toThrow()
    expect(checkSealedNames([name(first.deviceId)], chain.state)).toHaveLength(1)
  })

  it("refuses malformed names", async () => {
    const { chain, first } = await twoDevices()
    expect(() => checkSealedNames("x", chain.state)).toThrow(/array/)
    expect(() => checkSealedNames([{ ...name(first.deviceId), x: 1 }], chain.state)).toThrow(
      /unknown field/
    )
    expect(() => checkSealedNames([{ ...name(first.deviceId), ct: b64(64) }], chain.state)).toThrow(
      EnvelopeError
    )
    expect(() =>
      checkSealedNames([{ ...name(first.deviceId), recipient: 7 }], chain.state)
    ).toThrow(/recipient/)
  })
})
