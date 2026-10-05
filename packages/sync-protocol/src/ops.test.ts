import { fromBase64Url, toBase64Url } from "./bytes"
import { newEpochKey } from "./epoch"
import { encodeHlc } from "./hlc"
import { MAX_OP_PLAINTEXT_BYTES } from "./limits"
import {
  OpError,
  canonicalFields,
  decryptOpPayload,
  encryptOpPayload,
  opKey,
  parseOp,
  parseOpPayload,
  signOp,
  verifyOpSignature,
  type OpHeader,
  type OpPayload,
} from "./ops"
import { makeDevice } from "./testing/chain"

const SPACE = "s".repeat(43)

async function sealed(payload: OpPayload, header?: Partial<OpHeader>) {
  const device = await makeDevice()
  const key = await opKey(newEpochKey(), SPACE)
  const fullHeader: OpHeader = {
    deviceId: device.deviceId,
    deviceSeq: 1,
    hlc: { ms: 1000, c: 0 },
    epoch: 1,
    schemaVer: 1,
    cls: "c",
    ...header,
  }
  const { nonce, ct } = await encryptOpPayload(key, SPACE, fullHeader, payload)
  const op = await signOp(device.sign.privateKey, SPACE, { ...fullHeader, nonce, ct })
  return { op, key, device }
}

function upsert(deviceId: string): OpPayload {
  const hlc = encodeHlc({ ms: 1000, c: 0, deviceId })
  return { t: "sessions", id: "s1", k: "upsert", f: { title: ["Hello", hlc] } }
}

describe("canonicalFields", () => {
  it("length-prefixes each field big-endian, integers as decimal", () => {
    expect([...canonicalFields(["ab", 7])]).toEqual([0, 0, 0, 2, 97, 98, 0, 0, 0, 1, 55])
  })
})

describe("op encryption and signatures", () => {
  it("round-trips a payload and verifies its signature", async () => {
    const device = await makeDevice()
    const payload = upsert(device.deviceId)
    const { op, key, device: signer } = await sealed(payload)
    expect(await decryptOpPayload(key, SPACE, op)).toEqual(payload)
    expect(await verifyOpSignature(signer.sign.publicKey, SPACE, op)).toBe(true)
    expect(parseOp(JSON.parse(JSON.stringify(op)))).toEqual(op)
  })

  it("binds the ciphertext to the space and the envelope", async () => {
    const device = await makeDevice()
    const { op, key } = await sealed(upsert(device.deviceId))
    await expect(decryptOpPayload(key, "t".repeat(43), op)).rejects.toThrow(OpError)
    await expect(decryptOpPayload(key, SPACE, { ...op, deviceSeq: 2 })).rejects.toThrow(OpError)
    await expect(decryptOpPayload(key, SPACE, { ...op, cls: "s" })).rejects.toThrow(OpError)
  })

  it("rejects a signature over any changed field, another space or another key", async () => {
    const device = await makeDevice()
    const { op, device: signer } = await sealed(upsert(device.deviceId))
    const other = await makeDevice()
    expect(await verifyOpSignature(signer.sign.publicKey, SPACE, { ...op, epoch: 2 })).toBe(false)
    expect(
      await verifyOpSignature(signer.sign.publicKey, SPACE, { ...op, hlc: { ms: 1, c: 0 } })
    ).toBe(false)
    expect(await verifyOpSignature(signer.sign.publicKey, "t".repeat(43), op)).toBe(false)
    expect(await verifyOpSignature(other.sign.publicKey, SPACE, op)).toBe(false)
    expect(await verifyOpSignature(signer.sign.publicKey, SPACE, { ...op, sig: "!!" })).toBe(false)
  })

  it("pads: ciphertexts of similar payloads share a length", async () => {
    const device = await makeDevice()
    const hlc = encodeHlc({ ms: 1, c: 0, deviceId: device.deviceId })
    const lengths = new Set<number>()
    for (const title of ["a".repeat(1000), "a".repeat(1010), "a".repeat(1020)]) {
      const { op } = await sealed({
        t: "sessions",
        id: "s1",
        k: "upsert",
        f: { title: [title, hlc] },
      })
      lengths.add(fromBase64Url(op.ct).length)
    }
    expect(lengths.size).toBe(1)
  })

  it("refuses a payload larger than one op may carry", async () => {
    const device = await makeDevice()
    const hlc = encodeHlc({ ms: 1, c: 0, deviceId: device.deviceId })
    const big = "x".repeat(MAX_OP_PLAINTEXT_BYTES)
    await expect(
      sealed({ t: "messages", id: "m1", k: "upsert", f: { content: [big, hlc] } })
    ).rejects.toThrow("too large")
  })
})

describe("parseOpPayload", () => {
  const hlc = encodeHlc({ ms: 1, c: 0, deviceId: "dev_" + "A".repeat(26) })

  it("accepts upserts with unknown fields and deletes", () => {
    expect(
      parseOpPayload({ t: "x", id: "1", k: "upsert", f: { a: [1, hlc] }, u: { z: [null, hlc] } })
    ).toEqual({ t: "x", id: "1", k: "upsert", f: { a: [1, hlc] }, u: { z: [null, hlc] } })
    expect(parseOpPayload({ t: "x", id: "1", k: "delete", at: hlc })).toEqual({
      t: "x",
      id: "1",
      k: "delete",
      at: hlc,
    })
  })

  it.each([
    ["no table", { id: "1", k: "upsert", f: { a: [1, hlc] } }],
    ["no fields", { t: "x", id: "1", k: "upsert", f: {} }],
    ["an unclocked field", { t: "x", id: "1", k: "upsert", f: { a: [1, "now"] } }],
    ["a bare field", { t: "x", id: "1", k: "upsert", f: { a: 1 } }],
    ["a delete without a clock", { t: "x", id: "1", k: "delete" }],
    ["an unknown kind", { t: "x", id: "1", k: "append", f: { a: [1, hlc] } }],
    ["a bad unknown map", { t: "x", id: "1", k: "upsert", f: { a: [1, hlc] }, u: [] }],
  ])("refuses %s", (_label, value) => {
    expect(() => parseOpPayload(value)).toThrow(OpError)
  })
})

describe("parseOp", () => {
  const valid = {
    deviceId: "dev_" + "A".repeat(26),
    deviceSeq: 1,
    hlc: { ms: 5, c: 0 },
    epoch: 1,
    schemaVer: 1,
    cls: "c",
    nonce: toBase64Url(new Uint8Array(12)),
    ct: "AAAA",
    sig: "AAAA",
  }

  it.each([
    ["a bad device", { deviceId: "dev_1" }],
    ["sequence 0", { deviceSeq: 0 }],
    ["a fractional epoch", { epoch: 1.5 }],
    ["a counter past 16 bits", { hlc: { ms: 1, c: 70000 } }],
    ["an unknown class", { cls: "z" }],
    ["a short nonce", { nonce: "AAAA" }],
    ["non-base64url ciphertext", { ct: "a+b" }],
    ["no signature", { sig: undefined }],
  ])("refuses %s", (_label, change) => {
    expect(() => parseOp({ ...valid, ...change })).toThrow(OpError)
  })
})
